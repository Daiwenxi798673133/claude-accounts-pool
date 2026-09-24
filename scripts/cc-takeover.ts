#!/usr/bin/env bun
// make setup / make revert / make status —— 让这台机器上的 Claude Code 全面走账号池,以及一键撤回。
//
//   setup   依次问 master 的 ip:port 与 WorkerID,然后:
//             1. 写池子配置        ~/.claude-accounts-pool/senpi-worker.json(ccWorkerId = 你输入的 WorkerID)
//             2. 生成启动器        ~/.claude-accounts-pool/bin/claude-pool-launch
//             3. 接上后台进程      ~/.claude/settings.json 的 env.CLAUDE_CODE_PROCESS_WRAPPER
//             4. 接上终端 claude   ~/.claude-accounts-pool/bin/claude + shell rc 末尾一段 PATH
//             5. 常驻 relay        ~/Library/LaunchAgents/com.claude-accounts-pool.relay.plist
//           每一步写进清单 ~/.claude-accounts-pool/cc-takeover.json;改动别人的文件之前先备份。
//   revert  照清单逐项撤回。第一步就把清单挪开 —— 启动器看不到清单就原样放行,所以哪怕撤回中途出错,
//           Claude Code 也已经回到你自己的号上。
//   status  看现在装没装、relay 在不在、当前共享哪个号。
//
// 设计依据:issue #93;启动器契约见 code.claude.com/docs/en/corporate-launcher。
import { spawnSync } from "node:child_process"
import { accessSync, chmodSync, constants as fsConstants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { delimiter, dirname, join } from "node:path"
import { createInterface } from "node:readline/promises"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import { envBlockers, settingsBlockers } from "../src/claudecode/childEnv.ts"
import { CC_RELAY_DEFAULT_PORT, readPoolConfig, relayLogPath, relayUrl, takeoverManifestPath } from "../src/claudecode/config.ts"
import { RELAY_ROUTES, RELAY_SERVICE, type RelayHealth } from "../src/claudecode/relay.ts"
import { leaseCacheDir } from "../src/senpi/leaseCache.ts"
import {
  addPromptHook,
  addShellBlock,
  addWrapper,
  emptyManifest,
  MIN_CLAUDE_VERSION,
  mergeWorker,
  normalizeMasterUrl,
  parseClaudeVersion,
  parseManifest,
  proxyEnv,
  RELAY_AGENT_LABEL,
  removePromptHook,
  removeShellBlock,
  removeWrapper,
  renderClaudePoolCmd,
  renderClaudeShim,
  renderLauncher,
  renderPoolSkill,
  renderPromptHook,
  POOL_SKILL_MARKER,
  renderPlist,
  revertWorker,
  shellBlock,
  validateWorkerId,
  versionAtLeast,
  wrapperValue,
  type TakeoverManifest,
} from "./lib/ccTakeover.ts"
import { atomicWrite, backupFile, isJsonObject, type JsonObject } from "./lib/workerConfig.ts"

const EXIT_REFUSED = 1
const EXIT_USAGE = 2

const env = process.env
const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
// PATH 上的那个 bun,而不是 process.execPath:后者是解析过 symlink 的真实路径,Homebrew / mise 装的
// bun 会带着版本号(Cellar/bun/1.x/bin/bun),brew upgrade 之后启动器与常驻 relay 就一起找不到它了。
const BUN = Bun.which("bun") ?? process.execPath
const HOME = env.HOME && env.HOME.length > 0 ? env.HOME : homedir()
const POOL_DIR = leaseCacheDir(env)
const BIN_DIR = join(POOL_DIR, "bin")
const LAUNCHER = join(BIN_DIR, "claude-pool-launch")
const SHIM = join(BIN_DIR, "claude")
const POOL_CMD = join(BIN_DIR, "claude-pool")
const PROMPT_HOOK = join(BIN_DIR, "claude-pool-prompt-hook")
const MANIFEST = takeoverManifestPath(env)
const REVERTING = `${MANIFEST}.reverting`
const SETTINGS = join(env.CLAUDE_CONFIG_DIR && env.CLAUDE_CONFIG_DIR.length > 0 ? env.CLAUDE_CONFIG_DIR : join(HOME, ".claude"), "settings.json")
const WORKER_FILE = join(POOL_DIR, "senpi-worker.json")
// /pool 要能被 TUI 认成一条命令,得有一个同名 skill(见 ccTakeover.renderPoolSkill)。
const POOL_SKILL = join(dirname(SETTINGS), "skills", "pool", "SKILL.md")
const AGENT_PLIST = join(HOME, "Library", "LaunchAgents", `${RELAY_AGENT_LABEL}.plist`)
// 只在 macOS 上用 launchd;CAP_CC_TAKEOVER_NO_LAUNCHD=1 只给测试用(沙箱 HOME 里不能往真 launchd 装任务)。
const USE_LAUNCHD = process.platform === "darwin" && env.CAP_CC_TAKEOVER_NO_LAUNCHD !== "1"

// 生成的转发脚本里的一句注释,用来在 PATH 上认出它(见 isOurShim)。与 renderClaudeShim 的第二行对应。
const SHIM_MARKER = "终端里手敲的 claude 经由账号池的启动器"

// setup 时生效的 CAP_* 覆盖,抄进 launchd 任务。CAP_CC_TAKEOVER_* 只管 setup 自己,不抄。
function capOverrides(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [name, value] of Object.entries(source)) {
    if (name.startsWith("CAP_") && !name.startsWith("CAP_CC_TAKEOVER_") && typeof value === "string" && value.length > 0) out[name] = value
  }
  return out
}

const say = (line = ""): void => void process.stdout.write(`${line}\n`)
const warn = (line: string): void => void process.stderr.write(`${line}\n`)

// 登录 shell 实际会读的那个文件。bash 登录 shell 只读 .bash_profile / .bash_login / .profile 里【第一个
// 存在的】—— 在只有 .profile 的机器上新建 .bash_profile,会让 .profile 里的全部配置从此不再生效。
function shellRcPath(): string {
  const shell = env.SHELL ?? ""
  if (shell.endsWith("zsh")) return join(env.ZDOTDIR && env.ZDOTDIR.length > 0 ? env.ZDOTDIR : HOME, ".zshrc")
  if (shell.endsWith("bash")) {
    if (process.platform !== "darwin") return join(HOME, ".bashrc")
    const candidates = [".bash_profile", ".bash_login", ".profile"].map((name) => join(HOME, name))
    return candidates.find((path) => existsSync(path)) ?? candidates[0]
  }
  return join(HOME, ".profile")
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

type JsonRead = { kind: "missing" } | { kind: "ok"; value: JsonObject } | { kind: "bad"; reason: string }
function readJsonObject(path: string): JsonRead {
  const text = readText(path)
  if (text === undefined) return { kind: "missing" }
  try {
    const value = JSON.parse(text)
    return isJsonObject(value) ? { kind: "ok", value } : { kind: "bad", reason: `${path} 不是一个 JSON 对象` }
  } catch (error) {
    return { kind: "bad", reason: `${path} 解析失败(${error instanceof Error ? error.message : String(error)})` }
  }
}

const jsonText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

// 覆盖别人的文件:先备份,写完把权限改回原样(atomicWrite 一律 0600,shell rc / settings 原本多半是 0644)。
// symlink 写穿到它指向的文件:temp → rename 会把 symlink 本身换成普通文件,dotfiles 仓库(stow、
// home-manager)里那份就再也不会被更新,home-manager 下次切换还会因为这个挡路的文件失败。
async function rewrite(linkOrPath: string, text: string, now: Date): Promise<string | undefined> {
  let path = linkOrPath
  try {
    if (lstatSync(linkOrPath).isSymbolicLink()) path = realpathSync(linkOrPath)
  } catch {}
  let backup: string | undefined
  let mode: number | undefined
  if (existsSync(path)) {
    backup = await backupFile(path, now)
    mode = statSync(path).mode & 0o777
  }
  await atomicWrite(path, text)
  if (mode !== undefined) chmodSync(path, mode)
  return backup
}

async function writeExecutable(path: string, text: string): Promise<void> {
  await atomicWrite(path, text)
  chmodSync(path, 0o755)
}

function saveManifest(manifest: TakeoverManifest): Promise<void> {
  return atomicWrite(MANIFEST, jsonText({ ...manifest, updatedAt: new Date().toISOString() }))
}

function loadManifest(path: string): TakeoverManifest | undefined {
  const read = readJsonObject(path)
  return read.kind === "ok" ? parseManifest(read.value) : undefined
}

// 真正的 claude:PATH 上第一个不是我们自己转发脚本的 `claude`。保留 symlink 路径本身(不 realpath),
// 这样 Claude Code 自动更新换掉版本目录之后仍然指得对。
//
// 认出【我们自己的】转发脚本要靠内容与 realpath,不能靠目录字符串相等:PATH 里写成带尾斜杠、或经由
// symlink 的另一种拼法,字符串比较就会把转发脚本当成真 claude —— 新生成的转发脚本于是 exec 它自己,
// 无限循环,每一圈还跑一次 bun 与一次 relay attach。
function isOurShim(candidate: string): boolean {
  try {
    if (existsSync(SHIM) && realpathSync(candidate) === realpathSync(SHIM)) return true
    return readFileSync(candidate, "utf8").slice(0, 400).includes(SHIM_MARKER)
  } catch {
    return false
  }
}

function findRealClaude(): string | undefined {
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir.length === 0) continue
    const candidate = join(dir, "claude")
    try {
      accessSync(candidate, fsConstants.X_OK)
      if (statSync(candidate).isFile() && !isOurShim(candidate)) return candidate
    } catch {}
  }
  return undefined
}

async function relayHealth(port: number): Promise<RelayHealth | undefined> {
  try {
    const res = await fetch(`${relayUrl(port)}${RELAY_ROUTES.health}`, { signal: AbortSignal.timeout(1_000) })
    const body = (await res.json()) as RelayHealth
    return body.service === RELAY_SERVICE ? body : undefined
  } catch {
    return undefined
  }
}

async function stopRelay(port: number): Promise<number | undefined> {
  const health = await relayHealth(port)
  if (health === undefined) return undefined
  try {
    process.kill(health.pid, "SIGTERM")
  } catch {}
  for (let i = 0; i < 50 && (await relayHealth(port)) !== undefined; i++) await Bun.sleep(100)
  return health.pid
}

function launchctl(args: string[]): { ok: boolean; output: string } {
  const r = spawnSync("launchctl", args, { encoding: "utf8" })
  return { ok: r.status === 0, output: `${r.stdout ?? ""}${r.stderr ?? ""}`.trim() }
}

const uid = (): string => String(process.getuid?.() ?? "")

async function ask(rl: ReturnType<typeof createInterface> | undefined, question: string, fallback?: string): Promise<string> {
  if (rl === undefined) return fallback ?? ""
  const answer = (await rl.question(fallback === undefined ? `${question}: ` : `${question} [${fallback}]: `)).trim()
  return answer.length > 0 ? answer : (fallback ?? "")
}

// ── setup ─────────────────────────────────────────────────────────────────────────────────────

async function setup(flags: { master?: string; worker?: string; yes?: boolean }): Promise<number> {
  const interactive = process.stdin.isTTY === true
  const existingWorker = readJsonObject(WORKER_FILE)
  const current = existingWorker.kind === "ok" ? existingWorker.value : undefined
  // 一次中途失败的 revert 会留下 .reverting:那里记着最初的原样(池子配置、env 块是不是我们建的),
  // 丢了它,下一次 revert 就会把 setup 写的那份当成"原样"写回去。
  const previous = loadManifest(MANIFEST) ?? loadManifest(REVERTING)

  // ── 1. 输入 ──
  const rl = interactive ? createInterface({ input: process.stdin, output: process.stdout }) : undefined
  let masterUrl: string
  let workerId: string
  try {
    const defaultMaster = typeof current?.masterUrl === "string" ? current.masterUrl.replace(/^https?:\/\//, "") : undefined
    const masterInput = flags.master ?? (await ask(rl, "master 地址 (ip:port)", defaultMaster))
    const master = normalizeMasterUrl(masterInput)
    if (!master.ok) {
      warn(master.reason)
      return EXIT_USAGE
    }
    masterUrl = master.url

    const defaultWorker = typeof current?.ccWorkerId === "string" ? current.ccWorkerId : undefined
    const workerInput = flags.worker ?? (await ask(rl, "WorkerID(看板上显示的这台机器的名字)", defaultWorker))
    const worker = validateWorkerId(workerInput)
    if (!worker.ok) {
      warn(worker.reason)
      if (!interactive && flags.worker === undefined) warn("非交互环境请这样传:make setup MASTER=ip:port WORKER=名字")
      return EXIT_USAGE
    }
    workerId = worker.id

    // ── 2. master 连得上吗 ──
    let reachable = false
    try {
      const res = await fetch(`${masterUrl}/v1/health`, { signal: AbortSignal.timeout(5_000) })
      reachable = res.ok && ((await res.json()) as { ok?: unknown }).ok === true
    } catch {}
    if (!reachable) {
      warn(`连不上 master:${masterUrl}/v1/health 没有应答 {"ok":true}。`)
      const go = flags.yes === true || (await ask(rl, "仍然继续? (y/N)", "N")).toLowerCase() === "y"
      if (!go) return EXIT_REFUSED
    }
  } finally {
    rl?.close()
  }

  // ── 3. 预检:任何一条不过都不写任何东西 ──
  const refusals: string[] = []
  // 从 git worktree 里跑:启动器与 launchd 任务会写死这个目录,而 worktree 按本仓的流程合并后就删掉。
  // 那之后启动器会(按设计)把"仓库不在了"当成撤回、静默放行,常驻 relay 则每 10 秒崩一次。
  if (statSync(join(REPO, ".git"), { throwIfNoEntry: false })?.isFile() && env.CAP_CC_TAKEOVER_ALLOW_WORKTREE !== "1") {
    refusals.push(`${REPO} 是一个 git worktree。请在主 clone 里跑 make setup —— worktree 合并后会被删掉,接管会随之失效。`)
  }
  const realClaude = findRealClaude()
  if (realClaude === undefined) refusals.push("PATH 上找不到 claude。先装好 Claude Code。")
  else {
    const out = spawnSync(realClaude, ["--version"], { encoding: "utf8", timeout: 15_000 })
    const version = parseClaudeVersion(`${out.stdout ?? ""}`)
    if (version === undefined) refusals.push(`读不出 ${realClaude} 的版本号。`)
    else if (!versionAtLeast(version, MIN_CLAUDE_VERSION)) {
      refusals.push(`Claude Code ${version} 太旧:后台会话的接管需要 ${MIN_CLAUDE_VERSION} 以上(claude update)。`)
    }
  }
  // 你 shell 里的这些变量会盖过池子租约:接管之后每个 claude 都会被启动器拒绝,等于把 cc 弄坏。
  // relay 自己的地址不算(从一个已经走池子的会话里重跑 make setup 时,环境里继承的正是它)。
  const priorPort = readPoolConfig(env)?.relayPort ?? CC_RELAY_DEFAULT_PORT
  for (const blocker of envBlockers(env, relayUrl(priorPort))) refusals.push(blocker.remedy)
  if (env.CLAUDE_CODE_PROCESS_WRAPPER && env.CLAUDE_CODE_PROCESS_WRAPPER !== wrapperValue(LAUNCHER)) {
    refusals.push(`shell 里已经有 CLAUDE_CODE_PROCESS_WRAPPER=${env.CLAUDE_CODE_PROCESS_WRAPPER}(别的启动器),两个启动器不能叠加。`)
  }

  const settingsRead = readJsonObject(SETTINGS)
  if (settingsRead.kind === "bad") refusals.push(`${settingsRead.reason};没法安全地往里加一个键。`)
  const settings = settingsRead.kind === "ok" ? settingsRead.value : {}
  for (const blocker of settingsBlockers(settings, relayUrl(priorPort))) refusals.push(blocker.remedy)
  const settingsPlan = addWrapper(settings, wrapperValue(LAUNCHER))
  if (!settingsPlan.ok) refusals.push(`${SETTINGS}:${settingsPlan.reason}`)
  // /pool 面板钩子(issue #97)加在同一个文件里,与启动器那个键一起规划、一起写。
  const hookPlan = addPromptHook(settingsPlan.ok ? settingsPlan.config : settings, PROMPT_HOOK)
  if (!hookPlan.ok) refusals.push(`${SETTINGS}:${hookPlan.reason}`)

  const rcPath = shellRcPath()
  const rcExisting = readText(rcPath)
  const rcCreated = rcExisting === undefined
  const rcBefore = rcExisting ?? ""
  const rcPlan = addShellBlock(rcBefore, shellBlock(BIN_DIR))

  if (existingWorker.kind === "bad") refusals.push(`${existingWorker.reason};手工修好或删掉它再跑。`)

  if (refusals.length > 0) {
    warn("没有做任何改动:")
    for (const reason of refusals) warn(`  · ${reason}`)
    return EXIT_REFUSED
  }
  if (!settingsPlan.ok || !hookPlan.ok || realClaude === undefined) return EXIT_REFUSED // 上面已经报过;只为收窄类型

  // ── 4. 落盘:每一步之后更新清单,中途失败也能 revert ──
  const now = new Date()
  const manifest: TakeoverManifest = previous ?? emptyManifest(REPO, now)
  manifest.repo = REPO
  mkdirSync(BIN_DIR, { recursive: true, mode: 0o700 })
  await saveManifest(manifest)
  if (existsSync(REVERTING)) rmSync(REVERTING) // 它的内容已经并进 manifest(previous)

  const worker = mergeWorker(current, masterUrl, workerId)
  if (worker.changed) {
    const backup = await rewrite(WORKER_FILE, jsonText(worker.next), now)
    say(`写入   ${WORKER_FILE}${backup ? `(备份 ${backup})` : ""}`)
  }
  // 第一次装时记下原样;重跑只更新"setup 写的是什么",原样永远是第一次看到的那份 —— 重跑时读到的
  // current 是上一次 setup 写的,不是操作者原来的。
  const created = manifest.worker?.created ?? current === undefined
  const before = created ? undefined : (manifest.worker?.before ?? current)
  manifest.worker = { path: WORKER_FILE, created, ...(before === undefined ? {} : { before }), after: worker.next }
  await saveManifest(manifest)

  await writeExecutable(LAUNCHER, renderLauncher({ bun: BUN, repo: REPO, manifest: MANIFEST }))
  manifest.launcher = LAUNCHER
  await writeExecutable(SHIM, renderClaudeShim({ launcher: LAUNCHER, realClaude }))
  await writeExecutable(POOL_CMD, renderClaudePoolCmd({ bun: BUN, repo: REPO }))
  await writeExecutable(PROMPT_HOOK, renderPromptHook({ bun: BUN, repo: REPO, manifest: MANIFEST }))
  manifest.generated = [...new Set([...manifest.generated, SHIM, POOL_CMD, PROMPT_HOOK])]
  await saveManifest(manifest)
  say(`生成   ${LAUNCHER}`)
  say(`生成   ${SHIM} → ${realClaude}`)

  if (hookPlan.changed) {
    const backup = await rewrite(SETTINGS, jsonText(hookPlan.config), now)
    const what = [settingsPlan.changed ? "env.CLAUDE_CODE_PROCESS_WRAPPER" : "", "hooks.UserPromptSubmit(/pool 面板)"].filter(Boolean).join("、")
    say(`写入   ${SETTINGS} 的 ${what}${backup ? `(备份 ${backup})` : ""}`)
  } else if (settingsPlan.changed) {
    const backup = await rewrite(SETTINGS, jsonText(settingsPlan.config), now)
    say(`写入   ${SETTINGS} 的 env.CLAUDE_CODE_PROCESS_WRAPPER${backup ? `(备份 ${backup})` : ""}`)
  }
  manifest.settings = {
    path: SETTINGS,
    value: wrapperValue(LAUNCHER),
    createdEnv: manifest.settings?.createdEnv ?? settingsPlan.createdEnv,
  }
  manifest.promptHook = {
    command: PROMPT_HOOK,
    createdHooks: manifest.promptHook?.createdHooks ?? hookPlan.createdHooks,
    createdEvent: manifest.promptHook?.createdEvent ?? hookPlan.createdEvent,
  }
  await saveManifest(manifest)

  // /pool skill:已有一个不是我们写的同名 skill 就不碰它 —— 那是用户自己的东西;面板在 -p 模式下照样
  // 能用,只是交互式 TUI 会把 /pool 当成未知命令。
  const existingSkill = readText(POOL_SKILL)
  if (existingSkill !== undefined && !existingSkill.includes(POOL_SKILL_MARKER)) {
    warn(`跳过   ${POOL_SKILL}:已经有一个你自己的 pool skill,不覆盖。交互式界面里 /pool 会走它,而不是账号池面板。`)
  } else {
    mkdirSync(dirname(POOL_SKILL), { recursive: true })
    await atomicWrite(POOL_SKILL, renderPoolSkill())
    chmodSync(POOL_SKILL, 0o644)
    manifest.poolSkill = { path: POOL_SKILL }
    await saveManifest(manifest)
    say(`生成   ${POOL_SKILL}(让 /pool 成为可识别的命令)`)
  }

  if (rcPlan.changed) {
    const backup = await rewrite(rcPath, rcPlan.text, now)
    say(`写入   ${rcPath} 末尾的 PATH 段${backup ? `(备份 ${backup})` : ""}`)
  }
  manifest.shellRc = { path: rcPath, created: manifest.shellRc?.created ?? rcCreated }
  await saveManifest(manifest)

  // ── 5. 常驻 relay ──
  // 端口在池子配置写好之后再读:第一次装时文件刚刚才存在,之前读到的只是默认值。
  const port = readPoolConfig(env)?.relayPort ?? CC_RELAY_DEFAULT_PORT
  const stopped = await stopRelay(port) // 按需拉起的旧 relay 占着端口,launchd 那个就绑不上
  if (stopped !== undefined) say(`停掉   旧的 relay(pid ${stopped})`)
  if (USE_LAUNCHD) {
    const plist = renderPlist({
      bun: BUN,
      repo: REPO,
      home: HOME,
      logPath: relayLogPath(env),
      path: [dirname(BUN), "/usr/bin", "/bin", "/usr/sbin", "/sbin"].join(":"),
      // 代理:launchd 不继承 shell 的代理变量。CAP_*:setup 时生效的覆盖(端口、标签、缓存目录)
      // 常驻 relay 也得看到同样的值,否则它与启动器各用各的端口。
      extraEnv: { ...proxyEnv(env), ...capOverrides(env) },
    })
    mkdirSync(dirname(AGENT_PLIST), { recursive: true })
    await atomicWrite(AGENT_PLIST, plist)
    // 0600:代理地址里可能带着凭证。launchd 只要求它不被别人可写。
    chmodSync(AGENT_PLIST, 0o600)
    manifest.launchAgent = { path: AGENT_PLIST, label: RELAY_AGENT_LABEL }
    await saveManifest(manifest)
    launchctl(["bootout", `gui/${uid()}/${RELAY_AGENT_LABEL}`]) // 重跑:先卸下旧的,新代码才会被加载
    const loaded = launchctl(["bootstrap", `gui/${uid()}`, AGENT_PLIST])
    if (!loaded.ok) warn(`launchctl bootstrap 失败:${loaded.output}`)
    // 等它真的绑上端口再往下走:否则下面的冒烟里启动器会抢先按需拉起一个 relay 占住端口,
    // launchd 那个就只能在 KeepAlive 里反复绑定失败,直到按需那个闲置退出。
    for (let i = 0; i < 100 && (await relayHealth(port)) === undefined; i++) await Bun.sleep(100)
    say(`常驻   relay(launchd ${RELAY_AGENT_LABEL})`)
  } else {
    say("跳过   launchd(不是 macOS,或测试模式):relay 由启动器按需拉起")
  }

  // ── 6. 冒烟:走一遍真正的启动器,看它是否真的注入了池子租约 ──
  const smoke = spawnSync(LAUNCHER, ["/usr/bin/env"], { encoding: "utf8", timeout: 30_000, env })
  const injected = (smoke.stdout ?? "").split("\n")
  const baseOk = injected.includes(`ANTHROPIC_BASE_URL=${relayUrl(port)}`)
  const tokenOk = injected.some((line) => line.startsWith("CLAUDE_CODE_OAUTH_TOKEN=") && line.length > "CLAUDE_CODE_OAUTH_TOKEN=".length)
  const health = await relayHealth(port)

  say()
  if (smoke.status === 0 && baseOk && tokenOk) {
    say(`✓ 接管完成。这台机器在看板上显示为「${workerId}」,当前共享账号 ${health?.accountId ?? "?"}。`)
  } else {
    warn("✗ 文件都已写好,但冒烟测试没过 —— 启动器没能领到池子租约:")
    warn((smoke.stderr ?? "").trim() || `(退出码 ${smoke.status})`)
    warn(`relay 日志:${relayLogPath(env)}。修好后重跑 make setup,或 make revert 撤回。`)
  }
  say()
  say("接下来:")
  say("  · 开一个新终端(或 source 一下 shell rc),再敲 claude —— 它会走池子")
  say("  · 已经开着的 claude 会话读的是旧设置,重启后生效")
  say("  · 后台服务(claude agents / --bg)要重启一次才走池子:没有在跑的后台会话时执行 claude daemon stop --any")
  say("  · 在 Claude Code 里输入 /pool 看全池用量、切号、钉住(不经过模型,不花 token)")
  say("  · 出问题:在本目录 make revert,Claude Code 立刻回到你自己的号")
  return smoke.status === 0 && baseOk && tokenOk ? 0 : EXIT_REFUSED
}

// ── revert ────────────────────────────────────────────────────────────────────────────────────

async function revert(): Promise<number> {
  const manifest = loadManifest(MANIFEST) ?? loadManifest(REVERTING)
  const problems: string[] = []
  const now = new Date()

  // 第一步:把清单挪开。启动器只认 cc-takeover.json,看不到就原样 exec —— 从这一刻起,哪怕下面哪一步
  // 失败,所有 Claude Code 进程都已经回到你自己的号上。
  if (existsSync(MANIFEST)) renameSync(MANIFEST, REVERTING)

  // settings:只删我们那个键,且只在值还是我们的时候删。没有清单时按启动器路径认。
  const settingsPath = manifest?.settings?.path ?? SETTINGS
  const settingsRead = readJsonObject(settingsPath)
  if (settingsRead.kind === "ok") {
    const removed = removeWrapper(settingsRead.value, manifest?.settings?.value ?? wrapperValue(LAUNCHER), manifest?.settings?.createdEnv ?? false)
    const unhooked = removePromptHook(removed.config, manifest?.promptHook?.command ?? PROMPT_HOOK, {
      createdHooks: manifest?.promptHook?.createdHooks ?? false,
      createdEvent: manifest?.promptHook?.createdEvent ?? false,
    })
    if (removed.changed || unhooked.changed) {
      const backup = await rewrite(settingsPath, jsonText(unhooked.config), now)
      const what = [removed.changed ? "env.CLAUDE_CODE_PROCESS_WRAPPER" : "", unhooked.changed ? "/pool 面板钩子" : ""].filter(Boolean).join("、")
      say(`还原   ${settingsPath}:删掉 ${what}(备份 ${backup})`)
    }
  } else if (settingsRead.kind === "bad") {
    problems.push(`${settingsRead.reason};请手工删掉 env.CLAUDE_CODE_PROCESS_WRAPPER`)
  }

  // shell rc:删掉带标记的那一段。
  for (const rcPath of new Set([manifest?.shellRc?.path ?? shellRcPath(), shellRcPath()])) {
    const text = readText(rcPath)
    if (text === undefined) continue
    const removed = removeShellBlock(text)
    if (!removed.changed) continue
    // setup 新建的文件、删掉我们那段之后什么都不剩:整个删掉,不留一个会遮住 .profile 的空 .bash_profile。
    if (manifest?.shellRc?.path === rcPath && manifest.shellRc.created === true && removed.text.trim().length === 0) {
      rmSync(rcPath)
      say(`删除   ${rcPath}(setup 新建的,撤回后已空)`)
      continue
    }
    const backup = await rewrite(rcPath, removed.text, now)
    say(`还原   ${rcPath}:删掉 PATH 段(备份 ${backup})`)
  }

  // 常驻 relay。
  const agentPath = manifest?.launchAgent?.path ?? AGENT_PLIST
  if (process.platform === "darwin" && env.CAP_CC_TAKEOVER_NO_LAUNCHD !== "1") {
    launchctl(["bootout", `gui/${uid()}/${RELAY_AGENT_LABEL}`])
  }
  if (existsSync(agentPath)) {
    rmSync(agentPath)
    say(`删除   ${agentPath}`)
  }
  const port = readPoolConfig(env)?.relayPort ?? CC_RELAY_DEFAULT_PORT
  const stopped = await stopRelay(port)
  if (stopped !== undefined) say(`停掉   relay(pid ${stopped})`)

  // 生成的转发脚本。启动器本身留着:撤回之前启动的会话和后台服务还指着它,而它看不到清单就只做 exec。
  for (const path of manifest?.generated ?? [SHIM, POOL_CMD, PROMPT_HOOK]) {
    if (existsSync(path)) {
      rmSync(path)
      say(`删除   ${path}`)
    }
  }

  // /pool skill:只删还带着我们标记的那份;目录空了一并删掉。
  const skillPath = manifest?.poolSkill?.path ?? POOL_SKILL
  const skillText = readText(skillPath)
  if (skillText !== undefined && skillText.includes(POOL_SKILL_MARKER)) {
    rmSync(skillPath)
    try {
      rmdirSync(dirname(skillPath))
    } catch {}
    say(`删除   ${skillPath}`)
  }

  // 池子配置:setup 建的就删,setup 改的就改回去 —— 前提是它还是 setup 写的样子。
  if (manifest?.worker !== undefined) {
    const read = readJsonObject(manifest.worker.path)
    const decision = revertWorker(read.kind === "ok" ? read.value : undefined, manifest.worker)
    if (decision.action === "delete") {
      rmSync(manifest.worker.path)
      say(`删除   ${manifest.worker.path}`)
    } else if (decision.action === "write") {
      const backup = await rewrite(manifest.worker.path, jsonText(decision.next), now)
      say(`还原   ${manifest.worker.path}(备份 ${backup})`)
    } else {
      say(`保留   ${manifest.worker.path}:${decision.reason}`)
    }
  }

  if (existsSync(REVERTING)) rmSync(REVERTING)

  say()
  if (problems.length > 0) {
    warn("✗ 撤回完成,但有需要你手工处理的:")
    for (const p of problems) warn(`  · ${p}`)
  } else {
    say("✓ 已撤回。新开的 claude 用的是你自己的号。")
  }
  say("  · 已经开着的 claude 会话仍指向刚停掉的 relay,重启它们")
  say("  · 已打开的终端若提示找不到 claude,执行 rehash(zsh)或 hash -r(bash),或开新终端")
  say("  · 后台服务要重启一次才完全摆脱启动器(它现在只做 exec,不会再走池子):claude daemon stop --any")
  if (manifest?.launcher !== undefined) say(`  · 留下了 ${manifest.launcher}:它只做 exec,所有会话都重启过之后可以删`)
  return problems.length > 0 ? EXIT_REFUSED : 0
}

// ── status ────────────────────────────────────────────────────────────────────────────────────

async function status(): Promise<number> {
  const manifest = loadManifest(MANIFEST)
  const config = readPoolConfig(env)
  say(`接管:${manifest ? `已安装(${manifest.installedAt})` : "未安装"}`)
  if (config) say(`池子:master ${config.masterUrl},看板名字 ${config.workerId},relay 端口 ${config.relayPort}`)
  const health = config ? await relayHealth(config.relayPort) : undefined
  say(health ? `relay:在跑(pid ${health.pid}),共享账号 ${health.accountId ?? "尚未领取"},登记会话 ${health.sessions}` : "relay:不在")
  const settingsRead = readJsonObject(SETTINGS)
  const wrapper = settingsRead.kind === "ok" && isJsonObject(settingsRead.value.env) ? settingsRead.value.env.CLAUDE_CODE_PROCESS_WRAPPER : undefined
  say(`settings:${wrapper === undefined ? "没有 CLAUDE_CODE_PROCESS_WRAPPER" : `CLAUDE_CODE_PROCESS_WRAPPER=${String(wrapper)}`}`)
  const promptHooks = settingsRead.kind === "ok" && isJsonObject(settingsRead.value.hooks) ? settingsRead.value.hooks.UserPromptSubmit : undefined
  const panel = Array.isArray(promptHooks) && JSON.stringify(promptHooks).includes(PROMPT_HOOK)
  say(`/pool:${panel ? "已装(在 Claude Code 里输入 /pool)" : "没装"}`)
  const first = (env.PATH ?? "").split(delimiter).find((dir) => existsSync(join(dir, "claude")))
  say(`终端:当前 shell 里的 claude 来自 ${first ?? "(找不到)"}${first === BIN_DIR ? "(走池子)" : ""}`)
  return 0
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────

const USAGE = `用法:
  bun scripts/cc-takeover.ts setup [--master ip:port] [--worker 名字] [--yes]
  bun scripts/cc-takeover.ts revert
  bun scripts/cc-takeover.ts status
(通常通过 make setup / make revert / make status 调用)`

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv
  let values: { master?: string; worker?: string; yes?: boolean }
  try {
    values = parseArgs({
      args: rest,
      options: { master: { type: "string" }, worker: { type: "string" }, yes: { type: "boolean" } },
      allowPositionals: false,
    }).values
  } catch (error) {
    warn(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}`)
    return EXIT_USAGE
  }
  switch (command) {
    case "setup":
      return setup({
        // make 把没给的变量展开成空串;空串当没给,走交互提问。
        ...(values.master ? { master: values.master } : {}),
        ...(values.worker ? { worker: values.worker } : {}),
        ...(values.yes ? { yes: true } : {}),
      })
    case "revert":
      return revert()
    case "status":
      return status()
    default:
      warn(USAGE)
      return EXIT_USAGE
  }
}

process.exit(await main(process.argv.slice(2)))
