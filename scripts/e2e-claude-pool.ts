// E2E —— 入口链 C(claude-pool + 本机 relay)的端到端验收证据。
//
// 这不是单元测试,是【验收证据】:每一条断言都来自真实子进程、真实端口。
//   · master 与"Anthropic"都是本进程里真的 HTTP 服务(只绑 127.0.0.1,端口自选)。
//   · claude-pool 跑在独立子进程里,它拉起的 relay 是另一个【脱离终端的真进程】,端口单例、闲置退出、
//     信号退出全是真的。
//   · 被 spawn 的"claude"是一个真脚本:它照 ANTHROPIC_BASE_URL + CLAUDE_CODE_OAUTH_TOKEN 发请求,
//     和真 claude 一样只知道自己启动时拿到的那枚 token。于是"会话中途换号"由上游亲眼作证 ——
//     子进程手里始终是 A,上游收到的却是 B。
//
// 两条安全边界:
//   1) 绝不打真 master、绝不打 Anthropic。access 带 FAKE- 前缀,上游是 CAP_CC_UPSTREAM 指向的假服务。
//   2) 绝不碰这台机器真实的 worker 配置与真实 relay。CAP_LEASE_CACHE_DIR 指向临时目录,
//      CAP_CC_RELAY_PORT 用临时端口 —— 不设它就会连上操作者自己正在用的 relay。
//
//   bun scripts/e2e-claude-pool.ts    # 全部通过打印 E2E PASS 并 exit 0;任一断言失败 exit 1
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLOUD_ROUTES } from "../src/cloud/protocol.ts"
import { RELAY_ROUTES, type RelayHealth } from "../src/claudecode/relay.ts"

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const ACCOUNTS = [
  { id: "aaaaaaaa-e2e0-0000-0000-000000000000", access: "FAKE-A" },
  { id: "bbbbbbbb-e2e0-0000-0000-000000000000", access: "FAKE-B" },
  { id: "cccccccc-e2e0-0000-0000-000000000000", access: "FAKE-C" },
]
const QUOTA_HEADERS = {
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": String(Math.floor(Date.now() / 1000) + 3600),
}

const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) return void console.log(`  ✓ ${name}`)
  console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
  failures.push(name)
}

async function freePort(): Promise<number> {
  return await new Promise((resolve) => {
    const srv = createServer()
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

// pollUntil,不是固定 sleep(全仓规矩)。
async function pollUntil(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await cond()) return true
    await Bun.sleep(25)
  }
  return false
}

const box = mkdtempSync(join(tmpdir(), "e2e-claude-pool-"))

// 假 claude:照真 claude 的方式发请求 —— base URL 取 ANTHROPIC_BASE_URL,凭证取 CLAUDE_CODE_OAUTH_TOKEN。
// E2E_GO_n 存在才发第 n 个请求(没设就立刻发),这是"会话还开着、下一轮什么时候发"的精确控制。
const fakeClaude = join(box, "fake-claude.ts")
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env bun
import { existsSync, writeFileSync } from "node:fs"
const base = process.env.ANTHROPIC_BASE_URL
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN
const rounds = Number(process.env.E2E_ROUNDS ?? "1")
const results = []
for (let i = 1; i <= rounds; i++) {
  const go = process.env["E2E_GO_" + i]
  while (go && !existsSync(go)) await Bun.sleep(20)
  const res = await fetch(base + "/v1/messages?beta=true" + (process.env.E2E_QUERY ?? ""), {
    method: "POST",
    headers: { authorization: "Bearer " + token, "content-type": "application/json", "anthropic-beta": "oauth-2025-04-20" },
    body: JSON.stringify({ round: i, tag: process.env.E2E_TAG }),
  })
  results.push({ status: res.status, body: await res.text() })
}
writeFileSync(process.env.E2E_OUT, JSON.stringify({
  env: { base, token, sentinel: process.env.CLAUDE_ACCOUNTS_POOL_SESSION, toolSearch: process.env.ENABLE_TOOL_SEARCH },
  argv: process.argv.slice(2),
  results,
}))
process.exit(7)
`,
  { mode: 0o755 },
)

// ── 假 master ─────────────────────────────────────────────────────────────────────────────────
type LeaseSeen = { reason: string; currentAccountId?: string; preferredAccountIdPrefix?: string; pinned?: boolean; workerId: string }
const leases: LeaseSeen[] = []
const reports: { accountId: string; workerId: string; resetsAt?: number }[] = []
let serveNoAccount = false
const master = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === CLOUD_ROUTES.ratelimit && req.method === "POST") {
      reports.push((await req.json()) as (typeof reports)[number])
      return new Response(null, { status: 204 })
    }
    if (url.pathname !== CLOUD_ROUTES.lease || req.method !== "POST") return new Response("nope", { status: 404 })
    const body = (await req.json()) as LeaseSeen
    leases.push(body)
    if (serveNoAccount) return Response.json({ error: "no account available" }, { status: 503 })
    const index = (id?: string) => Math.max(0, ACCOUNTS.findIndex((a) => a.id === id))
    let pick = ACCOUNTS[0]
    if (body.preferredAccountIdPrefix) pick = ACCOUNTS.find((a) => a.id.startsWith(body.preferredAccountIdPrefix!)) ?? pick
    else if (body.reason === "ratelimit") pick = ACCOUNTS[(index(body.currentAccountId) + 1) % ACCOUNTS.length]
    else if (body.currentAccountId) pick = ACCOUNTS[index(body.currentAccountId)]
    return Response.json({ accountId: pick.id, access: pick.access, expiresAt: Date.now() + 3 * 3600_000 })
  },
})

// ── 假 Anthropic ──────────────────────────────────────────────────────────────────────────────
// FAKE-A 撞额度(只在 quotaOnA 打开时),其余回一段 SSE。?e2e=bare429 回一个不带配额头的 429。
type UpSeen = { authorization: string | null; path: string; apiKey: string | null; requestId: string | null; beta: string | null }
const upstreamSeen: UpSeen[] = []
let quotaOnA = false
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    const authorization = req.headers.get("authorization")
    upstreamSeen.push({
      authorization,
      path: `${url.pathname}${url.search}`,
      apiKey: req.headers.get("x-api-key"),
      requestId: req.headers.get("x-client-request-id"),
      beta: req.headers.get("anthropic-beta"),
    })
    await req.text()
    if (url.searchParams.get("e2e") === "bare429") return Response.json({ type: "error", error: { type: "rate_limit_error", message: "capacity" } }, { status: 429 })
    if (quotaOnA && authorization === "Bearer FAKE-A") {
      return Response.json({ type: "error", error: { type: "rate_limit_error", message: "quota" } }, { status: 429, headers: QUOTA_HEADERS })
    }
    return new Response(`event: message_start\ndata: {"by":"${authorization}"}\n\n`, { headers: { "content-type": "text/event-stream" } })
  },
})

writeFileSync(
  join(box, "senpi-worker.json"),
  JSON.stringify({ version: 1, masterUrl: `http://127.0.0.1:${master.port}`, workerId: "e2e-claude-pool.local" }),
)

// ASYNC SPAWN, NOT spawnSync —— 假 master 跑在本进程的事件循环上,spawnSync 会把这条线程整个堵住,
// 子进程连过来时没人应答(issue #83 评论里记过这个坑三次)。
function launch(port: number, opts: { env?: Record<string, string>; args?: string[]; out: string }) {
  const proc = Bun.spawn(["bun", join(REPO, "claude-pool.ts"), ...(opts.args ?? ["-p", "hello world"])], {
    cwd: box,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: box,
      CAP_LEASE_CACHE_DIR: box,
      CAP_CC_RELAY_PORT: String(port),
      CAP_CC_UPSTREAM: `http://127.0.0.1:${upstream.port}`,
      CLAUDE_BIN: fakeClaude,
      E2E_OUT: opts.out,
      ...opts.env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  return {
    done: (async () => {
      const stderr = await new Response(proc.stderr).text()
      const status = await proc.exited
      const report = existsSync(opts.out)
        ? (JSON.parse(readFileSync(opts.out, "utf8")) as {
            env: Record<string, string>
            argv: string[]
            results: { status: number; body: string }[]
          })
        : undefined
      return { status, stderr, report }
    })(),
  }
}

async function relayHealth(port: number): Promise<RelayHealth | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${RELAY_ROUTES.health}`, { signal: AbortSignal.timeout(500) })
    return (await res.json()) as RelayHealth
  } catch {
    return undefined
  }
}

const relayPids = new Set<number>()
async function stopRelay(port: number): Promise<boolean> {
  const health = await relayHealth(port)
  if (!health) return true
  process.kill(health.pid, "SIGTERM")
  return await pollUntil(async () => (await relayHealth(port)) === undefined)
}

let outSeq = 0
const outFile = () => join(box, `out-${++outSeq}.json`)

try {
  console.log("S1 顺利路径:拉起 relay,子进程指向它,请求经 relay 换凭证后到达上游")
  const port1 = await freePort()
  {
    const run = await launch(port1, { out: outFile() }).done
    const health = await relayHealth(port1)
    if (health) relayPids.add(health.pid)
    check("退出码取自子进程", run.status === 7, { status: run.status, stderr: run.stderr })
    check("relay 被拉起且活过了启动器", health?.service === "claude-pool-relay", health)
    check("子进程的 base URL 是本机 relay", run.report?.env.base === `http://127.0.0.1:${port1}`, run.report?.env)
    check("子进程拿到 master 发的共享租约作启动 token", run.report?.env.token === "FAKE-A", run.report?.env.token)
    check("ENABLE_TOOL_SEARCH 被补成 true", run.report?.env.toolSearch === "true", run.report?.env)
    check("哨兵已置位", run.report?.env.sentinel === "1")
    check("操作者参数原样透传,不再被塞 --settings", JSON.stringify(run.report?.argv) === JSON.stringify(["-p", "hello world"]), run.report?.argv)
    check("子进程收到上游的 SSE 应答", run.report?.results[0].status === 200 && run.report.results[0].body.includes("message_start"), run.report?.results)
    const seen = upstreamSeen.at(-1)
    check("上游收到的凭证是当前租约", seen?.authorization === "Bearer FAKE-A", seen)
    check("路径与查询串原样", seen?.path === "/v1/messages?beta=true", seen?.path)
    check("anthropic-beta 原样", seen?.beta === "oauth-2025-04-20", seen?.beta)
    check("x-client-request-id 被补上", typeof seen?.requestId === "string" && seen.requestId.length > 0, seen)
    check("会话结束后注销(relay 登记归零)", (await relayHealth(port1))?.sessions === 0, await relayHealth(port1))
    check("账号只出前 8 位", run.stderr.includes("aaaaaaaa") && !run.stderr.includes("e2e0-0000"), run.stderr.trim())
  }

  console.log("S2 守卫:更高优先级凭证在场时拒绝启动,不碰 relay、不占号")
  {
    const port = await freePort()
    const before = leases.length
    const run = await launch(port, { env: { ANTHROPIC_API_KEY: "sk-ant-api03-fake" }, out: outFile() }).done
    check("退出码 78", run.status === 78, run.status)
    check("一次租约都没发", leases.length === before, leases.length - before)
    check("没有拉起 relay", (await relayHealth(port)) === undefined)
    check("文案说出了怎么修", run.stderr.includes("unset ANTHROPIC_API_KEY"), run.stderr.trim())
  }

  console.log("S3 别名递归")
  {
    const run = await launch(port1, { env: { CLAUDE_ACCOUNTS_POOL_SESSION: "1" }, out: outFile() }).done
    check("退出码 78", run.status === 78, run.status)
    check("没有 spawn", run.report === undefined)
  }

  console.log("S4 池子没号:新 relay 领不到租约,75 且是该变体的文案")
  {
    const port = await freePort()
    serveNoAccount = true
    const run = await launch(port, { out: outFile() }).done
    serveNoAccount = false
    const health = await relayHealth(port)
    if (health) relayPids.add(health.pid)
    check("退出码 75", run.status === 75, { status: run.status, stderr: run.stderr })
    check("没有 spawn", run.report === undefined)
    check("文案是 no-account 那一条", run.stderr.includes("没有可用账号"), run.stderr.trim())
    await stopRelay(port)
  }

  console.log("S5 端口被别的程序占着:拒绝,不把凭证发给它")
  {
    const foreign = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("<html>not a relay</html>") })
    const before = leases.length
    const run = await launch(foreign.port ?? 0, { out: outFile() }).done
    foreign.stop(true)
    check("退出码 78", run.status === 78, run.status)
    check("文案说出怎么换端口", run.stderr.includes("ccRelayPort"), run.stderr.trim())
    check("一次租约都没发", leases.length === before)
  }

  console.log("S6 惊群:5 个会话共用一个号、同时撞额度 —— 只报一次、只换一次号、5 个都成功")
  const port6 = await freePort()
  {
    quotaOnA = true
    const goDir = mkdtempSync(join(box, "go-"))
    const go1 = join(goDir, "1")
    const go2 = join(goDir, "2")
    const reportsBefore = reports.length
    const leasesBefore = leases.length
    const runs = Array.from({ length: 5 }, (_, i) =>
      launch(port6, { env: { E2E_ROUNDS: "2", E2E_GO_1: go1, E2E_GO_2: go2, E2E_TAG: `s${i}` }, out: outFile() }),
    )
    const attached = await pollUntil(async () => (await relayHealth(port6))?.sessions === 5, 15_000)
    check("5 个会话都登记到了同一个 relay", attached, await relayHealth(port6))
    const firstPid = (await relayHealth(port6))?.pid
    if (firstPid) relayPids.add(firstPid)
    writeFileSync(go1, "")
    // 第一轮全部完成后,用第 6 个启动器点名 C —— 正在跑的 5 个会话从下一个请求起也该用 C。
    const firstRoundDone = await pollUntil(() => upstreamSeen.filter((s) => s.authorization === "Bearer FAKE-B").length >= 5, 15_000)
    check("第一轮 5 个请求都在 B 上重发成功", firstRoundDone, upstreamSeen.slice(-12))
    const namer = await launch(port6, { args: ["--pool-account", "cccccccc", "-p", "switch"], env: { E2E_ROUNDS: "1" }, out: outFile() }).done
    check("点名启动器正常退出", namer.status === 7, { status: namer.status, stderr: namer.stderr })
    check("点名时告诉操作者别的会话也跟着换", namer.stderr.includes("另外 5 个会话"), namer.stderr.trim())
    writeFileSync(go2, "")
    const done = await Promise.all(runs.map((r) => r.done))

    check("5 个启动器都以子进程的退出码结束", done.every((d) => d.status === 7), done.map((d) => d.status))
    check("5 个子进程手里始终是启动时的 A", done.every((d) => d.report?.env.token === "FAKE-A"), done.map((d) => d.report?.env.token))
    check("第一轮 5 个请求在子进程看来全部成功", done.every((d) => d.report?.results[0].status === 200), done.map((d) => d.report?.results[0]))
    check(
      "第一轮的应答来自 B —— 冻结在子进程里的 token 被 relay 绕开了",
      done.every((d) => d.report?.results[0].body.includes("Bearer FAKE-B")),
      done.map((d) => d.report?.results[0].body),
    )
    check("master 只收到 1 次限流上报", reports.length - reportsBefore === 1, reports.slice(reportsBefore))
    check("上报的是 A,带着 unified-reset 作 resetsAt", reports.at(-1)?.accountId === ACCOUNTS[0].id && typeof reports.at(-1)?.resetsAt === "number", reports.at(-1))
    const ratelimitLeases = leases.slice(leasesBefore).filter((l) => l.reason === "ratelimit")
    check("master 只收到 1 次换号租约", ratelimitLeases.length === 1, ratelimitLeases)
    check("换号租约带着 A 作 currentAccountId", ratelimitLeases[0]?.currentAccountId === ACCOUNTS[0].id, ratelimitLeases[0])
    check(
      "第二轮(点名 C 之后)5 个请求都走 C —— 会话中途换号,不用重开",
      done.every((d) => d.report?.results[1]?.status === 200 && d.report.results[1].body.includes("Bearer FAKE-C")),
      done.map((d) => d.report?.results[1]),
    )
    check("全程只有一个 relay 进程", (await relayHealth(port6))?.pid === firstPid, { firstPid, now: (await relayHealth(port6))?.pid })
    check("所有租约都用同一个标签(本链推导出的 <senpi 标签>.cc)", leases.slice(leasesBefore).every((l) => l.workerId === "e2e-claude-pool.local.cc"), leases.slice(leasesBefore))
    quotaOnA = false
  }

  console.log("S7 不带配额头的 429:原样交给客户端,不上报、不换号")
  {
    const reportsBefore = reports.length
    const leasesBefore = leases.filter((l) => l.reason === "ratelimit").length
    const run = await launch(port6, { env: { E2E_QUERY: "&e2e=bare429" }, out: outFile() }).done
    check("客户端看到 429", run.report?.results[0].status === 429, run.report?.results)
    check("没有上报", reports.length === reportsBefore)
    check("没有换号", leases.filter((l) => l.reason === "ratelimit").length === leasesBefore)
  }

  console.log("S8 relay 收到 SIGTERM 干净退出,端口释放")
  {
    check("port1 的 relay 退出", await stopRelay(port1))
    check("port6 的 relay 退出", await stopRelay(port6))
  }

  const relayLog = existsSync(join(box, "cc-relay.log")) ? readFileSync(join(box, "cc-relay.log"), "utf8") : ""
  check("relay 日志里没有任何一枚 access", !/FAKE-[ABC]/.test(relayLog), relayLog.match(/.{0,80}FAKE-[ABC].{0,40}/)?.[0])
  check("relay 日志记下了换号", relayLog.includes("claudecode:relay-quota-exhausted"))
} finally {
  for (const pid of relayPids) {
    try {
      process.kill(pid, "SIGTERM")
    } catch {}
  }
  master.stop(true)
  upstream.stop(true)
  if (failures.length > 0 && existsSync(join(box, "cc-relay.log"))) {
    console.log("\n--- cc-relay.log (tail) ---")
    console.log(readFileSync(join(box, "cc-relay.log"), "utf8").split("\n").slice(-30).join("\n"))
  }
  rmSync(box, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nE2E FAIL —— ${failures.length} 条断言未通过:`)
  for (const name of failures) console.log(`  · ${name}`)
  process.exit(1)
}
console.log("\nE2E PASS")
