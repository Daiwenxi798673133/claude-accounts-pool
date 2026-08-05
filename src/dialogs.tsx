/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { StoredAccount } from "./accounts.ts"
import { NEEDS_REAUTH_ERROR, type AccountUsage, type UsageResponse, type UsageWindow } from "./usage.ts"
import type { UsageAccountView, UsageSnapshotView, UsageWindowView } from "./cloud/protocol.ts"
import type { OpenaiUsage, OpenaiWindow } from "./openai-usage.ts"
import { planLabel } from "./profile.ts"
import { currentConversation } from "./current-conversation.ts"
import {
  clampSelection,
  heldStateFor,
  initialPageSelection,
  initialWorkerSelection,
  moveSelection,
  openaiRows,
  panelPages,
  pinnedStateFor,
  displayWidth,
  holderChips,
  poolColumns,
  poolLayout,
  poolStepColumn,
  selectedIndex,
  unattributedOpenaiUsage,
  PAGE_LABEL,
  POOL_COLUMN_GAP,
  type OpenaiRow,
  type OpenaiRowState,
} from "./panel-model.ts"

export type UsageState = {
  loading: boolean
  results: AccountUsage[]
  updatedAt?: number
  error?: string
  openai?: OpenaiUsage
  // Tracked apart from `loading`, which covers the Anthropic collect only. The ChatGPT fetch
  // settles AFTER that flag goes false, so sharing it would make the slot occupant's row read
  // "额度未知" for the gap between the two — an honest-looking lie about a call still in flight.
  openaiLoading: boolean
}

function bar(util: number, width = 18): string {
  const pct = Math.max(0, Math.min(100, util))
  const fill = Math.round((pct / 100) * width)
  return `[${"#".repeat(fill)}${"-".repeat(width - fill)}]`
}

function percent(util: number): string {
  return `${Math.round(util)}%`
}

function tone(api: TuiPluginApi, util: number) {
  const theme = api.theme.current
  if (util >= 85) return theme.error
  if (util >= 60) return theme.warning
  return theme.success
}

function resetIn(iso: string): string {
  const ms = new Date(iso).getTime() - Date.now()
  if (ms <= 0) return "now"
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.floor((ms % 3_600_000) / 60_000)
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`
  if (hours > 0) return `${hours}h ${minutes}m`
  return `${minutes}m`
}

function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

// DISPLAY FORM ONLY. Anthropic's fixed windows travel the wire under their RAW field names
// (normalizeAnthropic emits `five_hour` / `seven_day` / …, and scoring, logs and the protocol key
// off exactly those), so the short form has to be applied here rather than by renaming the label
// upstream. It is also what makes the column line up: a 9-character `five_hour` overruns the
// 6-column pad and shoves its bar out of line with the `Fable` row below it. A label that is
// absent — a dynamic per-model weekly window — passes through UNCHANGED rather than being
// dropped. The browser dashboard inlines its own copy of this table into generated JS
// (master/dashboardHtml.ts's SHORT_LABELS); keep the two in step.
const SHORT_WINDOW_LABELS: Record<string, string> = {
  five_hour: "5h",
  seven_day: "7d",
  seven_day_sonnet: "7d sonnet",
  seven_day_opus: "7d opus",
}

// Own-property lookup, not a bare index: a pool-derived label of "constructor" must not resolve
// to something off Object.prototype.
function shortWindowLabel(label: string): string {
  return Object.hasOwn(SHORT_WINDOW_LABELS, label) ? SHORT_WINDOW_LABELS[label] : label
}



function WindowRow(props: { api: TuiPluginApi; name: string; win?: UsageWindow | null }) {
  const theme = () => props.api.theme.current
  return (
    <Show when={props.win}>
      {(win) => (
        <box flexDirection="row" gap={1}>
          <text fg={theme().textMuted}>{props.name.padEnd(6)}</text>
          <text fg={tone(props.api, win().utilization)}>
            {bar(win().utilization)} {percent(win().utilization)}
          </text>
          <Show when={win().resets_at}>
            <text fg={theme().textMuted}>重置 {resetIn(win().resets_at!)}</text>
          </Show>
        </box>
      )}
    </Show>
  )
}

// Per-model weekly windows (e.g. "Fable"); replaces the old Opus/Sonnet row now null.
function ModelWindowRows(props: { api: TuiPluginApi; usage: () => UsageResponse }) {
  return (
    <For each={props.usage().scoped ?? []}>{(win) => <WindowRow api={props.api} name={win.label} win={win} />}</For>
  )
}

function AccountRow(props: {
  api: TuiPluginApi
  account: StoredAccount
  activeId?: string
  usage?: AccountUsage
  selected: boolean
  loading: boolean
  pendingDelete: boolean
}) {
  const theme = () => props.api.theme.current
  const isActive = () => props.account.id === props.activeId
  return (
    <box flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={props.selected ? theme().primary : theme().textMuted}>{props.selected ? "▶" : " "}</text>
          <text fg={props.selected ? theme().primary : theme().text}>
            {isActive() ? "●" : "○"} {props.account.label}
            {isActive() ? " In Use" : ""}
          </text>
          <Show when={planLabel(props.account.subscription)}>{(plan) => <text fg={theme().textMuted}>{plan()}</text>}</Show>
          <Show when={props.pendingDelete}>
            <text fg={theme().error}>确认删除? 再按 d · 其他键取消</text>
          </Show>
        </box>
        <Show when={props.account.excluded}>
          <text fg="#22D3EE">不自动切</text>
        </Show>
      </box>
      <box flexDirection="column" paddingLeft={4}>
        <Show when={props.usage?.error && props.usage?.error !== NEEDS_REAUTH_ERROR}>
          <text fg={theme().error}>{props.usage?.error}</text>
        </Show>
        <Show when={props.usage?.needsReauth || props.usage?.error === NEEDS_REAUTH_ERROR}>
          <text fg={theme().warning}>需重新登录 (enter 重试刷新)</text>
        </Show>
        <Show when={props.usage?.usage}>
          {(usage) => (
            <box flexDirection="column">
              <WindowRow api={props.api} name="5h" win={usage().five_hour} />
              <WindowRow api={props.api} name="7d" win={usage().seven_day} />
              <ModelWindowRows api={props.api} usage={usage} />
            </box>
          )}
        </Show>
        <Show when={props.usage?.pending === "waiting-refresh"}>
          <text fg={theme().textMuted}>等待 token 刷新…</text>
        </Show>
        <Show when={props.usage?.pending === "refreshing"}>
          <text fg={theme().textMuted}>刷新中…</text>
        </Show>
        <Show when={props.loading && !props.usage?.usage && !props.usage?.error && !props.usage?.pending}>
          <text fg={theme().textMuted}>加载中…</text>
        </Show>
      </box>
    </box>
  )
}

function rowError(state: OpenaiRowState): string | undefined {
  return state.kind === "error" ? state.message : undefined
}

// D1's copy. Split by reason because the occupant of the slot cannot sensibly be told to
// "switch to this account" — it already is the one switched to.
function rowUnknown(state: OpenaiRowState): string | undefined {
  if (state.kind !== "unknown") return undefined
  return state.reason === "not-in-slot" ? "额度未知(切换到该账号后可见)" : "额度未知(未取到实时数据)"
}

function rowWindows(state: OpenaiRowState): OpenaiWindow[] {
  return state.kind === "windows" ? state.windows : []
}

function OpenaiAccountRow(props: { api: TuiPluginApi; row: OpenaiRow; selected: boolean; pendingDelete: boolean }) {
  const theme = () => props.api.theme.current
  const state = () => props.row.state
  return (
    <box flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={props.selected ? theme().primary : theme().textMuted}>{props.selected ? "▶" : " "}</text>
          <text fg={props.selected ? theme().primary : theme().text}>
            {props.row.active ? "●" : "○"} {props.row.label}
            {props.row.active ? " In Use" : ""}
          </text>
          <Show when={props.row.plan}>{(plan) => <text fg={theme().textMuted}>{plan()}</text>}</Show>
          <Show when={props.pendingDelete}>
            <text fg={theme().error}>确认删除? 再按 d · 其他键取消</text>
          </Show>
        </box>
        <Show when={props.row.account.excluded}>
          <text fg="#22D3EE">不自动切</text>
        </Show>
      </box>
      <box flexDirection="column" paddingLeft={4}>
        <Show when={rowError(state())}>{(message) => <text fg={theme().error}>{message()}</text>}</Show>
        <Show when={state().kind === "needs-reauth"}>
          <text fg={theme().warning}>需重新登录(用 opencode auth login 重新登录 OpenAI)</text>
        </Show>
        <Show when={rowUnknown(state())}>{(message) => <text fg={theme().textMuted}>{message()}</text>}</Show>
        <Show when={state().kind === "loading"}>
          <text fg={theme().textMuted}>加载中…</text>
        </Show>
        <For each={rowWindows(state())}>{(win) => <WindowRow api={props.api} name={win.label} win={win} />}</For>
      </box>
    </box>
  )
}

// The slot occupant we could not file under any stored account (see unattributedOpenaiUsage).
// It has no id, so it cannot be a selectable row — this is the pre-list read-only presentation,
// kept verbatim so those numbers survive the page becoming a list.
function UnattributedOpenaiSection(props: { api: TuiPluginApi; usage: OpenaiUsage }) {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={theme().text}>{props.usage.email ?? "已登录"}</text>
        <Show when={props.usage.planType}>
          <text fg={theme().textMuted}>{props.usage.planType}</text>
        </Show>
        <text fg={theme().textMuted}>未收录,无法切换</text>
      </box>
      <box flexDirection="column" paddingLeft={4}>
        <Show when={props.usage.needsReauth}>
          <text fg={theme().warning}>需重新登录(用 opencode auth login 重新登录 OpenAI)</text>
        </Show>
        <Show when={props.usage.error}>
          <text fg={theme().error}>{props.usage.error}</text>
        </Show>
        <For each={props.usage.windows}>{(win) => <WindowRow api={props.api} name={win.label} win={win} />}</For>
      </box>
    </box>
  )
}

const ROW_KEYS_HINT = "↑↓ 选择 · enter 切换 · m 不自动切 · d 删除"

function AccountsPanel(props: {
  api: TuiPluginApi
  accounts: StoredAccount[]
  activeId?: string
  openaiAccounts: StoredAccount[]
  openaiActiveId?: string
  state: () => UsageState
  onSwitch: (id: string) => void
  // Separate from onSwitch because the two providers write DIFFERENT auth.json entries;
  // onDelete / onToggleExclude stay shared because their writers are already provider-agnostic.
  onOpenaiSwitch: (id: string) => void
  onDelete: (id: string) => void
  onToggleExclude: (id: string, next: boolean) => void
}) {
  const api = props.api
  const theme = () => api.theme.current
  const [accounts, setAccounts] = createSignal(props.accounts)
  const [openaiAccounts, setOpenaiAccounts] = createSignal(props.openaiAccounts)
  const [selection, setSelection] = createSignal(
    initialPageSelection({
      claude: props.accounts,
      claudeActiveId: props.activeId,
      chatgpt: props.openaiAccounts,
      chatgptActiveId: props.openaiActiveId,
    }),
  )
  const [pendingDelete, setPendingDelete] = createSignal(false)
  const [tab, setTab] = createSignal(0)

  // Narrowing memos, not conveniences. `state` is ONE signal, so reading it directly would make
  // every Claude partial invalidate the ChatGPT rows and force <For> to rebuild the whole list;
  // a memo only notifies when its value actually changes, and the spread in setState preserves
  // the OpenaiUsage reference across unrelated updates.
  const openaiUsage = createMemo(() => props.state().openai)
  const openaiLoading = createMemo(() => props.state().openaiLoading)

  const openaiRowList = createMemo(() =>
    openaiRows({
      accounts: openaiAccounts(),
      activeId: props.openaiActiveId,
      usage: openaiUsage(),
      loading: openaiLoading(),
    }),
  )
  const unattributed = createMemo(() =>
    unattributedOpenaiUsage({ accounts: openaiAccounts(), activeId: props.openaiActiveId, usage: openaiUsage() }),
  )
  // The un-attributed block is page content without being a row, so it keeps the ChatGPT page
  // alive on its own — otherwise a slot occupant we cannot file would lose its page entirely.
  const chatgptCount = createMemo(() => openaiRowList().length + (unattributed() ? 1 : 0))
  const pages = createMemo(() => panelPages({ claude: accounts().length, chatgpt: chatgptCount() }))
  // A page disappears the moment its provider's list empties, so clamp rather than read a page
  // index that can outlive the page it pointed at.
  const pageIndex = createMemo(() => clampSelection(tab(), pages().length))
  const page = createMemo(() => pages()[pageIndex()])

  const usageById = createMemo(() => {
    const map = new Map<string, AccountUsage>()
    for (const result of props.state().results) map.set(result.id, result)
    return map
  })

  const rowCount = () => (page() === "claude" ? accounts().length : openaiRowList().length)
  const index = () => selectedIndex(selection(), page(), rowCount())
  const selectedAccount = () => (page() === "claude" ? accounts()[index()] : openaiRowList()[index()]?.account)
  const pageActiveId = () => (page() === "claude" ? props.activeId : props.openaiActiveId)
  const footerHint = () => {
    if (page() === "claude") return ROW_KEYS_HINT
    // A ChatGPT page can consist of nothing but the un-attributed block, and then there is no
    // row for any of those four keys to act on.
    return openaiRowList().length > 0 ? ROW_KEYS_HINT : "仅展示,该账号未被收录"
  }

  function move(delta: number): void {
    setPendingDelete(false)
    setSelection((current) => moveSelection(current, page(), delta, rowCount()))
  }

  function confirm(): void {
    const account = selectedAccount()
    if (!account) return
    api.ui.dialog.clear()
    if (page() === "claude") props.onSwitch(account.id)
    else props.onOpenaiSwitch(account.id)
  }

  function requestDelete(): void {
    const account = selectedAccount()
    if (!account) return
    if (account.id === pageActiveId()) {
      api.ui.toast({ variant: "warning", message: "无法删除当前账号(会被自动重新收录)" })
      return
    }
    setPendingDelete(true)
  }

  function performDelete(): void {
    const account = selectedAccount()
    setPendingDelete(false)
    if (!account || account.id === pageActiveId()) return
    const onClaude = page() === "claude"
    props.onDelete(account.id)
    const next = (onClaude ? accounts() : openaiAccounts()).filter((item) => item.id !== account.id)
    // Only an EMPTY PANEL closes. Emptying one page while the other still has content must fall
    // through to that page instead: panelPages drops the emptied one and pageIndex re-clamps.
    const claudeLeft = onClaude ? next.length : accounts().length
    const chatgptLeft = (onClaude ? openaiAccounts().length : next.length) + (unattributed() ? 1 : 0)
    if (claudeLeft === 0 && chatgptLeft === 0) {
      api.ui.dialog.clear()
      return
    }
    if (onClaude) setAccounts(next)
    else setOpenaiAccounts(next)
    setSelection((current) => moveSelection(current, onClaude ? "claude" : "chatgpt", 0, next.length))
  }

  useKeyboard((evt) => {
    if (evt.name === "tab" || evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      evt.stopPropagation()
      setPendingDelete(false)
      setTab((pageIndex() + 1) % pages().length)
      return
    }
    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      evt.stopPropagation()
      setPendingDelete(false)
      setTab((pageIndex() + pages().length - 1) % pages().length)
      return
    }
    if (evt.name === "d") {
      evt.preventDefault()
      evt.stopPropagation()
      if (pendingDelete()) performDelete()
      else requestDelete()
      return
    }
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      setPendingDelete(false)
      confirm()
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      move(-1)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      move(1)
      return
    }
    if (evt.name === "m") {
      evt.preventDefault()
      evt.stopPropagation()
      setPendingDelete(false)
      const account = selectedAccount()
      if (!account) return
      const next = !account.excluded
      props.onToggleExclude(account.id, next)
      const patch = (list: StoredAccount[]) =>
        list.map((item) => (item.id === account.id ? { ...item, excluded: next } : item))
      if (page() === "claude") setAccounts(patch)
      else setOpenaiAccounts(patch)
      return
    }
    setPendingDelete(false)
  })

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="center" width="100%">
        <text fg={theme().text}>
          <b>账号用量</b>
        </text>
      </box>
      <box flexDirection="row" gap={2}>
        <For each={pages()}>
          {(id, i) => {
            const on = () => pageIndex() === i()
            return (
              <text fg={on() ? theme().primary : theme().textMuted}>
                {on() ? <b>{PAGE_LABEL[id]}</b> : PAGE_LABEL[id]}
              </text>
            )
          }}
        </For>
      </box>
      <Show when={currentConversation(api)}>
        {(current) => (
          <box flexDirection="row" gap={1}>
            <text fg={theme().textMuted}>当前对话</text>
            <text fg={theme().text}>{current()}</text>
          </box>
        )}
      </Show>
      <Show when={page() === "claude"}>
        <For each={accounts()}>
          {(account, i) => (
            <AccountRow
              api={api}
              account={account}
              activeId={props.activeId}
              usage={usageById().get(account.id)}
              selected={i() === index()}
              loading={props.state().loading}
              pendingDelete={pendingDelete() && i() === index()}
            />
          )}
        </For>
      </Show>
      <Show when={page() === "chatgpt"}>
        <box flexDirection="column" gap={1}>
          <Show when={unattributed()}>{(usage) => <UnattributedOpenaiSection api={api} usage={usage()} />}</Show>
          <For each={openaiRowList()}>
            {(row, i) => (
              <OpenaiAccountRow
                api={api}
                row={row}
                selected={i() === index()}
                pendingDelete={pendingDelete() && i() === index()}
              />
            )}
          </For>
          {/* D2: `m` writes a flag that nothing consumes yet (OPENAI_AUTOSWITCH_ENABLED is false),
              so without this line the control reads as governing behaviour that does not exist. */}
          <text fg={theme().textMuted}>ChatGPT 尚未启用自动切号,切换需手动进行</text>
        </box>
      </Show>
      <Show when={props.state().error}>
        <text fg={theme().error}>{props.state().error}</text>
      </Show>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme().textMuted}>
          {footerHint()}
          {pages().length > 1 ? " · tab 切页" : ""} · esc 关闭
        </text>
        <Show when={props.state().updatedAt}>
          <text fg={theme().textMuted}>更新于 {clockTime(props.state().updatedAt!)}</text>
        </Show>
      </box>
    </box>
  )
}

function recoverIn(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

export function openExhaustedAlert(api: TuiPluginApi, soonestMs?: number): void {
  const message =
    soonestMs === undefined
      ? "所有账号都已达额度上限"
      : `所有账号都已达额度上限，约 ${recoverIn(soonestMs)} 后恢复，届时将自动续接`
  const Alert = api.ui.DialogAlert
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => <Alert title="额度已满" message={message} onConfirm={() => api.ui.dialog.clear()} />)
}

export type UsageDialogOptions = {
  accounts: StoredAccount[]
  activeId?: string
  openaiAccounts: StoredAccount[]
  openaiActiveId?: string
  state: () => UsageState
  onSwitch: (id: string) => void | Promise<void>
  onOpenaiSwitch: (id: string) => void | Promise<void>
  onDelete: (id: string) => void | Promise<void>
  onToggleExclude: (id: string, next: boolean) => void | Promise<void>
}

export function openUsageDialog(api: TuiPluginApi, options: UsageDialogOptions): void {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => (
    <AccountsPanel
      api={api}
      accounts={options.accounts}
      activeId={options.activeId}
      openaiAccounts={options.openaiAccounts}
      openaiActiveId={options.openaiActiveId}
      state={options.state}
      onSwitch={(id) => void options.onSwitch(id)}
      onOpenaiSwitch={(id) => void options.onOpenaiSwitch(id)}
      onDelete={(id) => void options.onDelete(id)}
      onToggleExclude={(id, next) => void options.onToggleExclude(id, next)}
    />
  ))
}

// ── cloud-worker usage view ──────────────────────────────────────────────────────────────────
// Renders the master's UsageSnapshotView (a worker never collects usage itself) and offers the two
// actions a worker is ALLOWED to take on accounts it does not own: `enter` asks the master to lease
// the named account, `r` asks the master to sweep. Both are REQUESTS — every decision stays with the
// master (INV-CLOUD-2), which is why the props below are callbacks and not clients.
//
// Deliberately NOT ported from the local panel: `d` (delete) and `m` (不自动切), because both write to
// the account LIBRARY, which lives on the master and is not this machine's to edit.

// Solid blocks rather than the local panel's `[###---]`. Two columns of accounts only reads as a
// grid if the bars line up as a shape, and brackets plus hashes carry too much visual noise at that
// density. The local panel keeps its own form — this is the pool view's alone.
const POOL_BAR_WIDTH = 16

function blockBar(util: number): string {
  const pct = Math.max(0, Math.min(100, util))
  const fill = Math.round((pct / 100) * POOL_BAR_WIDTH)
  return `${"█".repeat(fill)}${"░".repeat(POOL_BAR_WIDTH - fill)}`
}

// An untouched window is not "healthy", it is unused, and painting it the same green as 40% makes
// a wall of idle accounts look like a wall of active ones.
function poolTone(api: TuiPluginApi, util: number) {
  return util <= 0 ? api.theme.current.textMuted : tone(api, util)
}

// Every cell is padded to a fixed width because these rows now sit in a grid: an unpadded
// percentage shifts the reset countdown, and the neighbouring column then reads as ragged.
function WorkerWindowRow(props: { api: TuiPluginApi; win: UsageWindowView }) {
  const theme = () => props.api.theme.current
  const util = () => props.win.utilization
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme().textMuted}>{shortWindowLabel(props.win.label).padEnd(6)}</text>
      <text fg={poolTone(props.api, util())}>{blockBar(util())}</text>
      <text fg={poolTone(props.api, util())}>{percent(util()).padStart(4)}</text>
      <Show when={props.win.resetsAt}>
        <text fg={theme().textMuted}>重置 {resetIn(props.win.resetsAt!).padStart(7)}</text>
      </Show>
    </box>
  )
}

// UNKNOWN IS NOT "NO". `held` is undefined only when this machine has NEVER recorded a leased
// account — a worker that has not yet completed its first lease. (It used to also cover the far more
// common case of booting onto a still-fresh on-disk lease, which left the whole column blank on the
// first /usage; worker/install.ts now records the id with every lease and reads it back at panel
// open.) Drawing `○` on every row while unknown would read as "I hold none of these", so the marker
// column goes BLANK instead: absence of knowledge, rendered as absence. Keep the three states.
// Measured and rendered from the SAME constants. The holder budget is the column minus whatever the
// rest of this row prints, so a badge whose literal drifted from the one being counted would silently
// overrun the column and get clipped.
const IN_USE_LABEL = " In Use"
// Replaces " In Use" rather than joining it: a pin is only ever placed on the account this worker
// holds, so printing both would say the same thing twice. Six cells + the flex row's gap is exactly
// the seven " In Use" occupied, which is what keeps the holder budget below unchanged.
const PINNED_LABEL = "已钉住"
const COOLING_LABEL = "冷却中"
const REAUTH_LABEL = "需重新登录"
const EXCLUDED_LABEL = "不自动切"

function WorkerAccountRow(props: {
  api: TuiPluginApi
  account: UsageAccountView
  selected: boolean
  held?: boolean
  // THIS machine's pin, not the pool's: `pinnedBy` on the row says who else asked to stay, and this
  // says whether we did. Kept separate because the local answer is known instantly (the operator just
  // pressed `p`) while the pool's copy only appears on the next snapshot.
  pinned: boolean
  // This machine's own self-declared label, so its name in the holder list can be told apart from
  // the other machines'. Not an identity — nothing authenticates a workerId.
  workerId: string
  columnWidth: number
}) {
  const theme = () => props.api.theme.current
  const account = () => props.account
  const marker = () => (props.held === undefined ? " " : props.held ? "●" : "○")
  // `▶` + its gap, then the marker and its space, then the label and every badge with a gap each,
  // and finally one more gap before the holder names begin.
  const titleUsed = () => {
    const badges = [
      account().coolingDown ? COOLING_LABEL : undefined,
      account().needsReauth ? REAUTH_LABEL : undefined,
      account().excluded ? EXCLUDED_LABEL : undefined,
    ].filter((badge): badge is string => badge !== undefined)
    const state = props.pinned ? 1 + displayWidth(PINNED_LABEL) : props.held === true ? displayWidth(IN_USE_LABEL) : 0
    const head = 2 + 2 + displayWidth(account().label) + state
    return badges.reduce((total, badge) => total + 1 + displayWidth(badge), head) + 1
  }
  const chips = () => holderChips(account().holders ?? [], props.columnWidth - titleUsed())
  return (
    <box flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={props.selected ? theme().primary : theme().textMuted}>{props.selected ? "▶" : " "}</text>
          <text fg={props.selected ? theme().primary : theme().text}>
            {marker()} {account().label}
            {props.held === true && !props.pinned ? IN_USE_LABEL : ""}
          </text>
          <Show when={props.pinned}>
            <text fg={theme().warning}>{PINNED_LABEL}</text>
          </Show>
          <Show when={account().coolingDown}>
            <text fg={theme().warning}>{COOLING_LABEL}</text>
          </Show>
          <Show when={account().needsReauth}>
            <text fg={theme().error}>{REAUTH_LABEL}</text>
          </Show>
        </box>
        <box flexDirection="row" gap={1}>
          {/* Our own name in the SAME green as `●`, every other machine muted — "the green one is me"
              is then the same sentence the marker at the head of this row already says, rather than a
              second convention to learn. A machine that PINNED this account borrows the same amber the
              已钉住 label above uses, so one colour means one thing on this panel. */}
          <For each={chips().names}>
            {(name) => (
              <text
                fg={
                  name === props.workerId
                    ? theme().success
                    : (account().pinnedBy ?? []).includes(name)
                      ? theme().warning
                      : theme().textMuted
                }
              >
                {name}
              </text>
            )}
          </For>
          <Show when={chips().overflow > 0}>
            <text fg={theme().textMuted}>+{chips().overflow}</text>
          </Show>
          <Show when={account().excluded}>
            <text fg="#22D3EE">{EXCLUDED_LABEL}</text>
          </Show>
        </box>
      </box>
      <box flexDirection="column" paddingLeft={4}>
        <Show when={account().hasUsage} fallback={<text fg={theme().textMuted}>额度未知(不在本次快照)</text>}>
          <For each={account().windows}>{(win) => <WorkerWindowRow api={props.api} win={win} />}</For>
        </Show>
      </box>
    </box>
  )
}

// ←→ is announced only where it does something. At one column poolStepColumn is a no-op, and a key
// advertised as 换列 that moves nothing reads as a broken panel rather than an absent feature.
const workerKeysHint = (columns: number): string =>
  columns > 1
    ? "↑↓ 选择 · ←→ 换列 · enter 切号 · p 钉住 · r 刷新 · esc 关闭"
    : "↑↓ 选择 · enter 切号 · p 钉住 · r 刷新 · esc 关闭"
// Spells out the marker column, which is the one thing on this panel that cannot be inferred from
// the row itself once a blank marker is in play (see WorkerAccountRow). Deliberately says 本机 and
// not 空闲: `○` means THIS worker is not on that account, and says nothing about the other workers.
const WORKER_LEGEND = "● 本机在用 · ○ 本机未用"

export type WorkerUsageDialogOptions = {
  view: UsageSnapshotView
  // FULL id of the lease this worker currently holds — the only thing that can mark a row "In Use",
  // and undefined until the first lease lands. Matched against a row by PREFIX because the prefix is
  // all the snapshot carries (UsageAccountView.idPrefix).
  heldAccountId?: string
  // FULL id of the account this machine has pinned, matched by prefix exactly as heldAccountId is.
  // Undefined when nothing is pinned, which is the normal state.
  pinnedAccountId?: string
  // This machine's `workerId` from tui.json, used only to pick its own name out of a holder list.
  workerId: string
  // `enter`. The panel is CLOSED before this runs, exactly as the local panel does it, so the verdict
  // arrives as a toast rather than as a dialog that has to describe its own failure.
  onSwitch: (input: { prefix: string; label: string }) => void
  // `p`. `pin:false` is the un-pin of the row already pinned — one key, both directions, because the
  // 已钉住 marker on the row is what says which of the two this press will do.
  //
  // CLOSES THE PANEL AND TOASTS, exactly like `enter` and for the same reason: pinning an account this
  // worker does not hold has to switch to it, which is `enter`'s flow with a pin recorded first — so
  // the two keys must not report themselves differently.
  onPin?: (input: { prefix: string; label: string; pin: boolean }) => void
  // `r`. Either a fresher snapshot, or the sentence explaining why there is none.
  //
  // A MESSAGE RATHER THAN A TOAST, and this is MEASURED, not stylistic: a toast raised while this
  // dialog is open comes out unreadable — the dialog's repaint blanks the double-width cells, so
  // Chinese text loses every glyph while the ASCII around it survives ("master  28"). The same
  // sentence toasted AFTER the dialog closes renders perfectly, which is why `enter` may still toast.
  // `r` deliberately keeps the panel open, so its outcome has to be drawn INSIDE the panel.
  onRefresh: () => Promise<WorkerUsageRefresh>
}

export type WorkerUsageRefresh = { ok: true; view: UsageSnapshotView } | { ok: false; message: string }

function WorkerUsagePanel(props: { api: TuiPluginApi; options: WorkerUsageDialogOptions }) {
  const api = props.api
  const theme = () => api.theme.current
  // The view is STATE, not a prop read: `r` replaces it in place, so the operator watches the same
  // list update rather than losing their position to a reopened dialog.
  const [view, setView] = createSignal(props.options.view)
  // Seeded on the held row, not on 0: the operator opens this panel already standing on the account
  // they are using, so confirming usage or switching away costs no ↑↓ first. Seeded ONCE, from the
  // snapshot the dialog opened with — `r` must not yank the cursor out from under them.
  const [selection, setSelection] = createSignal(
    initialWorkerSelection(props.options.view.accounts, props.options.heldAccountId),
  )
  const [refreshing, setRefreshing] = createSignal(false)
  const [notice, setNotice] = createSignal<string | undefined>(undefined)
  const accounts = () => view().accounts
  // Clamped on READ, like the local panel's selectedIndex: a refresh can return a shorter roster, and
  // an index that outlived its row would otherwise switch to whatever slid into that position.
  const index = () => clampSelection(selection(), accounts().length)
  const selected = () => accounts()[index()]
  // Shared with the cursor seed above, deliberately: the row `▶` starts on must be the row `●` is
  // drawn on, and one rule is the only way to keep that true.
  const heldFor = (account: UsageAccountView): boolean | undefined =>
    heldStateFor(account.idPrefix, props.options.heldAccountId)
  const pinnedFor = (account: UsageAccountView): boolean =>
    pinnedStateFor(account.idPrefix, props.options.pinnedAccountId)

  const dims = useTerminalDimensions()
  const layout = createMemo(() => poolLayout(accounts().length, dims().width))
  // Resized from INSIDE the panel rather than once at open time, because the roster changes under
  // `r` and the terminal can be resized while the dialog is up; either can flip the column count.
  createEffect(() => api.ui.dialog.setSize(layout().size))
  const columns = createMemo(() => poolColumns(accounts(), layout().columns))
  // Where each column starts in the FLAT list — the cursor is a single index over all accounts, so
  // a row has to be able to work out its own flat position to know whether it is the selected one.
  const columnOffsets = createMemo(() => {
    let at = 0
    return columns().map((column) => {
      const start = at
      at += column.length
      return start
    })
  })
  // "可用" is the pool's own word for it: a row this worker could actually be handed. Not a usage
  // threshold — a 90%-used account is still available, it is just nearly spent.
  const summary = () => {
    const usable = accounts().filter((a) => !a.coolingDown && !a.needsReauth && !a.excluded).length
    // 在用 appears ONLY when this snapshot proves the master tracks holders at all. A master
    // predating the field sends none, and printing `0 在用` there would state a count nobody
    // computed — the same distinction parseAccount preserves by leaving `holders` undefined.
    const tracked = accounts().some((a) => a.holders !== undefined)
    const busy = accounts().filter((a) => (a.holders?.length ?? 0) > 0).length
    return `${accounts().length} 个账号 · ${usable} 可用${tracked ? ` · ${busy} 在用` : ""}`
  }

  // Clamp, NOT wrap — moveSelection in panel-model.ts does the same, and the two panels must not feel
  // different under the same keys.
  function move(delta: number): void {
    setSelection((current) => clampSelection(current + delta, accounts().length))
  }

  function moveColumn(delta: number): void {
    setSelection((current) => poolStepColumn(current, delta, accounts().length, layout().columns))
  }

  function confirm(): void {
    const account = selected()
    if (!account) return
    api.ui.dialog.clear()
    props.options.onSwitch({ prefix: account.idPrefix, label: account.label })
  }

  function togglePin(): void {
    const account = selected()
    if (!account) return
    api.ui.dialog.clear()
    props.options.onPin?.({ prefix: account.idPrefix, label: account.label, pin: !pinnedFor(account) })
  }

  async function refresh(): Promise<void> {
    // Guarded because a forced sweep is SLOW (the master spaces its calls between accounts) and every
    // press costs the pool a real round of /api/oauth/usage requests.
    if (refreshing()) return
    setRefreshing(true)
    // Cleared on the way IN, not on success: a stale "刚刷新过" line sitting above numbers that have
    // since been refreshed would be a lie about the data below it.
    setNotice(undefined)
    try {
      const outcome = await props.options.onRefresh()
      if (outcome.ok) setView(outcome.view)
      else setNotice(outcome.message)
    } finally {
      setRefreshing(false)
    }
  }

  useKeyboard((evt) => {
    if (evt.name === "return") {
      evt.preventDefault()
      evt.stopPropagation()
      confirm()
      return
    }
    if (evt.name === "up" || evt.name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      move(-1)
      return
    }
    if (evt.name === "down" || evt.name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      move(1)
      return
    }
    // h/l alongside ←→ to match the other two panels' vim keys. They mean 换列 here rather than 切页
    // because this panel has no pages — the grid is the only thing there is to move across.
    if (evt.name === "left" || evt.name === "h") {
      evt.preventDefault()
      evt.stopPropagation()
      moveColumn(-1)
      return
    }
    if (evt.name === "right" || evt.name === "l") {
      evt.preventDefault()
      evt.stopPropagation()
      moveColumn(1)
      return
    }
    if (evt.name === "p") {
      evt.preventDefault()
      evt.stopPropagation()
      togglePin()
      return
    }
    if (evt.name === "r") {
      evt.preventDefault()
      evt.stopPropagation()
      // Fire-and-forget: useKeyboard takes a synchronous handler, and the refresh reports its own
      // failures through onRefresh's caller.
      void refresh()
      return
    }
  })

  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" gap={2} width="100%">
        <text fg={theme().text}>
          <b>账号池用量</b>
        </text>
        <text fg={theme().textMuted}>{summary()}</text>
      </box>
      <text fg={theme().border}>{"─".repeat(layout().contentWidth)}</text>
      <Show when={view().stale}>
        <text fg={theme().warning}>⚠ 快照已陈旧,master 可能已停止轮询,以下数字仅供参考</text>
      </Show>
      <Show when={accounts().length > 0} fallback={<text fg={theme().textMuted}>账号池暂无用量数据</text>}>
        <box flexDirection="row" gap={POOL_COLUMN_GAP}>
          <For each={columns()}>
            {(column, ci) => (
              <box flexDirection="column" gap={1} width={layout().columnWidth} overflow="hidden">
                <For each={column}>
                  {(account, ri) => (
                    <WorkerAccountRow
                      api={api}
                      account={account}
                      selected={columnOffsets()[ci()] + ri() === index()}
                      held={heldFor(account)}
                      pinned={pinnedFor(account)}
                      workerId={props.options.workerId}
                      columnWidth={layout().columnWidth}
                    />
                  )}
                </For>
              </box>
            )}
          </For>
        </box>
      </Show>
      <Show when={notice()}>{(message) => <text fg={theme().warning}>{message()}</text>}</Show>
      <text fg={theme().border}>{"─".repeat(layout().contentWidth)}</text>
      <box flexDirection="column">
        <box flexDirection="row" justifyContent="space-between" gap={2} width="100%">
          <text fg={theme().textMuted}>{WORKER_LEGEND}</text>
          <text fg={theme().textMuted}>{refreshing() ? "刷新中…" : `快照于 ${clockTime(view().at)}`}</text>
        </box>
        <text fg={theme().textMuted}>{workerKeysHint(layout().columns)}</text>
      </box>
    </box>
  )
}

export function openWorkerUsageDialog(api: TuiPluginApi, options: WorkerUsageDialogOptions): void {
  // Opens narrow and lets the panel's own effect widen it — the roster is already known here, but
  // the terminal width that decides whether two columns FIT is not.
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => <WorkerUsagePanel api={api} options={options} />)
}
