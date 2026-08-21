import type { UsageAccountView, UsageSnapshotView, UsageWindowView } from "../cloud/protocol.ts"
import { blockBar, displayWidth, heldStateFor, holderChips, resetIn, RESET_WIDTH } from "../panel-model.ts"

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

// EVERY OTHER VALUE IN THIS COLUMN IS A WORKER NAME, so ours has to read as one thing that is not a
// name at all. It used to print the senpi SLOT (`env`), which put a token-variable's internal label
// in a list of machines — reported straight off the live panel as "并没有 env 这个用户".
//
// Not `本机` either, and that is the non-obvious part: the operator's opencode worker (`vince-local`)
// runs on the same machine and appears in this very column, so "本机" would describe two different
// rows. `在用` says what is actually true and unambiguous — the omo drawing this panel is on it.
const IN_USE_LABEL = "在用"

// WHO holds this account, in the one column the operator scans to answer "can I take it".
function heldColumn(account: UsageAccountView, held: readonly SlotHold[], workerId: string): string {
  // THIS MACHINE FIRST, and never as our own workerId: it would print this machine twice under two
  // names, once here and once in the holder chips below. Through heldStateFor so the prefix rule
  // lives in exactly one place — `=== true` because its third state (undefined, "no lease
  // recorded") is not a match.
  const mine = held.filter((slot) => heldStateFor(account.idPrefix, slot.accountId) === true)
  if (mine.length > 0) {
    // The slot is named only when this worker runs more than one, because only then can it vary. A
    // single-slot worker is the default, and `在用 env` there is a word that never says anything.
    if (held.length === 1) return IN_USE_LABEL
    return `${IN_USE_LABEL} ${mine.map((slot) => slot.slotName).join(",")}`
  }
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

// `100%` is the widest a utilization can be, and every percentage is right-aligned into that width.
// Ragged numbers are what made the block a staircase: `5h 3%` and `5h 76%` put the NEXT label on two
// different cells, so one account crossing into three digits shifted every other row.
const WINDOW_PCT_WIDTH = 4

// SIX, not the opencode dialog's sixteen. That panel gives each window its own row and can spend the
// width; here three windows share ONE selectable line, and the line already carries an id, a label, a
// holder and a pin before the first bar starts. Six cells is one glyph per ~17% — coarse, but the bar
// is for scanning a column of eleven accounts as a shape, and the exact number is printed beside it.
export const SENPI_BAR_WIDTH = 6

type WindowColumn = { label: string; width: number; hasReset: boolean }

// What a row is allowed to draw, richest first. Chosen by width, and DROPPED IN THIS ORDER: the
// countdown goes before the bar because the bar answers the question asked far more often ("how
// loaded is this account"), while the horizon only matters once one is nearly spent. The numbers
// never go — they are the panel's actual content, and the rest is decoration on top of them.
type Decoration = "reset" | "bars" | "plain"
const DECORATIONS: readonly Decoration[] = ["reset", "bars", "plain"]

// The window columns THIS SNAPSHOT needs, keyed by label in first-seen order.
//
// A PROPERTY OF THE TABLE, NOT OF A ROW. Accounts do not all carry the same windows — the five-hour
// and seven-day pair is fixed but the per-model weekly ones are dynamic, so one row has `Fable` and
// the next has nothing there. Sizing each row against its own windows is what let two rows disagree
// about where a column starts; deciding once for the whole snapshot is what makes them agree.
//
// Keyed by LABEL rather than by index, which is the stricter of the two: an account whose windows
// arrive in a different order would otherwise put its second window under the first one's heading.
function windowColumns(accounts: readonly UsageAccountView[]): WindowColumn[] {
  const columns: WindowColumn[] = []
  for (const account of accounts) {
    if (!account.hasUsage) continue
    for (const window of account.windows) {
      const label = shortLabel(window)
      const existing = columns.find((column) => column.label === label)
      // A countdown slot is reserved for the column as soon as ANY account gives it a horizon, and
      // for none if none do — so a pool whose model windows never carry `resetsAt` spends no width
      // on an always-empty column.
      if (existing === undefined) columns.push({ label, width: displayWidth(label), hasReset: window.resetsAt !== undefined })
      else if (window.resetsAt !== undefined) existing.hasReset = true
      // A dynamic model name can be wider than the first one seen under the same heading only if the
      // labels differ, which would make it a different column — so the max is defensive, not load-bearing.
      if (existing !== undefined) existing.width = Math.max(existing.width, displayWidth(label))
    }
  }
  return columns
}

function shortLabel(window: UsageWindowView): string {
  return WINDOW_SHORT_LABEL[window.label] ?? window.label
}

// What the selector itself puts in front of every option (`→ ` or two spaces), plus a cell of slack
// so a row never ends flush against the right edge.
const SELECTOR_CHROME = 4

function windowsColumn(
  account: UsageAccountView,
  columns: readonly WindowColumn[],
  level: Decoration,
  now: number,
): string {
  // 未采集 ≠ 用量为零。Keyed off `hasUsage`, never off `windows.length`, because the two differ: an
  // account the poller reached but which reported no window is also `--`, and `0%` on either would
  // rank the pool's least-known account as its emptiest and send the operator straight at it.
  if (!account.hasUsage || account.windows.length === 0) return "--"
  const withBars = level !== "plain"
  const withReset = level === "reset"
  const bar = withBars ? 1 + SENPI_BAR_WIDTH : 0
  const cells = columns.map((column) => {
    const reset = withReset && column.hasReset ? 1 + RESET_WIDTH : 0
    const width = column.width + bar + 1 + WINDOW_PCT_WIDTH + reset
    const window = account.windows.find((candidate) => shortLabel(candidate) === column.label)
    // A BLANK OF THE SAME WIDTH, not a skipped column: an account missing this window must leave the
    // hole where it is so the columns after it still line up with everybody else's.
    if (window === undefined) return " ".repeat(width)
    const pct = `${window.utilization}%`.padStart(WINDOW_PCT_WIDTH)
    const drawn = withBars ? ` ${blockBar(window.utilization, SENPI_BAR_WIDTH)}` : ""
    // Padded even when this window has no horizon, because the column was reserved for the ones that
    // do — an unpadded blank here would pull every later column of this row left.
    const until =
      reset === 0 ? "" : ` ${(window.resetsAt === undefined ? "" : resetIn(window.resetsAt, now)).padStart(RESET_WIDTH)}`
    return `${padCell(column.label, column.width)}${drawn} ${pct}${until}`
  })
  // trimEnd, so a row whose last columns are blank does not carry a phantom one on its end — `ui.select`
  // prints the line raw and the flags column, when there is one, follows immediately after this.
  return cells.join(" ".repeat(COLUMN_GAP)).trimEnd()
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
  // The terminal's column count when it can be read. senpi's selector prints an option raw, so a row
  // wider than this wraps and destroys the grid rather than being cut short — measured at 95 columns,
  // where the `Fable` column fell off and ten wrapped lines appeared beneath the list.
  terminalWidth?: number
  // Wall clock for the reset countdowns, passed in so this module stays clock-free and its tests
  // stay deterministic. Omitted means "do not draw countdowns" rather than "assume now".
  now?: number
}): { rows: string[]; accountByRow: Map<string, UsageAccountView> } {
  // Decided ONCE, before any row is built: this is the layout every row shares.
  const windows = windowColumns(input.view.accounts)
  // Richest tier that fits, measured rather than predicted: the widths depend on the labels, the
  // holder chips and the window set this particular snapshot carries, and an arithmetic estimate is
  // exactly how a layout drifts from what actually renders. ALL rows or none at each tier — a list
  // where only the short rows kept their bars would read as missing data rather than as a narrow
  // window. Three passes over eleven rows is not worth avoiding.
  for (const level of DECORATIONS) {
    const built = build(input, windows, level)
    if (fits(built, input.terminalWidth)) return built
  }
  // Unreachable: "plain" is the last tier and fits() is only consulted above it.
  return build(input, windows, "plain")
}

function fits(built: { rows: string[] }, terminalWidth?: number): boolean {
  // Unknown width keeps everything: this panel runs in a real terminal far more often than not, and
  // defaulting to the degraded form would cost every user the decorations to serve a case that may
  // never happen.
  if (terminalWidth === undefined) return true
  const widest = built.rows.reduce((max, row) => Math.max(max, displayWidth(row)), 0)
  return widest + SELECTOR_CHROME <= terminalWidth
}

function build(
  input: { view: UsageSnapshotView; held: readonly SlotHold[]; workerId: string; now?: number },
  windows: readonly WindowColumn[],
  level: Decoration,
): { rows: string[]; accountByRow: Map<string, UsageAccountView> } {
  const accountByRow = new Map<string, UsageAccountView>()
  const rows: string[] = []
  for (const account of input.view.accounts) {
    const columns = [
      padCell(account.idPrefix, COLUMN_WIDTH.id),
      padCell(truncateCell(account.label, COLUMN_WIDTH.label), COLUMN_WIDTH.label),
      padCell(heldColumn(account, input.held, input.workerId), COLUMN_WIDTH.held),
      padCell(pinColumn(account, input.workerId), COLUMN_WIDTH.pin),
      windowsColumn(account, windows, level, input.now ?? 0),
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
