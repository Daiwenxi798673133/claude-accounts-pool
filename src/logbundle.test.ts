import { expect, test } from "bun:test"
import { inflateRawSync } from "node:zlib"
import {
  buildZip,
  collectEnvironment,
  extractPluginLines,
  redactLogLine,
  renderIssueDraft,
  renderMeta,
  summarizeRuns,
  type ZipEntry,
} from "./logbundle.ts"

const OURS = `timestamp=2026-08-03T03:06:33.569Z level=INFO run=105d7eb6 message="claude-accounts-usage worker:installed" masterUrl=http://100.64.0.36:8787 workerId=laptop-1`
// The false positive this filter exists to reject: somebody ELSE's line that merely mentions the
// old package name as a directory. Matching the bare service name would rake these in by the
// thousand and bury the lines the issue is about.
const FOREIGN = `timestamp=2026-08-03T03:06:33.569Z level=INFO run=105d7eb6 message=tracking cwd=/Users/x/code/claude-accounts-usage git=/Users/x/snapshot/a96`

test("only lines whose message starts with the service marker are kept", () => {
  const text = [OURS, FOREIGN, "", "level=INFO message=something-else"].join("\n")
  expect(extractPluginLines(text)).toEqual({ matched: 1, lines: [OURS] })
})

test("the newest lines survive the cap, the oldest are dropped, and the drop is reported", () => {
  const lines = Array.from({ length: 5 }, (_, i) => OURS.replace("worker:installed", `tag:${i}`))
  const extraction = extractPluginLines(lines.join("\n"), 2)
  // matched counts what was in the file, lines is what survived — a bundle that reported only the
  // survivors would present a truncated log as if it were complete.
  expect(extraction.matched).toBe(5)
  expect(extraction.lines).toHaveLength(2)
  expect(extraction.lines[0]).toContain("tag:3")
  expect(extraction.lines[1]).toContain("tag:4")
})

const runLine = (run: string, at: string) =>
  OURS.replace("run=105d7eb6", `run=${run}`).replace("2026-08-03T03:06:33.569Z", at)

test("runs are sorted by their LAST line, not by when they first appeared", () => {
  // Two concurrent OpenCode instances, which this plugin explicitly supports: `early` starts first
  // but `late` finishes first, so first-appearance order would name the wrong run as the latest.
  const runs = summarizeRuns([
    runLine("early", "2026-08-01T01:00:00.000Z"),
    runLine("late", "2026-08-01T02:00:00.000Z"),
    runLine("late", "2026-08-01T03:00:00.000Z"),
    runLine("early", "2026-08-01T09:00:00.000Z"),
  ])
  expect(runs).toEqual([
    { run: "late", lines: 2, first: "2026-08-01T02:00:00.000Z", last: "2026-08-01T03:00:00.000Z" },
    { run: "early", lines: 2, first: "2026-08-01T01:00:00.000Z", last: "2026-08-01T09:00:00.000Z" },
  ])
})

test("a line with no run field still lands somewhere countable", () => {
  expect(summarizeRuns([`message="claude-accounts-usage x"`])).toEqual([
    { run: "unknown", lines: 1, first: undefined, last: undefined },
  ])
})

test("emails keep their initial and domain, everything else of the local part goes", () => {
  const line = redactLogLine(`${OURS} label=alice.smith+tag@gmail.com`)
  expect(line).toContain("label=a***@gmail.com")
  expect(line).not.toContain("alice.smith")
})

test("version strings are not mistaken for emails", () => {
  // `pkg@1.2.3` has the shape of an address up to the TLD, and masking it would corrupt the one
  // field an issue triager reads first.
  expect(redactLogLine("message=\"claude-accounts-usage x\" v=claude-accounts-pool@0.4.0")).toContain(
    "v=claude-accounts-pool@0.4.0",
  )
})

test("credentials are masked, and the line is never truncated", () => {
  const padding = ` note=${"x".repeat(300)}`
  const secret = `${OURS} auth=Bearer abc.def-123 key=sk-live_ABCDEFGHIJ jwt=eyJhbGciOiJIUzI1NiJ9xxxxx${padding}`
  const line = redactLogLine(secret)
  expect(line).not.toContain("abc.def-123")
  expect(line).not.toContain("sk-live_ABCDEFGHIJ")
  expect(line).not.toContain("eyJhbGciOiJIUzI1NiJ9")
  expect(line).toContain("Bearer ***")
  // redactBody's default would have cut this at 300 characters; a log line must survive whole.
  expect(line.length).toBeGreaterThan(300)
  expect(line).toContain("workerId=laptop-1")
})

// Reads the archive the way an extractor does — local headers walked front to back, then the
// central directory the trailer points at. A wrong size or offset shows up here rather than as a
// "cannot open" from the user who tried to attach the file.
function readZip(zip: Buffer): { name: string; text: string }[] {
  const out: { name: string; text: string }[] = []
  let at = 0
  while (at + 4 <= zip.length && zip.readUInt32LE(at) === 0x04034b50) {
    const packedSize = zip.readUInt32LE(at + 18)
    const rawSize = zip.readUInt32LE(at + 22)
    const nameLength = zip.readUInt16LE(at + 26)
    const extraLength = zip.readUInt16LE(at + 28)
    const name = zip.subarray(at + 30, at + 30 + nameLength).toString("utf8")
    const start = at + 30 + nameLength + extraLength
    const raw = inflateRawSync(zip.subarray(start, start + packedSize))
    expect(raw.length).toBe(rawSize)
    out.push({ name, text: raw.toString("utf8") })
    at = start + packedSize
  }
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  expect(zip.readUInt16LE(end + 10)).toBe(out.length)
  const directoryAt = zip.readUInt32LE(end + 16)
  // An archive with no entries has an empty central directory, so there is no header to check —
  // the trailer's own arithmetic (offset + size lands on the trailer) still has to hold.
  if (out.length > 0) expect(zip.readUInt32LE(directoryAt)).toBe(0x02014b50)
  expect(directoryAt + zip.readUInt32LE(end + 12)).toBe(end)
  return out
}

test("the zip round-trips every entry, names and bytes intact", () => {
  const entries: ZipEntry[] = [
    { name: "meta.txt", text: "运行模式      cloud-worker\n" },
    { name: "plugin-opencode.log", text: `${OURS}\n${OURS}\n` },
  ]
  const parsed = readZip(buildZip(entries, new Date("2026-08-03T11:22:33Z")))
  expect(parsed.map((entry) => entry.name)).toEqual(["meta.txt", "plugin-opencode.log"])
  expect(parsed[0]?.text).toBe(entries[0]?.text)
  expect(parsed[1]?.text).toBe(entries[1]?.text)
})

test("an empty archive is still a readable archive", () => {
  // Not a state writeLogBundle can produce (meta.txt is always there), but the zip writer must not
  // be the thing that breaks if it ever is.
  expect(readZip(buildZip([], new Date()))).toEqual([])
})

const ENV = {
  pluginVersion: "0.4.0",
  opencodeVersion: "1.17.4",
  mode: "cloud-worker" as const,
  os: "Darwin 25.5.0 arm64",
  terminal: "Ghostty v1.2 / xterm-256color",
  runtime: "darwin/arm64 bun 1.3.14 (node 24.3.0)",
  logging: "OPENCODE_LOG_LEVEL=(未设置,默认 INFO) CLAUDE_AUTOSWITCH_DEBUG=off",
  plugins: ["claude-accounts-pool@0.4.0", "@ex-machina/opencode-anthropic-auth@1.8.1"],
}

test("meta names the mode, the versions and every source file", () => {
  const meta = renderMeta({
    at: new Date("2026-08-03T03:22:33Z"),
    env: ENV,
    logDir: "/home/x/.local/share/opencode/log",
    sources: [{ name: "opencode.log", sourceBytes: 2048, matched: 42, kept: 42 }],
    runs: [],
  })
  expect(meta).toContain("cloud-worker")
  expect(meta).toContain("1.17.4")
  expect(meta).toContain("0.4.0")
  expect(meta).toContain("2026-08-03T03:22:33.000Z")
  expect(meta).toContain("opencode.log  源文件 2 KB,命中 42 行,保留 42 行")
  // The four fields borrowed from `opencode debug info` and upstream's issue form. The plugin list
  // is the one that makes the fatal co-install (this package plus its predecessor) visible at all.
  expect(meta).toContain("Darwin 25.5.0 arm64")
  expect(meta).toContain("Ghostty v1.2 / xterm-256color")
  expect(meta).toContain("CLAUDE_AUTOSWITCH_DEBUG=off")
  expect(meta).toContain("@ex-machina/opencode-anthropic-auth@1.8.1")
})

test("meta says so when the cap dropped lines", () => {
  const meta = renderMeta({
    at: new Date(),
    env: ENV,
    logDir: "/log",
    sources: [{ name: "opencode.log", sourceBytes: 2048, matched: 40_000, kept: 20_000 }],
    runs: [],
  })
  expect(meta).toContain("命中 40000 行,保留 20000 行,已丢弃最早 20000 行")
})

test("meta marks the newest run and admits how many it hid", () => {
  const runs = Array.from({ length: 20 }, (_, i) => ({ run: `run${i}`, lines: 1, first: "t", last: "t" }))
  const meta = renderMeta({ at: new Date(), env: ENV, logDir: "/log", sources: [], runs })
  expect(meta).toContain("共 20 次")
  expect(meta).toContain("列最近 15 次")
  expect(meta).not.toContain("run4  ")
  expect(meta).toContain("run19  1 行")
  expect(meta.split("\n").filter((line) => line.includes("<- 最后一条日志在这里"))).toHaveLength(1)
})

test("the issue draft pre-fills the environment and leaves the rest blank", () => {
  const draft = renderIssueDraft({ env: ENV, zipName: "claude-accounts-pool-log-20260803-112233.zip" })
  expect(draft).toContain("## 问题描述")
  expect(draft).toContain("## 复现步骤")
  expect(draft).toContain("- 运行模式: cloud-worker")
  expect(draft).toContain("- OS: Darwin 25.5.0 arm64")
  expect(draft).toContain("  - claude-accounts-pool@0.4.0")
  expect(draft).toContain("claude-accounts-pool-log-20260803-112233.zip")
})

test("environment reads the real process, and the log-level field reflects the debug switch", () => {
  const before = process.env.CLAUDE_AUTOSWITCH_DEBUG
  process.env.CLAUDE_AUTOSWITCH_DEBUG = "1"
  try {
    const env = collectEnvironment({ mode: "local", opencodeVersion: "1.18.11", plugins: ["a@1"] })
    expect(env.logging).toContain("CLAUDE_AUTOSWITCH_DEBUG=on")
    expect(env.os).toContain(process.arch)
    expect(env.runtime).toContain(process.versions.node)
    expect(env.plugins).toEqual(["a@1"])
  } finally {
    if (before === undefined) delete process.env.CLAUDE_AUTOSWITCH_DEBUG
    else process.env.CLAUDE_AUTOSWITCH_DEBUG = before
  }
})
