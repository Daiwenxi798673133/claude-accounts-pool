// GATE 0 / EXPERIMENT 1 — billing attribution of a LEASED access token.
//
// Does usage run with a master-leased access token bill against THAT account's subscription
// window, or is it silently reclassified (metered / overage / another tenant)? A 200 proves
// NOTHING — only the usage DELTA on the leased account's own windows does.
//
// Owner-run diagnostic, NOT a test: it touches real endpoints and a real subscription, so every
// network call is gated behind --yes. READ-ONLY on local credential files, and it never
// refreshes — rotating a real chain is experiment 2's job.
//
//   bun scripts/gate0-billing-attribution.ts                      # dry run, protocol only
//   bun scripts/gate0-billing-attribution.ts --yes --account <id> # real run
import { createInterface } from "node:readline/promises"
import { loadAccounts, providerOf } from "../src/accounts.ts"
import { USAGE_ENDPOINT } from "../src/constants.ts"
import { redactBody } from "../src/logger.ts"
import { fetchUsage, type UsageResponse, type UsageWindow } from "../src/usage.ts"

const PROTOCOL = `
════════════════════════════════════════════════════════════════════════
 GATE 0 / 实验一:租借 access token 的计费归属
════════════════════════════════════════════════════════════════════════

要回答的问题
  中心 master 持有 refresh token,把短时效 access token 租借给 worker。worker 用这个
  租借来的 token 跑推理时,用量到底记在「该账号的订阅窗口」上,还是被服务端悄悄改判
  到别处(按量计费 / overage / 其它租户)?
  200 响应本身什么都证明不了。唯一的证据是该账号自己的用量窗口出现了 DELTA。

前置条件
  1. 一个可接受消耗少量额度的 Claude 订阅账号,已被本插件收录
     (账号库:~/.config/opencode/claude-accounts.json)。
  2. 该账号记录里有未过期的 access token(本脚本绝不刷新,以免轮换真实链)。
  3. 一台能用「租借 token」直接调 Anthropic 推理接口的 worker。

步骤
  1. 运行:bun scripts/gate0-billing-attribution.ts --yes --account <账号id>
     脚本打印 BEFORE 快照(来自 ${USAGE_ENDPOINT})。
  2. 脚本停下等你回车。此时到 worker 上,用这个被租借的 access token 发【恰好一次】
     小请求(几十 token 即可,别跑大任务:延迟越小归因越干净)。记下 HTTP 状态码
     —— 但别把它当成结论。
  3. 回到脚本按回车。脚本抓 AFTER 快照,并按窗口打印 BEFORE/AFTER 差异表。

判定标准
  PASS  租借账号自己的订阅窗口(five_hour / seven_day / 各受限模型周窗口)出现非零
        delta ⇒ 流量确实吃的是这个账号的订阅额度,「共享订阅额度」前提成立。
  FAIL  该账号窗口没有任何 delta ⇒ 流量被归到了别处(静默改判)。这是最坏的失败
        模式:请求成功、钱记在别人头上。此时整个架构的价值前提不成立。

必须人工复核(不可省略)
  本接口的数字不足以单独证明归属正确:「200 + 记到错误的 bucket」可能在这几个数字里
  根本看不出来。所以你【还必须】用浏览器打开该账号的用量/账单页面亲眼确认:
  (a) 这次调用出现在该账号名下;(b) 它算进的是订阅额度而不是按量计费 / overage。
  两边一致才算 PASS。

诚实性说明
  · ${USAGE_ENDPOINT} 已知有持续 429 的行为。撞 429 时报「结论不成立(INCONCLUSIVE)」
    并以非零码退出,不做激进重试 —— 拿不到快照就是拿不到,不猜、不补。
  · 窗口 delta 可能有服务端聚合延迟。若 AFTER 全零,隔几分钟重跑一轮再判 FAIL。
`

type Args = { yes: boolean; accountId?: string }
type Parsed = { ok: true; args: Args } | { ok: false; error: string }

function parseArgs(argv: readonly string[]): Parsed {
  let yes = false
  let accountId: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--yes") {
      yes = true
      continue
    }
    if (arg === "--account") {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) return { ok: false, error: "--account 需要一个账号 id" }
      accountId = value
      index++
      continue
    }
    return { ok: false, error: `未知参数: ${arg}` }
  }
  return { ok: true, args: { yes, accountId } }
}

/** Tokens are NEVER printed in full: the owner is expected to paste this output into an issue. */
function redactToken(token: string): string {
  return `${token.slice(0, 8)}…(len=${token.length})`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// fetchUsage throws `usage request failed (<status>)`; recovering the status from that text is
// the only way to tell a rate-limited (inconclusive) run from a genuinely failed one without
// duplicating the endpoint call + `limits[]` normalization this experiment wants to measure.
function statusOf(error: unknown): number | undefined {
  const match = /\((\d{3})\)/.exec(errorMessage(error))
  return match ? Number(match[1]) : undefined
}

type Snapshot = { at: number; usage: UsageResponse }

const FIXED_WINDOWS = ["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus"] as const

function windowsOf(usage: UsageResponse): Map<string, UsageWindow> {
  const out = new Map<string, UsageWindow>()
  for (const key of FIXED_WINDOWS) {
    const window = usage[key]
    if (window) out.set(key, window)
  }
  for (const scoped of usage.scoped ?? []) out.set(`weekly:${scoped.label}`, scoped)
  return out
}

function formatUtilization(window: UsageWindow | undefined): string {
  return window ? window.utilization.toFixed(4) : "—"
}

function printSnapshot(title: string, snapshot: Snapshot): void {
  const windows = windowsOf(snapshot.usage)
  console.log(`\n${title}  (${new Date(snapshot.at).toISOString()})`)
  if (windows.size === 0) {
    console.log("  该账号没有返回任何用量窗口。")
    return
  }
  for (const [key, window] of windows) {
    console.log(`  ${key.padEnd(24)} utilization=${formatUtilization(window)}  resets_at=${window.resets_at ?? "—"}`)
  }
}

function printDelta(before: Snapshot, after: Snapshot): boolean {
  const beforeWindows = windowsOf(before.usage)
  const afterWindows = windowsOf(after.usage)
  const keys = [...new Set([...beforeWindows.keys(), ...afterWindows.keys()])].sort()
  console.log("\n── BEFORE / AFTER 差异表 ──────────────────────────────────────────────")
  console.log(`  ${"window".padEnd(24)}${"before".padEnd(12)}${"after".padEnd(12)}${"delta".padEnd(12)}resets_at (before → after)`)
  let moved = false
  for (const key of keys) {
    const beforeWindow = beforeWindows.get(key)
    const afterWindow = afterWindows.get(key)
    const delta = beforeWindow && afterWindow ? afterWindow.utilization - beforeWindow.utilization : undefined
    if (delta !== undefined && delta !== 0) moved = true
    const deltaText = delta === undefined ? "n/a" : `${delta >= 0 ? "+" : ""}${delta.toFixed(4)}`
    console.log(`  ${key.padEnd(24)}${formatUtilization(beforeWindow).padEnd(12)}${formatUtilization(afterWindow).padEnd(12)}${deltaText.padEnd(12)}${beforeWindow?.resets_at ?? "—"} → ${afterWindow?.resets_at ?? "—"}`)
  }
  return moved
}

async function snapshot(access: string, phase: string): Promise<Snapshot> {
  try {
    return { at: Date.now(), usage: await fetchUsage(access) }
  } catch (error) {
    const status = statusOf(error)
    console.error(`\n[${phase}] 快照失败: ${redactBody(errorMessage(error))}`)
    if (status === 429) {
      console.error("裁决:INCONCLUSIVE — /api/oauth/usage 返回 429(已知的持续限流行为)。")
      console.error("不做激进重试。请稍后整轮重跑,或改用浏览器上的用量页面取证。")
    }
    throw error
  }
}

async function runLive(accountId: string): Promise<number> {
  const file = await loadAccounts()
  const account = file.accounts.find((item) => item.id === accountId)
  if (!account) {
    console.error(`账号未找到: ${accountId}(账号库里没有这个 id)`)
    return 2
  }
  const provider = providerOf(account)
  if (provider !== "anthropic") {
    console.error(`账号 ${accountId} 的 provider 是 ${provider},本实验只针对 anthropic 订阅。`)
    return 2
  }
  if (!account.access) {
    console.error(`账号 ${account.label} 本地没有 access token。本脚本绝不刷新(那会轮换真实链),请先在插件里刷新一次。`)
    return 2
  }

  console.log("── 实验对象 ──────────────────────────────────────────────────────────")
  console.log(`  id        ${account.id}`)
  console.log(`  label     ${account.label}`)
  console.log(`  provider  ${provider}`)
  console.log(`  access    ${redactToken(account.access)}`)
  console.log(`  expires   ${account.expires ? new Date(account.expires).toISOString() : "未知"}`)
  if (account.expires !== undefined && account.expires < Date.now()) {
    console.log("  ⚠ 该 access token 按本地记录已过期,快照大概率会 401。请先在插件里刷新后重跑。")
  }

  const before = await snapshot(account.access, "BEFORE")
  printSnapshot("BEFORE 快照", before)

  console.log("\n────────────────────────────────────────────────────────────────────────")
  console.log("现在请到 worker 上,用【上面这个被租借的 access token】发恰好一次小请求。")
  console.log("越小越好(几十 token),记下 HTTP 状态码 —— 但别把 200 当结论。")
  console.log("完成后回到这里按回车,脚本会抓 AFTER 快照。")
  console.log("────────────────────────────────────────────────────────────────────────")
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  await rl.question("按回车继续 > ")
  rl.close()

  const after = await snapshot(account.access, "AFTER")
  printSnapshot("AFTER 快照", after)
  const moved = printDelta(before, after)

  console.log("\n判定标准:PASS = 该账号自己的订阅窗口出现非零 delta;FAIL = 没有 delta(流量被归到别处)。")
  console.log("别忘了:必须再用浏览器打开该账号的用量/账单页面,确认这次调用算的是订阅额度而不是按量计费。")
  if (moved) console.log("\n最终裁决:PASS(待人工复核)— 租借 token 的用量确实落在该账号的订阅窗口上。")
  else console.log("\n最终裁决:FAIL — 该账号窗口无任何 delta,流量疑似被静默改判;「共享订阅额度」前提不成立。")
  return 0
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.error)
    console.error("用法: bun scripts/gate0-billing-attribution.ts [--yes --account <账号id>]")
    return 2
  }
  // SAFETY GATE — checked before ANY network call: everything below `runLive` is unreachable
  // without --yes, so a bare invocation is guaranteed to be zero-network.
  if (!parsed.args.yes) {
    console.log(PROTOCOL)
    console.log("这是 DRY RUN:没有发起任何网络请求。真跑请加 --yes --account <账号id>。")
    console.log("\n最终裁决:DRY RUN — 只打印协议,未做任何实验。")
    return 0
  }
  if (!parsed.args.accountId) {
    console.error("--yes 必须配合 --account <账号id>:不指定账号就没有可归因的对象。")
    return 2
  }
  return runLive(parsed.args.accountId)
}

try {
  process.exitCode = await main()
} catch (error) {
  // Not redundant with Bun's own non-zero exit: an unhandled rejection prints a stack trace
  // and NO verdict line, which is exactly what a pasted transcript must never be ambiguous about.
  console.error(`\n运行失败: ${redactBody(errorMessage(error))}`)
  console.error("\n最终裁决:ERROR — 实验未完成(操作性失败),不构成 PASS 也不构成 FAIL。")
  process.exitCode = 1
}
