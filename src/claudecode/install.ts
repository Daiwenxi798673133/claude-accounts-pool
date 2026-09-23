// COMPOSITION ROOT for the Claude Code lane — the one file that resolves the collaborators of
// session.ts (the launcher) and relay.ts (the relay process) against the real world: the real
// `fetch`, real child processes, the real settings files on disk, real timers.
//
// SCOPE: the launcher leases nothing itself — it asks the relay. The relay leases, renews and switches,
// but never refreshes: the master owns every chain (INV-CLOUD-1), so no token endpoint may ever be
// named anywhere in this directory.
import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { closeSync, existsSync, mkdirSync, openSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { constants as osConstants, homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { log } from "../logger.ts"
import { createLeaseClient } from "../worker/leaseClient.ts"
import type { PoolArgs } from "./args.ts"
import { relayLogPath, relayUrl, upstreamUrl, type ClaudeCodePoolConfig } from "./config.ts"
import { createPinStore } from "./pin.ts"
import type { RelayDeps } from "./relay.ts"
import { createRelayClient } from "./relayClient.ts"
import type { SessionDeps } from "./session.ts"
import { createSharedLease } from "./sharedLease.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// How often a live session re-confirms the relay, and how often the relay reaps dead sessions and
// renews ahead of need. Both well inside LEASE_RENEW_BUFFER_MS (5 min), so an approaching expiry is
// seen many times before it lands.
export const HEARTBEAT_MS = 15_000
export const RELAY_TICK_MS = 15_000

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
// wrapper — until the lines session.ts prints before handing over.
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

// The relay's entry file sits at the repo root, two levels up from here. Absolute, because the
// launcher's cwd is the operator's working directory, not this repository.
export function relayEntryPath(): string {
  const here = dirname(fileURLToPath(import.meta.url))
  return join(dirname(dirname(here)), "claude-pool-relay.ts")
}

// DETACHED and unref'd: the relay serves every session on this machine and must outlive the launcher
// that happened to start it. Its stdout/stderr go to the relay log, so a crash on startup (a syntax
// error after a bad pull, say) leaves a trace where relayFailureText tells the operator to look.
//
// The environment is passed whole: the relay resolves the same worker config the launcher did
// (CAP_LEASE_CACHE_DIR, CAP_CC_* overrides included), which is what keeps the two in agreement.
function spawnRelay(env: NodeJS.ProcessEnv): () => void {
  return () => {
    const logPath = relayLogPath(env)
    mkdirSync(dirname(logPath), { recursive: true, mode: 0o700 })
    const entry = relayEntryPath()
    if (!existsSync(entry)) {
      log.error("claudecode:relay-entry-missing", { entry })
      return
    }
    // Never throw out of here: a relay that could not be started is reported by the health poll that
    // follows (relayFailureText points at the log), not by a raw stack trace in the operator's terminal.
    let fd: number | undefined
    try {
      fd = openSync(logPath, "a", 0o600)
      const child = spawn(process.execPath, [entry], { env, detached: true, stdio: ["ignore", fd, fd] })
      child.on("error", (error) => log.error("claudecode:relay-spawn-fail", { error: error.message }))
      child.unref()
    } catch (error) {
      log.error("claudecode:relay-spawn-fail", { error: error instanceof Error ? error.message : String(error) })
    } finally {
      // The child holds its own copy of the descriptor; ours would otherwise stay open for the session.
      if (fd !== undefined) closeSync(fd)
    }
  }
}

export function createSessionDeps(
  cfg: ClaudeCodePoolConfig,
  env: NodeJS.ProcessEnv,
  cwd: string,
  poolArgs: Pick<PoolArgs, "accountPrefix" | "pin">,
): SessionDeps {
  const url = relayUrl(cfg.relayPort)
  return {
    relay: createRelayClient({ fetchImpl: fetch, baseUrl: url, spawnRelay: spawnRelay(env), sleep, now: Date.now }),
    relayUrl: url,
    relayPort: cfg.relayPort,
    relayLogPath: relayLogPath(env),
    spawn: spawnChild(env.CLAUDE_BIN && env.CLAUDE_BIN.length > 0 ? env.CLAUDE_BIN : "claude"),
    env,
    readSettings: () => readSettings(env, cwd),
    // STDERR, never stdout: `claude -p` output is routinely piped into jq, and a friendly Chinese
    // sentence in that stream would corrupt a machine-readable result.
    notify: (line) => process.stderr.write(`${line}\n`),
    masterUrl: cfg.masterUrl,
    workerId: cfg.workerId,
    pid: process.pid,
    preference: {
      ...(poolArgs.accountPrefix === undefined ? {} : { prefix: poolArgs.accountPrefix }),
      ...(poolArgs.pin === undefined ? {} : { pinned: poolArgs.pin }),
    },
    pin: createPinStore(env),
    heartbeat: (beat) => {
      // unref: the heartbeat must never be the thing keeping the launcher alive after its child exits.
      const timer = setInterval(() => void beat().catch(() => {}), HEARTBEAT_MS)
      timer.unref()
      return () => clearInterval(timer)
    },
  }
}

export function createRelayDeps(cfg: ClaudeCodePoolConfig, env: NodeJS.ProcessEnv): RelayDeps {
  const client = createLeaseClient({ fetchImpl: fetch, sleep, masterUrl: cfg.masterUrl, workerId: cfg.workerId })
  return {
    shared: createSharedLease({
      // ATTEMPTS: 1. Every lease here runs while a request (or a launcher) is waiting on it, and
      // leaseClient's default ladder can spend minutes before it answers. A fast failure becomes a 5xx
      // that claude retries on its own backoff — which bridges a master restart just as well, without
      // parking a request inside the relay's serial queue and everything queued behind it.
      lease: (input) => client.lease({ ...input, attempts: 1 }),
      reportRateLimit: (input) => client.reportRateLimit(input),
      pin: createPinStore(env),
      now: Date.now,
    }),
    fetchImpl: fetch,
    upstream: upstreamUrl(env),
    identity: { pid: process.pid, port: cfg.relayPort, workerId: cfg.workerId, masterUrl: cfg.masterUrl },
    // process.kill(pid, 0) sends nothing, it only checks existence; EPERM means the process is there.
    isAlive: (pid) => {
      try {
        process.kill(pid, 0)
        return true
      } catch (error) {
        return (error as NodeJS.ErrnoException)?.code === "EPERM"
      }
    },
    newRequestId: randomUUID,
    now: Date.now,
  }
}
