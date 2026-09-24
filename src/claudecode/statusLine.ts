// Claude Code 底部状态栏:本机共享号的 5h / 7d 进度条,常驻(issue #103)。
//
// 数字与 /pool 面板同源 —— master 的用量快照,号是 relay 手里的那一个 —— 而不是 Claude Code 自己塞进
// 状态栏输入的 rate_limits:那份来自 claude 进程自己看到的响应头,relay 换号之后要等下一个请求才跟上,
// 而且 profile / usage 端点直连 Anthropic、用的是启动 token,未必是 relay 现在的号。
//
// 【缓存】状态栏每 30 秒、外加每条消息之后都会跑一次,本机每个会话各跑各的。快照放在一个文件里
// 20 秒内共用,master 看到的是"每台机器每 20 秒最多一次",而不是"每个会话每次刷新一次"。
import type { UsageSnapshotView, UsageWindowView } from "../cloud/protocol.ts"
import { blockBar, resetIn } from "../panel-model.ts"
import type { RelayHealth } from "./relay.ts"
import { samePrefix } from "./panel.ts"

export const STATUS_BAR_WIDTH = 10
export const STATUS_USAGE_TTL_MS = 20_000
// master 连不上时,多旧的缓存还肯拿来画:数字会过时,但"用的是哪个号"不会错,比一片空白有用。
export const STATUS_USAGE_MAX_AGE_MS = 10 * 60_000

export type CachedUsage = { fetchedAt: number; view: UsageSnapshotView }

export async function statusSnapshot(deps: {
  read: () => CachedUsage | undefined
  write: (cached: CachedUsage) => void
  fetch: () => Promise<UsageSnapshotView | undefined>
  now: () => number
}): Promise<UsageSnapshotView | undefined> {
  const cached = deps.read()
  const now = deps.now()
  if (cached !== undefined && now - cached.fetchedAt >= 0 && now - cached.fetchedAt < STATUS_USAGE_TTL_MS) return cached.view
  const fresh = await deps.fetch()
  if (fresh !== undefined) {
    deps.write({ fetchedAt: now, view: fresh })
    return fresh
  }
  return cached !== undefined && now - cached.fetchedAt < STATUS_USAGE_MAX_AGE_MS ? cached.view : undefined
}

const paint = (code: string, text: string): string => `\x1b[${code}m${text}\x1b[0m`
const MUTED = "2"

// 与面板同一套分档(panel.ts utilTone / OMO poolTone)。
function tone(util: number): string {
  if (util <= 0) return MUTED
  if (util >= 85) return "31"
  if (util >= 60) return "33"
  return "32"
}

function windowCell(name: string, win: UsageWindowView | undefined, now: number): string {
  if (win === undefined) return ""
  const code = tone(win.utilization)
  const reset = win.resetsAt === undefined ? "" : ` ${paint(MUTED, resetIn(win.resetsAt, now))}`
  return `${paint(MUTED, name)} ${paint(code, blockBar(win.utilization, STATUS_BAR_WIDTH))} ${paint(code, `${Math.round(win.utilization)}%`)}${reset}`
}

const PREFIX = paint(MUTED, "账号池")

export function renderStatusLine(input: {
  health: RelayHealth | undefined
  snapshot: UsageSnapshotView | undefined
  pin?: string
  now: number
}): string {
  if (input.health === undefined) return `${PREFIX} ${paint("33", "relay 不在")}`
  const current = input.health.accountId
  if (current === undefined) return `${PREFIX} ${paint(MUTED, "还没领到号")}`
  const account = input.snapshot?.accounts.find((a) => samePrefix(a.idPrefix, current))
  // 邮箱的本地部分:整个池子共用一个域名,@ 后面不带信息。前缀照留 —— master 日志认的是它。
  const name = account === undefined ? "" : `${account.label.replace(/[\x00-\x1f\x7f]/g, "").split("@")[0]} `
  const parts = [`${PREFIX} ${paint("32", "●")} ${name}${paint(MUTED, current.slice(0, 8))}`]
  const badges: string[] = []
  if (input.pin !== undefined && samePrefix(input.pin, current)) badges.push(paint("33", "已钉住"))
  if (account?.coolingDown) badges.push(paint("33", "冷却中"))
  if (account?.needsReauth) badges.push(paint("31", "需重新登录"))
  if (badges.length > 0) parts[0] += ` ${badges.join(" ")}`
  if (account === undefined || !account.hasUsage) {
    parts.push(paint(MUTED, "用量未知"))
  } else {
    for (const [name, label] of [
      ["5h", "five_hour"],
      ["7d", "seven_day"],
    ] as const) {
      const cell = windowCell(name, account.windows.find((w) => w.label === label), input.now)
      if (cell !== "") parts.push(cell)
    }
  }
  return parts.join(paint(MUTED, " · "))
}
