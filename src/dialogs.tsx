/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Show } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { StoredAccount } from "./accounts.ts"
import { NEEDS_REAUTH_ERROR, type AccountUsage, type UsageResponse, type UsageWindow } from "./usage.ts"
import type { UsageAccountView, UsageSnapshotView, UsageWindowView } from "./cloud/protocol.ts"
import type { OpenaiUsage, OpenaiWindow } from "./openai-usage.ts"
import { planLabel } from "./profile.ts"
import { currentConversation } from "./current-conversation.ts"
import {
  clampSelection,
  initialPageSelection,
  moveSelection,
  openaiRows,
  panelPages,
  selectedIndex,
  unattributedOpenaiUsage,
  PAGE_LABEL,
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

// ── cloud-worker read-only usage view ────────────────────────────────────────────────────────
// Renders the master's UsageSnapshotView verbatim (a worker never collects usage itself). Strictly
// READ-ONLY — no switch/delete/exclude keys — because a worker does not own these accounts
// (INV-CLOUD-2), and the wire type carries no credential to leak.

function WorkerWindowRow(props: { api: TuiPluginApi; win: UsageWindowView }) {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="row" gap={1}>
      <text fg={theme().textMuted}>{props.win.label.padEnd(6)}</text>
      <text fg={tone(props.api, props.win.utilization)}>
        {bar(props.win.utilization)} {percent(props.win.utilization)}
      </text>
      <Show when={props.win.resetsAt}>
        <text fg={theme().textMuted}>重置 {resetIn(props.win.resetsAt!)}</text>
      </Show>
    </box>
  )
}

function WorkerAccountRow(props: { api: TuiPluginApi; account: UsageAccountView }) {
  const theme = () => props.api.theme.current
  const account = () => props.account
  return (
    <box flexDirection="column">
      <box flexDirection="row" justifyContent="space-between" gap={1}>
        <box flexDirection="row" gap={1}>
          <text fg={theme().text}>{account().label}</text>
          <Show when={account().coolingDown}>
            <text fg={theme().warning}>冷却中</text>
          </Show>
          <Show when={account().needsReauth}>
            <text fg={theme().error}>需重新登录</text>
          </Show>
        </box>
        <Show when={account().excluded}>
          <text fg="#22D3EE">不自动切</text>
        </Show>
      </box>
      <box flexDirection="column" paddingLeft={4}>
        <Show when={account().hasUsage} fallback={<text fg={theme().textMuted}>额度未知(不在本次快照)</text>}>
          <For each={account().windows}>{(win) => <WorkerWindowRow api={props.api} win={win} />}</For>
        </Show>
      </box>
    </box>
  )
}

function WorkerUsagePanel(props: { api: TuiPluginApi; view: UsageSnapshotView }) {
  const api = props.api
  const theme = () => api.theme.current
  return (
    <box paddingTop={1} paddingBottom={1} paddingLeft={2} paddingRight={2} gap={1} flexDirection="column">
      <box flexDirection="row" justifyContent="center" width="100%">
        <text fg={theme().text}>
          <b>账号池用量(只读)</b>
        </text>
      </box>
      <Show when={props.view.stale}>
        <text fg={theme().warning}>⚠ 快照已陈旧,master 可能已停止轮询,以下数字仅供参考</text>
      </Show>
      <Show
        when={props.view.accounts.length > 0}
        fallback={<text fg={theme().textMuted}>账号池暂无用量数据</text>}
      >
        <For each={props.view.accounts}>{(account) => <WorkerAccountRow api={api} account={account} />}</For>
      </Show>
      <box flexDirection="row" justifyContent="space-between" gap={2}>
        <text fg={theme().textMuted}>esc 关闭</text>
        <text fg={theme().textMuted}>快照于 {clockTime(props.view.at)}</text>
      </box>
    </box>
  )
}

export function openWorkerUsageDialog(api: TuiPluginApi, view: UsageSnapshotView): void {
  api.ui.dialog.setSize("medium")
  api.ui.dialog.replace(() => <WorkerUsagePanel api={api} view={view} />)
}
