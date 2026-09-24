// Claude Code 里的 /pool 面板 —— 纯函数:解析命令、定位账号、渲染 OMO 外观的彩色面板、拼钩子应答。
//
// 【为什么是文字面板】Claude Code 没有给插件自绘交互式 TUI 的接口,`!` 命令模式也不给 TTY(实测 2.1.281:
// `test -t 0` 为假),所以 OMO 的 ↑↓ + enter 在这里做不出来。能用的是 UserPromptSubmit 钩子:它拦下 `/pool`,
// 以 decision: block 把一段文字直接显示给用户、不进上下文 —— 上游收到的模型请求为 0。零 token、即时,
// 当前号撞墙、模型用不了的时候照样能看、能切(issue #97、#103)。
//
// 【长得像 OMO】照抄 dialogs.tsx 的 WorkerUsagePanel:标题 + 汇总、分隔线、每个号一行标题(● / ○、徽标、
// 持有者)加每个窗口一行 16 格块状进度条,多于 6 个号且终端够宽时双列。选中光标 `▶` 换成了行首编号 ——
// 文字里没有光标,编号就是 `/pool 3` 要敲的那个东西。
//
// 【颜色】reason 里的 ANSI 颜色会被照样画出来(实测 32/33/31/2 都生效)。Claude Code 给每一行先上一层
// 琥珀色,所以每行开头先 \x1b[0m 回到终端默认色 —— 面板要像 OMO,不是像一条警告。
//
//   /pool            面板
//   /pool 3          把本机共享号切到 #3(本机所有会话一起换);也可以写 id 前缀
//   /pool 3 pin      钉住 #3;对已钉住的号再来一次 = 取消钉住(OMO 的 p)
//   /pool r          让 master 立刻采一轮用量(OMO 的 r)
import type { UsageAccountView, UsageSnapshotView, UsageWindowView } from "../cloud/protocol.ts"
import {
  blockBar,
  displayWidth,
  holderChips,
  POOL_COLUMN_GAP,
  POOL_COLUMN_MIN_WIDTH,
  POOL_COLUMN_THRESHOLD,
  poolColumns,
  RESET_WIDTH,
  resetIn,
} from "../panel-model.ts"

// ── 命令 ─────────────────────────────────────────────────────────────────────────────────────

export type PanelCommand =
  | { kind: "list" }
  // pin: true 是 OMO 的 `p` —— 目标已经是本机钉住的号时取消钉住,否则切过去并钉住。
  | { kind: "switch"; target: string; pin: boolean }
  | { kind: "refresh" }
  | { kind: "help"; error?: string }

const POOL = /^\/pool(?:\s+([\s\S]*))?$/

/** 不是 /pool 就返回 undefined —— 钩子据此原样放行,不碰用户的输入。 */
export function parsePanelCommand(prompt: string): PanelCommand | undefined {
  const match = prompt.trim().match(POOL)
  if (!match) return undefined
  const args = (match[1] ?? "").trim().split(/\s+/).filter((token) => token.length > 0)
  if (args.length === 0) return { kind: "list" }
  const [first, second] = args
  if (args.length === 1) {
    if (first === "r" || first === "刷新") return { kind: "refresh" }
    if (first === "help") return { kind: "help" }
    if (first === "pin") return { kind: "help", error: "pin 要跟在编号后面,比如 /pool 3 pin" }
    return { kind: "switch", target: first, pin: false }
  }
  // 两种顺序都认:`/pool 3 pin` 是面板上写的,`/pool pin 3` 是 #97 时的写法,手熟的人会敲出来。
  if (args.length === 2 && second === "pin" && first !== "pin") return { kind: "switch", target: first, pin: true }
  if (args.length === 2 && first === "pin" && second !== "pin") return { kind: "switch", target: second, pin: true }
  return { kind: "help", error: `看不懂:/pool ${args.join(" ")}` }
}

export function isPoolCommand(prompt: string): boolean {
  return parsePanelCommand(prompt) !== undefined
}

/** 快照里的 8 位前缀与本机记下的前缀(钉住、relay 当前号)是不是同一个号。两边长度可能不同,所以双向比。 */
export function samePrefix(a: string, b: string): boolean {
  return a.startsWith(b) || b.startsWith(a)
}

export type TargetResult = { ok: true; account: UsageAccountView } | { ok: false; reason: string }

/**
 * 编号或 id 前缀 → 账号。编号按面板上显示的顺序(master 给的顺序,两次调用之间账号库没变就对得上);
 * 前缀必须唯一 —— 匹配到多个就拒绝,与 master 的 409 同一条规矩:绝不猜。
 *
 * 1–3 位数字是编号,4 位及以上按 id 前缀:id 是十六进制,`2277483b` 的前缀 `2277` 全是数字,
 * 当成编号就成了"没有 #2277"。
 */
export function resolveTarget(target: string, accounts: readonly UsageAccountView[]): TargetResult {
  if (/^\d{1,3}$/.test(target)) {
    const account = accounts[Number(target) - 1]
    return account === undefined ? { ok: false, reason: `没有 #${target}:面板上一共 ${accounts.length} 个号。` } : { ok: true, account }
  }
  if (!/^[0-9a-f]{4,}$/i.test(target)) {
    return { ok: false, reason: `「${target}」既不是编号,也不像账号 id 前缀(面板上那串十六进制,至少 4 位)。` }
  }
  const prefix = target.toLowerCase()
  const matches = accounts.filter((account) => samePrefix(account.idPrefix, prefix))
  if (matches.length === 1) return { ok: true, account: matches[0] }
  if (matches.length === 0) return { ok: false, reason: `没有以 ${prefix} 开头的账号。` }
  return { ok: false, reason: `${prefix} 匹配到 ${matches.length} 个账号,用更长的前缀。` }
}

export function helpText(error?: string): string {
  return [
    ...(error === undefined ? [] : [error, ""]),
    "/pool 用法:",
    "  /pool            看全池用量",
    "  /pool 3          把本机共享号切到 #3(本机所有会话一起换;也可以写 id 前缀)",
    "  /pool 3 pin      切过去并钉住,额度用满前不被轮换走;对已钉住的号再来一次 = 取消钉住",
    "  /pool r          让 master 立刻采一轮用量(master 30 秒内只采一次)",
  ].join("\n")
}

// ── 颜色 ─────────────────────────────────────────────────────────────────────────────────────
// 只用 16 色的基本码:跟着终端主题走,亮色、暗色主题下都读得清。与 OMO 的主题色一一对应:
// muted = textMuted,ok = success,warn = warning,error = error,cyan = 不自动切那个 #22D3EE。

type Tone = "plain" | "bold" | "muted" | "ok" | "warn" | "error" | "cyan"
const SGR: Record<Tone, string> = { plain: "", bold: "1", muted: "2", ok: "32", warn: "33", error: "31", cyan: "36" }
const ANSI = /\x1b\[[0-9;]*m/g

function paint(tone: Tone, text: string): string {
  return SGR[tone] === "" || text === "" ? text : `\x1b[${SGR[tone]}m${text}\x1b[0m`
}

/** 终端格数,颜色码不占格。 */
function cells(text: string): number {
  return displayWidth(text.replace(ANSI, ""))
}

function padTo(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - cells(text)))
}

/** 左右两端对齐到 width;放不下时中间至少留一格。 */
function justify(left: string, right: string, width: number): string {
  return `${left}${" ".repeat(Math.max(1, width - cells(left) - cells(right)))}${right}`
}

// 账号标签是邮箱、持有者是 workerId(形状校验过),都不该带控制字符;还是先剥掉 —— 一个 ESC 混进
// 面板就能把后面整段的颜色弄乱。
function clean(text: string): string {
  return text.replace(/[\x00-\x1f\x7f]/g, "")
}

// 空窗口不是"健康",是没用过:画成与 40% 一样的绿色,一墙闲着的号就会读成一墙在跑的号(OMO poolTone)。
function utilTone(util: number): Tone {
  if (util <= 0) return "muted"
  if (util >= 85) return "error"
  if (util >= 60) return "warn"
  return "ok"
}

// 与 dialogs.tsx 的 SHORT_WINDOW_LABELS、dashboardHtml.ts 的 SHORT_LABELS 同一张表,改一处要三处一起改。
// 不在表里的(按模型的动态周窗口,标签就是模型名)原样显示。
const SHORT_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_sonnet: "7d sonnet",
  seven_day_opus: "7d opus",
}

export function shortWindowLabel(label: string): string {
  return Object.hasOwn(SHORT_WINDOW_LABELS, label) ? SHORT_WINDOW_LABELS[label] : label
}

function truncate(text: string, width: number): string {
  if (displayWidth(text) <= width) return text
  let out = ""
  let used = 0
  for (const char of text) {
    const cost = displayWidth(char)
    if (used + cost > width - 1) break
    out += char
    used += cost
  }
  return `${out}…`
}

// ── 面板 ─────────────────────────────────────────────────────────────────────────────────────

export type Notice = { tone: "ok" | "warn" | "error"; text: string }

export type PanelView = {
  snapshot: UsageSnapshotView | undefined
  // 本机 relay 当前共享的号(前 8 位);relay 不在或还没领到时 undefined —— 此时 ● / ○ 一列留空,
  // 不画一排"本机没在用"的 ○(OMO 的三态,见 dialogs.tsx WorkerAccountRow)。
  current?: string
  // relay 在不在。不在时 current 必然 undefined,但"没领到号"与"relay 不在"要说成两句话。
  relayUp: boolean
  // 本机的钉住(id 前缀)。
  pin?: string
  workerId: string
  // 本机登记在 relay 上的会话数。
  sessions?: number
  // 面板上方先说的话(切号结果、错误)。
  notices?: readonly Notice[]
  // 终端列数;拿不到时 undefined,面板退回单列。
  terminalWidth?: number
  now: number
}

// Claude Code 给 reason 的每一行缩进两格;再留两格,免得一行正好顶到右边被折行。
const HOST_INDENT = 2
const EDGE_SLACK = 2
// OMO 对话框的内容宽度:medium 60、xlarge 116,各减去面板左右 padding 4(panel-model.ts 的 DIALOG_WIDTH)。
const OMO_MEDIUM_CONTENT = 56
const OMO_XLARGE_CONTENT = 112
const BAR_ROW_FIXED = 1 + 16 + 1 + 4 // 空格 + 进度条 + 空格 + 百分比
const RESET_CELLS = 1 + displayWidth("重置 ") + RESET_WIDTH

const IN_USE = " In Use"
const PINNED = "已钉住"
const COOLING = "冷却中"
const REAUTH = "需重新登录"
const EXCLUDED = "不自动切"
const LEGEND = "● 本机在用 · ○ 本机未用"
const HINTS = "/pool 编号 切号 · /pool 编号 pin 钉住/取消 · /pool r 刷新"

type Layout = { columns: number; columnWidth: number; contentWidth: number }

// 与 panel-model.ts 的 poolLayout 同一套规矩:不超过 6 个号单列;更多且放得下两列就两列,最多两列。
// 区别只在"宽度"从哪来:OMO 是对话框的固定宽度,这里是终端列数。拿不到列数就单列 —— 猜错的双列会整段折行。
function layoutFor(accounts: number, minColumn: number, terminalWidth: number | undefined): Layout {
  const avail = terminalWidth === undefined ? undefined : terminalWidth - HOST_INDENT - EDGE_SLACK
  if (accounts > POOL_COLUMN_THRESHOLD && avail !== undefined) {
    const content = Math.min(OMO_XLARGE_CONTENT, avail)
    const columnWidth = Math.floor((content - POOL_COLUMN_GAP) / 2)
    if (columnWidth >= minColumn) return { columns: 2, columnWidth, contentWidth: columnWidth * 2 + POOL_COLUMN_GAP }
  }
  const width = Math.max(minColumn, Math.min(OMO_MEDIUM_CONTENT, avail ?? OMO_MEDIUM_CONTENT))
  return { columns: 1, columnWidth: width, contentWidth: width }
}

function clock(at: number): string {
  const date = new Date(at)
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`
}

type BlockContext = {
  view: PanelView
  numberWidth: number
  labelWidth: number
  columnWidth: number
}

function windowRow(win: UsageWindowView, ctx: BlockContext): string {
  const tone = utilTone(win.utilization)
  const label = paint("muted", shortWindowLabel(clean(win.label)).padEnd(ctx.labelWidth))
  const pct = `${Math.round(win.utilization)}%`.padStart(4)
  const reset =
    win.resetsAt === undefined ? "" : paint("muted", ` 重置 ${resetIn(win.resetsAt, ctx.view.now).padStart(RESET_WIDTH)}`)
  return `${label} ${paint(tone, blockBar(win.utilization))} ${paint(tone, pct)}${reset}`
}

function accountBlock(account: UsageAccountView, index: number, ctx: BlockContext): string[] {
  const { view } = ctx
  const held = view.current === undefined ? undefined : samePrefix(account.idPrefix, view.current)
  const pinned = view.pin !== undefined && samePrefix(account.idPrefix, view.pin)
  const marker = held === undefined ? " " : held ? paint("ok", "●") : paint("muted", "○")

  // 标题行左半:编号、标记、标签,然后是状态与徽标。钉住只会钉在本机在用的号上,所以"已钉住"顶替
  // " In Use" 而不是跟在它后面(OMO 同样如此)。
  const tail: string[] = []
  if (pinned) tail.push(` ${paint("warn", PINNED)}`)
  if (account.coolingDown) tail.push(` ${paint("warn", COOLING)}`)
  if (account.needsReauth) tail.push(` ${paint("error", REAUTH)}`)
  const state = held === true && !pinned ? IN_USE : ""
  const head = `${String(index + 1).padStart(ctx.numberWidth)} ${marker} `

  // 右半:持有者(本机自己绿色、钉住了这个号的机器琥珀色、其余灰)+ 不自动切。
  const excluded = account.excluded ? paint("cyan", EXCLUDED) : ""
  const fixed = cells(head) + cells(state) + tail.reduce((sum, part) => sum + cells(part), 0)
  const label = truncate(clean(account.label), Math.max(8, ctx.columnWidth - fixed - (excluded === "" ? 0 : 1 + cells(excluded))))
  const labelText = held === true ? paint("bold", `${label}${state}`) : `${label}${state}`
  const left = `${head}${labelText}${tail.join("")}`
  const budget = ctx.columnWidth - cells(left) - 1 - (excluded === "" ? 0 : 1 + cells(excluded))
  const holders = (account.holders ?? []).map(clean)
  const chips = holderChips(holders, budget)
  const pinners = account.pinnedBy ?? []
  const right = [
    ...chips.names.map((name) => paint(name === view.workerId ? "ok" : pinners.includes(name) ? "warn" : "muted", name)),
    ...(chips.overflow > 0 ? [paint("muted", `+${chips.overflow}`)] : []),
    ...(excluded === "" ? [] : [excluded]),
  ].join(" ")
  const title = right === "" ? left : justify(left, right, ctx.columnWidth)

  const indent = " ".repeat(ctx.numberWidth + 3)
  if (!account.hasUsage || account.windows.length === 0) return [title, `${indent}${paint("muted", "额度未知(不在本次快照)")}`]
  return [title, ...account.windows.map((win) => `${indent}${windowRow(win, ctx)}`)]
}

function summary(accounts: readonly UsageAccountView[]): string {
  // "可用" 是池子自己的说法:这个号现在能派给本机。不是用量阈值 —— 用了 90% 的号仍然可用。
  const usable = accounts.filter((a) => !a.coolingDown && !a.needsReauth && !a.excluded).length
  // 只有快照证明 master 在记持有者时才说"在用":老 master 不发这个字段,那时的 `0 在用` 是没人算过的数。
  const tracked = accounts.some((a) => a.holders !== undefined)
  const busy = accounts.filter((a) => (a.holders?.length ?? 0) > 0).length
  return `${accounts.length} 个账号 · ${usable} 可用${tracked ? ` · ${busy} 在用` : ""}`
}

export function renderPanel(view: PanelView): string {
  const accounts = view.snapshot?.accounts ?? []
  const numberWidth = String(Math.max(1, accounts.length)).length
  const labels = accounts.flatMap((a) => (a.hasUsage ? a.windows.map((w) => displayWidth(shortWindowLabel(clean(w.label)))) : []))
  const labelWidth = Math.max(6, ...labels)
  const withReset = accounts.some((a) => a.windows.some((w) => w.resetsAt !== undefined))
  const barRow = numberWidth + 3 + labelWidth + BAR_ROW_FIXED + (withReset ? RESET_CELLS : 0)
  const layout = layoutFor(accounts.length, Math.max(POOL_COLUMN_MIN_WIDTH, barRow), view.terminalWidth)
  const width = layout.contentWidth
  const divider = paint("muted", "─".repeat(width))

  const lines: string[] = []
  for (const notice of view.notices ?? []) lines.push(paint(notice.tone, notice.text))
  if ((view.notices ?? []).length > 0) lines.push("")

  lines.push(justify(paint("bold", "账号池用量"), view.snapshot === undefined ? "" : paint("muted", summary(accounts)), width))
  const machine = !view.relayUp
    ? `本机 ${view.workerId} · relay 不在`
    : view.current === undefined
      ? `本机 ${view.workerId} · 还没领到号`
      : `本机 ${view.workerId}${view.sessions === undefined ? "" : ` · ${view.sessions} 个会话在用`}`
  const taken = view.snapshot === undefined ? "" : view.snapshot.at > 0 ? `快照于 ${clock(view.snapshot.at)}` : "尚未采集"
  lines.push(justify(paint("muted", machine), paint("muted", taken), width))
  lines.push(divider)

  if (view.snapshot === undefined) {
    lines.push(paint("muted", "拿不到 master 的用量数据 —— master 可能暂时不可达"))
  } else {
    if (view.snapshot.stale) lines.push(paint("warn", "⚠ 快照已陈旧,master 可能已停止轮询,以下数字仅供参考"))
    if (accounts.length === 0) lines.push(paint("muted", "账号池暂无用量数据"))
    const ctx: BlockContext = { view, numberWidth, labelWidth, columnWidth: layout.columnWidth }
    const blocks = accounts.map((account, i) => accountBlock(account, i, ctx))
    // 按列填(与 OMO 同):编号在屏幕上自上而下读,而不是左右跳。块与块之间空一行(OMO 的 gap={1})。
    const columns = poolColumns(blocks, layout.columns).map((column) => column.flatMap((block, i) => (i === 0 ? block : ["", ...block])))
    const height = Math.max(0, ...columns.map((column) => column.length))
    for (let row = 0; row < height; row += 1) {
      const cellsInRow = columns.map((column, ci) => (ci < columns.length - 1 ? padTo(column[row] ?? "", layout.columnWidth) : (column[row] ?? "")))
      lines.push(cellsInRow.join(" ".repeat(POOL_COLUMN_GAP)).replace(/ +$/, ""))
    }
  }

  lines.push(divider, paint("muted", LEGEND), paint("muted", HINTS))
  return lines.map((line) => `\x1b[0m${line}`).join("\n")
}

/**
 * UserPromptSubmit 钩子的应答:拦下这条输入、把面板显示给用户。`reason` 不进上下文。
 *
 * suppressOriginalPrompt 在 hookSpecificOutput 里,不在顶层(2.1.281 的 schema:hookEventName、
 * additionalContext、sessionTitle、suppressOriginalPrompt)—— #97 把它放在顶层,于是
 * "Original prompt: /pool" 那一行一直都在。
 */
export function hookResponse(text: string): string {
  return JSON.stringify({
    decision: "block",
    reason: text,
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
  })
}
