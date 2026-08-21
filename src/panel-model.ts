import type { StoredAccount } from "./accounts.ts"
import type { OpenaiUsage, OpenaiWindow } from "./openai-usage.ts"
import { placeholderOpenaiLabel } from "./openai-slot.ts"

// The /usage panel's decision logic, lifted OUT of dialogs.tsx. dialogs.tsx is JSX against a
// TUI runtime with no test harness, so every rule worth asserting has to be reachable from
// here instead — the same reason current-conversation.ts exists. Nothing in this file may
// import a UI runtime, and user-facing copy stays in dialogs.tsx; what lives here is the
// decision, not the wording.

export type PanelPage = "claude" | "chatgpt"

export const PAGE_LABEL: Record<PanelPage, string> = { claude: "Claude", chatgpt: "ChatGPT" }

// A ChatGPT row's body, decided EXHAUSTIVELY here so the JSX only maps a kind to a line.
//
// `unknown`/"not-in-slot" is the load-bearing case. Only the account occupying auth.json's
// `openai` slot holds a live access token — OPENAI_KEEPALIVE_ENABLED is false, so nothing
// refreshes the others — and fetchOpenaiUsage reads that slot, so it can only ever report the
// occupant. Every other stored row therefore has NO number we are entitled to render: not a
// stale one, not an interpolated one, not a zero. "实时优先、诚实报错,绝不显示缓存旧数据"
// governs the absence of data too. Do not add a cache to fill these in.
export type OpenaiRowState =
  | { kind: "windows"; windows: OpenaiWindow[] }
  | { kind: "needs-reauth" }
  | { kind: "error"; message: string }
  | { kind: "loading" }
  | { kind: "unknown"; reason: "not-in-slot" | "no-live-data" }

export type OpenaiRow = {
  account: StoredAccount
  active: boolean
  // What to PRINT as the row's name. Not always account.label: the dialog gets its account list as
  // a snapshot taken at open time, so a label backfilled during this very session would otherwise
  // keep showing the placeholder until the panel is reopened.
  label: string
  // Live plan type ("plus", "go"). Only ever present where there is a live response to take it
  // from, i.e. the slot occupant — there is no cached plan for anybody else and none is invented.
  plan?: string
  state: OpenaiRowState
}

// The live response, but ONLY if it provably describes THIS account. Two independent gates, and
// both must hold:
//   - accountId equality, which is the ATTRIBUTION: the response was authenticated with that
//     ChatGPT-Account-Id, so its email/plan belong to that account and to nobody else. This alone
//     is what makes it impossible to print account A's email on account B's row.
//   - the row being the slot occupant, which keeps the un-attributed read-only block (rendered
//     when no row is active) from ever showing the same identity twice on one page.
function liveIdentity(account: StoredAccount, active: boolean, usage?: OpenaiUsage): OpenaiUsage | undefined {
  if (!active || !usage?.accountId || !account.accountId) return undefined
  return usage.accountId === account.accountId ? usage : undefined
}

export function openaiRowLabel(account: StoredAccount, active: boolean, usage?: OpenaiUsage): string {
  const accountId = account.accountId
  if (!accountId) return account.label
  const email = liveIdentity(account, active, usage)?.email
  if (!email) return account.label
  // Byte-identical to the placeholder or the stored label wins — the user may have renamed this
  // account by hand, and the README promises that rename is never overwritten. Same comparison
  // backfillOpenaiLabel makes before it persists, against the same shared constructor.
  return account.label === placeholderOpenaiLabel(accountId) ? email : account.label
}

export type OpenaiRowInput = {
  accounts: StoredAccount[]
  // Which account occupies the slot, i.e. AccountsFile.openaiActiveId. Deliberately clearable:
  // captureInLock wipes it whenever nothing attributable occupies the slot, so "no row is
  // active" is a correct state and must render as every row unknown, never as row 0 active.
  activeId?: string
  // The slot occupant's live result, and nobody else's.
  usage?: OpenaiUsage
  loading: boolean
}

export function openaiRowState(input: {
  account: StoredAccount
  activeId?: string
  usage?: OpenaiUsage
  loading: boolean
}): OpenaiRowState {
  if (input.account.id !== input.activeId) {
    // A dead chain is knowable WITHOUT the slot, and enter on this row is refused by
    // switchToOpenaiAccount with exactly this reason, so say so up front rather than promise a
    // number that switching will never produce.
    return input.account.needsReauth ? { kind: "needs-reauth" } : { kind: "unknown", reason: "not-in-slot" }
  }
  const usage = input.usage
  // Undefined splits by CAUSE. In flight ⇒ loading. Settled-and-still-undefined means
  // fetchOpenaiUsage found no access token in the slot (or the call threw and tui.tsx swallowed
  // it to undefined): we are the occupant and still have nothing, so the "switch to this account"
  // hint would be nonsense — hence a separate reason rather than reusing not-in-slot.
  if (!usage) return input.loading ? { kind: "loading" } : { kind: "unknown", reason: "no-live-data" }
  if (usage.needsReauth) return { kind: "needs-reauth" }
  if (usage.error) return { kind: "error", message: usage.error }
  // May be EMPTY (a plan whose payload carried no parseable window) and is passed through as-is.
  // An empty list must render as no window rows at all; synthesising a 0% bar here would be the
  // fabrication D1 forbids. Length is also dynamic — a `go` plan reports exactly one 30d window —
  // so no caller may assume the Anthropic 5h/7d pair.
  return { kind: "windows", windows: usage.windows }
}

export function openaiRows(input: OpenaiRowInput): OpenaiRow[] {
  return input.accounts.map((account) => {
    const active = account.id === input.activeId
    return {
      account,
      active,
      label: openaiRowLabel(account, active, input.usage),
      plan: liveIdentity(account, active, input.usage)?.planType,
      state: openaiRowState({ account, activeId: input.activeId, usage: input.usage, loading: input.loading }),
    }
  })
}

// The slot can hold a ChatGPT credential belonging to NO stored row: an oauth entry carrying no
// accountId (or no refresh) is unattributable, so captureOpenaiSlot files it nowhere and clears
// openaiActiveId — yet fetchOpenaiUsage needs only `access` and still returns that account's real
// numbers. Before the ChatGPT page became a list those numbers were all it showed, so they get a
// read-only block above the rows instead of being dropped on the floor.
export function unattributedOpenaiUsage(input: {
  accounts: StoredAccount[]
  activeId?: string
  usage?: OpenaiUsage
}): OpenaiUsage | undefined {
  if (!input.usage) return undefined
  return input.accounts.some((account) => account.id === input.activeId) ? undefined : input.usage
}

// A provider with nothing to show gets no page at all, which is what keeps the initial page
// (always index 0) from landing on an empty list while the other page has content.
export function panelPages(counts: { claude: number; chatgpt: number }): PanelPage[] {
  const pages: PanelPage[] = []
  if (counts.claude > 0) pages.push("claude")
  if (counts.chatgpt > 0) pages.push("chatgpt")
  // NEVER empty: every consumer indexes into this list. Both-zero is already refused upstream
  // (tui.tsx does not open the panel), so this fallback exists to keep the function total.
  return pages.length > 0 ? pages : ["claude"]
}

// Read-time clamp, applied to BOTH the page index and each page's row index. Lists shrink under
// the selection (a delete, or a provider's page disappearing entirely), so a stored index can
// outlive the row it pointed at; clamping on read means a stale index can never resolve to a
// missing row, and length 0 collapses to 0 rather than -1.
export function clampSelection(index: number, length: number): number {
  if (length <= 0) return 0
  return Math.max(0, Math.min(length - 1, index))
}

function initialSelection(accounts: StoredAccount[], activeId?: string): number {
  const at = accounts.findIndex((account) => account.id === activeId)
  return at < 0 ? 0 : at
}

// One record instead of a bare index, because the pages must not share a cursor: a single index
// makes moving on one page move the other, and lets a page whose list emptied strand an index
// pointing past the end of the page you can still see. Every mutation goes through
// moveSelection, so independence is a property of the shape rather than of remembering to write
// two setters correctly.
export type PageSelection = Record<PanelPage, number>

// Each page seeds on its OWN active account, so whichever page you land on already highlights
// the row that is actually in use.
export function initialPageSelection(input: {
  claude: StoredAccount[]
  claudeActiveId?: string
  chatgpt: StoredAccount[]
  chatgptActiveId?: string
}): PageSelection {
  return {
    claude: initialSelection(input.claude, input.claudeActiveId),
    chatgpt: initialSelection(input.chatgpt, input.chatgptActiveId),
  }
}

// delta 0 is the post-delete re-clamp, not a no-op.
export function moveSelection(selection: PageSelection, page: PanelPage, delta: number, length: number): PageSelection {
  return { ...selection, [page]: clampSelection(selection[page] + delta, length) }
}

export function selectedIndex(selection: PageSelection, page: PanelPage, length: number): number {
  return clampSelection(selection[page], length)
}

// ── worker panel (账号池用量) ─────────────────────────────────────────────────────────────────
// A snapshot row carries only a PREFIX of the account uuid while a lease names the whole id, so
// "is this the row I hold" is a prefix test and cannot be an equality one.
//
// THREE-STATE, and it must stay that way: `undefined` means this worker has never recorded a lease
// and so does not KNOW what it holds — the row renders that as a blank marker. Collapsing it into
// `false` would stamp a confident `○` ("not this one") on every row.
export function heldStateFor(idPrefix: string, heldAccountId?: string): boolean | undefined {
  return heldAccountId === undefined ? undefined : heldAccountId.startsWith(idPrefix)
}

// The same prefix test heldStateFor makes, minus the third state: a pin either was recorded on this
// machine or it was not, and there is no "we have not found out yet" — the local store is the only
// place a pin lives, so reading it can never be inconclusive.
export function pinnedStateFor(idPrefix: string, pinnedAccountId?: string): boolean {
  return pinnedAccountId !== undefined && pinnedAccountId.startsWith(idPrefix)
}

// Seeds the cursor on the row the panel already marks as held, THROUGH heldStateFor rather than a
// second prefix test of its own: one rule means `▶` can never land on a row that is not the `●`
// one. Two rules is precisely how they drifted apart. No held row — nothing leased yet, or a lease
// whose account is missing from this snapshot — falls back to the first row.
export function initialWorkerSelection(accounts: readonly { idPrefix: string }[], heldAccountId?: string): number {
  const at = accounts.findIndex((account) => heldStateFor(account.idPrefix, heldAccountId) === true)
  return at < 0 ? 0 : at
}

// ── worker panel layout ──────────────────────────────────────────────────────────────────────
// The host dialog is a FIXED width per size — 60 / 88 / 116 cells, capped at terminal width − 2 —
// not a fraction of the terminal, so how many columns fit is arithmetic rather than a guess.
// Mirrored from OpenCode's dialog renderer; if those numbers ever move, the panel gets a column
// too many and the rightmost one is clipped.
const DIALOG_WIDTH = { medium: 60, xlarge: 116 } as const
// paddingLeft + paddingRight on the panel box.
const PANEL_PADDING = 4
// The NARROWEST a column may be, i.e. what the widest line inside it needs: a window row is
// 4 indent + 6 label + 16 bar + percentage + reset countdown. It is a floor, not the width — the
// drawn width divides up whatever the dialog gave, so the leftovers land in the title row where the
// holder names live rather than as dead space past the last column.
// Solid blocks rather than the local panel's `[###---]`. Two columns of accounts only reads as a
// grid if the bars line up as a shape, and brackets plus hashes carry too much visual noise at that
// density. The local panel keeps its own form — this is the pool view's alone.
//
// HERE RATHER THAN IN dialogs.tsx, where it used to live: the senpi panel draws the same bar and
// cannot import that file — it is TSX against opencode's plugin runtime and Solid, neither of which
// exists in a senpi process. A second copy is how two views of one number start disagreeing about
// what 50% looks like. The width is a parameter for the same reason: opencode's dialog gives a bar
// its own 16-cell row, while senpi's panel packs three of them onto one selectable line.
export const POOL_BAR_WIDTH = 16

// The widest form this produces ("23h 59m"), which is the column budget every caller reserves.
export const RESET_WIDTH = 7

// How long until this window's quota comes back, as a human duration rather than a timestamp: the
// operator's question is "how long do I wait", and answering it with an ISO instant makes them do
// the subtraction.
//
// `now` IS A PARAMETER, not Date.now(). Here beside blockBar for the same reason it is — both panels
// draw this and the senpi one cannot import dialogs.tsx — but also because the senpi row formatter is
// documented pure and clock-free, and a hidden clock would make every one of its tests depend on
// wall time.
export function resetIn(iso: string, now: number): string {
  const ms = new Date(iso).getTime() - now
  // Already elapsed is the ordinary state BETWEEN master sweeps, not an error: the snapshot is a
  // cache, so its horizon routinely passes before the next poll refreshes it. A negative duration
  // would be the only wrong thing to print.
  if (ms <= 0) return "now"
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

export function blockBar(util: number, width: number = POOL_BAR_WIDTH): string {
  // CLAMPED, and not defensively for its own sake: `repeat` throws on a negative count, so a
  // utilization the master reported out of range would take down the whole panel rather than draw
  // one odd row.
  const pct = Math.max(0, Math.min(100, util))
  const fill = Math.round((pct / 100) * width)
  return `${"█".repeat(fill)}${"░".repeat(width - fill)}`
}

export const POOL_COLUMN_MIN_WIDTH = 45
export const POOL_COLUMN_GAP = 4
// Below this, one column still fits on a normal screen without scrolling, and a single list reads
// better than a grid.
export const POOL_COLUMN_THRESHOLD = 6

export type PoolLayout = {
  columns: number
  size: "medium" | "xlarge"
  contentWidth: number
  columnWidth: number
}

// ponytail: two columns is the ceiling. A third needs 3×45 + 2×4 = 143 cells and the dialog stops
// at 116, so it could only exist by shrinking the bar row below what it needs.
export function poolLayout(accounts: number, terminalWidth: number): PoolLayout {
  const fit = (size: "medium" | "xlarge", columns: number): PoolLayout => {
    const contentWidth = Math.max(1, Math.min(DIALOG_WIDTH[size], terminalWidth - 2) - PANEL_PADDING)
    return {
      columns,
      size,
      contentWidth,
      columnWidth: Math.max(1, Math.floor((contentWidth - POOL_COLUMN_GAP * (columns - 1)) / columns)),
    }
  }
  if (accounts <= POOL_COLUMN_THRESHOLD) return fit("medium", 1)
  const wide = fit("xlarge", 2)
  // A narrow terminal clamps the dialog below its nominal size, so the second column has to be
  // re-checked against what the dialog ACTUALLY got rather than against 116.
  return wide.columnWidth < POOL_COLUMN_MIN_WIDTH ? fit("medium", 1) : wide
}

// ←→'s counterpart to ↑↓'s ±1: the list is filled column-major, so the row at the same height one
// column over sits exactly one column's worth of entries away.
//
// NO-OP AT THE EDGE, not a clamp, and this is the difference that matters. ↑↓ clamp because the
// flat list is what they walk, but `index ± rows` clamped would make ← on the leftmost column land
// on index 0 — the cursor jumps UP a few rows in the column it was already in, which is neither
// "moved left" nor "stayed put". Deciding on the COLUMN first is what keeps a horizontal key from
// producing vertical movement. Same reason a single column returns early: there is no column to
// step to, and ±rows would there be ±length.
//
// The row is preserved, except against a short final column: → from the bottom of a full column
// lands on the last account of the next one rather than off the end.
export function poolStepColumn(index: number, delta: number, total: number, columns: number): number {
  if (columns <= 1) return index
  const rows = Math.ceil(total / columns)
  if (rows <= 0) return index
  const target = Math.floor(index / rows) + delta
  // Against the columns poolColumns will actually draw, not against `columns`: those two differ
  // whenever the accounts do not fill the requested grid, and stepping into a column that was never
  // rendered would move the cursor somewhere the operator cannot see it.
  if (target < 0 || target >= Math.ceil(total / rows)) return index
  return clampSelection(target * rows + (index % rows), total)
}

// TERMINAL CELLS, not code units. The title row's badges are Chinese — `冷却中` occupies 6 cells,
// not 3 — so a budget measured with `.length` believes a full row still has room and the holder
// names get clipped by the column's overflow.
//
// ONE RANGE is provably enough here rather than a wcwidth table, and the bound is enforced
// elsewhere: the only wide text this panel can contain is its own Chinese literals (CJK Unified),
// because a workerId is shape-checked to `^[A-Za-z0-9._-]{1,64}$` and an account label is an email.
// The glyphs this panel draws from the ambiguous-width blocks — ●○▶ ░█ ─ · — measure ONE cell in a
// terminal, which is why they must stay outside the wide set.
export function displayWidth(text: string): number {
  let width = 0
  for (const char of text) {
    const cp = char.codePointAt(0) ?? 0
    width += cp >= 0x4e00 && cp <= 0x9fff ? 2 : 1
  }
  return width
}

// Names, never a count: a count is a number the operator then has to resolve into machines, and the
// names are what they were going to ask for next anyway. `overflow` carries the ones that did not
// fit so the row can say `+2` — holders too numerous to show is itself the anomaly worth surfacing,
// and silent clipping would read as "those are all of them".
export type HolderChips = { names: string[]; overflow: number }

// Drops from the END until the whole thing fits, re-measuring each time because the `+N` suffix
// appears (and widens) as names come off. Nothing fitting at all still yields the bare `+N`: the
// operator learns the account is held even on a row too cramped to name anyone.
export function holderChips(holders: readonly string[], budget: number): HolderChips {
  const empty: HolderChips = { names: [], overflow: 0 }
  if (holders.length === 0 || budget <= 0) return empty
  for (let shown = holders.length; shown > 0; shown -= 1) {
    const overflow = holders.length - shown
    const names = holders.slice(0, shown)
    // Joined by ONE space per gap, matching the flex row's gap={1}; the suffix costs its own gap.
    const width =
      names.reduce((sum, name) => sum + displayWidth(name), 0) +
      (shown - 1) +
      (overflow > 0 ? 1 + displayWidth(`+${overflow}`) : 0)
    if (width <= budget) return { names, overflow }
  }
  return displayWidth(`+${holders.length}`) <= budget ? { names: [], overflow: holders.length } : empty
}

// Column-MAJOR. ↑↓ walk the flat account list, so filling each column top to bottom is what makes
// the cursor travel down the screen instead of hopping sideways on every press.
export function poolColumns<T>(items: readonly T[], columns: number): T[][] {
  const rows = Math.ceil(items.length / Math.max(1, columns))
  if (rows <= 0) return []
  // Derived from `rows`, not from `columns`: 4 accounts across 2 columns is 2 rows each, and
  // asking for a third column would only produce an empty one that still eats its gap.
  const used = Math.ceil(items.length / rows)
  return Array.from({ length: used }, (_, i) => items.slice(i * rows, i * rows + rows))
}
