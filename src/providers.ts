import type { ProviderId } from "./accounts.ts"
import type { OpenaiUsage } from "./openai-usage.ts"
import type { UsageResponse } from "./usage.ts"

// The failed-turn error envelope OpenCode hands us. `session.status(retry)` fills in `message`
// ONLY; `session.error` can carry the full HTTP triple. Every field is optional because which
// ones arrive depends on the event path, not on the provider.
export type RetryErrorLike = {
  statusCode?: number
  responseHeaders?: Record<string, string>
  responseBody?: string
  message?: string
}

// The ONE window shape both providers reduce to, so scoring and reset resolution have a single
// implementation. Anthropic's four FIXED fields plus its dynamic `scoped[]` collapse into this;
// OpenAI's per-plan `windows` already IS this. The array length is DYNAMIC on both sides — a
// ChatGPT "go" plan really returns exactly one 30-day window — so nothing downstream may assume
// a count or index a position.
export type NormalizedWindow = { label: string; utilization: number; resets_at?: string }

// The usage payload each provider's normalizer consumes. A table rather than a union so adding a
// ProviderId is a COMPILE error until its payload type is declared here (the ACTIVE_ID_FIELD
// pattern in accounts.ts), instead of silently widening every normalizer's input.
type UsageOf = { anthropic: UsageResponse; openai: OpenaiUsage }

// Deliberately a config table of PURE FUNCTIONS, not an adapter interface / class hierarchy.
// There are exactly two providers and every variation point below is a pure function, while the
// storage and switch protocols are ASYMMETRIC by nature: anthropic refreshes its target on switch
// and needs a network profile call to identify an account, openai does neither (see the slot
// protocol header in openai-slot.ts). An interface spanning both would manufacture a symmetry
// that does not exist and invite a shared base class to "reuse" one side's protocol on the other.
export type ProviderOps<P extends ProviderId> = {
  isUsageLimit: (error?: RetryErrorLike) => boolean
  parseResetMs: (error: RetryErrorLike) => number | undefined
  normalize: (usage: UsageOf[P]) => NormalizedWindow[]
}

function lowerKeys(headers?: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  if (headers) for (const [key, value] of Object.entries(headers)) out[key.toLowerCase()] = value
  return out
}

function safeJson(body?: string): { error?: { type?: unknown; message?: unknown; resets_at?: unknown } } | undefined {
  if (!body) return undefined
  try {
    const value = JSON.parse(body)
    return typeof value === "object" && value !== null
      ? (value as { error?: { type?: unknown; message?: unknown; resets_at?: unknown } })
      : undefined
  } catch {
    return undefined
  }
}

// Detects a Claude Pro/Max rate-limit / quota rejection so we can switch accounts.
// 529 overloads are excluded (switching won't help). Anthropic surfaces this through
// several shapes depending on path (unified headers, JSON body type, or just a message
// string like "This request would exceed your account's rate limit"), so we match on
// ANY of: 429 status, rate_limit_error type, or rate-limit message text — the message
// regex is the one maintenance point as Anthropic's wording may drift.
function isAnthropicUsageLimit(error?: RetryErrorLike): boolean {
  if (!error) return false
  const body = error.responseBody ?? ""
  if (/overloaded_error/i.test(body)) return false
  const headers = lowerKeys(error.responseHeaders)
  const unifiedRejected = Object.entries(headers).some(
    ([key, value]) =>
      key.startsWith("anthropic-ratelimit-unified") && key.endsWith("status") && String(value).toLowerCase().includes("rejected"),
  )
  if (unifiedRejected) return true
  const parsed = safeJson(body)?.error
  const type = typeof parsed?.type === "string" ? parsed.type : ""
  const text = `${typeof parsed?.message === "string" ? parsed.message : ""} ${error.message ?? ""}`.toLowerCase()
  const rateLimitText = /rate limit|usage limit|limit reached|too many requests|out of (?:usage|quota)|5[- ]?hour|weekly limit|exceed/.test(text)
  return error.statusCode === 429 || type === "rate_limit_error" || rateLimitText
}

function parseAnthropicResetMs(error: RetryErrorLike): number | undefined {
  const headers = lowerKeys(error.responseHeaders)
  const reset = Number(headers["anthropic-ratelimit-unified-reset"])
  if (Number.isFinite(reset) && reset > 0) return reset * 1000
  const retryAfter = Number(headers["retry-after"])
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Date.now() + retryAfter * 1000
  return undefined
}

// Field order is preserved from the pre-normalization inline list purely for reviewability;
// neither scoreWindows nor latestMaxedReset is order-sensitive.
//
// A null / absent window is DROPPED, never emitted as a 0-utilization entry. Absent Anthropic
// windows legitimately arrive as `null` (seven_day_opus / seven_day_sonnet are null for most
// accounts since the per-model breakdown moved into `limits[]`), and latestMaxedReset computes
// its `maxUtil` over the SURVIVING windows only — a synthetic 0 entry would join that set and
// could drag maxUtil below 100, turning a real cooldown deadline into "unknown". The old score()
// read these through `?? 0`; that floor is preserved by scoreWindows' `Math.max(0, ...)` seed
// instead, so do NOT "fix" this by emitting placeholders.
function normalizeAnthropic(usage: UsageResponse): NormalizedWindow[] {
  const out: NormalizedWindow[] = []
  for (const [label, win] of [
    ["five_hour", usage.five_hour],
    ["seven_day", usage.seven_day],
    ["seven_day_sonnet", usage.seven_day_sonnet],
    ["seven_day_opus", usage.seven_day_opus],
  ] as const) {
    if (win) out.push({ label, utilization: win.utilization, resets_at: win.resets_at })
  }
  // Dynamic per-model weekly windows (e.g. "Fable"), whose label rides with the window.
  for (const win of usage.scoped ?? []) out.push({ label: win.label, utilization: win.utilization, resets_at: win.resets_at })
  return out
}

// DELIBERATE ASYMMETRY WITH isAnthropicUsageLimit — DO NOT UNIFY THE TWO DETECTORS.
// The Anthropic detector above accepts a BARE 429 (and even a bare message string) on purpose:
// for Claude Pro/Max, a 429 on the OAuth subscription path effectively means "subscription window
// exhausted", switching accounts is the correct and only remedy, and a false positive costs at
// most one wasted switch.
// For ChatGPT none of that holds. A bare 429 there may be ordinary transient throttling —
// per-minute pacing, concurrency, edge shedding — where the account is NOT out of quota. Reacting
// to it would burn a perfectly healthy account into cooldown (and, once the switch path is wired,
// evict it from the auth.json slot) for no gain, and the very next request would have succeeded.
// So this detector requires BOTH: status 429 AND a parsed body whose error.type is exactly
// "usage_limit_reached" — the quota-specific signal. A future reader WILL be tempted to collapse
// these two functions into one "shared" 429 check. That refactor is a REGRESSION; the strictness
// here is the feature, and V6/V7/V8 in providers.test.ts exist to fail if it is relaxed.
function isOpenaiUsageLimit(error?: RetryErrorLike): boolean {
  if (!error) return false
  if (error.statusCode !== 429) return false
  const parsed = safeJson(error.responseBody)?.error
  const type = typeof parsed?.type === "string" ? parsed.type : ""
  return type === "usage_limit_reached"
}

function unixSecondsToMs(value: unknown): number | undefined {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined
}

// ChatGPT does NOT use a standard `Retry-After`, so there is no shared header path with Anthropic.
// The reset arrives as Unix SECONDS from one of two places:
//   1. the body's `error.resets_at` — the deadline of the limit that actually rejected us, hence
//      authoritative and checked first;
//   2. failing that, the `x-codex-*-reset-at` quota headers.
// Both x-codex headers can be present at once (primary = the short window, secondary = the long
// one) and the response does not say WHICH one rejected us, so we take the LATEST — the same
// "never clear a cooldown before the last binding window clears" rule latestMaxedReset applies to
// tied Anthropic windows. Under-cooling costs an immediate re-hit and a second burn; over-cooling
// only delays an account rejoining selection.
// Neither source present ⇒ undefined. This codebase never fabricates a countdown.
function parseOpenaiResetMs(error: RetryErrorLike): number | undefined {
  const fromBody = unixSecondsToMs(safeJson(error.responseBody)?.error?.resets_at)
  if (fromBody !== undefined) return fromBody
  const headers = lowerKeys(error.responseHeaders)
  const fromHeaders = [headers["x-codex-primary-reset-at"], headers["x-codex-secondary-reset-at"]]
    .map(unixSecondsToMs)
    .filter((ms): ms is number => ms !== undefined)
  return fromHeaders.length > 0 ? Math.max(...fromHeaders) : undefined
}

// Not `Record<ProviderId, ProviderOps>`: the mapped form types each entry's normalizer to ITS OWN
// payload, so an OpenaiUsage can never reach normalizeAnthropic (or vice versa) without a cast.
export const PROVIDERS: { [P in ProviderId]: ProviderOps<P> } = {
  anthropic: {
    isUsageLimit: isAnthropicUsageLimit,
    parseResetMs: parseAnthropicResetMs,
    normalize: normalizeAnthropic,
  },
  openai: {
    isUsageLimit: isOpenaiUsageLimit,
    parseResetMs: parseOpenaiResetMs,
    // Already normalized at the fetch boundary (openai-usage.ts derives each label from
    // `limit_window_seconds` and drops windows whose used_percent is not a number). Assigning it
    // here is what makes TS verify OpenaiWindow is still structurally a NormalizedWindow.
    normalize: (usage) => usage.windows,
  },
}

// Derived, not re-listed: a provider added to PROVIDERS is picked up here for free
// (same pattern as accounts.ts's ACTIVE_ID_FIELD → PROVIDER_IDS).
export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[]

export function toProviderId(value: unknown): ProviderId | undefined {
  return PROVIDER_IDS.find((id) => id === value)
}

// Lower is a better switch target. `undefined` windows means "no usage snapshot for this account"
// — the honest unknown — and sorts LAST via +Infinity rather than being guessed at.
// The `Math.max(0, ...)` seed is load-bearing, not defensive: it reproduces the old per-field
// `?? 0` floor exactly (four fixed terms that each contributed 0 when null/absent), so a usage
// object with every window null still scores 0 and NOT -Infinity. It also keeps a provider whose
// window list is legitimately EMPTY (a plan reporting none) off -Infinity, which would otherwise
// make it beat every real account.
export function scoreWindows(windows?: readonly NormalizedWindow[]): number {
  if (!windows) return Number.POSITIVE_INFINITY
  return Math.max(0, ...windows.map((win) => win.utilization))
}

// The latest reset among the windows that are AT the limit — the cooldown deadline, generic over
// both providers. Binding = utilization >= 100; not maxed ⇒ undefined (honest unknown, never a
// fabricated countdown). Windows without a resets_at, with an unparseable one, or with one already
// in the past are excluded BEFORE maxUtil is computed, so a maxed window that cannot tell us WHEN
// it clears does not gate the windows that can. Multiple maxed windows ⇒ the LATEST, so a cooldown
// is never cleared before the last binding window clears.
export function latestMaxedReset(windows: readonly NormalizedWindow[], now: number): number | undefined {
  const candidates: { util: number; at: number }[] = []
  for (const win of windows) {
    if (win.resets_at === undefined) continue
    const at = Date.parse(win.resets_at)
    if (!Number.isFinite(at) || at <= now) continue
    candidates.push({ util: win.utilization, at })
  }
  if (candidates.length === 0) return undefined
  const maxUtil = Math.max(...candidates.map((c) => c.util))
  if (maxUtil < 100) return undefined
  const tied = candidates.filter((c) => c.util >= maxUtil - 0.5)
  return Math.max(...tied.map((c) => c.at))
}
