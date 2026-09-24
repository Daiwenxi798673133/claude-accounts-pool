// Claude Code 里的 /pool 面板 —— 纯函数:解析命令、定位账号、渲染文字面板、拼钩子应答。
//
// 【为什么是文字面板】Claude Code 没有给插件自绘交互式 TUI 的接口。能用的是 UserPromptSubmit 钩子:
// 实测(claude 2.1.280)它能拦下 `/pool`(有没有同名 skill 都一样),以 decision: block 把一段文字直接
// 显示给用户、不进上下文 —— 上游收到的模型请求为 0。所以面板是"看一眼 + 敲一条命令",零 token、即时,
// 而且当前号撞墙、模型用不了的时候照样能切(issue #97)。
//
//   /pool              列出全池账号
//   /pool 3            把本机共享号切到 #3(本机所有会话一起换)
//   /pool af008f89     同上,按 id 前缀
//   /pool pin 3        切过去并钉住
//   /pool unpin        取消钉住
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"

export type PanelCommand =
  | { kind: "list" }
  | { kind: "switch"; target: string; pin: boolean }
  | { kind: "unpin" }
  | { kind: "help"; error?: string }

const POOL = /^\/pool(?:\s+([\s\S]*))?$/

/** 不是 /pool 就返回 undefined —— 钩子据此原样放行,不碰用户的输入。 */
export function parsePanelCommand(prompt: string): PanelCommand | undefined {
  const match = prompt.trim().match(POOL)
  if (!match) return undefined
  const args = (match[1] ?? "").trim().split(/\s+/).filter((token) => token.length > 0)
  if (args.length === 0) return { kind: "list" }
  const [first, second, ...extra] = args
  if (extra.length > 0) return { kind: "help", error: `看不懂:/pool ${args.join(" ")}` }
  if (first === "help" && second === undefined) return { kind: "help" }
  if (first === "unpin" && second === undefined) return { kind: "unpin" }
  if (first === "pin") {
    return second === undefined ? { kind: "help", error: "pin 后面要跟编号或 id 前缀,比如 /pool pin 3" } : { kind: "switch", target: second, pin: true }
  }
  if (second !== undefined) return { kind: "help", error: `看不懂:/pool ${args.join(" ")}` }
  return { kind: "switch", target: first, pin: false }
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
    const index = Number(target)
    const account = accounts[index - 1]
    return account === undefined ? { ok: false, reason: `没有 #${target}:面板上一共 ${accounts.length} 个号。` } : { ok: true, account }
  }
  if (!/^[0-9a-f]{4,}$/i.test(target)) {
    return { ok: false, reason: `「${target}」既不是编号,也不像账号 id 前缀(看板上那串十六进制,至少 4 位)。` }
  }
  const prefix = target.toLowerCase()
  const matches = accounts.filter((account) => account.idPrefix.startsWith(prefix) || prefix.startsWith(account.idPrefix))
  if (matches.length === 1) return { ok: true, account: matches[0] }
  if (matches.length === 0) return { ok: false, reason: `没有以 ${prefix} 开头的账号。` }
  return { ok: false, reason: `${prefix} 匹配到 ${matches.length} 个账号,用更长的前缀。` }
}

const pct = (account: UsageAccountView, label: string): string => {
  const window = account.windows.find((w) => w.label === label)
  return window === undefined ? "–" : `${Math.round(window.utilization)}%`
}

export type PanelView = {
  snapshot: UsageSnapshotView | undefined
  // 本机 relay 当前共享的号(前 8 位);relay 不在或还没领到时 undefined。
  current?: string
  // 本机的钉住(id 前缀)。
  pin?: string
  workerId: string
  // 本机登记在 relay 上的会话数。
  sessions?: number
  // 面板上方要先说的一句话(切号结果、错误)。
  notice?: string
}

export function renderPanel(view: PanelView): string {
  const lines: string[] = []
  if (view.notice !== undefined) lines.push(view.notice, "")
  const shared = view.current === undefined ? "尚未领取" : view.current
  const sessions = view.sessions === undefined ? "" : ` · ${view.sessions} 个会话在用`
  lines.push(`账号池 · 本机 ${view.workerId} · 共享 ${shared}${sessions}`)
  if (view.snapshot === undefined) {
    lines.push("", "(拿不到 master 的用量数据 —— master 可能暂时不可达)")
  } else {
    if (view.snapshot.stale) lines.push("(用量数据已过期,数字可能不是最新的)")
    lines.push("")
    lines.push("  #  账号        5h    7d   状态")
    view.snapshot.accounts.forEach((account, i) => {
      const tags: string[] = []
      if (account.idPrefix === view.current) tags.push("← 当前")
      if (view.pin !== undefined && (account.idPrefix.startsWith(view.pin) || view.pin.startsWith(account.idPrefix))) tags.push("📌 钉住")
      if (account.needsReauth) tags.push("需重登")
      else if (account.coolingDown) tags.push("冷却中")
      if (account.excluded) tags.push("不自动切")
      const holders = account.holders?.length ?? 0
      if (holders > 0) tags.push(`${holders} 台在用`)
      const row = `${String(i + 1).padStart(3)}  ${account.idPrefix}  ${pct(account, "five_hour").padStart(4)}  ${pct(account, "seven_day").padStart(4)}   ${tags.join(" · ")}`
      lines.push(row.trimEnd(), `        ${account.label}`)
    })
  }
  lines.push("", "  /pool 3        切到 #3(本机所有会话一起换)", "  /pool pin 3    切到 #3 并钉住", "  /pool unpin    取消钉住")
  return lines.join("\n")
}

export function helpText(error?: string): string {
  return [
    ...(error === undefined ? [] : [error, ""]),
    "/pool 用法:",
    "  /pool              列出全池账号",
    "  /pool 3            把本机共享号切到 #3(也可以写 id 前缀)",
    "  /pool pin 3        切过去并钉住,额度用满前不被轮换走",
    "  /pool unpin        取消钉住",
  ].join("\n")
}

/**
 * UserPromptSubmit 钩子的应答:拦下这条输入、把面板显示给用户。`reason` 不进上下文,
 * suppressOriginalPrompt 省掉"Original prompt: /pool"那一行 —— 用户刚敲的就是它,不用复述。
 */
export function hookResponse(text: string): string {
  return JSON.stringify({ decision: "block", reason: text, suppressOriginalPrompt: true })
}
