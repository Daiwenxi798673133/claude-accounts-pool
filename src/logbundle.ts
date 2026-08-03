// /update-log: pulls THIS plugin's lines out of OpenCode's log file, redacts them, and zips them
// together with an environment summary so the user has one file to drag into a GitHub issue.
//
// Why a command rather than "please grep and paste": the two things a bug report is always missing
// are the environment (which version, which of the three modes) and the lines AROUND the failure —
// a hand-rolled grep produces the one error line and never the mode. Both go in here by default.
//
// The bundle is destined for a PUBLIC issue, so redaction happens BEFORE the bytes are written
// rather than as a "please check it yourself" footnote: every line goes through logger.ts's
// redactBody (token / Bearer / JWT / *_token fields) and then has its email local-parts masked.
// Account emails are the one piece of personal data this plugin's log carries in bulk — capture,
// switch and usage lines all end in label=<email>.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { arch, homedir, release, type } from "node:os"
import { basename, dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { deflateRawSync } from "node:zlib"
import type { TuiCommand, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { SERVICE, log, redactBody } from "./logger.ts"
import type { ModeConfig } from "./mode.ts"

// Newest few files, newest lines. An opencode.log that has been appended to for weeks is tens of
// MB while GitHub's attachment ceiling is 25MB, so something must go — and what gets dropped is
// the HEAD, because the tail is the part that describes the bug being reported.
const MAX_LOG_FILES = 3
const MAX_LINES_PER_FILE = 20_000

// The ONE test for "is this line ours", and the `message="` prefix plus trailing space are both
// load-bearing: this repo's former name is still `claude-accounts-usage`, so that string also shows
// up inside OTHER services' lines as a directory (cwd=/.../claude-accounts-usage). Matching the
// service name alone would rake those in. logger.ts always emits `${SERVICE} ${tag}` as the
// message, which is what makes this prefix both sufficient and necessary.
const MARKER = `message="${SERVICE} `

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// XDG_DATA_HOME and nothing else, because that is the only lever upstream actually reads: OpenCode
// resolves its data directory through the `xdg-basedir` package (packages/core/src/global.ts) and
// applies an env override to the CONFIG path alone. `OPENCODE_DATA_DIR` — which stats.ts still
// consults, inherited from upstream — exists only in an unmerged PR (anomalyco/opencode#8963) and was
// verified dead here: `OPENCODE_DATA_DIR=/tmp/x opencode debug paths` still reports ~/.local/share.
// Honouring it would send a bundle looking in a directory OpenCode never writes to.
function logDirCandidates(): string[] {
  const list: string[] = []
  if (process.env.XDG_DATA_HOME) list.push(join(process.env.XDG_DATA_HOME, "opencode", "log"))
  list.push(join(homedir(), ".local", "share", "opencode", "log"))
  list.push(join(homedir(), "Library", "Application Support", "opencode", "log"))
  return list
}

export function resolveLogDir(): string | undefined {
  for (const candidate of logDirCandidates()) if (existsSync(candidate)) return candidate
  return undefined
}

export function listLogFiles(dir: string): string[] {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".log"))
    .map((name) => join(dir, name))
    .map((path) => ({ path, at: statSync(path).mtimeMs }))
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_LOG_FILES)
    .map((entry) => entry.path)
}

// `alice@gmail.com` -> `a***@gmail.com`. Keeping the initial and the domain is deliberate: telling
// two accounts apart across a hundred switch lines is the whole point of the label, and an initial
// plus a mail provider does not identify anybody. The domain must end in a real TLD, otherwise
// version strings like `claude-accounts-usage@0.3.0` would be masked as if they were addresses.
const EMAIL_RE = /([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,})/g

export function redactLogLine(line: string): string {
  // max is the line's own length: redactBody's default 300 is an HTTP-body truncation, and a log
  // line must survive whole — masking is the point here, shortening is not.
  return redactBody(line, line.length).replace(EMAIL_RE, "$1***$2")
}

// `matched` is reported alongside the kept lines rather than discarded, because the cap silently
// drops the OLDEST lines — and a report of "this started two weeks ago" is exactly the one whose
// evidence gets eaten. The bundle has to say so out loud instead of presenting a truncated file as
// if it were the whole story.
export type Extraction = { matched: number; lines: string[] }

export function extractPluginLines(text: string, maxLines = MAX_LINES_PER_FILE): Extraction {
  const matched: string[] = []
  for (const line of text.split("\n")) if (line.includes(MARKER)) matched.push(line)
  const tail = matched.length > maxLines ? matched.slice(matched.length - maxLines) : matched
  return { matched: matched.length, lines: tail.map(redactLogLine) }
}

// OpenCode appends every process's lines to ONE file forever (no rotation), tagging each with an
// 8-char `run=` id minted per process. So a bundle spanning weeks interleaves dozens of launches,
// and "which lines belong to the run that broke" is otherwise unanswerable.
//
// SORTED BY LAST LINE, not by first appearance. This plugin explicitly supports several OpenCode
// instances at once (that is what the cross-process auth lock is for), and real logs prove they
// interleave: a run that started earlier can still be the one that wrote most recently. Ordering by
// first appearance therefore put the wrong row at the bottom, which is exactly the row a reader
// trusts.
export type RunSummary = { run: string; lines: number; first?: string; last?: string }

const RUN_RE = /\brun=([A-Za-z0-9]+)/
const TIMESTAMP_RE = /\btimestamp=(\S+)/

export function summarizeRuns(lines: string[]): RunSummary[] {
  const runs = new Map<string, RunSummary>()
  for (const line of lines) {
    const run = RUN_RE.exec(line)?.[1] ?? "unknown"
    const at = TIMESTAMP_RE.exec(line)?.[1]
    const seen = runs.get(run)
    if (seen === undefined) runs.set(run, { run, lines: 1, first: at, last: at })
    else {
      seen.lines += 1
      seen.first ??= at
      if (at !== undefined) seen.last = at
    }
  }
  // ISO-8601 timestamps sort correctly as plain strings; a run whose lines carried no timestamp has
  // nothing to sort by and goes first rather than being mistaken for the latest.
  return [...runs.values()].sort((a, b) => (a.last ?? a.first ?? "").localeCompare(b.last ?? b.first ?? ""))
}

// ---------------------------------------------------------------------------
// ZIP writing. Hand-rolled instead of adding a dependency: there is exactly one kind of entry here
// (UTF-8 text, deflated, no directories, no encryption), node:zlib already does the compression,
// and what remains is three fixed-layout headers. An archiver dependency would drag in a whole
// tree to serve that.
// ---------------------------------------------------------------------------

export type ZipEntry = { name: string; text: string }

const CRC_TABLE = ((): Uint32Array => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let bit = 0; bit < 8; bit += 1) c = (c & 1) === 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let c = 0xffffffff
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// ZIP timestamps are DOS-packed against a 1980 epoch, with 5 bits of seconds (2-second precision).
// Extractors only use it to display an mtime, so the precision is irrelevant — but the field has to
// be well-formed or some of them warn about it.
function dosStamp(at: Date): { time: number; date: number } {
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | Math.floor(at.getSeconds() / 2)
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
  return { time, date }
}

// Regular file, 0644. Left at 0 the extracted files inherit whatever the extractor guesses.
const UNIX_MODE_0644 = (0o100644 << 16) >>> 0

export function buildZip(entries: ZipEntry[], at: Date): Buffer {
  const { time, date } = dosStamp(at)
  const body: Buffer[] = []
  const directory: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8")
    const raw = Buffer.from(entry.text, "utf8")
    const packed = deflateRawSync(raw)
    const crc = crc32(raw)

    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6) // names are UTF-8
    local.writeUInt16LE(8, 8) // deflate
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(packed.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(8, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(packed.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(0, 30) // extra length + comment length
    central.writeUInt32LE(0, 34) // start disk + internal attributes
    central.writeUInt32LE(UNIX_MODE_0644, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)

    body.push(local, packed)
    directory.push(central)
    offset += local.length + packed.length
  }

  const files = Buffer.concat(body)
  const index = Buffer.concat(directory)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(index.length, 12)
  end.writeUInt32LE(files.length, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([files, index, end])
}

// ---------------------------------------------------------------------------
// Bundling
// ---------------------------------------------------------------------------

export type LogBundle = { path: string; lines: number; bytes: number }
export type LogSource = { name: string; sourceBytes: number; matched: number; kept: number }

// Both src/ and dist/ sit exactly one level below the repo root, so two levels up is package.json
// whether this module is running from source (src/logbundle.ts) or inlined into the build output
// (dist/tui.js). "unknown" on any failure: the version is a nice-to-have diagnostic, and a bundle
// that refuses to exist because it could not read a version number would be the worse outcome.
function pluginVersion(): string {
  try {
    const path = join(dirname(dirname(fileURLToPath(import.meta.url))), "package.json")
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"))
    const version = (parsed as { version?: unknown }).version
    return typeof version === "string" ? version : "unknown"
  } catch {
    return "unknown"
  }
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function stamp(at: Date): string {
  const day = `${at.getFullYear()}${pad2(at.getMonth() + 1)}${pad2(at.getDate())}`
  return `${day}-${pad2(at.getHours())}${pad2(at.getMinutes())}${pad2(at.getSeconds())}`
}

// ~/Downloads first: this file exists to be dropped into a browser's attachment picker, and
// ~/.config is hidden in Finder by default. A machine without it (a headless master) falls back to
// the home directory, which always exists and is always writable.
function resolveOutputDir(): string {
  const downloads = join(homedir(), "Downloads")
  return existsSync(downloads) ? downloads : homedir()
}

// The field list is not free-form: it mirrors what `opencode debug info` prints and what upstream's
// own .github/ISSUE_TEMPLATE/bug-report.yml asks a reporter for (version, plugins, OS, terminal).
// Two of them are ours: `mode`, because every cloud-mode question starts with "which side is this",
// and `logging`, because "the bundle has no debug lines" is otherwise indistinguishable from "the
// bug left no trace".
export type Environment = {
  pluginVersion: string
  opencodeVersion: string
  mode: ModeConfig["mode"]
  os: string
  terminal: string
  runtime: string
  logging: string
  plugins: string[]
}

// Same shape as debug info's `terminal:` line — TERM alone cannot tell iTerm2 from Ghostty, and the
// program alone cannot tell you the terminal is running with a TERM that has no 256-colour support.
function terminalLabel(): string {
  const program = process.env.TERM_PROGRAM
  // Joined with a space and NO added "v": Warp already reports TERM_PROGRAM_VERSION as
  // "v0.2026.07.29...", so prefixing one produced "WarpTerminal vv0.2026...".
  const version = process.env.TERM_PROGRAM_VERSION
  const named = program === undefined || program.length === 0 ? undefined : version ? `${program} ${version}` : program
  const parts = [named, process.env.TERM].filter((part): part is string => part !== undefined && part.length > 0)
  return parts.length > 0 ? parts.join(" / ") : "unknown"
}

function runtimeLabel(): string {
  const versions = process.versions as Record<string, string | undefined>
  const bun = versions["bun"]
  const base = `${process.platform}/${process.arch}`
  return bun === undefined ? `${base} node ${process.versions.node}` : `${base} bun ${bun} (node ${process.versions.node})`
}

function loggingLabel(): string {
  const level = process.env.OPENCODE_LOG_LEVEL
  const debug = process.env.CLAUDE_AUTOSWITCH_DEBUG ? "on" : "off"
  return `OPENCODE_LOG_LEVEL=${level === undefined || level.length === 0 ? "(未设置,默认 INFO)" : level} CLAUDE_AUTOSWITCH_DEBUG=${debug}`
}

export function collectEnvironment(input: {
  mode: ModeConfig["mode"]
  opencodeVersion: string
  plugins: string[]
}): Environment {
  return {
    pluginVersion: pluginVersion(),
    opencodeVersion: input.opencodeVersion,
    mode: input.mode,
    os: `${type()} ${release()} ${arch()}`,
    terminal: terminalLabel(),
    runtime: runtimeLabel(),
    logging: loggingLabel(),
    plugins: input.plugins,
  }
}

// Only the most recent handful: a months-old log can carry a hundred launches, and the older ones
// answer nothing that the per-file counts above have not already answered.
const MAX_RUNS_LISTED = 15

export function renderMeta(input: { at: Date; env: Environment; logDir: string; sources: LogSource[]; runs: RunSummary[] }): string {
  const lines = [
    "claude-accounts-pool 日志包(/update-log 生成,用于提 issue)",
    "",
    `生成时间      ${input.at.toISOString()}`,
    `插件版本      ${input.env.pluginVersion}`,
    `运行模式      ${input.env.mode}`,
    `OpenCode      ${input.env.opencodeVersion}`,
    `OS            ${input.env.os}`,
    `终端          ${input.env.terminal}`,
    `运行时        ${input.env.runtime}`,
    `日志级别      ${input.env.logging}`,
    `日志目录      ${input.logDir}`,
    "",
    "已加载插件:",
    ...(input.env.plugins.length > 0 ? input.env.plugins.map((plugin) => `  ${plugin}`) : ["  (拿不到插件清单)"]),
    "",
    `包含的日志(只抽 message 以 ${SERVICE} 开头的行):`,
  ]
  for (const source of input.sources) {
    const dropped = source.matched - source.kept
    const tail = dropped > 0 ? `,已丢弃最早 ${dropped} 行(每文件上限 ${MAX_LINES_PER_FILE} 行)` : ""
    lines.push(`  ${source.name}  源文件 ${(source.sourceBytes / 1024).toFixed(0)} KB,命中 ${source.matched} 行,保留 ${source.kept} 行${tail}`)
  }
  if (input.runs.length > 0) {
    const shown = input.runs.slice(-MAX_RUNS_LISTED)
    lines.push(
      "",
      `按 run 分布(run= 是 OpenCode 给每个进程的标识,同一个日志文件里混写着历次启动,可能有多个实例并发;共 ${input.runs.length} 次,按最后一行排序,列最近 ${shown.length} 次):`,
    )
    for (const [index, run] of shown.entries()) {
      const span = run.first === undefined ? "" : `  ${run.first} → ${run.last ?? run.first}`
      lines.push(`  ${run.run}  ${run.lines} 行${span}${index === shown.length - 1 ? "   <- 最后一条日志在这里" : ""}`)
    }
  }
  lines.push(
    "",
    `最多取最近 ${MAX_LOG_FILES} 个日志文件(当前 OpenCode 只写一个 opencode.log,不轮转)。`,
    "已脱敏:token / Bearer / JWT / *_token 字段已掩码,邮箱只留首字母与域名。",
    "",
  )
  return lines.join("\n")
}

// A draft, not a form: the environment half is already filled from the data above (it is the half
// reporters always omit), and what remains blank is the half only the reporter can write. Upstream's
// issue form asks for the same things and warns against pasting long generated analyses, so this
// stays deliberately short.
export function renderIssueDraft(input: { env: Environment; zipName: string }): string {
  return [
    "## 问题描述",
    "",
    "<!-- 你做了什么、期望看到什么、实际看到什么。有报错或 toast 请原文照抄。 -->",
    "",
    "## 复现步骤",
    "",
    "1. ",
    "2. ",
    "",
    "## 环境(已由 /update-log 填好)",
    "",
    `- 插件版本: ${input.env.pluginVersion}`,
    `- 运行模式: ${input.env.mode}`,
    `- OpenCode: ${input.env.opencodeVersion}`,
    `- OS: ${input.env.os}`,
    `- 终端: ${input.env.terminal}`,
    `- 运行时: ${input.env.runtime}`,
    `- 日志级别: ${input.env.logging}`,
    "- 已加载插件:",
    ...(input.env.plugins.length > 0 ? input.env.plugins.map((plugin) => `  - ${plugin}`) : ["  - (拿不到插件清单)"]),
    "",
    "## 日志",
    "",
    `已附上 \`${input.zipName}\`(含 meta.txt 与脱敏后的插件日志)。`,
    "",
  ].join("\n")
}

// The two throws are the two states only the user can fix (no log directory, no .log in it), so
// both messages name the next move. Finding the directory but matching zero lines is NOT an error:
// the environment summary alone is worth attaching, and the caller distinguishes it on lines === 0.
export async function writeLogBundle(input: {
  mode: ModeConfig["mode"]
  opencodeVersion: string
  plugins: string[]
  now?: Date
}): Promise<LogBundle> {
  const at = input.now ?? new Date()
  const dir = resolveLogDir()
  if (!dir) throw new Error("找不到 OpenCode 日志目录(用 opencode debug paths 看它在哪,或设置 XDG_DATA_HOME 后重试)")
  const files = listLogFiles(dir)
  if (files.length === 0) throw new Error(`${dir} 里没有 .log 文件`)

  const logs: ZipEntry[] = []
  const sources: LogSource[] = []
  const kept: string[] = []
  for (const file of files) {
    const text = await readFile(file, "utf8")
    const extraction = extractPluginLines(text)
    const name = basename(file)
    sources.push({ name, sourceBytes: Buffer.byteLength(text), matched: extraction.matched, kept: extraction.lines.length })
    kept.push(...extraction.lines)
    // A file that contributed nothing gets no entry, but it stays in the summary — "this log had
    // none of our lines" is itself an answer when the report is "the plugin does nothing".
    if (extraction.lines.length > 0) logs.push({ name: `plugin-${name}`, text: `${extraction.lines.join("\n")}\n` })
  }

  const env = collectEnvironment({ mode: input.mode, opencodeVersion: input.opencodeVersion, plugins: input.plugins })
  const zipName = `claude-accounts-pool-log-${stamp(at)}.zip`
  // meta first, draft second, logs last: an extract should open on the version and the mode, and the
  // draft is the next thing the reporter actually touches.
  const entries: ZipEntry[] = [
    { name: "meta.txt", text: renderMeta({ at, env, logDir: dir, sources, runs: summarizeRuns(kept) }) },
    { name: "issue.md", text: renderIssueDraft({ env, zipName }) },
    ...logs,
  ]

  const zip = buildZip(entries, at)
  const path = join(resolveOutputDir(), zipName)
  await writeFile(path, zip, { mode: 0o600 })
  return { path, lines: kept.length, bytes: zip.length }
}

// ---------------------------------------------------------------------------
// The command descriptor. All three install points (tui.tsx, worker/install.ts, master/install.ts)
// share this one, because "which mode was this" is precisely what the bundle exists to record —
// registering it only in local mode would blank out the two halves of cloud mode that are hardest
// to debug by hand.
// ---------------------------------------------------------------------------

// The plugin roster is the single most valuable field in the bundle, because the one configuration
// that CANNOT work is invisible everywhere else: this package and its predecessor
// claude-accounts-usage installed side by side, two refreshers of the same one-time-use chain. It
// also pins the ex-machina version, which owns the auth.json entry this plugin writes.
//
// The fallback reads paths ONLY, never the options object beside them — another plugin's options are
// its own business and could hold anything, and this file ends up on a public issue tracker.
function pluginRoster(api: TuiPluginApi): string[] {
  try {
    const listed = api.plugins?.list?.() ?? []
    if (listed.length > 0) {
      return listed.map((plugin) => `${plugin.spec}${plugin.enabled ? "" : " [disabled]"}${plugin.active ? "" : " [inactive]"}`)
    }
  } catch (error) {
    log.debug("logbundle:plugin-list-fail", { error: message(error) })
  }
  const configured = api.tuiConfig?.plugin ?? []
  return configured.flatMap((entry) => {
    if (typeof entry === "string") return [entry]
    const path: unknown = Array.isArray(entry) ? entry[0] : undefined
    return typeof path === "string" ? [path] : []
  })
}

export function logBundleCommand(api: TuiPluginApi, mode: ModeConfig["mode"]): TuiCommand {
  return {
    title: "Claude: 打包日志用于提 issue",
    // Same value namespace as every other command here (tui.tsx's ID and the composition roots'
    // ID are this same string).
    value: `${SERVICE}.update-log`,
    category: "Claude",
    slash: { name: "update-log" },
    onSelect: () => {
      // Fire-and-forget with its own catch: command handlers are void, and a rejection escaping
      // here would surface as an unhandled rejection in the plugin host.
      void (async () => {
        try {
          const bundle = await writeLogBundle({ mode, opencodeVersion: api.app.version, plugins: pluginRoster(api) })
          log.info("logbundle:written", { path: bundle.path, lines: bundle.lines, bytes: bundle.bytes })
          const size = `${(bundle.bytes / 1024).toFixed(0)} KB`
          api.ui.toast(
            bundle.lines === 0
              ? { variant: "warning", message: `没找到本插件的日志行,包里只有环境信息:${bundle.path}` }
              : { variant: "success", message: `已打包 ${bundle.lines} 行日志(${size}):${bundle.path}` },
          )
        } catch (error) {
          log.warn("logbundle:fail", { error: message(error) })
          api.ui.toast({ variant: "error", message: `打包日志失败:${message(error)}` })
        }
      })()
    },
  }
}
