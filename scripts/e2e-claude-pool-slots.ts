// E2E —— 一台机器上并发跑 N 个 claude-pool 会话,槽位与身份不相撞。
//
// 为什么必须是真进程:槽位分配的正确性【全部】压在跨进程原子性上(proper-lockfile 的 O_EXCL +
// mtime 刷新)。注入假锁的单测只能证明"决策对不对"(src/claudecode/slots.test.ts 做的是那个),
// 证明不了"两个进程同一毫秒抢同一个锁时恰好一个赢"。所以这里一律真 spawn、真锁、真抢。
//
// 假 claude 会【挂住】直到收到停止信号,于是"会话还开着"这个状态可以被精确控制 —— 没有这一点,
// 并发就只能靠 sleep 去碰运气,而那种用例失败起来毫无信息量。
//
//   bun scripts/e2e-claude-pool-slots.ts    # 全部通过打印 E2E PASS 并 exit 0
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLOUD_ROUTES } from "../src/cloud/protocol.ts"

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const STALE_MS = 3000 // 默认 60s,那会让"被杀的持有者槽位被回收"这条用例跑一分钟

const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) return void console.log(`  ✓ ${name}`)
  console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
  failures.push(name)
}

const box = mkdtempSync(join(tmpdir(), "e2e-slots-"))
const STOP = join(box, "stop")

// 假 claude:先记下自己看到的身份,然后挂住等 stop 文件出现。挂住 = 会话还开着 = 槽位还被占着。
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

// 每次租约发一个不同的账号,这样"两个会话拿到同一个号"会立刻显形。
const ACCOUNTS = Array.from({ length: 12 }, (_, i) => `acc${String(i).padStart(2, "0")}-0000-0000-0000-000000000000`)
let served = 0
const leaseWorkerIds: string[] = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname !== CLOUD_ROUTES.lease || req.method !== "POST") return new Response("nope", { status: 404 })
    const body = (await req.json()) as { workerId?: string }
    leaseWorkerIds.push(String(body.workerId))
    return Response.json({
      accountId: ACCOUNTS[served++ % ACCOUNTS.length],
      access: `FAKE-${served}`,
      expiresAt: Date.now() + 3 * 3600_000,
    })
  },
})
writeFileSync(
  join(box, "senpi-worker.json"),
  JSON.stringify({ version: 1, masterUrl: `http://127.0.0.1:${server.port}`, workerId: "e2e-slots.local" }),
)

type Launch = { proc: Bun.Subprocess; tag: string }
function launch(slots: number, index: number): Launch {
  const tag = join(box, `tag-${index}-${Math.random().toString(36).slice(2, 8)}`)
  const proc = Bun.spawn(["bun", join(REPO, "claude-pool.ts")], {
    cwd: box,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: box,
      CAP_LEASE_CACHE_DIR: box,
      CAP_CC_WORKER: "vince-cc",
      CAP_CC_SLOTS: String(slots),
      CAP_CC_SLOT_STALE_MS: String(STALE_MS),
      CLAUDE_BIN: fakeClaude,
      E2E_TAG: tag,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { proc, tag }
}

const identityOf = (tag: string): string | undefined => (existsSync(tag) ? readFileSync(tag, "utf8").trim() : undefined)
const workerOf = (tag: string): string | undefined => identityOf(tag)?.split(" ")[0]
const accountOf = (tag: string): string | undefined => identityOf(tag)?.split(" ")[1]

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
  console.log("S1 六个会话同时启动(槽位 6):各拿到不同的槽位、不同的身份、不同的账号")
  {
    const launches = Array.from({ length: 6 }, (_, i) => launch(6, i))
    const ok = await waitUntil(() => launches.every((l) => identityOf(l.tag) !== undefined), 45_000)
    check("六个会话全部起来了", ok, launches.map((l) => identityOf(l.tag)))
    const workers = launches.map((l) => workerOf(l.tag))
    const accounts = launches.map((l) => accountOf(l.tag))
    check("六个 workerId 互不相同", new Set(workers).size === 6, workers)
    check("六个都带槽位号", workers.every((w) => /^vince-cc\.[1-6]$/.test(String(w))), workers)
    // 这条是整套用例的核心:两个会话拿到同一个号 = 一个 5h 窗口被双倍烧,而 master 只记一个持有者。
    check("六个账号互不相同", new Set(accounts).size === 6, accounts)
    check("master 收到的是六个不同标签", new Set(leaseWorkerIds).size === 6, leaseWorkerIds)
    await stopAll(launches)
  }

  console.log("S2 并发数超过槽位数:多出来的拒绝启动,而不是挤进已占的槽位")
  {
    leaseWorkerIds.length = 0
    const held = Array.from({ length: 2 }, (_, i) => launch(2, 100 + i))
    await waitUntil(() => held.every((l) => identityOf(l.tag) !== undefined), 45_000)
    const extra = launch(2, 200)
    const status = await extra.proc.exited
    const stderr = await new Response(extra.proc.stderr).text()
    check("第三个退出码 75(EX_TEMPFAIL,稍后再试)", status === 75, status)
    check("第三个没有起会话", identityOf(extra.tag) === undefined)
    check("第三个一次租约都没发", leaseWorkerIds.length === 2, leaseWorkerIds)
    check("文案说清楚是并发位满了", stderr.includes("并发位"), stderr.trim())
    await stopAll(held)
  }

  console.log("S3 正常退出:槽位立刻可复用,不必等 stale 到期")
  {
    const first = launch(1, 300)
    await waitUntil(() => identityOf(first.tag) !== undefined, 45_000)
    const firstWorker = workerOf(first.tag)
    await stopAll([first])
    const started = Date.now()
    const second = launch(1, 301)
    const up = await waitUntil(() => identityOf(second.tag) !== undefined, 20_000)
    const elapsed = Date.now() - started
    check("同一个槽位被下一个会话拿到", up && workerOf(second.tag) === firstWorker, workerOf(second.tag))
    // 等 stale 才拿到,说明 release 根本没跑(process.exit 会吃掉 finally,正是这条用例要钉住的)。
    check(`没有等到 stale(${elapsed}ms < ${STALE_MS}ms)`, elapsed < STALE_MS, elapsed)
    await stopAll([second])
  }

  console.log("S4 持有者被 SIGKILL:槽位在 stale 之后被回收,不会永久漏掉")
  {
    const victim = launch(1, 400)
    await waitUntil(() => identityOf(victim.tag) !== undefined, 45_000)
    victim.proc.kill("SIGKILL")
    await victim.proc.exited
    // 被杀之后先确认它确实没能还回槽位(否则这条用例测不到 stale 回收)
    const immediate = launch(1, 401)
    const immediateStatus = await immediate.proc.exited
    check("刚被杀时槽位仍被占着(拒绝启动)", immediateStatus === 75, immediateStatus)
    // 【反复重试启动】,而不是启动一次然后等:启动器抢不到锁就立刻退出(那是它该有的行为),
    // 所以"等一个已经退出的进程去拿到槽位"永远不会发生 —— 这条用例第一版就是这么写错的。
    // 真实操作者的行为也是这个:失败了就再敲一次。
    let revived: Launch | undefined
    const deadline = Date.now() + STALE_MS * 4
    while (Date.now() < deadline) {
      const attempt = launch(1, 402)
      if (await waitUntil(() => identityOf(attempt.tag) !== undefined, 1500)) {
        revived = attempt
        break
      }
      await attempt.proc.exited
      await Bun.sleep(300)
    }
    check("stale 之后槽位被回收", revived !== undefined, revived && identityOf(revived.tag))
    if (revived) await stopAll([revived])
  }

  console.log("S5 快速启停 8 轮:槽位不泄漏")
  {
    let allOk = true
    for (let round = 0; round < 8; round++) {
      const l = launch(1, 500 + round)
      const up = await waitUntil(() => identityOf(l.tag) !== undefined, 30_000)
      if (!up) {
        allOk = false
        check(`第 ${round + 1} 轮起不来`, false)
        await stopAll([l])
        break
      }
      await stopAll([l])
    }
    check("八轮全部拿到槽位", allOk)
  }

  console.log("S6 两个进程抢最后一个空槽位:恰好一个赢")
  {
    const holder = launch(2, 600)
    await waitUntil(() => identityOf(holder.tag) !== undefined, 45_000)
    const a = launch(2, 601)
    const b = launch(2, 602)
    const up = await waitUntil(() => identityOf(a.tag) !== undefined || identityOf(b.tag) !== undefined, 45_000)
    const winners = [a, b].filter((l) => identityOf(l.tag) !== undefined)
    check("至少一个赢了", up && winners.length >= 1, winners.length)
    check("不是两个都赢", winners.length === 1, [identityOf(a.tag), identityOf(b.tag)])
    const loser = [a, b].find((l) => identityOf(l.tag) === undefined)
    check("输的那个干脆退出,没有卡住", loser !== undefined && (await loser.proc.exited) === 75)
    await stopAll([holder, ...winners])
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
