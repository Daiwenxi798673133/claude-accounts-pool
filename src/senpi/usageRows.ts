import type { UsageAccountView, UsageSnapshotView, UsageWindowView } from "../cloud/protocol.ts"
import { displayWidth, heldStateFor, holderChips } from "../panel-model.ts"

// The 账号池用量 panel, rendered for senpi instead of for the TUI's own dialog. senpi gives us exactly
// one primitive — `ctx.ui.select(title, options: string[])` — which draws each option as ONE raw line
// with no truncation and hands back the SELECTED STRING. Three consequences shape this whole file:
//
//   1. A row must be SELF-IDENTIFYING. There is no index, no key, no object: the string is the handle.
//      Hence `accountByRow`, and hence the row-uniqueness invariant below.
//   2. A row must be UNIQUE. Two accounts producing the same string collapse into one selectable
//      entry and the Map resolves to whichever one was inserted last. Column 1 is `idPrefix`, which
//      the master guarantees distinct, so uniqueness is a property of the layout — not of the data.
//      Labels are NOT unique (two pool entries can share an email), so it may never come from those.
//   3. Alignment is OURS to do. senpi pads nothing, so every column is space-padded here, measured in
//      TERMINAL CELLS via displayWidth — an account label is an email but a truncated one grows a
//      `…`, and this panel's own Chinese flags occupy two cells per glyph.
//
// PURE, and it must stay that way: no I/O, no senpi import, and no clock. `panelTitle` formats
// `view.at` and never reads Date.now(), so a snapshot renders identically whenever it is rendered.

// One source of truth for the layout, shared with usageRows.test.ts. The alignment test derives its
// expected cell offsets from these, so widening a column here cannot silently un-align the panel.
export const COLUMN_WIDTH = {
  // 8 hex chars of the account uuid, exactly as the master publishes it.
  id: 8,
  // Fits `vince.dai2@potentia.ai` (22 cells) whole — the pool's own labels are the common case.
  label: 22,
  // The holder budget holderChips() drops names against.
  held: 16,
  // `pin` / `?` / blank.
  pin: 3,
} as const

// Two spaces per gap. One reads as a single wide column on a terminal without column rules.
export const COLUMN_GAP = 2

// The sentinel that re-fetches. CANNOT COLLIDE with an account row: every account row begins with 8
// hex characters, and this begins with `↻`.
export const REFRESH_ROW = "↻ 重新采集"

// One senpi token slot and the FULL account uuid it currently holds. Full, not a prefix — a lease
// names the whole id — which is why matching it against a row is a startsWith test.
export type SlotHold = { slotName: string; accountId?: string }

// `five_hour` / `seven_day` are the fixed pair; anything else is a dynamic per-model weekly window
// whose label IS a model display name (`Fable`) and must pass through VERBATIM — a lookup that fell
// back to a placeholder would erase which model the row is about.
const WINDOW_SHORT_LABEL: Record<string, string> = { five_hour: "5h", seven_day: "7d" }

function padCell(text: string, width: number): string {
  const pad = width - displayWidth(text)
  return pad > 0 ? text + " ".repeat(pad) : text
}

// The `…` is paid for OUT OF the budget, not added on top: senpi does not truncate, so a column that
// overruns by one cell pushes every later column right and clips the rightmost one off the dialog.
function truncateCell(text: string, width: number): string {
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

function timeOfDay(at: number): string {
  const clock = new Date(at)
  return [clock.getHours(), clock.getMinutes(), clock.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")
}

export function panelTitle(view: UsageSnapshotView): string {
  // `at: 0` is a master that has NEVER swept. Formatting it would print a 1970 timestamp, which reads
  // as a real (if absurd) sweep rather than as the absence of one.
  const taken = view.at > 0 ? timeOfDay(view.at) : "尚未采集"
  // `stale` is the SCHEDULER's own verdict, not a threshold re-derived here: it means selection has
  // already stopped ranking by these numbers, so the panel must stop presenting them as current.
  return `账号池用量 · ${taken}${view.stale ? " · 数据可能过期" : ""}`
}

// WHO holds this account, in the one column the operator scans to answer "can I take it".
function heldColumn(account: UsageAccountView, held: readonly SlotHold[], workerId: string): string {
  // THIS MACHINE FIRST, and named by SLOT rather than by workerId: a slot is what the operator would
  // switch, and our own name in the holder chips would print this machine twice under two names.
  // Through heldStateFor so the prefix rule lives in exactly one place — `=== true` because its third
  // state (undefined, "no lease recorded") is not a match.
  const mine = held.filter((slot) => heldStateFor(account.idPrefix, slot.accountId) === true)
  if (mine.length > 0) return mine.map((slot) => slot.slotName).join(",")
  // `undefined` is a master too old to compute holders — NOT an account nobody holds. Rendering it as
  // blank is honest ("nothing said"); defaulting it to `[]` would assert a fact never computed.
  if (account.holders === undefined) return ""
  const chips = holderChips(
    account.holders.filter((holder) => holder !== workerId),
    COLUMN_WIDTH.held,
  )
  if (chips.names.length === 0 && chips.overflow === 0) return ""
  // `+N` says "held by more machines than fit" — holders too numerous to name is itself the anomaly.
  return chips.overflow > 0 ? `${chips.names.join(" ")} +${chips.overflow}`.trim() : chips.names.join(" ")
}

function pinColumn(account: UsageAccountView, workerId: string): string {
  // Same three-state honesty as `holders`: an absent `pinnedBy` is an old master, and blank would
  // claim the account is free to rotate away from.
  if (account.pinnedBy === undefined) return "?"
  return account.pinnedBy.includes(workerId) ? "pin" : ""
}

function windowsColumn(account: UsageAccountView): string {
  // 未采集 ≠ 用量为零。Keyed off `hasUsage`, never off `windows.length`, because the two differ: an
  // account the poller reached but which reported no window is also `--`, and `0%` on either would
  // rank the pool's least-known account as its emptiest and send the operator straight at it.
  if (!account.hasUsage || account.windows.length === 0) return "--"
  return account.windows.map(oneWindow).join("  ")
}

function oneWindow(window: UsageWindowView): string {
  return `${WINDOW_SHORT_LABEL[window.label] ?? window.label} ${window.utilization}%`
}

// Only the ones that HOLD. A fixed slate of three markers would put three pieces of noise on every
// healthy row, and these exist precisely to warn that a switch here will disappoint: the scheduler
// refuses a cooling-down or excluded account, and 重登 means the chain is dead.
function flagsColumn(account: UsageAccountView): string {
  const flags: string[] = []
  if (account.coolingDown) flags.push("冷却")
  if (account.needsReauth) flags.push("重登")
  if (account.excluded) flags.push("排除")
  return flags.join(" ")
}

export function formatAccountRows(input: {
  view: UsageSnapshotView
  held: readonly SlotHold[]
  workerId: string
}): { rows: string[]; accountByRow: Map<string, UsageAccountView> } {
  const accountByRow = new Map<string, UsageAccountView>()
  const rows: string[] = []
  for (const account of input.view.accounts) {
    const columns = [
      padCell(account.idPrefix, COLUMN_WIDTH.id),
      padCell(truncateCell(account.label, COLUMN_WIDTH.label), COLUMN_WIDTH.label),
      padCell(heldColumn(account, input.held, input.workerId), COLUMN_WIDTH.held),
      padCell(pinColumn(account, input.workerId), COLUMN_WIDTH.pin),
      windowsColumn(account),
    ]
    // Omitted rather than emptied: an empty trailing column would leave two stray spaces on every
    // healthy row, and `ui.select` prints the line raw.
    const flags = flagsColumn(account)
    if (flags !== "") columns.push(flags)
    const row = columns.join(" ".repeat(COLUMN_GAP))
    rows.push(row)
    accountByRow.set(row, account)
  }
  // LAST, and outside accountByRow: in `rows` so the refresh keypress exists at all, out of the map so
  // it can never be mistaken for "switch to some account".
  rows.push(REFRESH_ROW)
  return { rows, accountByRow }
}

// THREE STATES, MIRRORING manualSwitch's, because that module reads a bare `false` as UNPIN — an
// instruction of its own — and `undefined` as "switch, no opinion about pinning". A boolean here
// cannot tell those apart, and the one it silently picked reported every plain switch to the operator
// as "已取消钉住". Naming the third state is what makes the wrong one unrepresentable.
export type SwitchAction = { slotName: string; pin: "none" | "on" | "off" } | "back"

export function formatSwitchActions(input: {
  account: UsageAccountView
  slots: readonly string[]
  // Which of OUR slots currently pin THIS account. Drives the second verb, per slot: a slot already
  // pinned here is offered the un-pin, because offering it "钉住" again is a no-op dressed as an
  // action — and while the pin lives in this process, that would leave no way out of one.
  pinnedSlots?: readonly string[]
}): { options: string[]; actionByOption: Map<string, SwitchAction> } {
  const actionByOption = new Map<string, SwitchAction>()
  const options: string[] = []
  const add = (option: string, action: SwitchAction) => {
    options.push(option)
    actionByOption.set(option, action)
  }
  const pinnedHere = (slotName: string): boolean => input.pinnedSlots?.includes(slotName) === true
  // One slot needs no slot name: there is nothing to disambiguate, and `（槽位 env）` on a
  // single-slot worker is pure noise. Several slots need one on EVERY option, or the operator has no
  // way to say which token slot the account should land in.
  const single = input.slots.length === 1 ? input.slots[0] : undefined
  if (single !== undefined) {
    add("切换到此账号", { slotName: single, pin: "none" })
    if (pinnedHere(single)) add("取消钉住此账号", { slotName: single, pin: "off" })
    else add("切换并钉住此账号", { slotName: single, pin: "on" })
  } else {
    for (const slotName of input.slots) {
      add(`切换到此账号（槽位 ${slotName}）`, { slotName, pin: "none" })
      if (pinnedHere(slotName)) add(`取消钉住此账号（槽位 ${slotName}）`, { slotName, pin: "off" })
      else add(`切换并钉住此账号（槽位 ${slotName}）`, { slotName, pin: "on" })
    }
  }
  add("返回", "back")
  return { options, actionByOption }
}

// The label's local part, as a HINT beside the prefix. Labels are emails, so the domain is shared
// across the whole pool and carries no information; the local part is what the operator recognises.
function labelHint(accountId: string, labelByPrefix: ReadonlyMap<string, string>): string | undefined {
  // startsWith, not equality: labelByPrefix is keyed by the snapshot's 8-char idPrefix while `held`
  // carries the FULL uuid, so an equality lookup would never match anything.
  for (const [prefix, label] of labelByPrefix) {
    if (accountId.startsWith(prefix)) {
      const local = label.split("@")[0]
      return local !== undefined && local !== "" ? local : undefined
    }
  }
  return undefined
}

export function formatStatusText(input: {
  held: readonly SlotHold[]
  labelByPrefix: ReadonlyMap<string, string>
}): string {
  const holding = input.held.flatMap((slot) =>
    slot.accountId === undefined ? [] : [{ slotName: slot.slotName, accountId: slot.accountId }],
  )
  if (holding.length === 0) return "账号 无"
  // Keyed off how many slots are actually HOLDING, not off held.length: a worker with two configured
  // slots of which one is still empty has nothing to disambiguate, so it reads as the single case.
  const first = holding[0]
  if (holding.length === 1 && first !== undefined) {
    // The prefix STAYS even when a label resolves: it is the identity the master's log lines name,
    // and two accounts whose emails share a local part would otherwise be indistinguishable here.
    const hint = labelHint(first.accountId, input.labelByPrefix)
    // No trailing separator when unresolvable — a dangling space reads as a truncated name.
    return hint === undefined ? `账号 ${first.accountId.slice(0, 8)}` : `账号 ${first.accountId.slice(0, 8)} ${hint}`
  }
  // No label hints in the multi-slot form: the status line is one row of a narrow footer, and two
  // slot:prefix pairs already spend most of it.
  return `账号 ${holding.map((slot) => `${slot.slotName}:${slot.accountId.slice(0, 8)}`).join(" ")}`
}
