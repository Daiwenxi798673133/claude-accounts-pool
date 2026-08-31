import type { PluginOptions } from "@opencode-ai/plugin"
import type { AccountsScope } from "./accounts.ts"

export type ModeConfig =
  | { mode: "local" }
  | { mode: "cloud-master"; hostname: string; port: number }
  | { mode: "cloud-worker"; masterUrl: string; workerId: string }
  | { mode: "invalid"; reason: string }

// Which account library each mode owns. A Record for the same reason PARSERS below is one: a variant
// added to ModeConfig is a COMPILE error here until someone decides which file it writes, and
// "silently shares the local store" is the one answer that costs an account (INV-CLOUD-1).
export const ACCOUNTS_SCOPE: Record<ModeConfig["mode"], AccountsScope> = {
  local: "shared",
  // The master's pool IS the shared file, so a suffix here would orphan every account in it.
  "cloud-master": "shared",
  // The one mode that must not touch a local install's store: it records only which account it
  // leased, while the local store holds real refresh tokens the master alone may rotate.
  "cloud-worker": "cloud-worker",
  // Nothing is installed for `invalid` and no I/O follows, but a total table has no holes.
  invalid: "shared",
}

// Everything a user may WRITE in tui.json. `invalid` is a parse RESULT, never an input,
// so it is excluded here — that is also what makes the table below total: adding a variant
// to ModeConfig turns PARSERS into a compile error until someone decides how it parses.
type DeclaredMode = Exclude<ModeConfig["mode"], "invalid">

// Loopback, not 0.0.0.0: this port hands out live access tokens, so an operator who forgot
// to state a hostname gets the choice that cannot leak, and must opt IN to a wider bind.
const DEFAULT_MASTER_HOSTNAME = "127.0.0.1"

const MIN_PORT = 1
const MAX_PORT = 65535

function readNonEmptyString(options: PluginOptions, key: string): string | undefined {
  const value = options[key]
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === "http:" || url.protocol === "https:"
}

function parseCloudMaster(options: PluginOptions): ModeConfig {
  const port = options["port"]
  if (typeof port !== "number" || !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) {
    return {
      mode: "invalid",
      reason: `cloud-master needs field "port" to be an integer in ${MIN_PORT}..${MAX_PORT}, got ${JSON.stringify(port)}`,
    }
  }
  const hostname = options["hostname"] === undefined ? DEFAULT_MASTER_HOSTNAME : readNonEmptyString(options, "hostname")
  if (hostname === undefined) {
    return {
      mode: "invalid",
      reason: `cloud-master needs field "hostname" to be a non-empty string, got ${JSON.stringify(options["hostname"])}`,
    }
  }
  return { mode: "cloud-master", hostname, port }
}

function parseCloudWorker(options: PluginOptions): ModeConfig {
  const masterUrl = readNonEmptyString(options, "masterUrl")
  const workerId = readNonEmptyString(options, "workerId")
  if (masterUrl !== undefined && isHttpUrl(masterUrl) && workerId !== undefined) {
    return { mode: "cloud-worker", masterUrl, workerId }
  }
  // Every offending field at once, not just the first: a worker restart is expensive enough
  // that discovering the requirements one round-trip at a time is its own bug report.
  const bad: string[] = []
  if (masterUrl === undefined || !isHttpUrl(masterUrl)) bad.push(`"masterUrl" (non-empty http(s) URL)`)
  if (workerId === undefined) bad.push(`"workerId" (non-empty string)`)
  return { mode: "invalid", reason: `cloud-worker needs ${bad.join(", ")}` }
}

const PARSERS: Record<DeclaredMode, (options: PluginOptions) => ModeConfig> = {
  local: () => ({ mode: "local" }),
  "cloud-master": parseCloudMaster,
  "cloud-worker": parseCloudWorker,
}

const DECLARED_MODES = Object.keys(PARSERS) as DeclaredMode[]

function isDeclaredMode(value: string): value is DeclaredMode {
  return Object.hasOwn(PARSERS, value)
}

// The ONE boundary where tui.json's untyped plugin options become a typed value. Callers
// receive an already-decided union and must never re-read `options` themselves.
export function parseMode(options: PluginOptions | undefined): ModeConfig {
  if (options === undefined) return { mode: "local" }
  const raw = options["mode"]
  if (raw === undefined) return { mode: "local" }
  if (typeof raw === "string" && isDeclaredMode(raw)) return PARSERS[raw](options)
  return {
    mode: "invalid",
    reason: `unknown mode ${JSON.stringify(raw)}; expected one of ${DECLARED_MODES.join(", ")}`,
  }
}
