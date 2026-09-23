// GATE 2 —— 真网络验证:同一个 claude 进程内,两轮对话之间换号,第二轮在新号上成功。
//
// issue #83 正文判定这件事"在 2.1.278 上不可能":凭证在进程内冻结,改 settings、送 401 都换不掉。
// relay 的全部价值压在它上面,所以它必须用真 master 发的真租约、真 api.anthropic.com、真 claude 跑一遍,
// 而不是只靠 e2e 的假上游。
//
// 形状:
//   1. 起一个真 `claude -p --input-format stream-json`,经 claude-pool 拉起的 relay 发第一轮 → 账号 X
//   2. 另起一个 `claude-pool --pool-account Y`(操作者切号的真实路径)→ 全机共享号切到 Y
//   3. 往【同一个】claude 进程写第二轮 → relay 的逐请求日志应显示它走的是 Y,且成功
//
// 隔离:relay 用临时端口、临时 CAP_LEASE_CACHE_DIR(只复制 worker 配置进去),claude 用临时
// CLAUDE_CONFIG_DIR —— 不碰操作者正在用的 relay、日志、钉住,也不在 ~/.claude 留会话。
// 代价是真的:两个号各被租走一次、各烧几百 token。不刷新任何 refresh token(INV-CLOUD-1),
// 与 gate0-refresh-ownership.ts 不同,不需要祭品账号。
//
//   bun scripts/gate2-claudecode-relay.ts                       # dry-run:只打印协议
//   bun scripts/gate2-claudecode-relay.ts --yes                 # 自动挑一个空闲的号作 Y
//   bun scripts/gate2-claudecode-relay.ts --yes --switch-to b657773c
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLOUD_ROUTES, type UsageSnapshotView } from "../src/cloud/protocol.ts"
import { readPoolConfig } from "../src/claudecode/config.ts"
import { RELAY_ROUTES, type RelayHealth } from "../src/claudecode/relay.ts"
import { leaseCacheDir } from "../src/senpi/leaseCache.ts"

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const args = process.argv.slice(2)
const yes = args.includes("--yes")
const switchIdx = args.indexOf("--switch-to")
const switchTo = switchIdx === -1 ? undefined : args[switchIdx + 1]
const claudeBin = process.env.CLAUDE_BIN ?? "claude"

const PROTOCOL = `GATE 2 协议
  1. 临时端口起 relay,真 claude(stream-json)发第一轮          → 记下账号 X
  2. claude-pool --pool-account Y 起第二个会话                 → 全机共享号切到 Y
  3. 同一个 claude 进程发第二轮                                → 期望:走 Y、200、is_error=false
  证据:relay 的逐请求日志(CLAUDE_AUTOSWITCH_DEBUG),而不是 claude 的自述。`

console.log(PROTOCOL)
if (!yes) {
  console.log("\n(dry-run)加 --yes 真跑。会各租一次 X、Y,各烧几百 token。")
  process.exit(0)
}

const real = readPoolConfig(process.env)
if (!real) {
  console.error("这台机器没配过 worker(senpi-worker.json),跑不了。")
  process.exit(78)
}

const box = mkdtempSync(join(tmpdir(), "gate2-relay-"))
copyFileSync(join(leaseCacheDir(process.env), "senpi-worker.json"), join(box, "senpi-worker.json"))
mkdirSync(join(box, "cfg"))
const port = await new Promise<number>((resolve) => {
  const srv = createServer()
  srv.listen(0, "127.0.0.1", () => {
    const p = (srv.address() as { port: number }).port
    srv.close(() => resolve(p))
  })
})

// 最小环境:本脚本自己可能就跑在一个 Claude Code 会话里,那些 CLAUDE_CODE_* 变量不能漏给子进程。
const env: Record<string, string> = {
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  TERM: "xterm-256color",
  CAP_LEASE_CACHE_DIR: box,
  CAP_CC_RELAY_PORT: String(port),
  CLAUDE_CONFIG_DIR: join(box, "cfg"),
  CLAUDE_BIN: claudeBin,
  CLAUDE_AUTOSWITCH_DEBUG: "1",
}
const relayBase = `http://127.0.0.1:${port}`
const logPath = join(box, "cc-relay.log")

async function health(): Promise<RelayHealth | undefined> {
  try {
    return (await (await fetch(`${relayBase}${RELAY_ROUTES.health}`, { signal: AbortSignal.timeout(1000) })).json()) as RelayHealth
  } catch {
    return undefined
  }
}

async function usage(): Promise<UsageSnapshotView | undefined> {
  try {
    return (await (await fetch(`${real!.masterUrl}${CLOUD_ROUTES.usage}`, { signal: AbortSignal.timeout(10_000) })).json()) as UsageSnapshotView
  } catch {
    return undefined
  }
}

type Forward = { method: string; path: string; status: number; accountId: string; ts: string }
function forwards(): Forward[] {
  if (!existsSync(logPath)) return []
  return readFileSync(logPath, "utf8")
    .split("\n")
    .filter((line) => line.includes("claudecode:relay-forward"))
    .map((line) => {
      const rec = JSON.parse(line) as { ts: string; extra: Omit<Forward, "ts"> }
      return { ...rec.extra, ts: rec.ts }
    })
}

const session = Bun.spawn(
  ["bun", join(REPO, "claude-pool.ts"), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose"],
  { cwd: box, env, stdin: "pipe", stdout: "pipe", stderr: "pipe" },
)
const lines: Record<string, unknown>[] = []
const reader = (async () => {
  const decoder = new TextDecoder()
  let buffer = ""
  for await (const chunk of session.stdout as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true })
    let nl: number
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (line.length > 0) {
        try {
          lines.push(JSON.parse(line) as Record<string, unknown>)
        } catch {}
      }
    }
  }
})()
const results = () => lines.filter((l) => l.type === "result")

async function turn(text: string, nth: number): Promise<Record<string, unknown> | undefined> {
  session.stdin.write(`${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`)
  session.stdin.flush()
  const deadline = Date.now() + 180_000
  while (Date.now() < deadline) {
    if (results().length >= nth) return results()[nth - 1]
    await Bun.sleep(200)
  }
  return undefined
}

const verdict: string[] = []
let ok = true
const claim = (name: string, pass: boolean, detail?: unknown) => {
  verdict.push(`  ${pass ? "✓" : "✗"} ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
  if (!pass) ok = false
}

try {
  const before = await usage()
  const r1 = await turn("Reply with exactly the word: alpha", 1)
  const x = (await health())?.accountId
  claim("第一轮成功", r1?.is_error === false, { result: r1?.result, subtype: r1?.subtype })
  claim("relay 持有一个号(X)", typeof x === "string", x)

  const candidates = (before?.accounts ?? []).filter(
    (a) => a.idPrefix !== x && !a.coolingDown && !a.needsReauth && (a.holders ?? []).length === 0,
  )
  const y = switchTo ?? candidates.sort((a, b) => (a.windows.find((w) => w.label === "five_hour")?.utilization ?? 100) - (b.windows.find((w) => w.label === "five_hour")?.utilization ?? 100))[0]?.idPrefix
  if (y === undefined) throw new Error("master 上找不到空闲的号作 Y;用 --switch-to 指定")

  const namer = Bun.spawn(["bun", join(REPO, "claude-pool.ts"), "--pool-account", y, "-p", "Reply with exactly the word: beta"], {
    cwd: box,
    env,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [namerOut, namerErr, namerCode] = await Promise.all([new Response(namer.stdout).text(), new Response(namer.stderr).text(), namer.exited])
  claim("第二个会话(--pool-account Y)成功", namerCode === 0, { code: namerCode, out: namerOut.trim(), err: namerErr.trim().split("\n").slice(-2) })
  claim("全机共享号已切到 Y", (await health())?.accountId === y.slice(0, 8), { y, now: (await health())?.accountId })

  const r2 = await turn("Reply with exactly the word: gamma", 2)
  claim("同一个 claude 进程的第二轮成功", r2?.is_error === false, { result: r2?.result, subtype: r2?.subtype })

  session.stdin.end()
  await session.exited
  await reader

  const posts = forwards().filter((f) => f.method === "POST" && f.path.startsWith("/v1/messages") && !f.path.includes("count_tokens"))
  console.log("\nrelay 逐请求日志(POST /v1/messages):")
  for (const f of posts) console.log(`  ${f.ts}  ${f.status}  ${f.accountId}`)
  const firstTurn = posts.filter((f) => f.accountId === x)
  const secondTurn = posts.filter((f) => f.accountId === y.slice(0, 8))
  claim("第一轮的请求走 X 且 200", firstTurn.length > 0 && firstTurn.every((f) => f.status === 200), firstTurn)
  claim("切号之后的请求走 Y 且 200(含同一个进程的第二轮)", secondTurn.length >= 2 && secondTurn.every((f) => f.status === 200), secondTurn)
  claim("没有任何 401 / 429", posts.every((f) => f.status === 200), posts.filter((f) => f.status !== 200))
  const usage1 = r1?.usage as Record<string, unknown> | undefined
  const usage2 = r2?.usage as Record<string, unknown> | undefined
  console.log("\nusage 第一轮:", JSON.stringify(usage1))
  console.log("usage 第二轮:", JSON.stringify(usage2))
  const after = await usage()
  console.log("\nmaster 看板读数(5h,前 → 后;整数百分比,几百 token 通常看不出变化):")
  for (const id of [x, y.slice(0, 8)]) {
    const pick = (snap?: UsageSnapshotView) => snap?.accounts.find((a) => a.idPrefix === id)?.windows.find((w) => w.label === "five_hour")?.utilization
    console.log(`  ${id}: ${pick(before)} → ${pick(after)}`)
  }
} catch (error) {
  claim("脚本跑完", false, error instanceof Error ? error.message : String(error))
} finally {
  session.kill()
  const h = await health()
  if (h?.pid) process.kill(h.pid, "SIGTERM")
  console.log("\n" + verdict.join("\n"))
  if (!ok && existsSync(logPath)) console.log("\n--- cc-relay.log ---\n" + readFileSync(logPath, "utf8").split("\n").slice(-25).join("\n"))
  rmSync(box, { recursive: true, force: true })
}
console.log(ok ? "\nGATE 2 PASS" : "\nGATE 2 FAIL")
process.exit(ok ? 0 : 1)
