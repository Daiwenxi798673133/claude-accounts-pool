// COMPOSITION ROOT for the Claude Code lane — the one file that resolves session.ts's collaborators
// against the real world: the real `fetch`, a real child process, the real settings files on disk.
//
// SCOPE: this lane leases and launches. It runs no keeper, no autoswitch and no refresher, because a
// pooled `claude` session has nothing to renew (its credential is frozen at startup, issue #83) and
// nothing to refresh (the master owns every chain — INV-CLOUD-1). If a future edit adds a timer here,
// that is the signal something has been misunderstood.
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { constants as osConstants, homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { log } from "../logger.ts"
import { createLeaseClient } from "../worker/leaseClient.ts"
import type { HookRunDeps } from "./hookRun.ts"
import type { SessionDeps } from "./session.ts"
import { POOL_ACCOUNT_VAR } from "./childEnv.ts"

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

export type ClaudeCodeConfig = { masterUrl: string; workerId: string }

// 钩子进程的依赖。与 createSessionDeps 分开,因为它们跑在【不同的进程】里:启动器起会话,钩子由
// Claude Code 在一轮对话失败时另行拉起,两者唯一的共同点是同一份 worker 配置和同一个 master。
export function createHookDeps(cfg: ClaudeCodeConfig, env: NodeJS.ProcessEnv): HookRunDeps {
  const client = createLeaseClient({ fetchImpl: fetch, sleep, masterUrl: cfg.masterUrl, workerId: cfg.workerId })
  return {
    readStdin: async () => await new Response(process.stdin as unknown as ReadableStream).text(),
    reportRateLimit: (input) => client.reportRateLimit(input),
    accountId: env[POOL_ACCOUNT_VAR],
  }
}

export function createSessionDeps(cfg: ClaudeCodeConfig, env: NodeJS.ProcessEnv, cwd: string): SessionDeps {
  const client = createLeaseClient({ fetchImpl: fetch, sleep, masterUrl: cfg.masterUrl, workerId: cfg.workerId })
  return {
    // ATTEMPTS: 1, not the default ladder. An operator is sitting at a prompt waiting for a session to
    // start; leaseClient's 8-attempt backoff can spend minutes before it answers. Telling them the
    // master is down in five seconds is worth more than eventually succeeding after they gave up.
    lease: () => client.lease({ reason: "prelease", attempts: 1 }),
    spawn: spawnChild(env.CLAUDE_BIN && env.CLAUDE_BIN.length > 0 ? env.CLAUDE_BIN : "claude"),
    env,
    readSettings: () => readSettings(env, cwd),
    // STDERR, never stdout: `claude -p` output is routinely piped into jq, and a friendly Chinese
    // sentence in that stream would corrupt a machine-readable result.
    notify: (line) => process.stderr.write(`${line}\n`),
    masterUrl: cfg.masterUrl,
    hookPath: resolveHookPath(),
  }
}
