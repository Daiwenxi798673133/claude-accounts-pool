// E2E —— make setup / make revert(scripts/cc-takeover.ts)的验收证据。
//
// 全部跑在沙箱 HOME 里:setup 与 revert 是真子进程,改的是沙箱里真的 settings.json / .zshrc /
// senpi-worker.json;生成的启动器是真 sh 脚本,它拉起的 relay 是真进程。"claude" 是一个假二进制,
// 它把自己看到的环境写下来、照 ANTHROPIC_BASE_URL 发一个请求 —— 于是"这个进程到底有没有走池子"
// 由它自己和上游作证。
//
// 安全边界:
//   1) 绝不碰这台机器真实的 ~/.claude、~/.zshrc、~/.claude-accounts-pool —— HOME 指向临时目录。
//   2) 绝不往真 launchd 装任务 —— CAP_CC_TAKEOVER_NO_LAUNCHD=1;relay 由启动器按需拉起,用临时端口。
//   3) 绝不打真 master / Anthropic —— 两者都是本进程里的假服务。
//
//   bun scripts/e2e-cc-takeover.ts    # 全部通过打印 E2E PASS 并 exit 0
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { CLOUD_ROUTES } from "../src/cloud/protocol.ts"
import { RELAY_ROUTES, type RelayHealth } from "../src/claudecode/relay.ts"

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const failures: string[] = []
function check(name: string, ok: boolean, detail?: unknown): void {
  if (ok) return void console.log(`  ✓ ${name}`)
  console.log(`  ✗ ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`)
  failures.push(name)
}

const port = await new Promise<number>((resolve) => {
  const srv = createServer()
  srv.listen(0, "127.0.0.1", () => {
    const p = (srv.address() as { port: number }).port
    srv.close(() => resolve(p))
  })
})
const RELAY = `http://127.0.0.1:${port}`

const box = mkdtempSync(join(tmpdir(), "e2e-cc-takeover-"))
const home = join(box, "home")
const realBin = join(box, "realbin")
mkdirSync(join(home, ".claude"), { recursive: true })
mkdirSync(realBin)
const POOL = join(home, ".claude-accounts-pool")
const BIN = join(POOL, "bin")
const LAUNCHER = join(BIN, "claude-pool-launch")
const SETTINGS = join(home, ".claude", "settings.json")
const ZSHRC = join(home, ".zshrc")
const WORKER = join(POOL, "senpi-worker.json")
const MANIFEST = join(POOL, "cc-takeover.json")

// 假 claude:--version 报一个够新的版本;其余情况记下环境、照 base URL 发一个请求。
const fakeClaude = join(realBin, "claude")
writeFileSync(
  fakeClaude,
  `#!/usr/bin/env bun
if (process.argv[2] === "--version") { console.log("2.1.280 (Claude Code)"); process.exit(0) }
const base = process.env.ANTHROPIC_BASE_URL
let status = 0, body = ""
if (base) {
  const res = await fetch(base + "/v1/messages", { method: "POST", headers: { authorization: "Bearer " + process.env.CLAUDE_CODE_OAUTH_TOKEN, "content-type": "application/json" }, body: "{}" })
  status = res.status; body = await res.text()
}
await Bun.write(process.env.E2E_OUT, JSON.stringify({
  argv: process.argv.slice(2),
  base: base ?? null,
  token: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? null,
  sentinel: process.env.CLAUDE_ACCOUNTS_POOL_SESSION ?? null,
  status, body,
}))
`,
)
chmodSync(fakeClaude, 0o755)

const ORIGINAL_SETTINGS = { theme: "dark", env: { FOO: "bar" }, permissions: { allow: ["Bash(ls)"] } }
const ORIGINAL_ZSHRC = 'export PATH="$HOME/.local/bin:$PATH"\nalias ll="ls -l"\n'
writeFileSync(ZSHRC, ORIGINAL_ZSHRC)

// ── 假 master / 假 Anthropic ──
const leases: { workerId: string }[] = []
const master = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === CLOUD_ROUTES.health) return Response.json({ ok: true })
    if (url.pathname === CLOUD_ROUTES.lease && req.method === "POST") {
      leases.push((await req.json()) as { workerId: string })
      return Response.json({ accountId: "aaaaaaaa-e2e0-0000-0000-000000000000", access: "FAKE-A", expiresAt: Date.now() + 3 * 3600_000 })
    }
    return new Response(null, { status: 204 })
  },
})
const upstreamAuth: (string | null)[] = []
const upstream = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    upstreamAuth.push(req.headers.get("authorization"))
    await req.text()
    return Response.json({ ok: true })
  },
})
const MASTER = `127.0.0.1:${master.port}`

// 每个子进程都拿同一份最小环境:沙箱 HOME、测试端口、假上游、不碰 launchd。
const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => ({
  HOME: home,
  SHELL: "/bin/zsh",
  PATH: [realBin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
  CAP_CC_RELAY_PORT: String(port),
  CAP_CC_UPSTREAM: `http://127.0.0.1:${upstream.port}`,
  CAP_CC_TAKEOVER_NO_LAUNCHD: "1",
  ...extra,
})

async function run(argv: string[], extra: Record<string, string> = {}) {
  // 异步 spawn:假 master 跑在本进程事件循环上,spawnSync 会把它堵死。
  const proc = Bun.spawn(argv, { cwd: box, env: baseEnv(extra), stdout: "pipe", stderr: "pipe", stdin: "ignore" })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}
const takeover = (...args: string[]) => run(["bun", join(REPO, "scripts", "cc-takeover.ts"), ...args])

let outSeq = 0
async function claudeVia(argv: string[], extra: Record<string, string> = {}) {
  const out = join(box, `claude-${++outSeq}.json`)
  const r = await run(argv, { E2E_OUT: out, ...extra })
  const report = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")) as Record<string, unknown>) : undefined
  return { ...r, report }
}

async function relayHealth(): Promise<RelayHealth | undefined> {
  try {
    return (await (await fetch(`${RELAY}${RELAY_ROUTES.health}`, { signal: AbortSignal.timeout(500) })).json()) as RelayHealth
  } catch {
    return undefined
  }
}
const backups = (path: string) => readdirSync(dirname(path)).filter((f) => f.startsWith(`${path.split("/").pop()}.bak-`)).length
const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>

try {
  console.log("T0 预检不过:settings.json 解析不了 → 一个文件都不写")
  {
    writeFileSync(SETTINGS, "{ not json")
    const r = await takeover("setup", "--master", MASTER, "--worker", "e2e-box")
    check("退出码 1", r.code === 1, r)
    check("说明了原因", r.stderr.includes("settings.json") && r.stderr.includes("没有做任何改动"), r.stderr)
    check("没有清单", !existsSync(MANIFEST))
    check(".zshrc 没动", readFileSync(ZSHRC, "utf8") === ORIGINAL_ZSHRC)
    check("没有生成启动器", !existsSync(LAUNCHER))
    writeFileSync(SETTINGS, `${JSON.stringify(ORIGINAL_SETTINGS, null, 2)}\n`)
  }

  console.log("T1 setup:一次写好五样东西,别人的设置一个不动")
  {
    const r = await takeover("setup", "--master", MASTER, "--worker", "e2e-box")
    check("退出码 0", r.code === 0, { code: r.code, stdout: r.stdout, stderr: r.stderr })
    check("冒烟通过", r.stdout.includes("接管完成"), r.stdout)
    check("清单写了", existsSync(MANIFEST))
    const settings = readJson(SETTINGS) as { env: Record<string, string>; theme: string; permissions: unknown }
    check("settings 加上了启动器", settings.env.CLAUDE_CODE_PROCESS_WRAPPER === LAUNCHER, settings.env)
    check("settings 里别人的设置原样", settings.theme === "dark" && settings.env.FOO === "bar" && JSON.stringify(settings.permissions) === JSON.stringify(ORIGINAL_SETTINGS.permissions))
    check("settings 改之前备份了", backups(SETTINGS) === 1)
    const zshrc = readFileSync(ZSHRC, "utf8")
    check(".zshrc 原文原样保留在前面", zshrc.startsWith(ORIGINAL_ZSHRC))
    check(".zshrc 末尾加了 PATH 段", zshrc.includes(`export PATH="${BIN}:$PATH"`) && zshrc.trimEnd().endsWith("<<<"))
    const worker = readJson(WORKER)
    check("池子配置:master、看板名字", worker.masterUrl === `http://${MASTER}` && worker.ccWorkerId === "e2e-box", worker)
    for (const f of ["claude-pool-launch", "claude", "claude-pool"]) {
      const path = join(BIN, f)
      check(`生成了可执行的 ${f}`, existsSync(path) && (Bun.file(path).size ?? 0) > 0)
    }
    check("租约用的是输入的 WorkerID", leases.at(-1)?.workerId === "e2e-box", leases.at(-1))
  }

  console.log("T2 终端里手敲 claude:经 PATH 前面的转发脚本走池子")
  {
    const before = upstreamAuth.length
    const r = await claudeVia(["sh", "-c", 'claude -p "hello"'], { PATH: [BIN, realBin, dirname(process.execPath), "/usr/bin", "/bin"].join(":") })
    check("claude 正常跑完", r.code === 0, r)
    check("base URL 指向 relay", r.report?.base === RELAY, r.report)
    check("拿到池子租约", r.report?.token === "FAKE-A", r.report?.token)
    check("参数原样透传", JSON.stringify(r.report?.argv) === JSON.stringify(["-p", "hello"]), r.report?.argv)
    check("不置 claude-pool 的哨兵", r.report?.sentinel === null)
    check("请求经 relay 到达上游,凭证是池子的", upstreamAuth.length - before === 1 && upstreamAuth.at(-1) === "Bearer FAKE-A", upstreamAuth.slice(before))
    check("relay 在跑,持有这个号", (await relayHealth())?.accountId === "aaaaaaaa")
  }

  console.log("T3 Claude Code 自己拉起的进程(后台会话等):启动器契约 <launcher> <binary> <args>")
  {
    const r = await claudeVia([LAUNCHER, fakeClaude, "--bg", "task"])
    check("注入了池子租约", r.report?.token === "FAKE-A" && r.report?.base === RELAY, r.report)
    check("参数原样透传", JSON.stringify(r.report?.argv) === JSON.stringify(["--bg", "task"]))
  }

  console.log("T4 嵌套调用:继承来的 relay 地址与旧 token 不是障碍")
  {
    const r = await claudeVia([LAUNCHER, fakeClaude], { ANTHROPIC_BASE_URL: RELAY, CLAUDE_CODE_OAUTH_TOKEN: "stale" })
    check("正常启动", r.code === 0, r)
    check("token 换成当前租约", r.report?.token === "FAKE-A", r.report?.token)
  }

  console.log("T5 更高优先级的凭证在场:拒绝启动,告诉操作者怎么退回")
  {
    const r = await claudeVia([LAUNCHER, fakeClaude], { ANTHROPIC_API_KEY: "sk-ant-api03-x" })
    check("退出码 78", r.code === 78, r.code)
    check("claude 没有被启动", r.report === undefined)
    check("文案给出 make revert", r.stderr.includes("make revert") && r.stderr.includes("unset ANTHROPIC_API_KEY"), r.stderr)
  }

  console.log("T6 重跑 setup:幂等")
  {
    const r = await takeover("setup", "--master", MASTER, "--worker", "e2e-box")
    check("退出码 0", r.code === 0, r.stderr)
    check(".zshrc 里只有一段", readFileSync(ZSHRC, "utf8").split(">>> claude-accounts-pool").length === 2)
    check("settings 没有被再写一次(没有新备份)", backups(SETTINGS) === 1, backups(SETTINGS))
  }

  console.log("T7 revert:照单撤回,别人的文件回到原样")
  {
    const r = await takeover("revert")
    check("退出码 0", r.code === 0, { stdout: r.stdout, stderr: r.stderr })
    check("settings 回到原内容", JSON.stringify(readJson(SETTINGS)) === JSON.stringify(ORIGINAL_SETTINGS), readJson(SETTINGS))
    check(".zshrc 与原文逐字节相同", readFileSync(ZSHRC, "utf8") === ORIGINAL_ZSHRC, readFileSync(ZSHRC, "utf8"))
    check("setup 建的池子配置删掉了", !existsSync(WORKER))
    check("转发脚本删掉了", !existsSync(join(BIN, "claude")) && !existsSync(join(BIN, "claude-pool")))
    check("启动器留着(撤回前启动的进程还指着它)", existsSync(LAUNCHER))
    check("清单没了", !existsSync(MANIFEST) && !existsSync(`${MANIFEST}.reverting`))
    check("relay 停了", (await relayHealth()) === undefined)
  }

  console.log("T8 撤回之后:还指着启动器的进程拿到原生 Claude Code")
  {
    const r = await claudeVia([LAUNCHER, fakeClaude, "-p", "x"])
    check("正常启动", r.code === 0, r)
    check("没有注入任何池子变量", r.report?.token === null && r.report?.base === null, r.report)
    check("没有拉起 relay", (await relayHealth()) === undefined)
  }

  console.log("T9 已有 senpi 配置:只加 ccWorkerId,撤回后原样还原")
  {
    const senpi = { version: 1, masterUrl: `http://${MASTER}`, workerId: "e2e-box.senpi", slots: 1 }
    writeFileSync(WORKER, JSON.stringify(senpi, null, 2))
    const r = await takeover("setup", "--master", MASTER, "--worker", "e2e-cc")
    check("setup 成功", r.code === 0, r.stderr)
    const merged = readJson(WORKER)
    check("senpi 的标签原样,ccWorkerId 是输入值", merged.workerId === "e2e-box.senpi" && merged.ccWorkerId === "e2e-cc" && merged.slots === 1, merged)
    const back = await takeover("revert")
    check("revert 成功", back.code === 0, back.stderr)
    check("池子配置还原成 setup 之前", JSON.stringify(readJson(WORKER)) === JSON.stringify(senpi), readJson(WORKER))
  }
} finally {
  const h = await relayHealth()
  if (h?.pid) process.kill(h.pid, "SIGTERM")
  master.stop(true)
  upstream.stop(true)
  rmSync(box, { recursive: true, force: true })
}

if (failures.length > 0) {
  console.log(`\nE2E FAIL —— ${failures.length} 条断言未通过:`)
  for (const name of failures) console.log(`  · ${name}`)
  process.exit(1)
}
console.log("\nE2E PASS")
