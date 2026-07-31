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

// Seeds the cursor on the row the panel already marks as held, THROUGH heldStateFor rather than a
// second prefix test of its own: one rule means `▶` can never land on a row that is not the `●`
// one. Two rules is precisely how they drifted apart. No held row — nothing leased yet, or a lease
// whose account is missing from this snapshot — falls back to the first row.
export function initialWorkerSelection(accounts: readonly { idPrefix: string }[], heldAccountId?: string): number {
  const at = accounts.findIndex((account) => heldStateFor(account.idPrefix, heldAccountId) === true)
  return at < 0 ? 0 : at
}
