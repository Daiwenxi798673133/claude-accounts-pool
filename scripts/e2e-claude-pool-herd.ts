// E2E —— 一台机器上并发起 N 个 claude-pool 会话,共用【一个】 workerId,不会拿到同一个账号。
//
// 为什么必须是真进程:防惊群的正确性【全部】压在跨进程原子性上(proper-lockfile 的 O_EXCL + mtime
// 刷新 + stale 回收)。注入假锁的单测只能证明"在锁确实串行化的前提下逻辑对不对"
// (src/claudecode/claims.test.ts 做的是那个),证明不了"八个进程在同一毫秒抢同一把锁时会怎样"。
//
// 被测的竞态,原文见 src/senpi/slotRoster.ts:N 个会话同时启动,各自读"本机已持有哪些号"、都读到空、
// 都带着空排除集去租号,于是 master 把同一个号发给所有人 —— 一个 5 小时窗口被 N 倍烧。
//
// 假 claude 会【挂住】直到收到停止信号,所以"会话还开着"是被精确控制的状态,不靠 sleep 碰运气。
//
//   bun scripts/e2e-claude-pool-herd.ts    # 全部通过打印 E2E PASS 并 exit 0
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLOUD_ROUTES } from "../src/cloud/protocol.ts"

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const STALE_MS = 3000 // 默认 20s,会让"锁持有者崩溃后恢复"那条用例跑太久

const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) return void console.log(`  ✓ ${name}`)
  console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
  failures.push(name)
}

const box = mkdtempSync(join(tmpdir(), "e2e-herd-"))
const STOP = join(box, "stop")
const fakeClaude = join(box, "fake-claude")
writeFileSync(
  fakeClaude,
  `#!/bin/sh
echo "$CLAUDE_ACCOUNTS_POOL_WORKER $CLAUDE_ACCOUNTS_POOL_ACCOUNT" > "$E2E_TAG"
while [ ! -f "${STOP}" ]; do sleep 0.05; done
exit 0
`,
  { mode: 0o755 },
)

type LeaseSeen = { workerId: string; excludes: string[]; preferred?: string; pinned?: boolean }
let poolSize = 12
let leaseDelayMs = 0
let refuseNamed = false
const seen: LeaseSeen[] = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== CLOUD_ROUTES.lease || req.method !== "POST") return new Response("nope", { status: 404 })
    const body = (await req.json()) as {
      workerId?: string
      excludeAccountIds?: string[]
      preferredAccountIdPrefix?: string
      pinned?: boolean
    }
    const excludes = body.excludeAccountIds ?? []
    seen.push({
      workerId: String(body.workerId),
      excludes: [...excludes],
      preferred: body.preferredAccountIdPrefix,
      pinned: body.pinned,
    })
    if (leaseDelayMs > 0) await Bun.sleep(leaseDelayMs)
    const pool = Array.from({ length: poolSize }, (_, i) => `acc${String(i).padStart(2, "0")}-0000-0000-0000-00000000`)
    // 点名:服务它,或者按 refuseNamed 明确拒绝。绝不替换成别的 —— 与真 master 同一条规矩。
    if (body.preferredAccountIdPrefix !== undefined) {
      if (refuseNamed) return Response.json({ error: "cooling", refused: "cooling" }, { status: 409 })
      const named = pool.find((id) => id.startsWith(String(body.preferredAccountIdPrefix)))
      if (!named) return Response.json({ error: "unknown account", refused: "unknown" }, { status: 409 })
      return Response.json({ accountId: named, access: `FAKE-${named}`, expiresAt: Date.now() + 3 * 3600_000 })
    }
    const pick = pool.find((id) => !excludes.includes(id))
    // 503 = 池子没有可用账号。排除集把池子吃光时,master 就是这么答的。
    if (!pick) return Response.json({ error: "no account available" }, { status: 503 })
    return Response.json({ accountId: pick, access: `FAKE-${pick}`, expiresAt: Date.now() + 3 * 3600_000 })
  },
})
writeFileSync(
  join(box, "senpi-worker.json"),
  JSON.stringify({ version: 1, masterUrl: `http://127.0.0.1:${server.port}`, workerId: "e2e-herd.local" }),
)

type Launch = { proc: Bun.Subprocess; tag: string }
function launch(slots: number, index: number, poolFlags: string[] = []): Launch {
  const tag = join(box, `tag-${index}-${Math.random().toString(36).slice(2, 8)}`)
  const proc = Bun.spawn(["bun", join(REPO, "claude-pool.ts"), ...poolFlags, "-p", "ignored"], {
    cwd: box,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: box,
      CAP_LEASE_CACHE_DIR: box,
      CAP_CC_WORKER: "vince-cc",
      CAP_CC_SLOTS: String(slots),
      CAP_CC_CLAIM_STALE_MS: String(STALE_MS),
      CLAUDE_BIN: fakeClaude,
      E2E_TAG: tag,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { proc, tag }
}

const identity = (tag: string): string | undefined => (existsSync(tag) ? readFileSync(tag, "utf8").trim() : undefined)
const accountOf = (tag: string): string | undefined => identity(tag)?.split(" ")[1]
const claims = (): { accountId: string; pid: number }[] => {
  const path = join(box, "cc-claims.json")
  if (!existsSync(path)) return []
  try {
    return (JSON.parse(readFileSync(path, "utf8")) as { claims?: { accountId: string; pid: number }[] }).claims ?? []
  } catch {
    return []
  }
}

async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pred()) return true
    await Bun.sleep(40)
  }
  return pred()
}
async function stopAll(launches: Launch[]): Promise<void> {
  writeFileSync(STOP, "1")
  await Promise.all(launches.map((l) => l.proc.exited))
  rmSync(STOP, { force: true })
}

try {
  console.log("S1 惊群:八个会话同时启动,拿到八个【不同】的账号")
  {
    const launches = Array.from({ length: 8 }, (_, i) => launch(8, i))
    const up = await waitUntil(() => launches.every((l) => identity(l.tag) !== undefined), 60_000)
    check("八个会话全部起来了", up, launches.map((l) => identity(l.tag)))
    const accounts = launches.map((l) => accountOf(l.tag))
    // 整套用例的核心:两个会话拿到同一个号 = 一个 5h 窗口被双倍烧,而 master 只记一个持有者。
    check("八个账号互不相同", new Set(accounts).size === 8, accounts)
    check("八次租约全部用同一个 workerId", new Set(seen.map((s) => s.workerId)).size === 1, [...new Set(seen.map((s) => s.workerId))])
    check("workerId 就是配置的那个", seen.every((s) => s.workerId === "vince-cc"), seen[0]?.workerId)
    // 排除集逐次变长,是"读排除集与写声明在同一个临界区"的可观测形态 —— 乱序或重复都说明锁没起作用
    const sizes = seen.map((s) => s.excludes.length).sort((a, b) => a - b)
    check("排除集依次是 0..7(每个人都看得见前面所有人)", JSON.stringify(sizes) === JSON.stringify([0, 1, 2, 3, 4, 5, 6, 7]), sizes)
    check("声明簿里正好八条", claims().length === 8, claims().length)
    await stopAll(launches)
    check("全部退出后声明簿清空", claims().length === 0, claims())
  }

  console.log("S2 容量上限:四个同时启动但只允许两个")
  {
    seen.length = 0
    const launches = Array.from({ length: 4 }, (_, i) => launch(2, 100 + i))
    await Promise.all(launches.map(async (l) => (identity(l.tag) ? undefined : undefined)))
    const up = await waitUntil(() => launches.filter((l) => identity(l.tag) !== undefined).length === 2, 60_000)
    check("恰好两个起来了", up, launches.map((l) => identity(l.tag)))
    const refused = launches.filter((l) => identity(l.tag) === undefined)
    const codes = await Promise.all(refused.map((l) => l.proc.exited))
    check("被拒的两个退出码 75", codes.every((c) => c === 75), codes)
    // 容量检查在锁里、在租号之前 —— 满了就不该去打扰 master
    check("master 只收到两次租约请求", seen.length === 2, seen.length)
    await stopAll(launches.filter((l) => identity(l.tag) !== undefined))
  }

  console.log("S3 池子比并发小:拿到的各不相同,拿不到的干脆失败")
  {
    seen.length = 0
    poolSize = 2
    const launches = Array.from({ length: 4 }, (_, i) => launch(8, 200 + i))
    await waitUntil(() => launches.filter((l) => identity(l.tag) !== undefined).length === 2, 60_000)
    const ok = launches.filter((l) => identity(l.tag) !== undefined)
    const failed = launches.filter((l) => identity(l.tag) === undefined)
    check("两个拿到号且不相同", ok.length === 2 && new Set(ok.map((l) => accountOf(l.tag))).size === 2, ok.map((l) => accountOf(l.tag)))
    const stderrs = await Promise.all(failed.map((l) => new Response(l.proc.stderr).text()))
    check("拿不到的报的是「没有可用账号」", stderrs.every((e) => e.includes("没有可用账号")), stderrs.map((e) => e.trim()))
    await stopAll(ok)
    poolSize = 12
  }

  console.log("S4 会话崩溃:它的声明被下一个会话回收,账号重新可用")
  {
    const victim = launch(2, 300)
    await waitUntil(() => identity(victim.tag) !== undefined, 60_000)
    const victimAccount = accountOf(victim.tag)
    victim.proc.kill("SIGKILL")
    await victim.proc.exited
    check("崩溃后声明还挂在簿上(进程没机会还)", claims().length === 1, claims())
    const next = launch(2, 301)
    const up = await waitUntil(() => identity(next.tag) !== undefined, 60_000)
    // 不回收的话,这台机器眼里的池子会越来越小,直到再也租不到号
    check("下一个会话把死声明收掉了", up && claims().length === 1, claims())
    check("被回收的账号可以重新拿到", accountOf(next.tag) === victimAccount, [accountOf(next.tag), victimAccount])
    await stopAll([next])
  }

  console.log("S5 持有锁的进程崩在临界区里:别人在 stale 之后恢复")
  {
    leaseDelayMs = 4000 // 让租约请求慢到足以在临界区里被杀
    const stuck = launch(2, 400)
    await waitUntil(() => seen.length > 0, 30_000) // 请求已发出 = 锁已在手
    stuck.proc.kill("SIGKILL")
    await stuck.proc.exited
    leaseDelayMs = 0
    // 反复重试启动,而不是启动一次然后等 —— 抢不到锁的启动器会立刻退出,等一个已退出的进程毫无意义
    let revived: Launch | undefined
    const deadline = Date.now() + STALE_MS * 5
    while (Date.now() < deadline) {
      const attempt = launch(2, 401)
      if (await waitUntil(() => identity(attempt.tag) !== undefined, 2000)) {
        revived = attempt
        break
      }
      await attempt.proc.exited
      await Bun.sleep(300)
    }
    check("stale 之后锁被接管,会话能起来", revived !== undefined, revived && identity(revived.tag))
    if (revived) await stopAll([revived])
  }

  console.log("S6 快速启停十轮:声明簿不泄漏")
  {
    let ok = true
    for (let round = 0; round < 10; round++) {
      const l = launch(1, 500 + round)
      if (!(await waitUntil(() => identity(l.tag) !== undefined, 30_000))) {
        ok = false
        check(`第 ${round + 1} 轮起不来`, false, claims())
        await stopAll([l])
        break
      }
      await stopAll([l])
      if (claims().length !== 0) {
        ok = false
        check(`第 ${round + 1} 轮之后声明簿没清空`, false, claims())
        break
      }
    }
    check("十轮全部正常,每轮结束声明簿都是空的", ok)
  }
  console.log("S7 点名与钉住")
  {
    seen.length = 0
    const pinFile = join(box, "cc-pin.json")

    // 一次性点名:pinned 必须是 false —— 那正是「一次 enter 切号」与「p 钉住」的区别
    const once = launch(2, 700, ["--pool-account", "acc03"])
    await waitUntil(() => identity(once.tag) !== undefined, 60_000)
    check("点名的号被服务了", accountOf(once.tag)?.startsWith("acc03") === true, accountOf(once.tag))
    check("一次性点名 pinned=false", seen.at(-1)?.pinned === false, seen.at(-1))
    check("一次性点名不写钉住文件", !existsSync(pinFile))
    await stopAll([once])

    // 钉住:pinned=true 且落盘
    const pinned = launch(2, 701, ["--pool-account", "acc05", "--pool-pin"])
    await waitUntil(() => identity(pinned.tag) !== undefined, 60_000)
    check("钉住时 pinned=true", seen.at(-1)?.pinned === true, seen.at(-1))
    check("钉住落了盘", existsSync(pinFile))
    await stopAll([pinned])

    // 下一次不带任何参数,应当自动点名钉住的那个
    const inherited = launch(2, 702)
    await waitUntil(() => identity(inherited.tag) !== undefined, 60_000)
    check("下次启动自动点名钉住的号", seen.at(-1)?.preferred === "acc05", seen.at(-1))
    check("拿到的确实是它", accountOf(inherited.tag)?.startsWith("acc05") === true, accountOf(inherited.tag))

    // 钉住的号正被这个会话占着时,另一个会话退回排名派号 —— 点名与排除集矛盾,本机自己化解
    const second = launch(2, 703)
    await waitUntil(() => identity(second.tag) !== undefined, 60_000)
    check("被占着时不点名", seen.at(-1)?.preferred === undefined, seen.at(-1))
    check("退回排名派号,拿到别的号", accountOf(second.tag)?.startsWith("acc05") === false, accountOf(second.tag))
    // 先停再读 stderr:读到 EOF 需要进程退出,而进程退出需要 STOP 文件 —— 顺序反了就是死锁,
    // 这个脚本第一版就是这么挂住的。
    await stopAll([inherited, second])
    const secondErr = await new Response(second.proc.stderr).text()
    check("说清楚了为什么没用钉住的号", secondErr.includes("另一个会话占着"), secondErr.trim())
    check("钉住没有因此丢失", existsSync(pinFile))

    // master 拒绝被点名的账号:钉住必须交还,否则每次启动都白跑一趟往返
    refuseNamed = true
    const refused = launch(2, 704)
    const refusedCode = await refused.proc.exited
    const refusedErr = await new Response(refused.proc.stderr).text()
    refuseNamed = false
    check("被拒时不启动", refusedCode === 75, refusedCode)
    check("报的是该拒绝变体自己的文案", refusedErr.includes("冷却"), refusedErr.trim())
    check("钉住被交还了", !existsSync(pinFile) || readFileSync(pinFile, "utf8").includes("null"), readFileSync(pinFile, "utf8"))

    // 取消钉住之后不再点名
    const unpin = launch(2, 705, ["--pool-unpin"])
    await waitUntil(() => identity(unpin.tag) !== undefined, 60_000)
    check("取消钉住后不再点名", seen.at(-1)?.preferred === undefined, seen.at(-1))
    await stopAll([unpin])

    // 用法错误当场挡住
    const bad = Bun.spawn(["bun", join(REPO, "claude-pool.ts"), "--pool-pin"], {
      cwd: box,
      env: { PATH: process.env.PATH ?? "", HOME: box, CAP_LEASE_CACHE_DIR: box, CAP_CC_WORKER: "vince-cc", CLAUDE_BIN: fakeClaude },
      stdout: "pipe",
      stderr: "pipe",
    })
    const badErr = await new Response(bad.stderr).text()
    check("--pool-pin 单独出现被挡住", (await bad.exited) === 78 && badErr.includes("必须配"), badErr.trim())
  }

} finally {
  writeFileSync(STOP, "1")
  server.stop(true)
  rmSync(box, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nE2E FAIL —— ${failures.length} 条断言未通过:`)
  for (const name of failures) console.log(`  · ${name}`)
  process.exit(1)
}
console.log("\nE2E PASS")
