import { afterAll, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { parseMode } from "../src/mode.ts"
import {
  discoverConfig,
  isJsonObject,
  isOurTuiEntry,
  mergeOpencodeConfig,
  mergeTuiConfig,
  stripVersionSpec,
  type JsonObject,
} from "./lib/workerConfig.ts"

const CLI = join(import.meta.dir, "configure-worker.ts")
const REPO_ROOT = dirname(import.meta.dir)
const EXPECTED_PLUGIN_PATH = join(REPO_ROOT, "dist", "tui.js")

const MASTER = "http://10.0.0.5:8787"
const LABEL = "laptop-1"
const ARGS = ["--master", MASTER, "--worker", LABEL]

// Byte-exact replica of the verified real machine: .jsonc (not .json), a version-pinned
// ex-machina entry, and an unrelated mcp block that must survive untouched.
const REAL_OPENCODE_JSONC = `{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "oh-my-openagent@4.19.3",
    "@ex-machina/opencode-anthropic-auth@1.8.1",
    "@warp-dot-dev/opencode-warp"
  ],
  "mcp": {
    "codegraph": {
      "type": "local",
      "command": ["codegraph", "serve", "--mcp"],
      "enabled": true
    }
  }
}
`

// Same package listed twice at two versions, with our tuple wedged between them at index 1
// — the duplicate is none of our business and must come out in the same order.
const REAL_TUI_JSON = `{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "oh-my-openagent@4.19.0",
    [
      "/Users/someone/elsewhere/claude-accounts-pool/dist/tui.js",
      {
        "mode": "cloud-worker",
        "masterUrl": "http://127.0.0.1:1",
        "poolKey": "STALE_KEY",
        "workerId": "stale-label"
      }
    ],
    "oh-my-openagent@4.19.3"
  ]
}
`

const sandboxes: string[] = []

afterAll(() => {
  for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true })
})

/** A fake XDG_CONFIG_HOME. The real ~/.config is never read or written by these tests. */
function sandbox(files: Record<string, string>): string {
  const home = mkdtempSync(join(tmpdir(), "configure-worker-"))
  sandboxes.push(home)
  mkdirSync(join(home, "opencode"), { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(home, "opencode", name), content)
  return home
}

type CliRun = { code: number; stdout: string; stderr: string }

async function runCli(home: string, args: string[] = ARGS): Promise<CliRun> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    env: { ...process.env, XDG_CONFIG_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  return { code: await proc.exited, stdout, stderr }
}

function readText(home: string, name: string): string {
  return readFileSync(join(home, "opencode", name), "utf8")
}

function readConfig(home: string, name: string): JsonObject {
  const parsed: unknown = JSON.parse(readText(home, name))
  if (!isJsonObject(parsed)) throw new Error(`${name} is not a JSON object`)
  return parsed
}

function plugins(home: string, name: string): unknown[] {
  const list = readConfig(home, name)["plugin"]
  if (!Array.isArray(list)) throw new Error(`${name} has no plugin array`)
  return list
}

function backups(home: string): string[] {
  return readdirSync(join(home, "opencode")).filter((name) => name.includes(".bak-"))
}

const expectedEntry = [EXPECTED_PLUGIN_PATH, { mode: "cloud-worker", masterUrl: MASTER, workerId: LABEL }]

test("the real machine survives: pins, duplicates and unrelated blocks come out verbatim", async () => {
  const home = sandbox({ "opencode.jsonc": REAL_OPENCODE_JSONC, "tui.json": REAL_TUI_JSON })

  const run = await runCli(home)
  expect(run.code).toBe(0)

  // .json was never invented beside the .jsonc, and the .jsonc needed nothing, so the whole
  // file — pin, mcp block, hand-written inline array — is byte-identical to what was there.
  expect(existsSync(join(home, "opencode", "opencode.json"))).toBe(false)
  expect(readText(home, "opencode.jsonc")).toBe(REAL_OPENCODE_JSONC)
  expect(readText(home, "opencode.jsonc")).toContain(`"@ex-machina/opencode-anthropic-auth@1.8.1"`)
  expect(plugins(home, "opencode.jsonc")).toEqual([
    "oh-my-openagent@4.19.3",
    "@ex-machina/opencode-anthropic-auth@1.8.1",
    "@warp-dot-dev/opencode-warp",
  ])

  // Our entry is replaced AT ITS ORIGINAL INDEX; both oh-my-openagent entries keep their slots.
  expect(plugins(home, "tui.json")).toEqual(["oh-my-openagent@4.19.0", expectedEntry, "oh-my-openagent@4.19.3"])
  // Only the file that actually changed was backed up.
  expect(backups(home)).toHaveLength(1)
})

test("a config that already says what we need is not rewritten, not even reformatted", async () => {
  const hand = `{\n    "plugin": [\n        "@ex-machina/opencode-anthropic-auth@1.8.1"\n    ]\n}`
  const home = sandbox({ "opencode.json": hand })

  const run = await runCli(home)

  expect(run.code).toBe(0)
  expect(readText(home, "opencode.json")).toBe(hand)
  expect(run.stdout).not.toContain(join(home, "opencode", "opencode.json"))
  expect(backups(home)).toEqual([])
})

test("running twice is idempotent: no duplicate entries, no growth", async () => {
  const home = sandbox({ "opencode.jsonc": REAL_OPENCODE_JSONC, "tui.json": REAL_TUI_JSON })

  await runCli(home)
  const afterFirst = { opencode: readText(home, "opencode.jsonc"), tui: readText(home, "tui.json") }
  const second = await runCli(home)

  expect(second.code).toBe(0)
  expect(readText(home, "opencode.jsonc")).toBe(afterFirst.opencode)
  expect(readText(home, "tui.json")).toBe(afterFirst.tui)
  expect(plugins(home, "tui.json")).toHaveLength(3)
  expect(plugins(home, "opencode.jsonc")).toHaveLength(3)
})

test("fresh machine: both config files are created with minimal correct content", async () => {
  const home = sandbox({})

  const run = await runCli(home)

  expect(run.code).toBe(0)
  expect(readConfig(home, "opencode.json")).toEqual({
    $schema: "https://opencode.ai/config.json",
    plugin: ["@ex-machina/opencode-anthropic-auth"],
  })
  expect(readConfig(home, "tui.json")).toEqual({
    $schema: "https://opencode.ai/tui.json",
    plugin: [expectedEntry],
  })
  // Nothing existed, so nothing was worth backing up.
  expect(backups(home)).toEqual([])
})

test("ex-machina absent is appended unpinned", async () => {
  const home = sandbox({ "opencode.json": `{ "plugin": ["oh-my-openagent@4.19.3"] }` })

  await runCli(home)

  expect(plugins(home, "opencode.json")).toEqual(["oh-my-openagent@4.19.3", "@ex-machina/opencode-anthropic-auth"])
})

test("ex-machina present unpinned is left alone", async () => {
  const home = sandbox({ "opencode.json": `{ "plugin": ["@ex-machina/opencode-anthropic-auth"] }` })

  await runCli(home)

  expect(plugins(home, "opencode.json")).toEqual(["@ex-machina/opencode-anthropic-auth"])
})

test("ex-machina present pinned keeps its pin and is not duplicated", async () => {
  const home = sandbox({ "opencode.json": `{ "plugin": ["@ex-machina/opencode-anthropic-auth@0.9.0"] }` })

  await runCli(home)

  expect(plugins(home, "opencode.json")).toEqual(["@ex-machina/opencode-anthropic-auth@0.9.0"])
})

test("our tui entry is appended when absent", async () => {
  const home = sandbox({ "tui.json": `{ "plugin": ["oh-my-openagent@4.19.3"] }` })

  await runCli(home)

  expect(plugins(home, "tui.json")).toEqual(["oh-my-openagent@4.19.3", expectedEntry])
})

test("a bare-string entry of ours at another path is replaced in place at the same index", async () => {
  const home = sandbox({
    "tui.json": `{ "plugin": ["first", "/old/claude-accounts-pool/tui.tsx", "last"] }`,
  })

  await runCli(home)

  expect(plugins(home, "tui.json")).toEqual(["first", expectedEntry, "last"])
})

test("refuses a config that does not parse, and writes nothing at all", async () => {
  const home = sandbox({ "opencode.jsonc": `{\n  // a comment JSON.parse cannot read\n  "plugin": []\n}\n` })

  const run = await runCli(home)

  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("parse")
  expect(run.stderr).toContain(`"mode": "cloud-worker"`)
  expect(run.stderr).toContain("@ex-machina/opencode-anthropic-auth")
  // All-or-nothing: the healthy sibling file is not created either.
  expect(existsSync(join(home, "opencode", "tui.json"))).toBe(false)
  expect(backups(home)).toEqual([])
})

test("refuses when plugin exists but is not an array", async () => {
  const home = sandbox({ "opencode.json": `{ "plugin": "oh-my-openagent" }` })

  const run = await runCli(home)

  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("not an array")
  expect(run.stderr).toContain(`"mode": "cloud-worker"`)
  expect(readText(home, "opencode.json")).toBe(`{ "plugin": "oh-my-openagent" }`)
  expect(existsSync(join(home, "opencode", "tui.json"))).toBe(false)
})

test("refuses when both .json and .jsonc exist for the same config", async () => {
  const home = sandbox({ "opencode.json": `{ "plugin": [] }`, "opencode.jsonc": `{ "plugin": [] }` })

  const run = await runCli(home)

  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("both")
  expect(run.stderr).toContain(`"mode": "cloud-worker"`)
  expect(readText(home, "opencode.json")).toBe(`{ "plugin": [] }`)
  expect(readText(home, "opencode.jsonc")).toBe(`{ "plugin": [] }`)
  expect(existsSync(join(home, "opencode", "tui.json"))).toBe(false)
})

test("refuses when the old claude-accounts-usage plugin is installed", async () => {
  const original = `{ "plugin": ["/opt/claude-accounts-usage/dist/tui.js"] }`
  const home = sandbox({ "tui.json": original })

  const run = await runCli(home)

  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("claude-accounts-usage")
  expect(run.stderr).toContain(`"mode": "cloud-worker"`)
  expect(readText(home, "tui.json")).toBe(original)
  expect(existsSync(join(home, "opencode", "opencode.json"))).toBe(false)
})

test("--dry-run prints the diff, writes nothing and leaves no backup", async () => {
  const home = sandbox({ "opencode.jsonc": REAL_OPENCODE_JSONC, "tui.json": REAL_TUI_JSON })

  const run = await runCli(home, [...ARGS, "--dry-run"])

  expect(run.code).toBe(0)
  expect(run.stdout).toContain("tui.json")
  expect(run.stdout).toContain(EXPECTED_PLUGIN_PATH)
  expect(readText(home, "opencode.jsonc")).toBe(REAL_OPENCODE_JSONC)
  expect(readText(home, "tui.json")).toBe(REAL_TUI_JSON)
  expect(backups(home)).toEqual([])
})

test("a real write backs the previous file up first", async () => {
  const home = sandbox({ "tui.json": `{ "plugin": [] }` })

  await runCli(home)

  const saved = backups(home)
  expect(saved).toHaveLength(1)
  expect(readFileSync(join(home, "opencode", saved[0]), "utf8")).toBe(`{ "plugin": [] }`)
})

test("the generated options are accepted by the real parser in src/mode.ts", async () => {
  const home = sandbox({})

  await runCli(home)

  const entry = plugins(home, "tui.json")[0]
  if (!Array.isArray(entry)) throw new Error("expected a [path, options] tuple")
  const options: unknown = entry[1]
  if (!isJsonObject(options)) throw new Error("expected an options object")

  const parsed = parseMode(options)
  expect(parsed).toEqual({ mode: "cloud-worker", masterUrl: MASTER, workerId: LABEL })
})

test("missing or empty required flags print usage and exit non-zero", async () => {
  const home = sandbox({})

  const missingMaster = await runCli(home, ["--worker", LABEL])
  const missingWorker = await runCli(home, ["--master", MASTER])

  expect(missingMaster.code).not.toBe(0)
  expect(missingMaster.stderr).toContain("--master")
  expect(missingMaster.stderr).toContain("Usage")

  expect(missingWorker.code).not.toBe(0)
  expect(missingWorker.stderr).toContain("--worker")
  expect(missingWorker.stderr).toContain("Usage")

  expect(existsSync(join(home, "opencode", "tui.json"))).toBe(false)
})

test("a --master that is not an http(s) URL is rejected", async () => {
  const home = sandbox({})

  const run = await runCli(home, ["--master", "ftp://10.0.0.5", "--worker", LABEL])

  expect(run.code).not.toBe(0)
  expect(run.stderr).toContain("--master")
  expect(existsSync(join(home, "opencode", "tui.json"))).toBe(false)
})

test("stripVersionSpec keeps a scoped package name whole", () => {
  expect(stripVersionSpec("@ex-machina/opencode-anthropic-auth@1.8.1")).toBe("@ex-machina/opencode-anthropic-auth")
  expect(stripVersionSpec("@ex-machina/opencode-anthropic-auth")).toBe("@ex-machina/opencode-anthropic-auth")
  expect(stripVersionSpec("oh-my-openagent@4.19.3")).toBe("oh-my-openagent")
  expect(stripVersionSpec("oh-my-openagent")).toBe("oh-my-openagent")
})

test("isOurTuiEntry matches by shape, never by path equality", () => {
  expect(isOurTuiEntry("/a/claude-accounts-pool/dist/tui.js")).toBe(true)
  expect(isOurTuiEntry(["/b/claude-accounts-pool/tui.tsx", { mode: "local" }])).toBe(true)
  expect(isOurTuiEntry("/c/claude-accounts-usage/dist/tui.js")).toBe(true)
  expect(isOurTuiEntry("/d/claude-accounts-pool/dist/other.js")).toBe(false)
  expect(isOurTuiEntry("oh-my-openagent@4.19.3")).toBe(false)
  expect(isOurTuiEntry(["/e/somewhere/dist/tui.js", {}])).toBe(false)
  expect(isOurTuiEntry(undefined)).toBe(false)
})

test("discoverConfig probes .jsonc first and only invents .json when neither exists", () => {
  const home = sandbox({ "opencode.jsonc": "{}" })
  const dir = join(home, "opencode")

  expect(discoverConfig(dir, "opencode")).toEqual({ kind: "existing", path: join(dir, "opencode.jsonc") })
  expect(discoverConfig(dir, "tui")).toEqual({ kind: "create", path: join(dir, "tui.json") })
})

test("the merge helpers leave a config object they do not need to change identical", () => {
  const config: JsonObject = { plugin: ["@ex-machina/opencode-anthropic-auth@1.8.1"] }

  const merged = mergeOpencodeConfig(config)

  expect(merged).toEqual({ ok: true, config })
})

test("mergeTuiConfig never reorders or dedupes a neighbour", () => {
  const config: JsonObject = { plugin: ["dup@1", "dup@1", "/x/claude-accounts-pool/dist/tui.js", "dup@2"] }
  const entry: [string, JsonObject] = ["/new/dist/tui.js", { mode: "cloud-worker" }]

  const merged = mergeTuiConfig(config, entry)

  expect(merged).toEqual({ ok: true, config: { plugin: ["dup@1", "dup@1", entry, "dup@2"] } })
})
