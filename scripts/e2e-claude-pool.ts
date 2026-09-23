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
const REPORT = join(box, "child.json")
const fakeClaude = join(box, "fake-claude")
writeFileSync(
  fakeClaude,
  `#!/bin/sh
printf '{"argv":"%s","token":"%s","sentinel":"%s","path":"%s"}' "$*" "$CLAUDE_CODE_OAUTH_TOKEN" "$CLAUDE_ACCOUNTS_POOL_SESSION" "$PATH" > "${REPORT}"
exit 7
`,
  { mode: 0o755 },
)

let leaseRequests = 0
let serveNoAccount = false
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
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
  if (existsSync(REPORT)) rmSync(REPORT)
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
  const report = existsSync(REPORT) ? (JSON.parse(readFileSync(REPORT, "utf8")) as Record<string, string>) : undefined
  return { status, stderr, report }
}

try {
  console.log("S1 顺利路径:租约注入子进程,argv 透传,退出码透传")
  {
    const before = leaseRequests
    const run = await runLauncher()
    check("发出了恰好一次租约请求", leaseRequests - before === 1, leaseRequests - before)
    check("子进程真的被 spawn 了", run.report !== undefined)
    check("子进程拿到的就是 master 发的那枚 access", run.report?.token === `${FAKE_ACCESS_PREFIX}token`, run.report?.token)
    check("argv 原样透传", run.report?.argv === "-p hello world", run.report?.argv)
    check("哨兵已置位(下一代认得出自己在环里)", run.report?.sentinel === "1", run.report?.sentinel)
    check("退出码取自子进程,不是启动器自己的", run.status === 7, run.status)
    check("账号只出前 8 位", run.stderr.includes("af008f89") && !run.stderr.includes("dead-beef"), run.stderr.trim())
  }

  console.log("S2 守卫路径:更高优先级凭证在场时拒绝启动,且【不占用】池子的号")
  {
    const before = leaseRequests
    const run = await runLauncher({ ANTHROPIC_API_KEY: "sk-ant-api03-fake" })
    check("退出码 78(EX_CONFIG)", run.status === 78, run.status)
    check("一次租约都没发 —— 守卫跑在租约之前", leaseRequests - before === 0, leaseRequests - before)
    check("没有 spawn 任何子进程", run.report === undefined)
    check("文案说出了怎么修", run.stderr.includes("unset ANTHROPIC_API_KEY"), run.stderr.trim())
  }

  console.log("S3 别名递归:从自己启动的会话里再次被调用")
  {
    const before = leaseRequests
    const run = await runLauncher({ CLAUDE_ACCOUNTS_POOL_SESSION: "1" })
    check("退出码 78", run.status === 78, run.status)
    check("一次租约都没发", leaseRequests - before === 0, leaseRequests - before)
    check("没有 spawn,没有无限繁殖", run.report === undefined)
  }

  console.log("S4 池子没号:503 被翻译成该变体自己的文案,不启动")
  {
    serveNoAccount = true
    const run = await runLauncher()
    serveNoAccount = false
    check("退出码 75(EX_TEMPFAIL)", run.status === 75, run.status)
    check("没有 spawn", run.report === undefined)
    check("文案是 no-account 那一条", run.stderr.includes("没有可用账号"), run.stderr.trim())
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
