import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { accountsOf, loadAccounts, readActiveId, type AccountsFile, type ProviderId, type StoredAccount } from "./accounts.ts"
import { OPENAI_AUTOSWITCH_ENABLED } from "./constants.ts"
import { log, redactHeaders, redactBody, diagnosticHeaders } from "./logger.ts"
import { openExhaustedAlert } from "./dialogs.tsx"
import { latestMaxedReset, PROVIDER_IDS, PROVIDERS, scoreWindows, toProviderId, type RetryErrorLike } from "./providers.ts"
import { latestTurn } from "./turn.ts"
import { decideRedo, type PartLike } from "./continuation.ts"
import { collectAllUsage, switchToAccount, type AccountUsage, type UsageResponse } from "./usage.ts"
import type { SwitchStrategy } from "./worker/switchStrategy.ts"

const ENABLED = true

// Per-provider ACTION gate — separate from detection, which always runs (see decideLimit).
// A table so adding a ProviderId is a compile error until someone decides, out loud, whether its
// limits may drive a real switch.
const ACTION_ENABLED: Record<ProviderId, boolean> = {
  anthropic: true,
  openai: OPENAI_AUTOSWITCH_ENABLED,
}
const USAGE_CACHE_TTL_MS = 10 * 60_000
const RECENT_SWITCH_GUARD_MS = 4_000
const IDLE_WAIT_TIMEOUT_MS = 8_000
const IDLE_POLL_MS = 150
const COOLDOWN_KV_KEY = "claude-accounts-usage.autoswitch.cooldown"

type StateParts = ReturnType<TuiPluginApi["state"]["part"]>
type StateMessage = ReturnType<TuiPluginApi["state"]["session"]["messages"]>[number]
type AssistantMsg = Extract<StateMessage, { role: "assistant" }>
type PromptParts = NonNullable<Parameters<TuiPluginApi["client"]["session"]["promptAsync"]>[0]["parts"]>

export type AutoSwitchController = {
  dispose: () => void
  setUsageCache: (results: AccountUsage[]) => void
  isSessionRunning: () => boolean
}

function toErrorData(error: unknown): RetryErrorLike | undefined {
  if (typeof error !== "object" || error === null) return undefined
  const candidate = error as { name?: unknown; data?: RetryErrorLike }
  if (candidate.name === "APIError" && candidate.data && typeof candidate.data === "object") return candidate.data
  return undefined
}

// Key names only, never values: toErrorData() unwraps solely `name === "APIError"`, so an
// error shaped any other way reads as "no data at all" and would wrongly look like proof
// that the provider sends nothing.
function describeRawError(error: unknown): Record<string, unknown> {
  if (typeof error !== "object" || error === null) return { kind: typeof error }
  const candidate = error as Record<string, unknown>
  const data = candidate.data
  return {
    kind: "object",
    name: typeof candidate.name === "string" ? candidate.name : undefined,
    keys: Object.keys(candidate),
    dataKeys: typeof data === "object" && data !== null ? Object.keys(data) : undefined,
  }
}

// Candidate ranking reads the ANTHROPIC pool only (pickNext filters via accountsOf), so the
// normalizer is pinned to that provider here rather than derived from the record.
function score(usage?: UsageResponse): number {
  return scoreWindows(usage ? PROVIDERS.anthropic.normalize(usage) : undefined)
}

function fmtDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest > 0 ? `${hours} 小时 ${rest} 分钟` : `${hours} 小时`
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function installAutoSwitch(api: TuiPluginApi, strategy?: SwitchStrategy): AutoSwitchController {
  const cooldown = new Map<string, number>()
  // Cooled without a known reset deadline. The SOLE encoding of "unknown when" — never a sentinel
  // in `cooldown`, never passed to scheduleRecovery (a bogus timer clamps to ~1ms = false recovery).
  const cooldownPending = new Set<string>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  const attempted = new Map<string, Set<string>>()
  const sessionLocks = new Map<string, Promise<unknown>>()
  const repromptInFlight = new Set<string>()
  const stalledSessions = new Set<string>()
  const lastAction = new Map<string, number>()
  const lastHandledAssistantId = new Map<string, string>()
  const seen = new Set<string>()
  // Running-session tracking (INV-1). A session is "running" while its status is busy OR retry;
  // it leaves the set only on a positively-confirmed idle (session.idle / session.error / status idle).
  const runningSessions = new Set<string>()
  // Every anthropic session ever observed, so isSessionRunning can distinguish "confirmed idle"
  // (all known sessions poll idle) from "unknown" (nothing observed yet ⇒ treat as running).
  const knownAnthropicSessions = new Set<string>()
  let usageCache: { at: number; byId: Map<string, UsageResponse> } = { at: 0, byId: new Map() }
  let refreshing = false
  let lastSwitch: { id?: string; sessionID?: string; at: number } = { at: 0 }
  // One-shot smoke hook (read once; UNSET ⇒ never armed ⇒ zero overhead). When truthy, the next
  // idle turn injects one synthetic usage-limit to exercise the real switch→continue/resend path.
  let forceLimitOnce = Boolean(process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE)

  function persistCooldown(): void {
    const now = Date.now()
    const snapshot: Record<string, number> = {}
    for (const [id, until] of cooldown) if (until > now) snapshot[id] = until
    api.kv.set(COOLDOWN_KV_KEY, snapshot)
  }

  function scheduleRecovery(id: string, until: number): void {
    const existing = recoveryTimers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      recoveryTimers.delete(id)
      void announceRecovery(id)
    }, Math.max(0, until - Date.now()))
    recoveryTimers.set(id, timer)
  }

  // Estimated recovery only: the cooldown deadline comes from the rate-limit
  // response (or a default), so an elapsed timer means the quota *should* be
  // back — we don't re-hit the API to verify before clearing the cooldown. The
  // account silently rejoins selection; the only visible action is auto-resuming
  // stalled sessions (below).
  async function announceRecovery(id: string): Promise<void> {
    const file = await loadAccounts()
    // INV-P1: this path switches into the anthropic slot, so resolve the id inside that pool only.
    const account = accountsOf(file, "anthropic").find((item) => item.id === id)
    cooldown.delete(id)
    persistCooldown()
    if (!account) return
    // A recovered account with stalled sessions: switch back to it and auto-resume each
    // stalled turn via continue (riding Fix A's whole-turn aggregation). Excluded accounts
    // are never auto-switched into — they just rejoin manual selection silently.
    if (stalledSessions.size === 0 || account.excluded) return
    try {
      await switchToAccount(id, "anthropic")
      log.info("autoswitch:recover-resume", { id, sessions: stalledSessions.size })
      api.ui.toast({
        variant: "warning",
        message: `「${account.label}」额度已恢复，正在自动续接 ${stalledSessions.size} 个会话`,
      })
      void refreshUsageInBackground()
      for (const sid of [...stalledSessions]) {
        stalledSessions.delete(sid)
        attempted.delete(sid)
        lastAction.delete(sid)
        await repromptFailedTurn(sid, false)
      }
    } catch (error) {
      log.warn("autoswitch:recover-resume-fail", { id, error: String(error) })
    }
  }

  function markCooldown(id: string, untilMs?: number): void {
    if (typeof untilMs === "number" && Number.isFinite(untilMs)) {
      cooldownPending.delete(id)
      cooldown.set(id, untilMs)
      persistCooldown()
      scheduleRecovery(id, untilMs)
      log.info("autoswitch:cooldown-enter", { id, until: untilMs })
      return
    }
    cooldown.delete(id)
    cooldownPending.add(id)
    log.info("autoswitch:cooldown-indefinite", { id })
  }

  function clearCooldown(id: string): void {
    const timer = recoveryTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      recoveryTimers.delete(id)
    }
    cooldownPending.delete(id)
    if (cooldown.delete(id)) {
      persistCooldown()
      log.info("autoswitch:cooldown-clear", { id })
    }
  }

  function isCooled(id: string, now: number): boolean {
    if (cooldownPending.has(id)) return true
    const until = cooldown.get(id)
    return typeof until === "number" && until > now
  }

  // Deadline: (1) server header; else (2) the account's binding-window FUTURE resets_at from cache.
  // resets_at is absolute wall-clock, so USAGE_CACHE_TTL_MS is intentionally NOT applied. Binding =
  // a window at the limit (util >= 100); not-maxed ⇒ undefined (honest unknown). Multiple maxed
  // windows ⇒ the LATEST reset (never clear the cooldown before the last binding window clears).
  function resolveResetMs(error: RetryErrorLike, id?: string): number | undefined {
    const header = PROVIDERS.anthropic.parseResetMs(error)
    if (header !== undefined) return header
    if (!id) return undefined
    const usage = usageCache.byId.get(id)
    if (!usage) return undefined
    return latestMaxedReset(PROVIDERS.anthropic.normalize(usage), Date.now())
  }

  const stored = api.kv.get<Record<string, number>>(COOLDOWN_KV_KEY, {})
  if (stored) {
    const now = Date.now()
    for (const [id, until] of Object.entries(stored)) {
      if (until <= now) continue
      cooldown.set(id, until)
      scheduleRecovery(id, until)
    }
  }

  function setUsageCache(results: AccountUsage[]): void {
    const byId = new Map<string, UsageResponse>()
    for (const result of results) if (result.usage) byId.set(result.id, result.usage)
    usageCache = { at: Date.now(), byId }
    // Sole clearing path for indefinite cooldowns: a fresh snapshot either supplies the real reset
    // (upgrade to a timed cooldown + accurate recovery) or shows the account is no longer maxed
    // (clear it). Lives here so it fires for BOTH /usage and the background refresh (the caller-side
    // `refreshing` guard would skip it).
    for (const id of [...cooldownPending]) {
      if (!cooldownPending.has(id)) continue
      const at = resolveResetMs({}, id)
      if (at !== undefined) markCooldown(id, at)
      else clearCooldown(id)
    }
  }

  // INV-1: returns true when a session is running OR the running-state is UNKNOWN; false ONLY on a
  // positively-confirmed idle. An empty knownAnthropicSessions set (nothing observed yet) reads as
  // running, never idle — so the active-token self-refresh never fires while a turn might be live.
  function isSessionRunning(): boolean {
    if (runningSessions.size > 0) return true
    if (knownAnthropicSessions.size === 0) return true
    for (const sid of knownAnthropicSessions) {
      const status = api.state.session.status(sid)
      if (status && status.type !== "idle") return true
    }
    return false
  }

  async function refreshUsageInBackground(): Promise<void> {
    if (refreshing) return
    refreshing = true
    try {
      const { results } = await collectAllUsage({ isSessionRunning })
      setUsageCache(results)
    } catch {
      // best-effort cache warming; selection falls back to round-robin
      log.debug("autoswitch:usage-refresh-fail")
    } finally {
      refreshing = false
    }
  }

  function dedup(id: string): boolean {
    if (seen.has(id)) return false
    seen.add(id)
    if (seen.size > 1000) {
      seen.clear()
      seen.add(id)
    }
    return true
  }

  function runExclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = sessionLocks.get(key) ?? Promise.resolve()
    const run = prev.then(fn, fn)
    sessionLocks.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    )
    return run
  }

  function labelOf(file: AccountsFile, id?: string): string {
    return file.accounts.find((account) => account.id === id)?.label ?? "当前账号"
  }

  function lastAssistant(sessionID: string): AssistantMsg | undefined {
    const messages = api.state.session.messages(sessionID)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "assistant") return message
    }
    return undefined
  }

  // Turn-scoped on purpose: after a mid-session model switch the previous turn's assistant
  // still sits in history, so a session-wide lookup would keep reporting the old provider.
  // "other" = a provider we have no ops for (a third-party model); "unknown" = the turn has not
  // emitted its assistant message yet, which is NOT the same thing and must stay distinguishable.
  function currentTurnProvider(sessionID: string): ProviderId | "other" | "unknown" {
    const assistant = latestTurn(api.state.session.messages(sessionID))?.failed
    if (!assistant || assistant.role !== "assistant") return "unknown"
    return toProviderId(assistant.providerID) ?? "other"
  }

  // The two consumers below need OPPOSITE defaults for an unknown provider, because the
  // unsafe direction is opposite for each. Parameterizing them by provider must NOT relax
  // either default — and note the accounting side is `=== provider || === "unknown"`, never
  // `!== "other"`: now that a CONFIRMED sibling provider (openai) is representable, `!== "other"`
  // would count a live ChatGPT turn as an anthropic running session and re-open exactly the
  // race INV-1 closes from the other direction.

  // INV-1 side: a turn that has not emitted its assistant message yet may still be a live
  // session of this provider, so it must read as running — otherwise the active-token
  // self-refresh could fire mid-flight and race ex-machina for the one-shot refresh token.
  function mayBeProviderSession(sessionID: string, provider: ProviderId): boolean {
    const turn = currentTurnProvider(sessionID)
    return turn === provider || turn === "unknown"
  }

  // Switch side: an unknown provider must NOT switch. Beyond misfiring on another
  // provider's 429, the switch is provably useless here — latestTurn() needs an assistant
  // message, so repromptFailedTurn falls through to the manual-resend toast after we have
  // already burned the outgoing account into cooldown.
  function isConfirmedProviderSession(sessionID: string, provider: ProviderId): boolean {
    return currentTurnProvider(sessionID) === provider
  }

  // Runs the limit detector belonging to the turn's OWN provider and records the verdict.
  // DETECTION AND LOGGING ARE UNCONDITIONAL, including for a provider whose action is disabled:
  // whether OpenCode's event layer even delivers a ChatGPT 429 body/headers to a TUI plugin is
  // UNVERIFIED, and this log (alongside probeForeignLimit's raw sample) is the ONLY channel
  // through which that will be confirmed. Gating detection on the flag would make the question
  // permanently unanswerable, so only the returned go-ahead is withheld.
  // Returns the provider to act for, or undefined. Callers must treat a non-anthropic return as
  // unreachable while ACTION_ENABLED.openai is false — handleLimit's tail is anthropic-only.
  function decideLimit(sessionID: string, error: RetryErrorLike, source: "status" | "error"): ProviderId | undefined {
    const turn = currentTurnProvider(sessionID)
    // Routed through isConfirmedProviderSession rather than narrowing `turn` directly, so the
    // switch-side default stays the SINGLE place that decides it: an "unknown" turn is confirmed
    // for no provider and therefore matches nothing here. Narrowing `turn` inline would leave that
    // function unreferenced and its invariant untested (P7's mutation would stop biting).
    const provider = PROVIDER_IDS.find((id) => isConfirmedProviderSession(sessionID, id))
    const matched = provider !== undefined && PROVIDERS[provider].isUsageLimit(error)
    const enabled = provider !== undefined && ACTION_ENABLED[provider]
    log.debug(`autoswitch:${source}-decision`, { matched, turn, enabled })
    return matched && enabled ? provider : undefined
  }

  // Debug-only, no behaviour change. The ChatGPT limit signature documented in openai/codex
  // (429 + body error.type=usage_limit_reached + x-codex-* headers) is UNVERIFIED on the path
  // a TUI plugin actually receives: session.status delivers a bare message string and nothing
  // else, so that signature may be unreachable here. Capture what a non-anthropic turn really
  // carries, so the openai detector gets written against a real sample instead of the Rust source.
  function probeForeignLimit(sessionID: string, source: "retry" | "error", error: RetryErrorLike, raw?: unknown): void {
    const provider = currentTurnProvider(sessionID)
    if (provider === "anthropic") return
    const failed = latestTurn(api.state.session.messages(sessionID))?.failed
    const assistant = failed && failed.role === "assistant" ? failed : undefined
    log.debug("autoswitch:foreign-limit-probe", {
      source,
      provider,
      providerID: assistant?.providerID,
      modelID: assistant?.modelID,
      statusCode: error.statusCode,
      message: redactBody(error.message),
      body: redactBody(error.responseBody),
      headerKeys: redactHeaders(error.responseHeaders),
      limitHeaders: diagnosticHeaders(error.responseHeaders),
      rawEnvelope: source === "error" ? describeRawError(raw) : undefined,
    })
  }

  function pickNext(file: AccountsFile, tried: Set<string>, activeId?: string): StoredAccount | undefined {
    const now = Date.now()
    // INV-P1: auto-switch is ANTHROPIC-only — the pick is handed to switchToAccount, which writes
    // auth.json's `anthropic` entry. A provider-blind pool would file a ChatGPT refresh token
    // there and break BOTH accounts at once, so the candidate list AND the round-robin order below
    // must come from accountsOf (never `provider === "anthropic"`, which drops legacy records).
    const pool = accountsOf(file, "anthropic")
    const candidates = pool.filter(
      (account) => account.id !== activeId && !tried.has(account.id) && !isCooled(account.id, now) && !account.excluded && !account.needsReauth,
    )
    if (candidates.length === 0) {
      log.debug("autoswitch:pick", { candidates: 0, cacheFresh: false, picked: undefined })
      return undefined
    }

    const cacheFresh = usageCache.at > 0 && now - usageCache.at <= USAGE_CACHE_TTL_MS
    let picked: StoredAccount | undefined = candidates[0]
    if (cacheFresh) {
      picked = [...candidates].sort((a, b) => score(usageCache.byId.get(a.id)) - score(usageCache.byId.get(b.id)))[0]
    } else {
      const order = pool.map((account) => account.id)
      const start = activeId ? order.indexOf(activeId) : -1
      for (let offset = 1; offset <= order.length; offset++) {
        const id = order[(start + offset + order.length) % order.length]
        const match = candidates.find((account) => account.id === id)
        if (match) {
          picked = match
          break
        }
      }
    }
    log.debug("autoswitch:pick", { candidates: candidates.length, cacheFresh, picked: picked?.id })
    return picked
  }

  function standDown(file: AccountsFile): void {
    const now = Date.now()
    // INV-P1: both the countdown and "how many accounts exist" are ANTHROPIC facts. A mixed pool
    // inflates the count and lets a ChatGPT record's cooldown deadline become the recovery time
    // this alert promises the user.
    const pool = accountsOf(file, "anthropic")
    const times = pool
      .map((account) => cooldown.get(account.id))
      .filter((until): until is number => typeof until === "number" && until > now)
    const soonest = times.length > 0 ? Math.min(...times) : undefined
    const message = soonest
      ? `所有账号都已达额度上限，约 ${fmtDuration(soonest - now)} 后恢复`
      : "所有账号都已达额度上限"
    log.warn("autoswitch:standdown", { accounts: pool.length, soonest })
    api.ui.toast({ variant: "error", message })
    openExhaustedAlert(api, soonest ? soonest - now : undefined)
  }

  async function doSwitch(sessionID: string, error: RetryErrorLike, activeId?: string): Promise<boolean> {
    if (activeId) markCooldown(activeId, resolveResetMs(error, activeId))

    const file = await loadAccounts()
    const tried = attempted.get(sessionID) ?? new Set<string>()
    attempted.set(sessionID, tried)
    // INV-P1: the "nothing to switch to" fast path and the retry bound are ANTHROPIC counts; a
    // ChatGPT record must never fake a spare Claude account here.
    const pool = accountsOf(file, "anthropic")
    if (pool.length <= 1) {
      standDown(file)
      return false
    }

    for (let i = 0; i < pool.length; i++) {
      const next = pickNext(file, tried, activeId)
      if (!next) break
      try {
        const account = await switchToAccount(next.id, "anthropic")
        tried.add(next.id)
        lastSwitch = { id: account.id, sessionID, at: Date.now() }
        log.info("autoswitch:switched", { from: labelOf(file, activeId), to: account.label })
        api.ui.toast({
          variant: "warning",
          message: `「${labelOf(file, activeId)}」额度已满，已切到「${account.label}」并自动重试`,
        })
        void refreshUsageInBackground()
        return true
      } catch (error) {
        log.warn("autoswitch:switch-candidate-fail", { id: next.id, error: String(error) })
        tried.add(next.id)
        markCooldown(next.id, undefined)
      }
    }

    standDown(file)
    return false
  }

  function toInputParts(parts: StateParts): PromptParts {
    const out: PromptParts = []
    for (const part of parts) {
      if (part.type === "text") {
        if (part.synthetic || part.ignored) continue
        if (part.text && part.text.trim().length > 0) out.push({ type: "text", text: part.text })
      } else if (part.type === "file") {
        out.push({ type: "file", mime: part.mime, filename: part.filename, url: part.url, source: part.source })
      }
    }
    return out
  }

  async function waitIdle(sessionID: string): Promise<boolean> {
    const deadline = Date.now() + IDLE_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      const status = api.state.session.status(sessionID)
      if (!status || status.type === "idle") return true
      await sleep(IDLE_POLL_MS)
    }
    log.debug("autoswitch:wait-idle-timeout", { sessionID })
    return false
  }

  async function repromptFailedTurn(sessionID: string, abortFirst: boolean): Promise<void> {
    if (repromptInFlight.has(sessionID)) return
    repromptInFlight.add(sessionID)
    const guidance = () => api.ui.toast({ variant: "info", message: "已切换账号，请手动重新发送上一条消息" })
    try {
      if (abortFirst) {
        try {
          await api.client.session.abort({ sessionID })
        } catch {
          // ignore: stream may already be settling
        }
      }
      if (!(await waitIdle(sessionID))) return guidance()

      const messages = api.state.session.messages(sessionID)
      const turn = latestTurn(messages)
      if (!turn) return guidance()
      const { user, failed, assistants } = turn

      if (lastHandledAssistantId.get(sessionID) === failed.id) return

      // Fold parts across all assistant steps, not just the last: a rate-limit hit at a step
      // boundary leaves an empty placeholder tail, so judging `failed.id` alone resends instead
      // of continuing the productive earlier steps.
      const failedParts: PartLike[] = assistants.flatMap((m) =>
        api.state.part(m.id).map((part) => ({
          type: part.type,
          tool: part.type === "tool" ? part.tool : undefined,
          text: part.type === "text" ? part.text : undefined,
          state: part.type === "tool" ? { status: part.state?.status } : undefined,
        })),
      )

      let parts: PromptParts
      if (decideRedo(failedParts) === "continue") {
        parts = [{ type: "text", text: "continue" }]
        log.debug("autoswitch:continue", { sessionID })
      } else {
        parts = toInputParts(api.state.part(user.id))
        if (parts.length === 0) return guidance()
        log.debug("autoswitch:resend", { sessionID })
      }

      lastHandledAssistantId.set(sessionID, failed.id)
      // Replay the failed turn's model + agent so the redo runs under the same config;
      // promptAsync has no `mode` param, so session mode cannot be carried over (known limit).
      const arg: Parameters<TuiPluginApi["client"]["session"]["promptAsync"]>[0] = { sessionID, parts }
      if (failed.role === "assistant") {
        arg.model = { providerID: failed.providerID, modelID: failed.modelID }
        if (failed.agent) arg.agent = failed.agent
      }
      const prompted = await api.client.session.promptAsync(arg)
      if (prompted.error) {
        lastHandledAssistantId.delete(sessionID)
        guidance()
      }
    } catch {
      guidance()
    } finally {
      repromptInFlight.delete(sessionID)
    }
  }

  async function handleLimit(sessionID: string, error: RetryErrorLike, mode: "retry" | "error"): Promise<void> {
    await runExclusive(sessionID, async () => {
      const now = Date.now()
      // Coalesce the burst of retry/error events a single failed turn emits: once we have
      // acted for this session, ignore further limit events until that action settles.
      if (now - (lastAction.get(sessionID) ?? 0) < RECENT_SWITCH_GUARD_MS) return

      const activeId = await readActiveId()
      // Cross-session race: another session just switched to this fresh account, so the
      // failure predates the switch. Reuse the fresh account instead of cooling it again.
      const reuseFresh =
        !!activeId && lastSwitch.id === activeId && lastSwitch.sessionID !== sessionID && now - lastSwitch.at < RECENT_SWITCH_GUARD_MS
      // INV-CLOUD-2: a strategy present means cloud-worker mode, where the MASTER owns account
      // SELECTION and COOLDOWN — it alone sees the whole roster and every worker's reports — so the
      // local pick/cooldown machinery is deliberately NOT consulted. Detection and resume must stay
      // here: the limit is only observable as this session's failed turn, and only this session can
      // re-issue it. `??` short-circuits, so `strategy === undefined` evaluates the original
      // expression untouched and doSwitch is never even entered in cloud mode. `activeId ?? ""` =
      // this worker has never recorded a leased account (worker/install.ts's writeLease seam writes
      // one on every lease), so there is no account for the master to cool or exclude.
      const leased = strategy
        ? await strategy.onLimit({ accountId: activeId ?? "", headers: diagnosticHeaders(error.responseHeaders), resetsAt: PROVIDERS.anthropic.parseResetMs(error) })
        : undefined
      const usable = leased ?? (reuseFresh ? true : await doSwitch(sessionID, error, activeId))
      if (!usable) {
        stalledSessions.add(sessionID)
        return
      }

      lastAction.set(sessionID, Date.now())
      await repromptFailedTurn(sessionID, mode === "retry")
    })
  }

  // INV-CLOUD-5: a 401 on a LEASED token is a POOL-COORDINATION event, never a quota event. MEASURED
  // against the real API: once the master refreshes an account (grant_type=refresh_token), the access
  // token issued BEFORE that refresh answers 401 — Anthropic revokes it on rotation — so a master
  // refresh kills every outstanding lease for that account. The account is HEALTHY, hence this path
  // deliberately shares NOTHING with handleLimit's tail: no markCooldown, no pickNext/doSwitch, and
  // no report telling the master to exclude an account that would only cost the pool capacity.
  // Re-lease the same account, then hand the turn to the caller's EXISTING resume logic.
  async function handleStaleLease(sessionID: string, cloud: SwitchStrategy): Promise<void> {
    await runExclusive(sessionID, async () => {
      if (Date.now() - (lastAction.get(sessionID) ?? 0) < RECENT_SWITCH_GUARD_MS) return
      if (!(await cloud.onStaleLease({ accountId: (await readActiveId()) ?? "" }))) return
      lastAction.set(sessionID, Date.now())
      await repromptFailedTurn(sessionID, false)
    })
  }

  async function onStatus(event: {
    id: string
    properties: { sessionID: string; status?: { type: string; message?: string; next?: number } }
  }): Promise<void> {
    const status = event.properties.status
    log.debug("autoswitch:status", {
      sessionID: event.properties.sessionID,
      type: status?.type,
      message: status?.type === "retry" ? status.message : undefined,
    })
    const sid = event.properties.sessionID
    if (mayBeProviderSession(sid, "anthropic")) {
      knownAnthropicSessions.add(sid)
      if (status?.type === "idle") runningSessions.delete(sid)
      else if (status?.type) runningSessions.add(sid)
    }
    if (status?.type !== "retry" || !ENABLED || !dedup(event.id)) return
    const error: RetryErrorLike = { message: status.message }
    probeForeignLimit(sid, "retry", error)
    if (decideLimit(sid, error, "status") === undefined) return
    await handleLimit(event.properties.sessionID, error, "retry")
  }

  async function onError(event: { id: string; properties: { sessionID?: string; error?: unknown } }): Promise<void> {
    const sessionID = event.properties.sessionID
    const error = toErrorData(event.properties.error)
    log.debug("autoswitch:error", {
      sessionID,
      statusCode: error?.statusCode,
      message: error?.message,
      headerKeys: redactHeaders(error?.responseHeaders),
      body: redactBody(error?.responseBody),
    })
    if (sessionID) runningSessions.delete(sessionID)
    if (!ENABLED || !dedup(event.id) || !sessionID) return
    probeForeignLimit(sessionID, "error", error ?? {}, event.properties.error)
    // Gated on `strategy` so local mode is byte-for-byte unchanged, and on mayBeProviderSession
    // (NOT isConfirmedProviderSession) because leases live in the anthropic slot: a confirmed ChatGPT
    // 401 must not consume one, while an unattributed turn may well be ours and the re-lease repairs
    // auth.json regardless — leaseKeeper cannot, a revoked lease is not yet expired.
    if (strategy && error?.statusCode === 401 && mayBeProviderSession(sessionID, "anthropic")) return await handleStaleLease(sessionID, strategy)
    // `error ?? {}` so the decision is still logged when the envelope carried no data at all —
    // that emptiness is itself the diagnostic the probe is looking for.
    const decided = decideLimit(sessionID, error ?? {}, "error")
    if (decided === undefined || !error) return
    await handleLimit(sessionID, error, "error")
  }

  async function onIdle(sessionID: string): Promise<void> {
    runningSessions.delete(sessionID)
    const assistant = lastAssistant(sessionID)
    if (assistant && !assistant.error) {
      // Only an ANTHROPIC success tells us anything about the anthropic account in the slot.
      // Clearing on any successful turn meant a ChatGPT reply lifted a Claude account's
      // cooldown, putting a still-rate-limited account back into selection to burn a switch.
      // Read from this very assistant message rather than currentTurnProvider so the verdict
      // belongs to the message we just confirmed succeeded. Unknown provider ⇒ do NOT clear:
      // a missed clear self-corrects (the real reset fires, or the next confirmed success
      // clears it), whereas clearing too early is the harmful direction.
      if (assistant.providerID === "anthropic") {
        const activeId = await readActiveId()
        if (activeId) clearCooldown(activeId)
      }
      // A successful turn resets the per-session switch state so a later limit can switch again;
      // this relocates the reset the dead session.next.prompted handler used to do.
      attempted.delete(sessionID)
      lastAction.delete(sessionID)
      // User manually resumed this turn → drop it from auto-resume so recovery won't re-continue it.
      stalledSessions.delete(sessionID)
    }
    // Pinned to anthropic: this hook injects a synthetic limit straight into handleLimit,
    // bypassing decideLimit and therefore the dark-launch gate too, so an unpinned hook could
    // put a ChatGPT session into the anthropic switch/stall bookkeeping. Env-gated dev-only.
    if (forceLimitOnce && isConfirmedProviderSession(sessionID, "anthropic")) {
      forceLimitOnce = false
      log.info("autoswitch:force-limit-injected", { sessionID })
      const error: RetryErrorLike = { statusCode: 429, message: "forced rate limit (test): rate limit reached" }
      await handleLimit(sessionID, error, "error")
    }
  }

  log.info("autoswitch:installed", { enabled: ENABLED })

  // session.next.* is not delivered to the current OpenCode SDK; detection relies on
  // session.status(retry) + session.error.
  const offs = [
    api.event.on("session.status", (event) => {
      void onStatus(event)
    }),
    api.event.on("session.error", (event) => {
      void onError(event)
    }),
    api.event.on("session.idle", (event) => {
      void onIdle(event.properties.sessionID)
    }),
  ]

  return {
    dispose: () => {
      for (const off of offs) {
        try {
          off()
        } catch {
          // ignore unsubscribe failures during teardown
        }
      }
      for (const timer of recoveryTimers.values()) clearTimeout(timer)
      recoveryTimers.clear()
      persistCooldown()
    },
    setUsageCache,
    isSessionRunning,
  }
}
