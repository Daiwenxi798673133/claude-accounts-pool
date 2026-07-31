import type { AnthropicOauth, AuthToken, ProviderId, StoredAccount } from "./accounts.ts"
import { accountsOf, applyToken, loadAccounts, providerOf, readAuthAnthropic, saveAccounts, upsertAccount, withAuthLock, writeAuthAnthropic } from "./accounts.ts"
import { ACTIVE_WAIT_POLL_MS, ACTIVE_WAIT_TIMEOUT_MS, CLIENT_ID, INACTIVE_REFRESH_THRESHOLD_MS, NETWORK_TIMEOUT_MS, OAUTH_BETA, TOKEN_EXPIRY_BUFFER_MS, TOKEN_URL, USAGE_ENDPOINT } from "./constants.ts"
import { log, redactBody, redactHeaders } from "./logger.ts"
import { fetchProfile } from "./profile.ts"

const REFRESH_DELAY_MS = 500
const REFRESH_429_COOLDOWN_MS = 5 * 60_000

// Thrown ONLY for a 400 `invalid_grant` refresh response: the stored refresh token has
// been rotated out / revoked and can NEVER succeed again. Distinct from transient
// failures (429/5xx/network) so callers can mark the account for re-login instead of
// hammering a permanently-dead token every cycle.
export class RefreshRevokedError extends Error {
  readonly revoked = true as const
  constructor(readonly refresh: string) {
    super("refresh token revoked (invalid_grant)")
    this.name = "RefreshRevokedError"
  }
}

function isInvalidGrant(body: string): boolean {
  try {
    return (JSON.parse(body) as { error?: string }).error === "invalid_grant"
  } catch {
    return false
  }
}

// Row sentinel for an account whose stored refresh token is revoked: the dialog maps it
// to a "需重新登录" prompt instead of a raw "token refresh failed (400)".
export const NEEDS_REAUTH_ERROR = "needs-reauth"

const inflightRefresh = new Map<string, Promise<{ access: string; refresh: string; expires: number }>>()
const refresh429Cooldown = new Map<string, number>()

export type UsageWindow = { utilization: number; resets_at?: string }

// A per-model weekly window whose model name (e.g. "Fable") is dynamic, so it rides with
// the window as `label`.
export type ScopedUsageWindow = UsageWindow & { label: string }

// Anthropic moved the per-model weekly breakdown out of the fixed `seven_day_opus` /
// `seven_day_sonnet` fields (now null for most accounts) into the `limits[]` array;
// fetchUsage normalizes those `weekly_scoped` entries into `scoped`. Legacy fields kept
// for any account/plan that still populates them. Absent windows arrive as `null`.
export type UsageResponse = {
  five_hour?: UsageWindow | null
  seven_day?: UsageWindow | null
  seven_day_sonnet?: UsageWindow | null
  seven_day_opus?: UsageWindow | null
  scoped?: ScopedUsageWindow[]
}

type RawLimit = {
  kind?: string
  percent?: unknown
  resets_at?: unknown
  scope?: { model?: { display_name?: unknown } | null } | null
}

function scopedFromLimits(limits: unknown): ScopedUsageWindow[] | undefined {
  if (!Array.isArray(limits)) return undefined
  const out: ScopedUsageWindow[] = []
  for (const raw of limits as RawLimit[]) {
    if (raw?.kind !== "weekly_scoped") continue
    const label = raw.scope?.model?.display_name
    if (typeof label !== "string" || label.length === 0) continue
    if (typeof raw.percent !== "number" || !Number.isFinite(raw.percent)) continue
    const resets_at = typeof raw.resets_at === "string" ? raw.resets_at : undefined
    out.push({ label, utilization: raw.percent, resets_at })
  }
  return out.length > 0 ? out : undefined
}

export type AccountUsage = {
  id: string
  label: string
  active: boolean
  usage?: UsageResponse
  error?: string
  pending?: "waiting-refresh" | "refreshing"
  needsReauth?: boolean
}

export type ActiveTokenOutcome = {
  access?: string
  state: "fresh" | "waited" | "self-refreshed" | "waiting-timeout" | "unavailable"
  authToken?: AuthToken
}

export type CollectOptions = {
  // REQUIRED (INV-1): omitting the predicate MUST be a compile error, never a
  // silent "assume idle" that would let the plugin self-refresh the active chain.
  // Unknown-state callers pass `() => true` (assume running → never self-refresh).
  isSessionRunning: () => boolean
  onPartial?: (results: AccountUsage[]) => void
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isStale(token: { access?: string; expires?: number }, bufferMs = TOKEN_EXPIRY_BUFFER_MS): boolean {
  return !token.access || !token.expires || token.expires < Date.now() + bufferMs
}

function isRefresh429Cooldown(refresh: string): boolean {
  const until = refresh429Cooldown.get(refresh)
  if (!until) return false
  if (Date.now() >= until) {
    refresh429Cooldown.delete(refresh)
    return false
  }
  return true
}

function doRefreshToken(refresh: string): Promise<{ access: string; refresh: string; expires: number }> {
  // PRIVACY: never log the request body — it contains the refresh_token / grant_type.
  log.debug("usage:refresh-start")
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/plain, */*",
      "User-Agent": "axios/1.13.6",
    },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  }).then(async (res) => {
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        headers[key] = value
      })
      log.warn("usage:refresh-failed", { status: res.status, headerKeys: redactHeaders(headers), body: redactBody(body) })
      if (res.status === 429) {
        refresh429Cooldown.set(refresh, Date.now() + REFRESH_429_COOLDOWN_MS)
      }
      if (res.status === 400 && isInvalidGrant(body)) {
        log.warn("usage:refresh-revoked")
        throw new RefreshRevokedError(refresh)
      }
      throw new Error(`token refresh failed (${res.status})`)
    }
    const json = (await res.json()) as { access_token: string; refresh_token: string; expires_in: number }
    log.debug("usage:refresh-result", { status: res.status })
    return {
      access: json.access_token,
      refresh: json.refresh_token,
      expires: Date.now() + json.expires_in * 1000,
    }
  })
}

export function refreshToken(refresh: string): Promise<{ access: string; refresh: string; expires: number }> {
  const existing = inflightRefresh.get(refresh)
  if (existing) return existing
  const promise = doRefreshToken(refresh).finally(() => {
    inflightRefresh.delete(refresh)
  })
  inflightRefresh.set(refresh, promise)
  return promise
}

// Escape hatch: one explicit refresh of a needsReauth account (user pressed enter on its
// row). Success clears the flag via applyToken; a still-revoked token rethrows and keeps
// the flag. Never called from inside another withAuthLock (sequential lock, no nesting).
export async function retryFlaggedRefresh(id: string, expected: ProviderId = "anthropic"): Promise<void> {
  await withAuthLock(async () => {
    const file = await loadAccounts()
    const account = file.accounts.find((item) => item.id === id)
    if (!account) throw new Error("account not found")
    // INV-P1, same choke point as switchToAccount: refreshToken POSTs to Anthropic's TOKEN_URL,
    // so a cross-provider id would disclose that vendor's refresh token to platform.claude.com
    // and have the resulting 400 brand a healthy account needsReauth. Defaults to anthropic —
    // what every existing caller means — so an omitted argument fails closed.
    const provider = providerOf(account)
    if (provider !== expected) {
      log.warn("usage:retry-refuse-provider", { id, expected, provider })
      throw new Error("该账号与目标 provider 不一致,拒绝用 Claude 端点刷新")
    }
    try {
      const fresh = await refreshToken(account.refresh)
      applyToken(account, { kind: "full", token: fresh })
      await saveAccounts(file)
      log.info("usage:retry-flagged-ok", { id, label: account.label })
    } catch (error) {
      if (error instanceof RefreshRevokedError) {
        const latest = await loadAccounts()
        const rec = latest.accounts.find((item) => item.id === id)
        if (rec && !rec.needsReauth && rec.refresh !== error.refresh) {
          applyToken(account, { kind: "full", token: { refresh: rec.refresh, access: rec.access, expires: rec.expires } })
          await saveAccounts(file)
          log.info("usage:retry-adopt-rotation", { id, label: account.label })
          return
        }
      }
      throw error
    }
  })
}

// Idle-time pre-refresh of the ACTIVE chain (auth.json), staggered from ex-machina by
// construction: ex-machina only refreshes DURING a request, so refreshing while no
// anthropic session is running can never race it. This keeps the active token fresh so
// /usage is real-time even if a session starts later, without a "usage_refresh" probe
// message (which would burn real quota). The isSessionRunning re-check happens INSIDE
// the lock to shrink the race window to the in-flight POST only (same as selfRefresh).
const revokedActiveRefresh = new Set<string>()

export async function keepActiveFresh(isSessionRunning: () => boolean): Promise<void> {
  await withAuthLock(async () => {
    if (isSessionRunning()) return
    const auth = await readAuthAnthropic()
    if (!auth?.refresh) return
    if (revokedActiveRefresh.has(auth.refresh)) return
    if (auth.expires && auth.expires >= Date.now() + INACTIVE_REFRESH_THRESHOLD_MS) return
    if (isRefresh429Cooldown(auth.refresh)) return
    try {
      const fresh = await refreshToken(auth.refresh)
      await writeAuthAnthropic({ kind: "full", token: fresh })
      log.info("usage:active-keepalive-refreshed")
    } catch (error) {
      if (error instanceof RefreshRevokedError) revokedActiveRefresh.add(error.refresh)
      log.warn("usage:active-keepalive-fail", { error: errorMessage(error) })
    }
  })
}

export async function fetchUsage(access: string): Promise<UsageResponse> {
  log.debug("usage:fetch-start")
  const res = await fetch(USAGE_ENDPOINT, {
    headers: { Authorization: `Bearer ${access}`, "anthropic-beta": OAUTH_BETA },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
  if (!res.ok) {
    log.warn("usage:fetch-fail", { status: res.status })
    throw new Error(`usage request failed (${res.status})`)
  }
  const usage = (await res.json()) as UsageResponse & { limits?: unknown }
  const scoped = scopedFromLimits(usage.limits)
  if (scoped) usage.scoped = scoped
  return usage
}

// Identify whatever account ex-machina currently holds in auth.json by its profile
// uuid (stable across token rotation) and upsert it: the same account is updated in
// place, a genuinely new login is added — so no manual /account-add is needed.
export async function autoCapture(): Promise<void> {
  await withAuthLock(async () => {
    const auth = await readAuthAnthropic()
    if (!auth?.refresh) return

    // auth.json is the SINGLE source of truth for the active chain (INV-2): NEVER
    // refresh it here — a refresh would consume ex-machina's refresh token and cause
    // the permanent invalid_grant lockout. Capture only when the stored token is still
    // valid, and store it AS-IS (no rotation, no writeAuthAnthropic).
    // Known limitation: a brand-new account whose stored token is already expired is
    // captured only after its NEXT successful use (which refreshens auth.json); this
    // round is skipped rather than risk racing/breaking ex-machina's refresh.
    if (!isActiveFresh(auth)) return

    const profile = await fetchProfile(auth.access)
    await upsertAccount(
      profile.uuid,
      profile.email,
      { refresh: auth.refresh, access: auth.access, expires: auth.expires },
      profile.subscription,
    )
  })
}

// Resolve a usable access token for ONE inactive account, doing the entire
// read → staleness-check → refresh → persist as a SINGLE withAuthLock critical section.
// Re-reading the record inside the lock (never trusting the caller's t0 snapshot) is what
// closes the seeding races: a concurrent switch/collect can neither refresh an
// already-rotated token nor write a stale one, because it either waits for this block to
// persist the rotation first, or sees the account has since become active (INV-2 → never
// touch the auth-held chain) and skips. A rotated token is persisted BEFORE the lock is
// released, so it is never lost on crash between the refresh and the write.
type InactiveOutcome = { access?: string; error?: string; refreshed: boolean; needsReauth?: boolean }

function liveAccess(account: StoredAccount | undefined): string | undefined {
  if (!account?.access || !account.expires) return undefined
  return account.expires >= Date.now() + TOKEN_EXPIRY_BUFFER_MS ? account.access : undefined
}

function reauthOutcome(account: StoredAccount | undefined): InactiveOutcome {
  const access = liveAccess(account)
  if (access) return { access, refreshed: false, needsReauth: true }
  return { error: NEEDS_REAUTH_ERROR, refreshed: false, needsReauth: true }
}

export async function acquireInactiveAccess(id: string): Promise<InactiveOutcome> {
  return withAuthLock(async () => {
    const current = await loadAccounts()
    const account = current.accounts.find((item) => item.id === id)
    if (!account) return { error: "missing access token", refreshed: false }
    if (current.activeId === id) return { access: account.access, refreshed: false }
    if (account.needsReauth) return reauthOutcome(account)
    if (!isStale(account, INACTIVE_REFRESH_THRESHOLD_MS)) return { access: account.access, refreshed: false }
    if (isRefresh429Cooldown(account.refresh)) {
      log.warn("usage:refresh-skip-429", { label: account.label })
      return { access: account.access, refreshed: false }
    }
    try {
      const fresh = await refreshToken(account.refresh)
      applyToken(account, { kind: "full", token: fresh })
      await saveAccounts(current)
      return { access: fresh.access, refreshed: true }
    } catch (error) {
      if (error instanceof RefreshRevokedError) {
        // Cross-process guard: re-read the store BEFORE flagging. If another OpenCode
        // window already rotated this account (our POSTed token lost the race), the
        // account is perfectly healthy — adopt the winner's token instead of branding a
        // live account as needs-reauth. NEVER adopt a record that is itself flagged:
        // that would clear another process's dead-chain verdict.
        const latest = await loadAccounts()
        const rec = latest.accounts.find((item) => item.id === id)
        if (rec && !rec.needsReauth && rec.refresh !== error.refresh) {
          log.info("usage:adopt-foreign-rotation", { id, label: rec.label })
          return { access: liveAccess(rec), refreshed: false }
        }
        if (rec && !rec.needsReauth) {
          rec.needsReauth = true
          await saveAccounts(latest)
          log.warn("usage:account-needs-reauth", { id, label: rec.label })
        }
        return reauthOutcome(rec)
      }
      throw error
    }
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// INV-5: the active account is FRESH only when auth.json's own access token is not
// yet expired — a HARD check with NO TOKEN_EXPIRY_BUFFER_MS, matching ex-machina, so
// we never wait for / trigger a refresh ex-machina itself would not produce.
function isActiveFresh(auth: AnthropicOauth | undefined): auth is AnthropicOauth & { access: string; expires: number } {
  return Boolean(auth?.access && auth.expires && auth.expires >= Date.now())
}

function toAuthToken(auth: AnthropicOauth | undefined): AuthToken | undefined {
  if (!auth?.refresh) return undefined
  return { refresh: auth.refresh, access: auth.access, expires: auth.expires }
}

async function waitForExMachinaRefresh(initial: AnthropicOauth | undefined): Promise<ActiveTokenOutcome> {
  let last = initial
  const deadline = Date.now() + ACTIVE_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    await sleep(ACTIVE_WAIT_POLL_MS)
    last = await readAuthAnthropic()
    if (isActiveFresh(last)) {
      return { access: last.access, state: "waited", authToken: { refresh: last.refresh!, access: last.access, expires: last.expires } }
    }
  }
  return { state: "waiting-timeout", authToken: toAuthToken(last) }
}

async function selfRefresh(initial: AnthropicOauth | undefined, isSessionRunning: () => boolean): Promise<ActiveTokenOutcome> {
  let auth = initial
  try {
    auth = await readAuthAnthropic()
    if (isActiveFresh(auth)) {
      return { access: auth.access, state: "self-refreshed", authToken: { refresh: auth.refresh!, access: auth.access, expires: auth.expires } }
    }
    if (!auth?.refresh) return { state: "unavailable", authToken: toAuthToken(auth) }
    if (isRefresh429Cooldown(auth.refresh)) return { state: "unavailable", authToken: toAuthToken(auth) }
    if (isSessionRunning()) return { state: "waiting-timeout", authToken: toAuthToken(auth) }
    const fresh = await refreshToken(auth.refresh)
    await writeAuthAnthropic({ kind: "full", token: fresh })
    return { access: fresh.access, state: "self-refreshed", authToken: fresh }
  } catch (error) {
    // H2: the plugin never surfaces its own refresh error — re-read auth.json and
    // use whatever token is there (ex-machina may have written a fresh one).
    log.warn("usage:active-self-refresh-fail", { error: errorMessage(error) })
    const auth2 = await readAuthAnthropic()
    if (isActiveFresh(auth2)) {
      return { access: auth2.access, state: "self-refreshed", authToken: { refresh: auth2.refresh!, access: auth2.access, expires: auth2.expires } }
    }
    return { state: "unavailable", authToken: toAuthToken(auth2) ?? toAuthToken(auth) }
  }
}

// Resolve a usable access token for the ACTIVE account from auth.json ONLY (INV-2),
// via the three-branch policy: FRESH → use it; EXPIRED+running → wait for ex-machina
// (ZERO refresh POSTs); EXPIRED+idle → self-refresh once under a single lock and write
// back. `isSessionRunning` is a REQUIRED param (INV-1): unknown-state callers pass
// `() => true` so we default to waiting rather than racing ex-machina.
export async function acquireActiveAccess(isSessionRunning: () => boolean): Promise<ActiveTokenOutcome> {
  const auth = await readAuthAnthropic()
  if (isActiveFresh(auth)) {
    return { access: auth.access, state: "fresh", authToken: { refresh: auth.refresh!, access: auth.access, expires: auth.expires } }
  }
  if (isSessionRunning()) return waitForExMachinaRefresh(auth)
  return withAuthLock(() => selfRefresh(auth, isSessionRunning))
}

export async function collectAllUsage(opts: CollectOptions): Promise<{ activeId?: string; results: AccountUsage[] }> {
  const { isSessionRunning, onPartial } = opts
  const file = await loadAccounts()
  const auth = await readAuthAnthropic()

  // INV-P1: every row below feeds its record's refresh token to acquireInactiveAccess, i.e. to a
  // POST at Anthropic's TOKEN_URL. Filtering the pool HERE — before any record reaches a request
  // builder — is what keeps a ChatGPT refresh token from being disclosed to platform.claude.com
  // (and from being branded needsReauth by the 400 that comes back).
  const pool = accountsOf(file, "anthropic")

  const activeRecord = file.activeId ? pool.find((account) => account.id === file.activeId) : undefined
  const hasActive = Boolean(activeRecord) || Boolean(auth)
  const activeBase = {
    id: activeRecord?.id ?? file.activeId ?? "active",
    label: activeRecord?.label ?? "当前账号",
    active: true,
  }

  // INACTIVE accounts (everything that is NOT the auth-held/active one): proactive 30-min
  // refresh via a per-account locked read→refresh→persist (INV-3, writes accounts.json
  // only). The token POST + its persist live inside acquireInactiveAccess's lock; the
  // usage fetch runs OUTSIDE the lock so a slow network fetch never starves switches.
  const inactiveAccounts = pool.filter((account) => account !== activeRecord)
  const inactiveResults = new Map<string, AccountUsage>()
  for (let index = 0; index < inactiveAccounts.length; index++) {
    const account = inactiveAccounts[index]
    const base = { id: account.id, label: account.label, active: false }
    let refreshed = false
    try {
      const outcome = await acquireInactiveAccess(account.id)
      refreshed = outcome.refreshed
      const flag = outcome.needsReauth ? { needsReauth: true as const } : {}
      if (outcome.access) {
        try {
          const usage = await fetchUsage(outcome.access)
          inactiveResults.set(account.id, { ...base, usage, ...flag })
        } catch (fetchError) {
          log.warn("usage:collect-account-fail", { label: account.label, error: errorMessage(fetchError) })
          inactiveResults.set(account.id, { ...base, error: errorMessage(fetchError), ...flag })
        }
      } else {
        inactiveResults.set(account.id, { ...base, error: outcome.error ?? "missing access token", ...flag })
      }
    } catch (error) {
      log.warn("usage:collect-account-fail", { label: account.label, error: errorMessage(error) })
      inactiveResults.set(account.id, { ...base, error: errorMessage(error) })
    }
    if (refreshed && index < inactiveAccounts.length - 1) {
      await sleep(REFRESH_DELAY_MS)
    }
  }

  // ACTIVE account: auth.json is the SINGLE source of truth (INV-2/4/5). FRESH → fetch
  // now (real-time); EXPIRED → defer to the resolve phase; no anthropic token → cached
  // or "未登录". The auth-held chain NEVER enters the inactive refresh path.
  let activeAuth: AuthToken | undefined = toAuthToken(auth)
  let activeFast: AccountUsage | undefined
  let activeDeferred = false
  if (hasActive) {
    if (!auth) {
      activeFast = { ...activeBase, error: "未登录" }
    } else if (isActiveFresh(auth)) {
      try {
        const usage = await fetchUsage(auth.access)
        activeFast = { ...activeBase, usage }
      } catch (error) {
        log.warn("usage:collect-active-fail", { error: errorMessage(error) })
        activeFast = { ...activeBase, error: errorMessage(error) }
      }
    } else {
      activeFast = { ...activeBase, pending: isSessionRunning() ? "waiting-refresh" : "refreshing" }
      activeDeferred = true
    }
  }

  const fastResults: AccountUsage[] = []
  if (activeRecord) {
    for (const account of pool) {
      fastResults.push(account === activeRecord ? activeFast! : inactiveResults.get(account.id)!)
    }
  } else {
    if (activeFast) fastResults.push(activeFast)
    for (const account of pool) fastResults.push(inactiveResults.get(account.id)!)
  }
  onPartial?.(fastResults)

  let activeResolved = activeFast
  if (activeDeferred) {
    let outcome: ActiveTokenOutcome | undefined
    try {
      outcome = await acquireActiveAccess(isSessionRunning)
    } catch (error) {
      // withFileLock (now live inside acquireActiveAccess's idle→withAuthLock branch) can
      // throw LockTimeoutError BEFORE selfRefresh's own body (and its H2 catch) ever runs.
      // Degrade this row honestly instead of rejecting the whole panel — inactive rows
      // already collected above must still reach the caller.
      log.warn("usage:collect-active-fail", { error: errorMessage(error) })
      activeResolved = { ...activeBase, error: "额度暂不可用(等待 token 刷新)" }
    }
    if (outcome) {
      if (outcome.access) {
        try {
          const usage = await fetchUsage(outcome.access)
          activeResolved = { ...activeBase, usage }
        } catch (error) {
          log.warn("usage:collect-active-fail", { error: errorMessage(error) })
          activeResolved = { ...activeBase, error: errorMessage(error) }
        }
      } else {
        activeResolved = { ...activeBase, error: "额度暂不可用(等待 token 刷新)" }
      }
      activeAuth = outcome.authToken ?? activeAuth
    }
  }

  const results = fastResults.map((row) => (row === activeFast ? activeResolved! : row))

  // REVERSE-SYNC the ACTIVE record (auth.json → accounts.json only), under a SEPARATE lock
  // from acquireActiveAccess's (INV-6, never nested). Inactive rotations are already
  // persisted per-account by acquireInactiveAccess, so nothing is batched here. The active
  // record's token is overwritten from activeAuth — a value that always originated in
  // auth.json.
  const doActiveSync = Boolean(activeRecord && activeAuth?.refresh)
  if (doActiveSync && activeRecord && activeAuth) {
    try {
      await withAuthLock(async () => {
        const current = await loadAccounts()
        // activeId drifted mid-collect: a concurrent switch already reverse-synced the live
        // token into this record, so our t0 snapshot is stale — never clobber it.
        if (current.activeId !== activeRecord.id) {
          log.debug("usage:active-sync-skip", { was: activeRecord.id, now: current.activeId })
          return
        }
        const index = current.accounts.findIndex((existing) => existing.id === activeRecord.id)
        if (index >= 0) {
          // Prefer auth.json AS IT IS NOW (ex-machina may have rotated during collect) over the
          // t0 activeAuth snapshot; fall back to the snapshot only if auth.json lost its refresh.
          const nowAuth = await readAuthAnthropic()
          applyToken(current.accounts[index], {
            kind: "full",
            token: nowAuth?.refresh ? { refresh: nowAuth.refresh, access: nowAuth.access, expires: nowAuth.expires } : activeAuth,
          })
        }
        await saveAccounts(current)
      })
    } catch (error) {
      // Reverse-sync is best-effort: a lock timeout here must not blank the panel either.
      // The next collect cycle retries this sync.
      log.warn("usage:active-sync-fail", { error: errorMessage(error) })
    }
  }

  return { activeId: file.activeId, results }
}

// `expected` is the provider whose session the CALLER is acting for. This function writes
// auth.json's `anthropic` entry unconditionally, so it defaults to anthropic — the value every
// pre-multi-provider caller already meant — while still forcing new call sites to say it out loud.
export async function switchToAccount(id: string, expected: ProviderId = "anthropic"): Promise<StoredAccount> {
  return withAuthLock(async () => {
    const file = await loadAccounts()
    const index = file.accounts.findIndex((account) => account.id === id)
    if (index < 0) throw new Error("account not found")

    // INV-P1 choke point, checked BEFORE the record's token is read: a cross-provider target would
    // put that vendor's refresh token in the anthropic entry, breaking both accounts. Every caller
    // filters its own list too; this makes the mismatch unrepresentable rather than remembered.
    const provider = providerOf(file.accounts[index])
    if (provider !== expected) {
      log.warn("usage:switch-refuse-provider", { id, expected, provider })
      throw new Error("该账号与目标 provider 不一致,拒绝写入 Claude 登录态")
    }

    // Never write a known-dead refresh into auth.json — that would brick the active chain
    // once its still-valid access token expires. Refuse the switch and let the user re-login.
    if (file.accounts[index].needsReauth) {
      log.warn("usage:switch-refuse-reauth", { id })
      throw new Error("账号需重新登录")
    }

    // INV-9 single choke point: reverse-sync the OUTGOING active account's live
    // auth.json token into its accounts.json record BEFORE switching, so a later switch
    // BACK to it uses ex-machina's rotated (fresh) refresh, not a stale one (400
    // invalid_grant). Known residual: this assumes auth.json still belongs to
    // file.activeId; an out-of-band `opencode auth login` that drifted auth.json before
    // the next autoCapture realigned activeId could copy a foreign token here — a
    // documented low-frequency limitation. No fetchProfile identity check (keep switch fast).
    if (file.activeId && file.activeId !== id) {
      const outAuth = await readAuthAnthropic()
      if (outAuth?.refresh) {
        const outIdx = file.accounts.findIndex((account) => account.id === file.activeId)
        if (outIdx >= 0) {
          applyToken(file.accounts[outIdx], { kind: "full", token: { refresh: outAuth.refresh, access: outAuth.access, expires: outAuth.expires } })
        }
      }
    }

    let account = file.accounts[index]
    if (isStale(account)) {
      if (isRefresh429Cooldown(account.refresh)) {
        log.warn("usage:switch-skip-429", { label: account.label })
      } else {
        try {
          const fresh = await refreshToken(account.refresh)
          applyToken(file.accounts[index], { kind: "full", token: fresh })
          account = file.accounts[index]
        } catch (error) {
          if (error instanceof RefreshRevokedError) {
            const latest = await loadAccounts()
            const rec = latest.accounts.find((item) => item.id === id)
            if (rec && !rec.needsReauth && rec.refresh !== error.refresh) {
              applyToken(file.accounts[index], { kind: "full", token: { refresh: rec.refresh, access: rec.access, expires: rec.expires } })
              account = file.accounts[index]
              log.info("usage:switch-adopt-rotation", { id, label: account.label })
            } else {
              if (rec && !rec.needsReauth) {
                rec.needsReauth = true
                await saveAccounts(latest)
              }
              log.warn("usage:switch-target-revoked", { id, label: account.label })
              throw error
            }
          } else {
            throw error
          }
        }
      }
    }

    file.activeId = id
    await saveAccounts(file)
    await writeAuthAnthropic({ kind: "full", token: { refresh: account.refresh, access: account.access, expires: account.expires } })
    log.info("usage:switch-commit", { id, label: account.label })
    return account
  })
}
