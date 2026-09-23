// COMPOSITION ROOT for the Claude Code lane — the one file that resolves session.ts's collaborators
// against the real world: the real `fetch`, a real child process, the real settings files on disk.
//
// SCOPE: this lane leases and launches. It runs no keeper, no autoswitch and no refresher, because a
// pooled `claude` session has nothing to renew (its credential is frozen at startup, issue #83) and
// nothing to refresh (the master owns every chain — INV-CLOUD-1). If a future edit adds a timer here,
// that is the signal something has been misunderstood.
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { constants as osConstants, homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import properLockfile from "proper-lockfile"
import { log } from "../logger.ts"
import { claimLockTarget, claimsPath } from "./config.ts"
import { leaseWithClaim, type Claim, type ClaimStore } from "./claims.ts"
import { createPinStore, resolvePreference } from "./pin.ts"
import type { PoolArgs } from "./args.ts"
import { createLeaseClient } from "../worker/leaseClient.ts"
import type { HookRunDeps } from "./hookRun.ts"
import type { SessionDeps } from "./session.ts"
import { POOL_ACCOUNT_VAR, POOL_WORKER_VAR } from "./childEnv.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Every settings file whose `apiKeyHelper` would outrank our lease. Claude Code scopes that key to
// "any file", so checking only the user file would let a project-local one silently win.
function settingsCandidates(env: NodeJS.ProcessEnv, cwd: string): string[] {
  const configDir = env.CLAUDE_CONFIG_DIR
  const userDir = configDir && configDir.length > 0 ? configDir : join(homedir(), ".claude")
  return [
    join(userDir, "settings.json"),
    join(cwd, ".claude", "settings.json"),
    join(cwd, ".claude", "settings.local.json"),
  ]
}

// A MISSING file is clean; an UNPARSEABLE one is reported and skipped. Claude Code itself ignores a
// settings file it cannot read, so refusing to launch over one would be stricter than the client we
// are protecting — and would strand an operator behind a stray comma in a file nobody reads.
async function readSettings(env: NodeJS.ProcessEnv, cwd: string): Promise<unknown> {
  const merged: Record<string, unknown> = {}
  for (const path of settingsCandidates(env, cwd)) {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      continue
    }
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>
      // Only the keys this lane judges. Merging whole files would invent a settings-precedence model
      // this module has no business owning.
      if (typeof parsed.apiKeyHelper === "string" && parsed.apiKeyHelper.length > 0) {
        merged.apiKeyHelper = parsed.apiKeyHelper
      }
    } catch (error) {
      log.warn("claudecode:settings-unparseable", { path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return merged
}

// The child inherits this process's stdio, which is what makes the launcher invisible: `claude` draws
// its TUI on the real terminal, reads the real keyboard, and the operator never learns there was a
// wrapper — until the one line session.ts prints before handing over.
//
// SIGNALS ARE NOT FORWARDED, DELIBERATELY. The child is in this process's group, so Ctrl-C already
// reaches it from the terminal; re-sending would deliver SIGINT twice and turn a clean interrupt into
// a kill. A child that dies on a signal is reported as 128+signo, the shell convention.
function spawnChild(bin: string): SessionDeps["spawn"] {
  return (input) =>
    new Promise<number>((resolve, reject) => {
      const child = spawn(bin, [...input.argv], { env: input.env, stdio: "inherit" })
      child.on("error", reject)
      child.on("exit", (code, signal) =>
        resolve(code ?? (signal ? 128 + (osConstants.signals[signal as keyof typeof osConstants.signals] ?? 0) : 1)),
      )
    })
}

// 钩子脚本在仓库根,与本文件相距两层。解析成绝对路径而不是相对路径,因为它要被写进交给子进程的
// settings JSON,而子进程的 cwd 是操作者的工作目录,不是这个仓库。
// 找不到就返回 undefined:一个装了一半的 clone(或某天改了布局)不该让整条链路起不来,代价只是
// 少一条遥测 —— session.ts 会照实说一句。
export function resolveHookPath(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))
  const path = join(dirname(dirname(here)), "claude-pool-hook.ts")
  return existsSync(path) ? path : undefined
}

// `lock` 取自默认导出而不是具名导入 —— 与 src/senpi/slotLock.ts 同一个理由:CJS 包的具名导出在
// 某些加载器下静态探测不到,`import { lock }` 会在加载期就把整个模块带崩。
const { lock } = properLockfile

// 【等待,而不是放弃】—— 与 src/senpi/slotLock.ts 相反,这是有意的。那边是续期循环,抢不到就跳过
// 一个 tick,代价为零;这边是启动器,抢不到就等于启动失败。能这么等的前提是临界区很短:里面只有
// 一次 attempts:1 的租约请求(一次带超时的 HTTP),而不是 leaseClient 默认那条最长十分钟的退避梯子。
//
// stale 管的是"持有者崩在临界区里"。可被 CAP_CC_CLAIM_STALE_MS 覆盖,仅为测试。
const DEFAULT_CLAIM_STALE_MS = 20_000
const CLAIM_RETRIES = { retries: 15, factor: 1.5, minTimeout: 100, maxTimeout: 2000 } as const

export function createClaimLock(env: NodeJS.ProcessEnv): <T>(fn: () => Promise<T>) => Promise<T | undefined> {
  const staleRaw = Number(env.CAP_CC_CLAIM_STALE_MS)
  const stale = Number.isInteger(staleRaw) && staleRaw >= 2000 ? staleRaw : DEFAULT_CLAIM_STALE_MS
  const target = claimLockTarget(env)
  return async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 })
    try {
      writeFileSync(target, "", { flag: "wx", mode: 0o600 })
    } catch {
      // 已经在了,这是稳态。锁目标只需存在,内容没人读。
    }
    let release: (() => Promise<void>) | undefined
    try {
      release = await lock(target, { realpath: false, stale, update: Math.floor(stale / 4), retries: CLAIM_RETRIES })
    } catch {
      // 等满了还没拿到。调用方必须当成失败 —— 不在锁里租号正是这一切要防的那件事。
      return undefined
    }
    try {
      return await fn()
    } finally {
      await release().catch(() => {})
    }
  }
}

const CLAIMS_VERSION = 1

// 同步读写:它们在临界区里跑,而临界区越短越好。写用 temp → rename,与全仓其它落盘一致。
export function createClaimStore(env: NodeJS.ProcessEnv): ClaimStore {
  const path = claimsPath(env)
  return {
    read: () => {
      try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as { version?: number; claims?: unknown }
        if (raw.version !== CLAIMS_VERSION || !Array.isArray(raw.claims)) return []
        // 逐条形状检查:这个文件会被多个进程写,半条坏记录不该让整台机器起不来。
        return (raw.claims as Claim[]).filter(
          (c) =>
            typeof c?.accountId === "string" &&
            c.accountId.length > 0 &&
            Number.isInteger(c?.pid) &&
            Number.isFinite(c?.expiresAt),
        )
      } catch {
        // 文件不存在是常态(第一次跑);坏掉则当作空 —— 下一次写会把它修好。
        return []
      }
    },
    write: (claims) => {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
      const tmp = `${path}.tmp-${process.pid}`
      writeFileSync(tmp, JSON.stringify({ version: CLAIMS_VERSION, claims }, null, 2), { mode: 0o600 })
      renameSync(tmp, path)
    },
  }
}

export type ClaudeCodeConfig = { masterUrl: string; workerId: string }

// 钩子进程的依赖。与 createSessionDeps 分开,因为它们跑在【不同的进程】里:启动器起会话,钩子由
// Claude Code 在一轮对话失败时另行拉起,两者唯一的共同点是同一份 worker 配置和同一个 master。
export function createHookDeps(cfg: ClaudeCodeConfig, env: NodeJS.ProcessEnv): HookRunDeps {
  // 会话注进来的标签优先:那是【发出这次租约的】身份,而配置里的基名不是。对不上就等于给别人记账。
  const workerId = env[POOL_WORKER_VAR] ?? cfg.workerId
  const client = createLeaseClient({ fetchImpl: fetch, sleep, masterUrl: cfg.masterUrl, workerId })
  return {
    readStdin: async () => await new Response(process.stdin as unknown as ReadableStream).text(),
    reportRateLimit: (input) => client.reportRateLimit(input),
    accountId: env[POOL_ACCOUNT_VAR],
  }
}

export function createSessionDeps(
  cfg: ClaudeCodeConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
  maxSessions: number,
  poolArgs: Pick<PoolArgs, "accountPrefix" | "pin"> = {},
): SessionDeps {
  const pinStore = createPinStore(env)
  const client = createLeaseClient({ fetchImpl: fetch, sleep, masterUrl: cfg.masterUrl, workerId: cfg.workerId })
  return {
    // ATTEMPTS: 1, not the default ladder. An operator is sitting at a prompt waiting for a session to
    // start; leaseClient's 8-attempt backoff can spend minutes before it answers. Telling them the
    // master is down in five seconds is worth more than eventually succeeding after they gave up.
    // ATTEMPTS: 1 —— 操作者正坐在提示符前等会话起来,而 leaseClient 默认那条梯子要花几分钟才给出
    // 结论。更重要的是:这次请求跑在本机的声明锁【里面】,梯子会把这台机器上所有并发启动一起堵死。
    lease: () =>
      leaseWithClaim({
        withLock: createClaimLock(env),
        store: createClaimStore(env),
        lease: (input) => client.lease({ reason: "prelease", attempts: 1, ...input }),
        // 点名在临界区【里面】算:要点的那个是不是已被本机另一个会话占着,只有拿到活声明才知道。
        preferenceFor: (heldAccountIds) =>
          resolvePreference({
            cliPrefix: poolArgs.accountPrefix,
            cliPin: poolArgs.pin,
            storedPin: pinStore.read(),
            heldAccountIds,
          }),
        // master 明说不服务这个账号时交还钉住 —— 唯一允许放弃它的那条路径(与 src/worker/pin.ts 同规矩)。
        onPreferenceRefused: () => pinStore.write(undefined),
        maxSessions,
        pid: process.pid,
        // process.kill(pid, 0) 不发信号,只做存在性检查;拿不到权限(EPERM)说明进程确实在,算活着。
        isAlive: (pid) => {
          try {
            process.kill(pid, 0)
            return true
          } catch (error) {
            return (error as NodeJS.ErrnoException)?.code === "EPERM"
          }
        },
        now: Date.now,
      }),
    spawn: spawnChild(env.CLAUDE_BIN && env.CLAUDE_BIN.length > 0 ? env.CLAUDE_BIN : "claude"),
    env,
    readSettings: () => readSettings(env, cwd),
    // STDERR, never stdout: `claude -p` output is routinely piped into jq, and a friendly Chinese
    // sentence in that stream would corrupt a machine-readable result.
    notify: (line) => process.stderr.write(`${line}\n`),
    masterUrl: cfg.masterUrl,
    hookPath: resolveHookPath(),
    workerId: cfg.workerId,
  }
}
