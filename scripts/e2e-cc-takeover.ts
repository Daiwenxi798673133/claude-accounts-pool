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
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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
const leases: { workerId: string; preferredAccountIdPrefix?: string; pinned?: boolean }[] = []
let usageRefreshes = 0
const POOL_ACCOUNTS = [
  { id: "aaaaaaaa-e2e0-0000-0000-000000000000", access: "FAKE-A", label: "a@e2e.invalid" },
  { id: "bbbbbbbb-e2e0-0000-0000-000000000000", access: "FAKE-B", label: "b@e2e.invalid" },
]
const master = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname === CLOUD_ROUTES.health) return Response.json({ ok: true })
    if (url.pathname === CLOUD_ROUTES.usageRefresh && req.method === "POST") usageRefreshes += 1
    if (url.pathname === CLOUD_ROUTES.usage || (url.pathname === CLOUD_ROUTES.usageRefresh && req.method === "POST")) {
      return Response.json({
        at: Date.now(),
        stale: false,
        accounts: POOL_ACCOUNTS.map((a) => ({
          idPrefix: a.id.slice(0, 8),
          label: a.label,
          windows: [{ label: "five_hour", utilization: 7 }, { label: "seven_day", utilization: 40 }],
          hasUsage: true,
          coolingDown: false,
          excluded: false,
          needsReauth: false,
        })),
      })
    }
    if (url.pathname === CLOUD_ROUTES.lease && req.method === "POST") {
      const body = (await req.json()) as (typeof leases)[number]
      leases.push(body)
      const pick = POOL_ACCOUNTS.find((a) => body.preferredAccountIdPrefix !== undefined && a.id.startsWith(body.preferredAccountIdPrefix)) ?? POOL_ACCOUNTS[0]
      return Response.json({ accountId: pick.id, access: pick.access, expiresAt: Date.now() + 3 * 3600_000 })
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
  // 本脚本就跑在 worktree 里;生产上 setup 拒绝在 worktree 里跑(worktree 合并后会被删掉)。
  CAP_CC_TAKEOVER_ALLOW_WORKTREE: "1",
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
    const skill = join(home, ".claude", "skills", "pool", "SKILL.md")
    check("装了 /pool skill(交互式界面才认得这条命令),且不许模型自己调用", existsSync(skill) && readFileSync(skill, "utf8").includes("disable-model-invocation: true"))
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

  console.log("T15 /pool 面板:经生成的 UserPromptSubmit 钩子,不经过模型 —— 看用量、切号、钉住、刷新")
  {
    const HOOK = join(BIN, "claude-pool-prompt-hook")
    const settings = readJson(SETTINGS) as { hooks?: { UserPromptSubmit?: { hooks: { command: string }[] }[] } }
    check("settings 里挂上了 /pool 钩子", JSON.stringify(settings.hooks?.UserPromptSubmit ?? []).includes(HOOK), settings.hooks)
    type Reply = { decision?: string; reason?: string; hookSpecificOutput?: { hookEventName?: string; suppressOriginalPrompt?: boolean } }
    const feed = async (prompt: string) => {
      const proc = Bun.spawn([HOOK], { cwd: box, env: baseEnv(), stdin: Buffer.from(JSON.stringify({ session_id: "s", prompt })), stdout: "pipe", stderr: "pipe" })
      const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
      const reply = stdout.length > 0 ? (JSON.parse(stdout) as Reply) : undefined
      // 面板带 ANSI 颜色;断言看的是字。
      return { code, stdout, reply, text: (reply?.reason ?? "").replace(/\x1b\[[0-9;]*m/g, "") }
    }
    const pinFile = join(POOL, "cc-pin.json")
    const pinned = () => (existsSync(pinFile) ? (readJson(pinFile).accountPrefix as string | null) : null)

    const plain = await feed("fix the failing test")
    check("普通输入:原样放行,什么都不输出", plain.code === 0 && plain.stdout === "", plain)
    const list = await feed("/pool")
    check(
      "/pool:拦下输入,不复述原输入(suppressOriginalPrompt 在 hookSpecificOutput 里)",
      list.reply?.decision === "block" && list.reply.hookSpecificOutput?.hookEventName === "UserPromptSubmit" && list.reply.hookSpecificOutput.suppressOriginalPrompt === true,
      list.reply,
    )
    check("/pool:OMO 外观 —— 标题、两个号、当前号 ● In Use、进度条", /^账号池用量\s+2 个账号/.test(list.text) && /1 ● a@e2e\.invalid In Use/.test(list.text) && /2 ○ b@e2e\.invalid/.test(list.text) && list.text.includes("█"), list.text)
    check("/pool:进度条带颜色", (list.reply?.reason ?? "").includes("\x1b[32m"), list.reply?.reason)
    check("/pool:底部给出命令提示", list.text.includes("/pool 编号 切号"), list.text)

    const leasesBefore = leases.length
    const sw = await feed("/pool 2")
    check("/pool 2:点名 #2 发到 master,不带钉住", leases.slice(leasesBefore).some((l) => l.preferredAccountIdPrefix === "bbbbbbbb" && l.pinned === false), leases.slice(leasesBefore))
    check("/pool 2:说切过去了", sw.text.includes("✓ 已切到「b@e2e.invalid」"), sw.text)
    check("relay 现在持有 #2", (await relayHealth())?.accountId === "bbbbbbbb")
    const beforeTraffic = upstreamAuth.length
    const after = await claudeVia([join(BIN, "claude"), "-p", "after switch"])
    check("之后的请求用的是 #2 的凭证", after.code === 0 && upstreamAuth.slice(beforeTraffic).at(-1) === "Bearer FAKE-B", upstreamAuth.slice(beforeTraffic))

    const pin = await feed("/pool 1 pin")
    check("/pool 1 pin:点名带钉住,钉住落盘", leases.at(-1)?.preferredAccountIdPrefix === "aaaaaaaa" && leases.at(-1)?.pinned === true && pinned() === "aaaaaaaa", { lease: leases.at(-1), pin: pinned() })
    check("/pool 1 pin:面板标出已钉住", pin.text.includes("✓ 已钉住「a@e2e.invalid」") && /1 ● a@e2e\.invalid 已钉住/.test(pin.text), pin.text)
    const leasesBeforeUnpin = leases.length
    const unpin = await feed("/pool 1 pin")
    check("再 /pool 1 pin:取消钉住,不发点名", pinned() === null && leases.length === leasesBeforeUnpin && unpin.text.includes("✓ 已取消钉住"), { pin: pinned(), text: unpin.text })

    const refresh = await feed("/pool r")
    check("/pool r:让 master 采一轮", usageRefreshes === 1 && refresh.text.includes("master 刚采完一轮用量"), refresh.text)
    const bad = await feed("/pool 9")
    check("/pool 9:编号越界如实说", bad.text.includes("没有 #9"), bad.text)

    const STATUS = join(BIN, "claude-pool-statusline")
    const statusLine = (readJson(SETTINGS) as { statusLine?: { type?: string; command?: string; refreshInterval?: number } }).statusLine
    check("settings 里装了状态栏,30 秒刷新", statusLine?.type === "command" && statusLine.command === STATUS && statusLine.refreshInterval === 30, statusLine)
    const status = await run([STATUS])
    const line = status.stdout.replace(/\x1b\[[0-9;]*m/g, "")
    check("状态栏:一行,当前号与 5h / 7d 进度条", status.code === 0 && line.startsWith("账号池 ● a aaaaaaaa · 5h ") && line.includes("7%") && line.includes("40%") && line.trim().split("\n").length === 1, status)
  }

  console.log("T7 revert:照单撤回,别人的文件回到原样")
  {
    const r = await takeover("revert")
    check("退出码 0", r.code === 0, { stdout: r.stdout, stderr: r.stderr })
    check("settings 回到原内容", JSON.stringify(readJson(SETTINGS)) === JSON.stringify(ORIGINAL_SETTINGS), readJson(SETTINGS))
    check(".zshrc 与原文逐字节相同", readFileSync(ZSHRC, "utf8") === ORIGINAL_ZSHRC, readFileSync(ZSHRC, "utf8"))
    check("setup 建的池子配置删掉了", !existsSync(WORKER))
    check("转发脚本删掉了", !existsSync(join(BIN, "claude")) && !existsSync(join(BIN, "claude-pool")) && !existsSync(join(BIN, "claude-pool-prompt-hook")) && !existsSync(join(BIN, "claude-pool-statusline")))
    check("启动器留着(撤回前启动的进程还指着它)", existsSync(LAUNCHER))
    check("清单没了", !existsSync(MANIFEST) && !existsSync(`${MANIFEST}.reverting`))
    check("/pool skill 连目录一起删掉了", !existsSync(join(home, ".claude", "skills", "pool")))
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
    rmSync(WORKER)
  }

  console.log("T16 用户自己已有 UserPromptSubmit 钩子:setup 追加、revert 只删自己那条")
  {
    const withHooks = { hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: "/their/prompt-hook" }] }], Stop: [{ hooks: [{ type: "command", command: "/their/stop" }] }] } }
    writeFileSync(SETTINGS, `${JSON.stringify(withHooks, null, 2)}\n`)
    const r = await takeover("setup", "--master", MASTER, "--worker", "e2e-box")
    check("setup 成功", r.code === 0, r.stderr)
    const merged = readJson(SETTINGS) as { hooks: { UserPromptSubmit: unknown[]; Stop: unknown[] } }
    check("别人的钩子还在,我们的追加在后面", merged.hooks.UserPromptSubmit.length === 2 && JSON.stringify(merged.hooks.UserPromptSubmit[0]).includes("/their/prompt-hook"), merged.hooks)
    const back = await takeover("revert")
    check("revert 成功", back.code === 0, back.stderr)
    check("settings 回到原样(别人的两个钩子都在)", JSON.stringify(readJson(SETTINGS)) === JSON.stringify(withHooks), readJson(SETTINGS))
    writeFileSync(SETTINGS, `${JSON.stringify(ORIGINAL_SETTINGS, null, 2)}\n`)
  }

  console.log("T17 用户自己已有一个 pool skill:不覆盖,revert 也不删")
  {
    const skill = join(home, ".claude", "skills", "pool", "SKILL.md")
    mkdirSync(dirname(skill), { recursive: true })
    const theirs = "---\nname: pool\ndescription: 我自己的 pool\n---\n我的内容\n"
    writeFileSync(skill, theirs)
    const r = await takeover("setup", "--master", MASTER, "--worker", "e2e-box")
    check("setup 成功,并说明跳过了", r.code === 0 && r.stderr.includes("不覆盖"), { code: r.code, stderr: r.stderr })
    check("用户的 skill 原样", readFileSync(skill, "utf8") === theirs)
    const back = await takeover("revert")
    check("revert 成功", back.code === 0, back.stderr)
    check("revert 后用户的 skill 仍在", readFileSync(skill, "utf8") === theirs)
    rmSync(dirname(skill), { recursive: true })
  }

  console.log("T18 用户自己已有状态栏:不覆盖,revert 也不删")
  {
    const theirs = { ...ORIGINAL_SETTINGS, statusLine: { type: "command", command: "~/my-status.sh", padding: 1 } }
    writeFileSync(SETTINGS, `${JSON.stringify(theirs, null, 2)}\n`)
    const r = await takeover("setup", "--master", MASTER, "--worker", "e2e-box")
    check("setup 成功,并说明跳过了状态栏", r.code === 0 && r.stderr.includes("statusLine") && r.stderr.includes("不覆盖"), { code: r.code, stderr: r.stderr })
    check("用户的状态栏原样", JSON.stringify((readJson(SETTINGS) as { statusLine?: unknown }).statusLine) === JSON.stringify(theirs.statusLine))
    const st = await takeover("status")
    check("make status 说状态栏是用户自己的", st.stdout.includes("状态栏:是你自己的,没动"), st.stdout)
    const back = await takeover("revert")
    check("revert 成功,settings 回到原样", back.code === 0 && JSON.stringify(readJson(SETTINGS)) === JSON.stringify(theirs), readJson(SETTINGS))
    writeFileSync(SETTINGS, `${JSON.stringify(ORIGINAL_SETTINGS, null, 2)}\n`)
  }

  console.log("T10 settings 的 env 块里有盖过租约的变量:setup 拒绝,什么都不写")
  {
    writeFileSync(SETTINGS, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "http://gw.internal" } }, null, 2))
    const r = await takeover("setup", "--master", MASTER, "--worker", "e2e-box")
    check("退出码 1", r.code === 1, r)
    check("文案指向 settings 的 env 块", r.stderr.includes("env 块") && r.stderr.includes("ANTHROPIC_BASE_URL"), r.stderr)
    check("没有清单", !existsSync(MANIFEST))
    writeFileSync(SETTINGS, `${JSON.stringify(ORIGINAL_SETTINGS, null, 2)}\n`)
  }

  console.log("T11 .zshrc 是 symlink(dotfiles 仓库):写穿到目标,symlink 保留")
  {
    const dotfiles = join(box, "dotfiles")
    mkdirSync(dotfiles)
    const target = join(dotfiles, "zshrc")
    writeFileSync(target, ORIGINAL_ZSHRC)
    rmSync(ZSHRC)
    symlinkSync(target, ZSHRC)
    const r = await takeover("setup", "--master", MASTER, "--worker", "e2e-box")
    check("setup 成功", r.code === 0, r.stderr)
    check(".zshrc 仍是 symlink", lstatSync(ZSHRC).isSymbolicLink())
    check("PATH 段写进了 dotfiles 里的目标文件", readFileSync(target, "utf8").includes(">>> claude-accounts-pool"))
    const back = await takeover("revert")
    check("revert 成功", back.code === 0, back.stderr)
    check("撤回后仍是 symlink,目标文件回到原文", lstatSync(ZSHRC).isSymbolicLink() && readFileSync(target, "utf8") === ORIGINAL_ZSHRC)
    rmSync(ZSHRC)
    writeFileSync(ZSHRC, ORIGINAL_ZSHRC)
  }

  console.log("T12 macOS 上只有 .profile 的 bash 用户:写进 .profile,绝不新建 .bash_profile 把它遮住")
  if (process.platform === "darwin") {
    const profile = join(home, ".profile")
    const original = 'export MYVAR=keep\n'
    writeFileSync(profile, original)
    const r = await run(["bun", join(REPO, "scripts", "cc-takeover.ts"), "setup", "--master", MASTER, "--worker", "e2e-box"], { SHELL: "/bin/bash" })
    check("setup 成功", r.code === 0, r.stderr)
    check("没有新建 .bash_profile", !existsSync(join(home, ".bash_profile")))
    check("PATH 段进了 .profile,原内容保留", readFileSync(profile, "utf8").startsWith(original) && readFileSync(profile, "utf8").includes(">>> claude-accounts-pool"))
    const back = await run(["bun", join(REPO, "scripts", "cc-takeover.ts"), "revert"], { SHELL: "/bin/bash" })
    check("revert 成功", back.code === 0, back.stderr)
    check(".profile 回到原文", readFileSync(profile, "utf8") === original)
    rmSync(profile)
  }

  console.log("T13 bash 用户什么启动文件都没有:新建 .bash_profile,撤回后删掉而不是留个空壳")
  if (process.platform === "darwin") {
    const r = await run(["bun", join(REPO, "scripts", "cc-takeover.ts"), "setup", "--master", MASTER, "--worker", "e2e-box"], { SHELL: "/bin/bash" })
    check("setup 成功", r.code === 0, r.stderr)
    check("新建了 .bash_profile", existsSync(join(home, ".bash_profile")))
    const back = await run(["bun", join(REPO, "scripts", "cc-takeover.ts"), "revert"], { SHELL: "/bin/bash" })
    check("revert 成功", back.code === 0, back.stderr)
    check(".bash_profile 被删掉", !existsSync(join(home, ".bash_profile")))
  }

  console.log("T14 PATH 里转发脚本目录换一种拼法(带尾斜杠):重跑 setup 不会把转发脚本当成真 claude")
  {
    const first = await takeover("setup", "--master", MASTER, "--worker", "e2e-box")
    check("第一次 setup 成功", first.code === 0, first.stderr)
    const again = await run(["bun", join(REPO, "scripts", "cc-takeover.ts"), "setup", "--master", MASTER, "--worker", "e2e-box"], {
      PATH: [`${BIN}/`, realBin, dirname(process.execPath), "/usr/bin", "/bin"].join(":"),
    })
    check("重跑成功", again.code === 0, again.stderr)
    const shim = readFileSync(join(BIN, "claude"), "utf8")
    check("转发脚本仍指向真 claude,而不是它自己", shim.includes(`'${fakeClaude}'`) && !shim.includes(`'${BIN}/claude'`), shim)
    const back = await takeover("revert")
    check("revert 成功", back.code === 0, back.stderr)
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
