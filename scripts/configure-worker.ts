#!/usr/bin/env bun
// Configures THIS machine as a cloud-worker of the Claude account pool.
//
// It runs on a colleague's laptop that already has a working OpenCode setup, as the last
// step of the one-liner the dashboard hands out after minting a pool key. Destroying that
// setup is the only failure that matters here, so the whole script is arranged around it:
// nothing is rewritten, reordered or deduped, every write is preceded by a backup and a
// printed diff, and anything the script does not fully understand is a refusal with the
// JSON to paste by hand rather than a guess.

import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { parseArgs } from "node:util"
import {
  atomicWrite,
  backupFile,
  discoverConfig,
  EX_MACHINA_PLUGIN,
  isJsonObject,
  mergeOpencodeConfig,
  mergeTuiConfig,
  renderDiff,
  serializeConfig,
  type JsonObject,
  type MergeOutcome,
  type TuiEntry,
} from "./lib/workerConfig.ts"

const EXIT_USAGE = 2
const EXIT_REFUSED = 1

const USAGE = `Usage: bun run scripts/configure-worker.ts --master <url> --key <poolKey> --worker <label> [--dry-run]

Merges this machine into the Claude account pool as a cloud-worker, editing the OpenCode
config under $XDG_CONFIG_HOME/opencode (default ~/.config/opencode). Existing plugin
entries are left exactly as they are; re-running changes nothing.

  --master <url>    http(s) URL of the master, e.g. http://10.0.0.5:8787
  --key <poolKey>   the pool key the master issued for this machine
  --worker <label>  a label for this machine, written as workerId
  --dry-run         print the diff and write nothing`

type WorkerArgs = { masterUrl: string; poolKey: string; workerId: string; dryRun: boolean }
type Flags = { master?: string; key?: string; worker?: string; "dry-run"?: boolean }
type ArgsResult = { ok: true; args: WorkerArgs } | { ok: false; reason: string }
type LoadResult = { ok: true; config: JsonObject } | { ok: false; reason: string }
type ConfigSpec = { base: string; schema: string; merge: (config: JsonObject) => MergeOutcome }
type FilePlan = { path: string; before: string; after: string; existed: boolean; changed: boolean }
type PlanResult = { ok: true; plan: FilePlan } | { ok: false; reason: string }

function isHttpUrl(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  return url.protocol === "http:" || url.protocol === "https:"
}

function validateFlags(values: Flags): ArgsResult {
  const masterUrl = (values.master ?? "").trim()
  const poolKey = (values.key ?? "").trim()
  const workerId = (values.worker ?? "").trim()
  // Report every missing flag at once: the operator is pasting a command they were handed,
  // and discovering the three requirements one run at a time is its own bug report.
  const missing = [
    masterUrl.length === 0 ? "--master" : undefined,
    poolKey.length === 0 ? "--key" : undefined,
    workerId.length === 0 ? "--worker" : undefined,
  ].filter((flag) => flag !== undefined)
  if (missing.length > 0) return { ok: false, reason: `missing or empty: ${missing.join(", ")}` }
  if (!isHttpUrl(masterUrl)) {
    return { ok: false, reason: `--master must be an http(s) URL, got ${JSON.stringify(masterUrl)}` }
  }
  return { ok: true, args: { masterUrl, poolKey, workerId, dryRun: values["dry-run"] === true } }
}

function parseCliArgs(argv: string[]): ArgsResult {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        master: { type: "string" },
        key: { type: "string" },
        worker: { type: "string" },
        "dry-run": { type: "boolean", default: false },
      },
      allowPositionals: false,
    })
    return validateFlags(values)
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) }
  }
}

// Resolved from THIS file rather than from cwd: the install one-liner runs the script by
// absolute path from wherever the user happens to stand, and the JSON must end up pointing
// at the clone they just built — with no "~" left in it for OpenCode to choke on.
function builtPluginPath(): string {
  return join(dirname(dirname(fileURLToPath(import.meta.url))), "dist", "tui.js")
}

function opencodeConfigDir(): string {
  const xdg = process.env["XDG_CONFIG_HOME"]
  const root = xdg !== undefined && xdg.length > 0 ? xdg : join(homedir(), ".config")
  return join(root, "opencode")
}

function readConfigObject(path: string, text: string): LoadResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, reason: `${path} does not parse as JSON (${detail}); comments are not supported` }
  }
  if (!isJsonObject(parsed)) return { ok: false, reason: `${path} does not parse as a JSON object` }
  return { ok: true, config: parsed }
}

async function planFile(dir: string, spec: ConfigSpec): Promise<PlanResult> {
  const found = discoverConfig(dir, spec.base)
  if (found.kind === "conflict") return { ok: false, reason: found.reason }
  const existed = found.kind === "existing"
  const before = existed ? await readFile(found.path, "utf8") : ""
  const loaded: LoadResult = existed
    ? readConfigObject(found.path, before)
    : { ok: true, config: { $schema: spec.schema } }
  if (!loaded.ok) return loaded
  const merged = spec.merge(loaded.config)
  if (!merged.ok) return { ok: false, reason: `${found.path}: ${merged.reason}` }
  const after = serializeConfig(merged.config)
  // Compared in CANONICAL form, not against the raw text: a file that already says what we
  // need is left alone byte for byte, so nobody's hand formatting is "fixed" for them and a
  // re-run is a no-op whatever indent style they use.
  const changed = serializeConfig(loaded.config) !== after
  return { ok: true, plan: { path: found.path, before, after, existed, changed } }
}

function manualInstructions(dir: string, entry: TuiEntry): string {
  const tuple = JSON.stringify(entry, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n")
  return [
    "Nothing was written. To do it by hand:",
    "",
    `  ${join(dir, "opencode.json")}  ->  "plugin" must contain`,
    `    ${JSON.stringify(EX_MACHINA_PLUGIN)}`,
    "",
    `  ${join(dir, "tui.json")}  ->  "plugin" must contain`,
    tuple,
  ].join("\n")
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseCliArgs(argv)
  if (!parsed.ok) {
    process.stderr.write(`${parsed.reason}\n\n${USAGE}\n`)
    return EXIT_USAGE
  }
  const { masterUrl, poolKey, workerId, dryRun } = parsed.args
  const dir = opencodeConfigDir()
  // The field names are the ones src/mode.ts parses; anything else parses as `invalid`
  // and the plugin then installs nothing at all.
  const entry: TuiEntry = [builtPluginPath(), { mode: "cloud-worker", masterUrl, poolKey, workerId }]

  const plans: FilePlan[] = []
  const refusals: string[] = []
  for (const spec of [
    { base: "opencode", schema: "https://opencode.ai/config.json", merge: mergeOpencodeConfig },
    { base: "tui", schema: "https://opencode.ai/tui.json", merge: (config: JsonObject) => mergeTuiConfig(config, entry) },
  ]) {
    const result = await planFile(dir, spec)
    if (result.ok) plans.push(result.plan)
    else refusals.push(result.reason)
  }

  // Both files are planned before either is written: a machine half-joined to the pool is
  // worse than one that never started, and the operator gets every problem in one pass.
  if (refusals.length > 0) {
    for (const reason of refusals) process.stderr.write(`refusing: ${reason}\n`)
    process.stderr.write(`\n${manualInstructions(dir, entry)}\n`)
    return EXIT_REFUSED
  }

  const changes = plans.filter((plan) => plan.changed)
  if (changes.length === 0) {
    process.stdout.write(`already configured as cloud-worker "${workerId}"; nothing to change\n`)
    return 0
  }
  for (const change of changes) process.stdout.write(`${renderDiff(change.path, change.before, change.after)}\n\n`)
  if (dryRun) {
    process.stdout.write("--dry-run: nothing written, no backup taken\n")
    return 0
  }

  const now = new Date()
  for (const change of changes) {
    if (change.existed) process.stdout.write(`backed up  ${await backupFile(change.path, now)}\n`)
    await atomicWrite(change.path, change.after)
    process.stdout.write(`wrote      ${change.path}\n`)
  }
  process.stdout.write(`\nDone. Fully quit and reopen OpenCode so the plugin reloads.\n`)
  return 0
}

const code = await main(process.argv.slice(2))
// Only bail out explicitly on failure; returning from main lets stdout flush on its own.
if (code !== 0) process.exit(code)
