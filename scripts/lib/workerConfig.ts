// Pure config surgery for scripts/configure-worker.ts. Everything here operates on values
// the caller already read; only the last three functions touch the filesystem, and they are
// the write path the CLI funnels through.
//
// The governing rule of this module: the machine it runs on already has a WORKING OpenCode
// setup that somebody else wrote. Every function below is allowed to add exactly what the
// pool needs and is forbidden from normalising, deduping or reordering anything else.

import { existsSync } from "node:fs"
import { copyFile, mkdir, rename, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

export type JsonObject = Record<string, unknown>
export type TuiEntry = [string, JsonObject]
export type MergeOutcome = { ok: true; config: JsonObject } | { ok: false; reason: string }
export type Discovery =
  | { kind: "existing"; path: string }
  | { kind: "create"; path: string }
  | { kind: "conflict"; reason: string }

export const EX_MACHINA_PLUGIN = "@ex-machina/opencode-anthropic-auth"

const LEGACY_MARKER = "claude-accounts-usage"
const POOL_MARKER = "claude-accounts-pool"
const BUILT_SUFFIXES = ["dist/tui.js", "tui.tsx"]
const JSON_INDENT = 2
const DIFF_CONTEXT = 2

export const REFUSAL_NOT_ARRAY = `"plugin" exists but is not an array`
export const REFUSAL_LEGACY =
  `an entry for the old package "${LEGACY_MARKER}" is installed; ` +
  "the two plugins must never run side by side, so a human has to decide which one to drop"

export function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// "@scope/name@1.2.3" -> "@scope/name". lastIndexOf, never split("@"): a scoped package
// name STARTS with "@", so split("@")[0] is the empty string and matches everything.
export function stripVersionSpec(spec: string): string {
  const at = spec.lastIndexOf("@")
  return at > 0 ? spec.slice(0, at) : spec
}

// A plugin entry is either "pkg" or ["path", options]; both carry the path in slot 0.
// Anything else is somebody else's business and stays unread.
export function entryPath(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0]
  return undefined
}

export function isLegacyEntry(entry: unknown): boolean {
  return entryPath(entry)?.includes(LEGACY_MARKER) ?? false
}

// Ours by SHAPE, never by path equality: the clone moves between machines, and the user may
// point at the built dist/tui.js or straight at the tui.tsx source.
export function isOurTuiEntry(entry: unknown): boolean {
  const path = entryPath(entry)
  if (path === undefined) return false
  const named = path.includes(POOL_MARKER) || path.includes(LEGACY_MARKER)
  return named && BUILT_SUFFIXES.some((suffix) => path.endsWith(suffix))
}

// Missing `plugin` is legal (a config may only carry mcp/theme), an absent array is just an
// empty one. A `plugin` of any other type means we do not understand this file and must not
// guess. The legacy check lives here so BOTH config files inherit it for free.
function readPluginList(config: JsonObject): { ok: true; list: unknown[] } | { ok: false; reason: string } {
  const raw = config["plugin"]
  if (raw === undefined) return { ok: true, list: [] }
  if (!Array.isArray(raw)) return { ok: false, reason: REFUSAL_NOT_ARRAY }
  if (raw.some(isLegacyEntry)) return { ok: false, reason: REFUSAL_LEGACY }
  return { ok: true, list: raw }
}

// Spreading the config keeps `plugin` at its original key position (and every sibling key
// untouched), so a merge that changes nothing serialises back byte-identical.
function withPlugins(config: JsonObject, plugin: unknown[]): JsonObject {
  return { ...config, plugin }
}

export function mergeOpencodeConfig(config: JsonObject): MergeOutcome {
  const plugins = readPluginList(config)
  if (!plugins.ok) return plugins
  // Present in ANY form wins. Rewriting somebody's deliberate version pin is not this
  // script's business, and appending a second unpinned copy would load the plugin twice.
  const present = plugins.list.some((entry) => {
    const path = entryPath(entry)
    return path !== undefined && stripVersionSpec(path) === EX_MACHINA_PLUGIN
  })
  if (present) return { ok: true, config }
  return { ok: true, config: withPlugins(config, [...plugins.list, EX_MACHINA_PLUGIN]) }
}

export function mergeTuiConfig(config: JsonObject, entry: TuiEntry): MergeOutcome {
  const plugins = readPluginList(config)
  if (!plugins.ok) return plugins
  const index = plugins.list.findIndex(isOurTuiEntry)
  const list = [...plugins.list]
  // Replace IN PLACE: plugin load order is observable, and the neighbours (including the
  // same package listed twice at two versions) must keep the indices their owner gave them.
  if (index < 0) list.push(entry)
  else list[index] = entry
  return { ok: true, config: withPlugins(config, list) }
}

// .jsonc first, because that is what the file OpenCode actually ships is named. Creating a
// second file next to an existing one would leave the machine with two configs and no way
// to know which one won, so a pair is a refusal rather than a choice.
export function discoverConfig(dir: string, base: string): Discovery {
  const jsonc = join(dir, `${base}.jsonc`)
  const json = join(dir, `${base}.json`)
  const hasJsonc = existsSync(jsonc)
  const hasJson = existsSync(json)
  if (hasJsonc && hasJson) return { kind: "conflict", reason: `both ${jsonc} and ${json} exist; keep exactly one` }
  if (hasJsonc) return { kind: "existing", path: jsonc }
  if (hasJson) return { kind: "existing", path: json }
  return { kind: "create", path: json }
}

export function serializeConfig(config: JsonObject): string {
  return `${JSON.stringify(config, null, JSON_INDENT)}\n`
}

// Trims the shared head and tail so the reader sees the entry that moved, not the whole
// file. Returns "" when there is nothing to show — the caller uses that as "no change".
export function renderDiff(label: string, before: string, after: string): string {
  if (before === after) return ""
  const old = before.length > 0 ? before.split("\n") : []
  const next = after.split("\n")
  let head = 0
  while (head < old.length && head < next.length && old[head] === next[head]) head += 1
  let tail = 0
  while (
    tail < old.length - head &&
    tail < next.length - head &&
    old[old.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1
  }
  const lines = [`--- ${label}`]
  for (const line of old.slice(Math.max(0, head - DIFF_CONTEXT), head)) lines.push(`  ${line}`)
  for (const line of old.slice(head, old.length - tail)) lines.push(`- ${line}`)
  for (const line of next.slice(head, next.length - tail)) lines.push(`+ ${line}`)
  for (const line of next.slice(next.length - tail, next.length - tail + DIFF_CONTEXT)) lines.push(`  ${line}`)
  return lines.join("\n")
}

export function backupPath(path: string, now: Date): string {
  return `${path}.bak-${now.toISOString().replace(/[:.]/g, "-")}`
}

export async function backupFile(path: string, now: Date): Promise<string> {
  const target = backupPath(path, now)
  await copyFile(path, target)
  return target
}

// Same idiom as src/accounts.ts atomicWriteJson: write a sibling temp file, then rename over
// the target. A crash mid-write leaves the previous config intact instead of a truncated one.
export async function atomicWrite(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, text, { mode: 0o600 })
  await rename(tmp, path)
}
