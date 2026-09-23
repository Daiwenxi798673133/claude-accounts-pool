// Pure logic for scripts/cc-takeover.ts (make setup / make revert): what to add to someone's machine
// so that EVERY Claude Code process goes through the account pool, and how to take exactly that back.
//
// The governing rule is the same as scripts/lib/workerConfig.ts: the machine already has a WORKING
// Claude Code that somebody else configured. Setup adds what the pool needs and nothing else; revert
// removes what setup added and nothing else. A file the user edited afterwards keeps their edits —
// revert works surgically (remove our key, remove our marked block), never by restoring a whole-file
// snapshot over their later changes.
import { isWorkerLabel } from "../../src/cloud/protocol.ts"
import { isJsonObject, type JsonObject } from "./workerConfig.ts"

export const RELAY_AGENT_LABEL = "com.claude-accounts-pool.relay"
// The official launcher contract (code.claude.com/docs/en/corporate-launcher): every process Claude
// Code starts from its own binary runs as `<launcher> <claude binary> <args…>`. Set in the settings
// `env` block, which the docs require so the detached background service inherits it.
export const WRAPPER_VAR = "CLAUDE_CODE_PROCESS_WRAPPER"
// The same launcher as a named settings key (v2.1.210+). Setup never writes it, but one already set
// by someone else means a launcher is in place that ours must not silently stack on or replace.
export const WRAPPER_KEY = "processWrapper"
// CLAUDE_CODE_PROCESS_WRAPPER requires v2.1.208 (docs); earlier versions ignore it and would leave
// background sessions on the operator's own login while the terminal ones use the pool.
export const MIN_CLAUDE_VERSION = "2.1.208"

export const SHELL_BLOCK_BEGIN = "# >>> claude-accounts-pool (make setup) >>>"
export const SHELL_BLOCK_END = "# <<< claude-accounts-pool (make setup) <<<"

export type Result<T> = ({ ok: true } & T) | { ok: false; reason: string }

// ── inputs ────────────────────────────────────────────────────────────────────────────────────

/** "10.0.0.5:8787" → "http://10.0.0.5:8787". A scheme the user typed is kept; a trailing slash is not. */
export function normalizeMasterUrl(input: string): Result<{ url: string }> {
  const trimmed = input.trim()
  if (trimmed.length === 0) return { ok: false, reason: "master 地址不能为空" }
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { ok: false, reason: `「${trimmed}」不是合法的地址,要的是 ip:port,比如 100.64.0.36:8787` }
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: `只支持 http / https,收到的是 ${url.protocol}` }
  }
  if (url.hostname.length === 0) return { ok: false, reason: `「${trimmed}」里没有主机名` }
  // Path/query are meaningless for the master (routes are absolute) and would break every URL the
  // clients build from it.
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") {
    return { ok: false, reason: `只要 ip:port,不要路径:「${trimmed}」` }
  }
  return { ok: true, url: `${url.protocol}//${url.host}` }
}

export function validateWorkerId(input: string): Result<{ id: string }> {
  const id = input.trim()
  if (!isWorkerLabel(id)) {
    return { ok: false, reason: `WorkerID 只能用字母、数字、点、下划线、连字符,1–64 个字符:「${id}」` }
  }
  return { ok: true, id }
}

/** "2.1.280 (Claude Code)" → "2.1.280". */
export function parseClaudeVersion(text: string): string | undefined {
  return text.match(/(\d+\.\d+\.\d+)/)?.[1]
}

export function versionAtLeast(version: string, min: string): boolean {
  const a = version.split(".").map(Number)
  const b = min.split(".").map(Number)
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return true
}

/**
 * The value Claude Code parses as an argument list: whitespace separates tokens and there is no
 * shell expansion. A path with whitespace in it goes in the JSON-array form the docs define, since
 * a bare path would split into two tokens.
 */
export function wrapperValue(launcherPath: string): string {
  return /\s/.test(launcherPath) ? JSON.stringify([launcherPath]) : launcherPath
}

// ── ~/.claude/settings.json ──────────────────────────────────────────────────────────────────

export type SettingsAdd = Result<{ config: JsonObject; createdEnv: boolean; changed: boolean }>

export function addWrapper(settings: JsonObject, value: string): SettingsAdd {
  const env = settings.env
  if (env !== undefined && !isJsonObject(env)) return { ok: false, reason: `"env" 存在但不是对象` }
  const existing = env?.[WRAPPER_VAR]
  if (existing !== undefined && existing !== value) {
    return { ok: false, reason: `env.${WRAPPER_VAR} 已经被设成别的启动器(${JSON.stringify(existing)}),两个启动器不能叠加` }
  }
  const named = settings[WRAPPER_KEY]
  if (named !== undefined && named !== value) {
    return { ok: false, reason: `"${WRAPPER_KEY}" 已经被设成别的启动器(${JSON.stringify(named)}),两个启动器不能叠加` }
  }
  if (existing === value) return { ok: true, config: settings, createdEnv: false, changed: false }
  // Spread, never mutate: the caller compares before/after to decide whether to write at all.
  return {
    ok: true,
    config: { ...settings, env: { ...(env ?? {}), [WRAPPER_VAR]: value } },
    createdEnv: env === undefined,
    changed: true,
  }
}

/** Removes OUR value only. An env block setup created and that is now empty goes too. */
export function removeWrapper(settings: JsonObject, value: string, createdEnv: boolean): { config: JsonObject; changed: boolean } {
  const env = settings.env
  if (!isJsonObject(env) || env[WRAPPER_VAR] !== value) return { config: settings, changed: false }
  const { [WRAPPER_VAR]: _ours, ...rest } = env
  const next: JsonObject = { ...settings, env: rest }
  if (createdEnv && Object.keys(rest).length === 0) delete next.env
  return { config: next, changed: true }
}

// ── shell rc: PATH so a hand-typed `claude` reaches the launcher ─────────────────────────────

// The docs' own recipe for terminal sessions: "put a script named claude in a directory earlier on
// PATH that runs your launcher with the real binary; don't replace the managed symlink."
export function shellBlock(binDir: string): string {
  return [
    SHELL_BLOCK_BEGIN,
    "# 让终端里手敲的 claude 先经过账号池的启动器。make revert 会删掉这一段。",
    `export PATH="${binDir.replace(/(["\\$`])/g, "\\$1")}:$PATH"`,
    SHELL_BLOCK_END,
  ].join("\n")
}

function blockRange(text: string): { start: number; end: number } | undefined {
  const start = text.indexOf(SHELL_BLOCK_BEGIN)
  if (start === -1) return undefined
  const endMarker = text.indexOf(SHELL_BLOCK_END, start)
  if (endMarker === -1) return undefined
  return { start, end: endMarker + SHELL_BLOCK_END.length }
}

/**
 * APPENDED at the very end, not inserted: PATH entries prepended later in the file win, so a block
 * anywhere but last could be shadowed by a later `export PATH="$HOME/.local/bin:$PATH"`. An existing
 * block is replaced in place (a re-run), never duplicated.
 */
export function addShellBlock(text: string, block: string): { text: string; changed: boolean } {
  const range = blockRange(text)
  if (range !== undefined) {
    const next = text.slice(0, range.start) + block + text.slice(range.end)
    return { text: next, changed: next !== text }
  }
  const sep = text.length === 0 ? "" : text.endsWith("\n") ? "\n" : "\n\n"
  return { text: `${text}${sep}${block}\n`, changed: true }
}

export function removeShellBlock(text: string): { text: string; changed: boolean } {
  const range = blockRange(text)
  if (range === undefined) return { text, changed: false }
  let start = range.start
  let end = range.end
  // Take back the separator addShellBlock put around it, and nothing more.
  if (text[end] === "\n") end++
  if (start >= 2 && text.slice(start - 2, start) === "\n\n") start--
  return { text: text.slice(0, start) + text.slice(end), changed: true }
}

// ── ~/.claude-accounts-pool/senpi-worker.json ─────────────────────────────────────────────────

// The file is shared with the senpi lane: `workerId` is senpi's label, `ccWorkerId` is this lane's.
// Setup sets ccWorkerId to exactly what the operator typed — that is the name they will look for on
// the dashboard — and leaves an existing senpi label alone.
export function mergeWorker(existing: JsonObject | undefined, masterUrl: string, workerId: string): { next: JsonObject; changed: boolean } {
  const base: JsonObject = existing ?? { version: 1 }
  const senpiId = typeof base.workerId === "string" && isWorkerLabel(base.workerId) ? base.workerId : workerId
  const next: JsonObject = { ...base, version: 1, masterUrl, workerId: senpiId, ccWorkerId: workerId }
  return { next, changed: existing === undefined || JSON.stringify(existing) !== JSON.stringify(next) }
}

export type WorkerRecord = { path: string; created: boolean; before?: JsonObject; after: JsonObject }

/**
 * Put the file back as it was — but only if it is still what setup wrote. Someone who re-pointed the
 * worker by hand since then made a newer decision than the one we would restore.
 */
export function revertWorker(current: JsonObject | undefined, record: WorkerRecord): { action: "delete" } | { action: "write"; next: JsonObject } | { action: "keep"; reason: string } {
  if (current === undefined) return { action: "keep", reason: "文件已经不在了" }
  if (JSON.stringify(current) !== JSON.stringify(record.after)) return { action: "keep", reason: "setup 之后被改过,保留现状" }
  if (record.created) return { action: "delete" }
  return record.before === undefined ? { action: "keep", reason: "清单里没有原内容" } : { action: "write", next: record.before }
}

// ── generated files ───────────────────────────────────────────────────────────────────────────

const sq = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`

export type LauncherPaths = { bun: string; repo: string; manifest: string }

/**
 * The launcher itself. Two exits that are NOT the pool, both deliberate:
 *   · the manifest is gone — make revert ran. Sessions and the background service started before
 *     the revert still point here until they restart; they must get plain Claude Code, not a pool
 *     the operator just removed.
 *   · the clone is gone — the operator deleted the repository. Same intent.
 * Everything else goes through claude-pool-env.ts, which refuses loudly rather than fall back to the
 * operator's own account.
 */
export function renderLauncher(p: LauncherPaths): string {
  return `#!/bin/sh
# 账号池的 Claude Code 启动器 —— make setup 生成。官方启动器契约(CLAUDE_CODE_PROCESS_WRAPPER):
# 注入池子租约后 exec "$@"。make revert 之后它退化成原样 exec(见下面的条件),可以安全地留着。
if [ -f ${sq(p.manifest)} ] && [ -f ${sq(`${p.repo}/claude-pool-env.ts`)} ]; then
  pool_env=$(${sq(p.bun)} ${sq(`${p.repo}/claude-pool-env.ts`)} "$$") || exit $?
  eval "$pool_env"
fi
exec "$@"
`
}

/** A script named `claude`, earlier on PATH than the real one. Never a replacement for the managed symlink. */
export function renderClaudeShim(p: { launcher: string; realClaude: string }): string {
  return `#!/bin/sh
# 终端里手敲的 claude 经由账号池的启动器 —— make setup 生成,make revert 删除。
# 官方文档对终端会话的建议做法:PATH 前面放一个名为 claude 的脚本,不替换官方 symlink。
exec ${sq(p.launcher)} ${sq(p.realClaude)} "$@"
`
}

export function renderClaudePoolCmd(p: { bun: string; repo: string }): string {
  return `#!/bin/sh
# claude-pool(点名 / 钉住账号)—— make setup 生成,make revert 删除。
exec ${sq(p.bun)} ${sq(`${p.repo}/claude-pool.ts`)} "$@"
`
}

const xml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export type PlistInput = { bun: string; repo: string; home: string; logPath: string; path: string; extraEnv: Record<string, string> }

// KeepAlive: a relay that crashes mid-session would otherwise leave every open session without a
// route to Anthropic until something restarted it. CAP_CC_RELAY_RESIDENT stops the idle exit, which
// under KeepAlive would only become a restart every ten minutes.
export function renderPlist(p: PlistInput): string {
  const env: Record<string, string> = { HOME: p.home, PATH: p.path, CAP_CC_RELAY_RESIDENT: "1", ...p.extraEnv }
  const envXml = Object.entries(env)
    .map(([k, v]) => `      <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n")
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key><string>${RELAY_AGENT_LABEL}</string>
    <key>ProgramArguments</key>
    <array>
      <string>${xml(p.bun)}</string>
      <string>${xml(`${p.repo}/claude-pool-relay.ts`)}</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
${envXml}
    </dict>
    <key>RunAtLoad</key><true/>
    <key>KeepAlive</key><true/>
    <key>ThrottleInterval</key><integer>10</integer>
    <key>StandardOutPath</key><string>${xml(p.logPath)}</string>
    <key>StandardErrorPath</key><string>${xml(p.logPath)}</string>
  </dict>
</plist>
`
}

// Proxies the operator's shell has and launchd would not: a relay that cannot reach api.anthropic.com
// through the corporate proxy fails every request.
export const PROXY_VARS = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy", "NO_PROXY", "no_proxy"]

export function proxyEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {}
  for (const name of PROXY_VARS) {
    const value = env[name]
    if (typeof value === "string" && value.length > 0) out[name] = value
  }
  return out
}

// ── manifest ──────────────────────────────────────────────────────────────────────────────────

export type TakeoverManifest = {
  version: 1
  installedAt: string
  updatedAt: string
  repo: string
  settings?: { path: string; value: string; createdEnv: boolean }
  shellRc?: { path: string }
  // Files setup created. The launcher is listed separately: revert leaves it (it is a passthrough
  // once the manifest is gone, and processes started before the revert still point at it).
  generated: string[]
  launcher?: string
  launchAgent?: { path: string; label: string }
  worker?: WorkerRecord
}

export function emptyManifest(repo: string, now: Date): TakeoverManifest {
  return { version: 1, installedAt: now.toISOString(), updatedAt: now.toISOString(), repo, generated: [] }
}

export function parseManifest(raw: unknown): TakeoverManifest | undefined {
  if (!isJsonObject(raw) || raw.version !== 1 || typeof raw.repo !== "string" || !Array.isArray(raw.generated)) return undefined
  return raw as unknown as TakeoverManifest
}
