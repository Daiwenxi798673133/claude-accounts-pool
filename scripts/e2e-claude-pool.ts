// E2E —— 入口链 C(claude-pool)的端到端验收证据。
//
// 这不是单元测试,是【验收证据】:每一条断言都来自真实子进程、真实端口、真实 spawn。
//   · master 是一个真的 HTTP 服务(只绑 127.0.0.1,端口 0 自选),按 CLOUD_ROUTES.lease 应答。
//   · claude-pool 跑在独立子进程里,走的是真的 resolveWorkerConfig → leaseClient → spawn。
//   · 被 spawn 的"claude"是一个真脚本,它把自己看到的 argv 与环境写进文件 —— 于是"租约有没有
//     真的到子进程手上"这件事,由子进程自己作证,而不是由启动器自述。
//
// 两条安全边界:
//   1) 绝不打真 master、绝不打 Anthropic。发出去的 access 带 FAKE_ACCESS_PREFIX,一眼可辨。
//   2) 绝不碰这台机器真实的 worker 配置。CAP_LEASE_CACHE_DIR 指向临时目录 —— 这是 leaseCacheDir
//      唯一的改写点,不设它就会读到操作者自己的 ~/.claude-accounts-pool/senpi-worker.json。
//
//   bun scripts/e2e-claude-pool.ts    # 全部通过打印 E2E PASS 并 exit 0;任一断言失败 exit 1
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLOUD_ROUTES } from "../src/cloud/protocol.ts"

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const FAKE_ACCESS_PREFIX = "FAKE-LEASE-"
const ACCOUNT_ID = "af008f89-dead-beef-cafe-000000000000"

const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) {
    console.log(`  ✓ ${name}`)
    return
  }
  console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
  failures.push(name)
}

const box = mkdtempSync(join(tmpdir(), "e2e-claude-pool-"))
// 被 spawn 的假 claude:把 argv 与它实际看到的凭证写进报告文件。用 printf 拼 JSON 而不是依赖
// 任何运行时,因为这一层要证明的正是"启动器把东西交到了一个普通子进程手上"。
const ARGV_FILE = join(box, "child-argv.txt")
const ENV_FILE = join(box, "child-env.json")
const fakeClaude = join(box, "fake-claude")
// argv 逐行写,不拼进 JSON:传给子进程的 --settings 本身就是一段带引号的 JSON,拼进去会把
// 报告文件撑破(这个脚本第一版就是这么坏的)。环境值都是我们自己造的,没有引号问题。
writeFileSync(
  fakeClaude,
  `#!/bin/sh
printf '%s\\n' "$@" > "${ARGV_FILE}"
printf '{"token":"%s","sentinel":"%s","account":"%s"}' "$CLAUDE_CODE_OAUTH_TOKEN" "$CLAUDE_ACCOUNTS_POOL_SESSION" "$CLAUDE_ACCOUNTS_POOL_ACCOUNT" > "${ENV_FILE}"
exit 7
`,
  { mode: 0o755 },
)

let leaseRequests = 0
let serveNoAccount = false
// S6 用:master 收到的限流上报。钩子跑在另一个进程里,所以"它有没有真的上报"只能由 master 作证。
const limitReports: { workerId?: string; accountId?: string }[] = []
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)

    // S6:假 Anthropic。真 claude 会被指到这里,拿到一个 429 —— 于是 StopFailure 该被触发。
    if (url.pathname.endsWith("/v1/messages") && req.method === "POST") {
      return new Response(
        JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "e2e forced rate limit" } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "1" } },
      )
    }
    if (url.pathname === CLOUD_ROUTES.ratelimit && req.method === "POST") {
      limitReports.push((await req.json()) as { workerId?: string; accountId?: string })
      return Response.json({ ok: true })
    }

    if (url.pathname !== CLOUD_ROUTES.lease || req.method !== "POST") return new Response("nope", { status: 404 })
    leaseRequests++
    // 503 = 池子没有可用账号,leaseClient 把它映射成 {kind:"no-account"}。
    if (serveNoAccount) return Response.json({ error: "no account available" }, { status: 503 })
    return Response.json({
      accountId: ACCOUNT_ID,
      access: `${FAKE_ACCESS_PREFIX}token`,
      // 远在未来:本脚本不验到期逻辑(那是 session.test.ts 的事),只要它别把这次启动挡掉。
      expiresAt: Date.now() + 3 * 3600_000,
    })
  },
})
const masterUrl = `http://127.0.0.1:${server.port}`

writeFileSync(
  join(box, "senpi-worker.json"),
  JSON.stringify({ version: 1, masterUrl, workerId: "e2e-claude-pool.local" }),
)

// ASYNC SPAWN, NOT spawnSync —— 这一条是这个脚本踩出来的:假 master 跑在本进程的事件循环上,
// 而 spawnSync 会把这条线程整个堵住,于是子进程连过来时没人应答,每次都超时成 "连不上 master"。
// 同进程内既当服务端又等子进程,就只能异步。
async function runLauncher(extraEnv: Record<string, string> = {}, args: string[] = ["-p", "hello world"]) {
  for (const f of [ARGV_FILE, ENV_FILE]) if (existsSync(f)) rmSync(f)
  const proc = Bun.spawn(["bun", join(REPO, "claude-pool.ts"), ...args], {
    cwd: box, // 不在仓库里跑:顺带证明 settings 扫描不会因为没有 .claude/ 目录而炸
    env: {
      PATH: process.env.PATH ?? "",
      HOME: box,
      CAP_LEASE_CACHE_DIR: box,
      CLAUDE_BIN: fakeClaude,
      ...extraEnv,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const stderr = await new Response(proc.stderr).text()
  const status = await proc.exited
  const argvSeen = existsSync(ARGV_FILE)
    ? readFileSync(ARGV_FILE, "utf8").split("\n").filter((line) => line.length > 0)
    : undefined
  const childEnv = existsSync(ENV_FILE) ? (JSON.parse(readFileSync(ENV_FILE, "utf8")) as Record<string, string>) : undefined
  return { status, stderr, argvSeen, childEnv }
}

try {
  console.log("S1 顺利路径:租约注入子进程,argv 透传,退出码透传")
  {
    const before = leaseRequests
    const run = await runLauncher()
    check("发出了恰好一次租约请求", leaseRequests - before === 1, leaseRequests - before)
    check("子进程真的被 spawn 了", run.argvSeen !== undefined)
    check("子进程拿到的就是 master 发的那枚 access", run.childEnv?.token === `${FAKE_ACCESS_PREFIX}token`, run.childEnv?.token)
    check("操作者的参数原样透传,顺序不变", JSON.stringify(run.argvSeen?.slice(-2)) === JSON.stringify(["-p", "hello world"]), run.argvSeen)
    check("限流钩子经 --settings 挂了上去", run.argvSeen?.[0] === "--settings" && String(run.argvSeen?.[1]).includes("claude-pool-hook.ts"), run.argvSeen?.[0])
    check("账号 id 随环境送给钩子", run.childEnv?.account === ACCOUNT_ID, run.childEnv?.account)
    check("哨兵已置位(下一代认得出自己在环里)", run.childEnv?.sentinel === "1", run.childEnv?.sentinel)
    check("退出码取自子进程,不是启动器自己的", run.status === 7, run.status)
    check("账号只出前 8 位", run.stderr.includes("af008f89") && !run.stderr.includes("dead-beef"), run.stderr.trim())
  }

  console.log("S2 守卫路径:更高优先级凭证在场时拒绝启动,且【不占用】池子的号")
  {
    const before = leaseRequests
    const run = await runLauncher({ ANTHROPIC_API_KEY: "sk-ant-api03-fake" })
    check("退出码 78(EX_CONFIG)", run.status === 78, run.status)
    check("一次租约都没发 —— 守卫跑在租约之前", leaseRequests - before === 0, leaseRequests - before)
    check("没有 spawn 任何子进程", run.argvSeen === undefined)
    check("文案说出了怎么修", run.stderr.includes("unset ANTHROPIC_API_KEY"), run.stderr.trim())
  }

  console.log("S3 别名递归:从自己启动的会话里再次被调用")
  {
    const before = leaseRequests
    const run = await runLauncher({ CLAUDE_ACCOUNTS_POOL_SESSION: "1" })
    check("退出码 78", run.status === 78, run.status)
    check("一次租约都没发", leaseRequests - before === 0, leaseRequests - before)
    check("没有 spawn,没有无限繁殖", run.argvSeen === undefined)
  }

  console.log("S4 池子没号:503 被翻译成该变体自己的文案,不启动")
  {
    serveNoAccount = true
    const run = await runLauncher()
    serveNoAccount = false
    check("退出码 75(EX_TEMPFAIL)", run.status === 75, run.status)
    check("没有 spawn", run.argvSeen === undefined)
    check("文案是 no-account 那一条", run.stderr.includes("没有可用账号"), run.stderr.trim())
  }

  // 客户端【会不会】派发这个钩子,是外部事实,不在本脚本的射程内:已用真 pty + 假端点单独验过
  // (2026-09-23,claude 2.1.278)——交互式下 StopFailure 触发,`-p` 下不触发。记录在 issue #83。
  // 这里验的是【我们自己那一段】:拿到真报文之后,钩子进程做对了没有。
  //
  // 报文是原样抓来的,字段名与官方文档不一致(实际是 `error` / `last_assistant_message`,文档写的是
  // `error_type` / `error_message`)——用抓来的那份,而不是文档那份,正是这两条断言的意义。
  const realPayload = (error: string) =>
    JSON.stringify({
      session_id: "e0df9949-1758-4017-ba13-68d2ce49e956",
      transcript_path: join(box, "transcript.jsonl"),
      cwd: box,
      prompt_id: "78ba6018-9b3f-47b1-be90-fd21d9d45de3",
      effort: { level: "high" },
      hook_event_name: "StopFailure",
      error,
      last_assistant_message: "API Error",
    })

  async function feedHook(payload: string, extraEnv: Record<string, string> = {}) {
    const proc = Bun.spawn(["bun", join(REPO, "claude-pool-hook.ts")], {
      cwd: box,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: box,
        CAP_LEASE_CACHE_DIR: box, // 钩子靠它找到 worker 配置,才知道 master 在哪
        CLAUDE_ACCOUNTS_POOL_ACCOUNT: ACCOUNT_ID,
        ...extraEnv,
      },
      stdin: Buffer.from(payload),
      stdout: "pipe",
      stderr: "pipe",
    })
    await new Response(proc.stdout).text()
    return await proc.exited
  }

  console.log("S6 钩子进程:真实 rate_limit 报文 → 上报给 master")
  {
    const before = limitReports.length
    const code = await feedHook(realPayload("rate_limit"))
    check("钩子正常退出", code === 0, code)
    check("master 收到了限流上报", limitReports.length - before === 1, limitReports.length - before)
    check("上报的是本次会话那个账号", limitReports.at(-1)?.accountId === ACCOUNT_ID, limitReports.at(-1))
    check("上报带着这台机器的标签", limitReports.at(-1)?.workerId === "e2e-claude-pool.local", limitReports.at(-1))
  }

  console.log("S6b 钩子用【会话的】workerId 上报,而不是配置里的基名")
  {
    // master 的持有者账本按 workerId 键。用基名上报 = 给一个并不持有这个号的身份记账。
    const before = limitReports.length
    await feedHook(realPayload("rate_limit"), { CLAUDE_ACCOUNTS_POOL_WORKER: "vince-cc.3" })
    check("上报带的是会话注进来的槽位标签", limitReports.at(-1)?.workerId === "vince-cc.3", limitReports.at(-1))
    check("确实多了一条上报", limitReports.length - before === 1)
  }

  console.log("S7 钩子进程:鉴权失败【绝不】上报 —— 那会把一个额度健康的号打进冷却")
  {
    const before = limitReports.length
    for (const error of ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "overloaded", "server_error"]) {
      await feedHook(realPayload(error))
    }
    check("五种非限流错误一条都没上报", limitReports.length - before === 0, limitReports.length - before)
  }

  console.log("S5 没配过的机器:说清楚下一步跑什么命令")
  {
    const naked = mkdtempSync(join(tmpdir(), "e2e-claude-pool-naked-"))
    const proc = Bun.spawn(["bun", join(REPO, "claude-pool.ts")], {
      env: { PATH: process.env.PATH ?? "", HOME: naked, CAP_LEASE_CACHE_DIR: naked, CLAUDE_BIN: fakeClaude },
      stdout: "pipe",
      stderr: "pipe",
    })
    const stderr = await new Response(proc.stderr).text()
    const status = await proc.exited
    check("退出码 78", status === 78, status)
    check("指明了 configure-worker", stderr.includes("configure-worker"), stderr.trim())
    rmSync(naked, { recursive: true, force: true })
  }
} finally {
  server.stop(true)
  rmSync(box, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nE2E FAIL —— ${failures.length} 条断言未通过:`)
  for (const name of failures) console.log(`  · ${name}`)
  process.exit(1)
}
console.log("\nE2E PASS")
