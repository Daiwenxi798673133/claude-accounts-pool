// Claude Code 里的 /pool 面板 —— 纯函数:认出 /pool、渲染文字面板、拼钩子应答。
//
// 【为什么是文字面板】Claude Code 没有给插件自绘交互式 TUI 的接口。能用的是 UserPromptSubmit 钩子:
// 实测(claude 2.1.280)它能拦下 `/pool`(有没有同名 skill 都一样),以 decision: block 把一段文字直接
// 显示给用户、不进上下文 —— 上游收到的模型请求为 0。所以零 token、即时,当前号撞墙、模型用不了的时候
// 照样能看(issue #97)。
//
// 【只有一条命令】/pool 只显示面板;带参数也一样(issue #101:切号、钉住的衍生命令不要)。
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"

/** 这条输入是不是 /pool。不是就原样放行,不碰用户的输入。 */
export function isPoolCommand(prompt: string): boolean {
  return /^\/pool(?:\s|$)/.test(prompt.trim())
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
  // 面板上方要先说的一句话(比如 relay 不在)。
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
    return lines.join("\n")
  }
  if (view.snapshot.stale) lines.push("(用量数据已过期,数字可能不是最新的)")
  lines.push("", "  #  账号        5h    7d   状态")
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
  return lines.join("\n")
}

/**
 * UserPromptSubmit 钩子的应答:拦下这条输入、把面板显示给用户。`reason` 不进上下文,
 * suppressOriginalPrompt 省掉"Original prompt: /pool"那一行(2.1.280 上实测不一定生效,无害)。
 */
export function hookResponse(text: string): string {
  return JSON.stringify({ decision: "block", reason: text, suppressOriginalPrompt: true })
}
