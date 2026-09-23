// GATE 1 / 实验 —— 原生 Claude Code 两条凭证车道的计费归属（issue #83 的未决项）。
//
// 前置的 E1/E2 已经用本地假端点判明了 header 形状，不花一分额度：
//   · CLAUDE_CODE_OAUTH_TOKEN → Authorization: Bearer + anthropic-beta 含 oauth-2025-04-20
//   · apiKeyHelper            → Authorization: Bearer 但【没有】 oauth-2025-04-20
// 假端点回答不了的只剩一件事,而它恰恰是整个价值主张:真请求扣在哪个桶。
//
// 200 什么都不证明。静默改判的表现恰恰就是 200 + 正常回答 + 扣错桶。
//
// 与 gate0-billing-attribution.ts 的关系:那个测的是 ex-machina / opencode 那条链,且把
// 发请求这一步交给操作者手工做。这个测的是原生 `claude`,并把发请求也接管了 —— 因为两条
// 车道的差别就在客户端怎么发,手工复现容易走样。两份脚本有意分开,不合并。
//
// 绝不刷新:本脚本只读账号库,拿到的 access token 过期就直接拒绝跑,不去 POST token 端点
// (轮换真实链是 gate0-refresh-ownership.ts 的活儿,且会把该账号的其它持有者踢下线)。
//
//   bun scripts/gate1-claudecode-billing.ts                          # 干跑,只打印协议
//   bun scripts/gate1-claudecode-billing.ts --yes --account <id前缀>  # 用账号库里的号
//   bun scripts/gate1-claudecode-billing.ts --yes --lease            # 向 master 领一个真租约
//   bun scripts/gate1-claudecode-billing.ts --yes --token-file <路径>  # 用操作者自备的 token
import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { accountsOf, loadAccounts } from "../src/accounts.ts"
import { CLOUD_ROUTES, type LeaseRequest, type LeaseResponse } from "../src/cloud/protocol.ts"
import { USAGE_ENDPOINT } from "../src/constants.ts"
import { redactBody } from "../src/logger.ts"
import { readWorkerConfig } from "../src/senpi/workerConfig.ts"
import { fetchUsage, type UsageResponse, type UsageWindow } from "../src/usage.ts"

const PROTOCOL = `
════════════════════════════════════════════════════════════════════════
 GATE 1:原生 Claude Code 两条凭证车道的计费归属
════════════════════════════════════════════════════════════════════════

要回答的问题
  1) CLAUDE_CODE_OAUTH_TOKEN 车道(带 oauth-2025-04-20):真请求扣在该账号的订阅窗口吗?
  2) apiKeyHelper 车道(不带那个 flag):是响亮地 401,还是 200 但被改判到按量计费?
  第 2 问才是关键。401 = 好消息(这条车道判死,设计收敛到「每会话一租约」);
  200 + 改判 = 最坏(看起来能跑,每一分钱都在按量烧)。

本脚本做什么
  BEFORE 快照 → 车道 A 发一次真请求 → MID 快照 → 车道 B 发一次真请求 → AFTER 快照,
  然后按窗口打印两段 delta。两条车道都用【同一枚】 access token,所以差异只可能来自
  客户端怎么发。

必须人工复核(不可省略)
  ${USAGE_ENDPOINT} 只给订阅窗口的利用率,【不给】 overage / 按量计费的计数器。所以
  「没扣在订阅窗口」与「扣在别处」这两件事,本脚本只能证前者。判 PASS 之前必须用浏览器
  打开该账号的用量/账单页,亲眼确认这次调用算进的是订阅额度而不是 extra usage。

已知的干扰项(照实记,别事后解释)
  · 若被测账号同时正在被别人(或你自己另一个会话)使用,窗口会因为别人的流量而移动。
    小额请求的 delta 可能完全淹没在噪声里 —— 这就是 --burn medium 存在的理由。
  · ${USAGE_ENDPOINT} 已知有持续 429。撞 429 就报 INCONCLUSIVE 并非零退出,不激进重试。
  · 窗口 delta 可能有服务端聚合延迟。AFTER 全零时隔几分钟重跑再判,不要立刻判 FAIL。
`

type TokenSource = { kind: "account"; idPrefix: string } | { kind: "lease" } | { kind: "file"; path: string }
type Lane = "env" | "helper"
type Args = { yes: boolean; source?: TokenSource; lanes: Lane[]; burn: "small" | "medium" }
type Parsed = { ok: true; args: Args } | { ok: false; error: string }

function parseArgs(argv: readonly string[]): Parsed {
  let yes = false
  let source: TokenSource | undefined
  let lanes: Lane[] = ["env", "helper"]
  let burn: "small" | "medium" = "small"
  const need = (index: number): string | undefined => {
    const value = argv[index + 1]
    return value === undefined || value.startsWith("--") ? undefined : value
  }
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--yes") { yes = true; continue }
    if (arg === "--account") {
      const value = need(index)
      if (value === undefined) return { ok: false, error: "--account 需要一个账号 id 前缀" }
      if (source) return { ok: false, error: "token 来源只能指定一个" }
      source = { kind: "account", idPrefix: value }; index++; continue
    }
    if (arg === "--lease") {
      if (source) return { ok: false, error: "token 来源只能指定一个" }
      source = { kind: "lease" }; continue
    }
    if (arg === "--token-file") {
      const value = need(index)
      if (value === undefined) return { ok: false, error: "--token-file 需要一个路径" }
      if (source) return { ok: false, error: "token 来源只能指定一个" }
      source = { kind: "file", path: value }; index++; continue
    }
    if (arg === "--lane") {
      const value = need(index)
      if (value !== "env" && value !== "helper" && value !== "both") return { ok: false, error: "--lane 取 env / helper / both" }
      lanes = value === "both" ? ["env", "helper"] : [value]; index++; continue
    }
    if (arg === "--burn") {
      const value = need(index)
      if (value !== "small" && value !== "medium") return { ok: false, error: "--burn 取 small / medium" }
      burn = value; index++; continue
    }
    return { ok: false, error: `未知参数: ${arg}` }
  }
  return { ok: true, args: { yes, source, lanes, burn } }
}

/** Never printed in full: this output is meant to be pasted into an issue. */
const redactToken = (token: string): string => `${token.slice(0, 8)}…(len=${token.length})`
const errorMessage = (error: unknown): string => (error instanceof Error ? error.message : String(error))

// ── token 获取:三个来源,共同的纪律是「绝不刷新、绝不打印」 ────────────────────────────

async function tokenFromAccount(idPrefix: string): Promise<{ access: string; accountId: string }> {
  const file = await loadAccounts()
  // 前缀匹配不唯一时一律拒绝,不猜 —— 与 master 的 409 同一条规矩。
  const matches = accountsOf(file, "anthropic").filter((a) => a.id.startsWith(idPrefix))
  if (matches.length === 0) throw new Error(`没有账号匹配前缀 ${idPrefix}`)
  if (matches.length > 1) throw new Error(`前缀 ${idPrefix} 匹配到 ${matches.length} 个账号,拒绝猜`)
  const account = matches[0]
  if (account.needsReauth) throw new Error(`账号 ${account.id.slice(0, 8)} 被标记 needsReauth,刷新链已断`)
  const access = account.access
  if (!access) throw new Error(`账号 ${account.id.slice(0, 8)} 记录里没有 access token`)
  const remaining = (account.expires ?? 0) - Date.now()
  if (remaining < 60_000) {
    throw new Error(
      `账号 ${account.id.slice(0, 8)} 的 access token 已过期 ${Math.round(-remaining / 60000)} 分钟。` +
        `本脚本绝不刷新(会轮换真实链并踢掉其它持有者),请先用插件正常跑一次让它自然续上。`,
    )
  }
  return { access, accountId: account.id }
}

async function tokenFromLease(): Promise<{ access: string; accountId: string }> {
  const config = readWorkerConfig()
  if (!config) throw new Error("本机没有 worker 配置(~/.claude-accounts-pool/senpi-worker.json),无法领租约")
  // "prelease" = 拿来用之前先要一枚,而不是撞限流后换号 —— 后者会让 master 记一次限流。
  const body: LeaseRequest = { workerId: config.workerId, reason: "prelease" }
  const res = await fetch(`${config.masterUrl}${CLOUD_ROUTES.lease}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`master 拒绝发租约 (${res.status}): ${redactBody(text, 200)}`)
  const lease = JSON.parse(text) as LeaseResponse
  return { access: lease.access, accountId: lease.accountId }
}

// 接受整段终端输出而不只是一行:`claude setup-token` 会连同提示语一起打印,要求操作者
// 手抠出那一行,只会让他们改用剪贴板 —— 而剪贴板是这条路径唯一真正想避开的东西。
// 挑第一个 OAuth token 形状的串,挑不到就拒绝,不做模糊匹配。
function tokenFromFile(path: string): { access: string; accountId: string } {
  const raw = readFileSync(path, "utf8")
  const match = raw.match(/sk-ant-[A-Za-z0-9_-]{20,}/)
  if (!match) throw new Error(`${path} 里没有找到 OAuth token 形状的串(sk-ant-…)`)
  return { access: match[0], accountId: "(操作者自备,账号未知)" }
}

// ── 用量快照与差异 ────────────────────────────────────────────────────────────────────

type Snapshot = { phase: string; at: number; usage: UsageResponse }

function windowsOf(usage: UsageResponse): Map<string, UsageWindow> {
  const out = new Map<string, UsageWindow>()
  if (usage.five_hour) out.set("five_hour", usage.five_hour)
  if (usage.seven_day) out.set("seven_day", usage.seven_day)
  if (usage.seven_day_sonnet) out.set("seven_day_sonnet", usage.seven_day_sonnet)
  if (usage.seven_day_opus) out.set("seven_day_opus", usage.seven_day_opus)
  for (const scoped of usage.scoped ?? []) out.set(`scoped:${scoped.label}`, scoped)
  return out
}

const fmt = (w: UsageWindow | undefined): string => (w === undefined ? "—" : `${w.utilization.toFixed(4)}%`)

// fetchUsage throws `usage request failed (<status>)`; 从文本里捞状态码是唯一的办法,
// 但只用来分流,不用来推断语义。
function statusOf(error: unknown): number | undefined {
  const match = errorMessage(error).match(/\((\d{3})\)/)
  return match ? Number(match[1]) : undefined
}

export class UsageScopeError extends Error {}

// 403 = 这枚 token 没有读用量的 scope(`claude setup-token` 只申请 user:inference),
// 换个时间重试不会变;429 = 端点已知的持续发火,那是 INCONCLUSIVE 而不是降级。
// 两者混为一谈会让「这条路走不通」和「这次没测成」长得一样。
async function snapshot(access: string, phase: string): Promise<Snapshot> {
  try {
    return { phase, at: Date.now(), usage: await fetchUsage(access) }
  } catch (error) {
    if (statusOf(error) === 403) throw new UsageScopeError(errorMessage(error))
    throw new Error(`${phase} 快照拿不到(${errorMessage(error)})—— 判定 INCONCLUSIVE,不猜`)
  }
}

function printDelta(before: Snapshot, after: Snapshot, title: string): boolean {
  const b = windowsOf(before.usage)
  const a = windowsOf(after.usage)
  const keys = [...new Set([...b.keys(), ...a.keys()])].sort()
  console.log(`\n── ${title} ──`)
  console.log(`  ${"window".padEnd(26)}${"before".padEnd(12)}${"after".padEnd(12)}delta`)
  let moved = false
  for (const key of keys) {
    const bw = b.get(key)
    const aw = a.get(key)
    const delta = bw && aw ? aw.utilization - bw.utilization : undefined
    if (delta !== undefined && delta !== 0) moved = true
    const text = delta === undefined ? "n/a" : `${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`
    console.log(`  ${key.padEnd(26)}${fmt(bw).padEnd(12)}${fmt(aw).padEnd(12)}${text}`)
  }
  return moved
}

// ── 两条车道 ──────────────────────────────────────────────────────────────────────────

// 小请求的 delta 可能整个淹没在别人的流量里;medium 用一段可复述的填充把输入推到几万 token,
// 让这一次调用自己盖过噪声。内容无意义是故意的:要测的是计费,不是模型能力。
function promptFor(burn: "small" | "medium"): string {
  if (burn === "small") return "reply with the single word: ok"
  const filler = Array.from({ length: 1200 }, (_, i) => `line ${i}: the quick brown fox jumps over the lazy dog`).join("\n")
  return `${filler}\n\n以上内容不用读。只回答一个词:ok`
}

type LaneOutcome = {
  lane: Lane
  exitCode: number | null
  isError?: boolean
  apiErrorStatus?: unknown
  result?: string
  usage?: unknown
  serviceTier?: unknown
  stderr?: string
}

function runLane(lane: Lane, access: string, burn: "small" | "medium"): LaneOutcome {
  const cfg = mkdtempSync(join(tmpdir(), `gate1-${lane}-`))
  try {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      HOME: process.env.HOME ?? "",
      TERM: "dumb",
      // 沙箱化:不碰操作者自己的 ~/.claude 与 Keychain 条目(官方文档:Keychain entry 按 config dir 分键)
      CLAUDE_CONFIG_DIR: cfg,
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
    }
    if (lane === "env") {
      env.CLAUDE_CODE_OAUTH_TOKEN = access
      writeFileSync(join(cfg, "settings.json"), "{}")
    } else {
      // helper 车道:token 只经由脚本的 stdout 交给客户端,不进 settings、不进进程环境
      const helper = join(cfg, "helper.sh")
      writeFileSync(helper, `#!/bin/sh\ncat "${join(cfg, "tok")}"\n`, { mode: 0o755 })
      writeFileSync(join(cfg, "tok"), access, { mode: 0o600 })
      writeFileSync(join(cfg, "settings.json"), JSON.stringify({ apiKeyHelper: helper }))
    }
    const bin = process.env.CLAUDE_BIN ?? "claude"
    const r = spawnSync(
      bin,
      ["-p", promptFor(burn), "--output-format", "json", "--setting-sources", "user", "--model", "sonnet"],
      { env, encoding: "utf8", timeout: 180_000 },
    )
    let parsed: Record<string, unknown> | undefined
    try {
      parsed = JSON.parse(String(r.stdout ?? "").trim().split("\n").at(-1) ?? "")
    } catch {}
    return {
      lane,
      exitCode: r.status,
      isError: parsed?.is_error as boolean | undefined,
      apiErrorStatus: parsed?.api_error_status,
      result: typeof parsed?.result === "string" ? (parsed.result as string).slice(0, 160) : undefined,
      usage: parsed?.usage,
      serviceTier: (parsed?.usage as { service_tier?: unknown })?.service_tier,
      stderr: parsed ? undefined : redactBody(String(r.stderr ?? r.stdout ?? ""), 300),
    }
  } finally {
    rmSync(cfg, { recursive: true, force: true })
  }
}

// ── 主流程 ────────────────────────────────────────────────────────────────────────────

async function runLive(args: Args): Promise<number> {
  const source = args.source!
  const { access, accountId } = await (source.kind === "account"
    ? tokenFromAccount(source.idPrefix)
    : source.kind === "lease"
      ? tokenFromLease()
      : Promise.resolve(tokenFromFile(source.path)))
  console.log(`token 来源: ${source.kind} | 账号: ${accountId.slice(0, 8)} | token: ${redactToken(access)}`)
  console.log(`车道: ${args.lanes.join(" → ")} | 消耗档位: ${args.burn}\n`)

  // 降级而不是中止:车道 B 究竟是 401 还是 200,根本不需要用量端点 —— 而那才是本轮最贵的
  // 那一问。拿不到快照就把「扣费桶」这半交给浏览器人工复核,不要连能测的那半也一起放弃。
  let snapshots = true
  const snaps: Snapshot[] = []
  try {
    snaps.push(await snapshot(access, "BEFORE"))
  } catch (error) {
    if (!(error instanceof UsageScopeError)) throw error
    snapshots = false
    console.log("⚠ 这枚 token 读不了用量(403,scope 只有 user:inference)。")
    console.log("  降级:窗口 delta 这一半改由你在浏览器用量页人工读,车道判定照常跑。\n")
  }
  const outcomes: LaneOutcome[] = []
  for (const lane of args.lanes) {
    console.log(`▶ 车道 ${lane} 发请求中…`)
    const outcome = runLane(lane, access, args.burn)
    outcomes.push(outcome)
    console.log(`  exit=${outcome.exitCode} is_error=${outcome.isError} api_error_status=${JSON.stringify(outcome.apiErrorStatus)}`)
    if (outcome.result !== undefined) console.log(`  result: ${outcome.result}`)
    if (outcome.usage !== undefined) console.log(`  usage: ${JSON.stringify(outcome.usage)}`)
    if (outcome.stderr) console.log(`  stderr: ${outcome.stderr}`)
    if (snapshots) snaps.push(await snapshot(access, `AFTER-${lane}`))
  }

  let anyMoved = false
  for (let i = 1; i < snaps.length; i++) {
    anyMoved = printDelta(snaps[i - 1], snaps[i], `${snaps[i - 1].phase} → ${snaps[i].phase}`) || anyMoved
  }
  if (!snapshots) {
    console.log("\n窗口 delta:未测(token 无用量 scope)。上面的车道判定不依赖它。")
  }

  console.log("\n判读:")
  console.log("  · env 车道有 delta ⇒ 原生 claude 吃的是该账号订阅额度,「每会话一租约」成立。")
  console.log("  · helper 车道 401 ⇒ 该车道判死(好消息:响亮)。")
  console.log("  · helper 车道 200 且【无】 delta ⇒ 静默改判,最坏情形,立刻停用该车道。")
  console.log("  · 任一 delta 为 0 但请求成功 ⇒ 先查是不是聚合延迟,隔几分钟重跑,再看账单页。")
  console.log(`\n别忘了浏览器复核 extra usage 计数器 —— ${USAGE_ENDPOINT} 不暴露它。`)
  return snapshots && !anyMoved ? 2 : 0
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(`参数错误:${parsed.error}`)
    return 1
  }
  const { args } = parsed
  console.log(PROTOCOL)
  if (!args.yes) {
    console.log("干跑结束。要真的跑,加 --yes 并指定 token 来源(--account / --lease / --token-file)。")
    return 0
  }
  if (!args.source) {
    console.error("--yes 必须配一个 token 来源:--account <id前缀> / --lease / --token-file <路径>")
    return 1
  }
  try {
    return await runLive(args)
  } catch (error) {
    console.error(`\n中止:${errorMessage(error)}`)
    return 1
  }
}

process.exit(await main())
