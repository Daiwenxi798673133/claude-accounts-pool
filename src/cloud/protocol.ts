// Wire contract shared by the master server and every worker client. TYPES AND CONSTANTS
// ONLY — no runtime logic lives here, so both sides can import it without pulling in the
// other side's dependencies, and a shape change is a COMPILE error on both ends at once.

// Frozen so a caller cannot rewrite a route at runtime and desynchronise the two sides.
// Methods are fixed by the protocol: the two POSTs mutate lease/limit state, the GET is a
// side-effect-free readiness probe a worker may call before trusting a master URL.
export const CLOUD_ROUTES = Object.freeze({
  // POST — worker asks for an access token to write into its local auth.json.
  lease: "/v1/lease",
  // POST — worker reports that the leased account just hit a subscription limit.
  ratelimit: "/v1/ratelimit",
  // GET — liveness/readiness probe.
  health: "/v1/health",
  // GET — the read-only usage dashboard's JSON. The two routes below are master↔OPERATOR, not
  // master↔worker: no leaseClient calls them. They live in this table anyway because the server's
  // route map is a `Record<Route, RouteHandler>` derived from it, which is what makes "every route
  // this master answers, and whether it needs a key" readable in one place.
  usage: "/v1/usage",
  // GET — the dashboard's HTML shell. Answered WITHOUT a key because the document carries no data
  // at all (see dashboardHtml.ts); the key is typed into the page and only ever travels in the
  // Authorization header of its fetch to `usage`.
  dashboard: "/",
} as const)

// Why the worker is asking. `prelease` is the routine path (startup or renewal before the
// current lease expires); `ratelimit` says the leased account is spent and the master must
// hand out a DIFFERENT one rather than re-issuing the same account's token.
export type LeaseReason = "prelease" | "ratelimit"

export type LeaseRequest = {
  workerId: string
  reason: LeaseReason
  currentAccountId?: string
}

// `expiresAt` is an absolute epoch-ms instant, not a duration: the worker writes it straight
// into auth.json, where ex-machina compares it against Date.now().
export type LeaseResponse = {
  accountId: string
  access: string
  expiresAt: number
}

// Raw response headers as received — the master owns the parsing, because only it knows the
// full account roster and can therefore decide what a given reset instant means for the pool.
export type RateLimitReport = {
  workerId: string
  accountId: string
  headers: Record<string, string>
  resetsAt?: number
}

export type ErrorBody = {
  error: string
}

// ── Dashboard payload (master → the operator's browser) ────────────────────────────────────────
// PRIVACY IS ENFORCED BY THIS TYPE, not by the care taken in the builder. There is no field below
// an access or refresh token could be assigned to, so leaking one requires ADDING a field here
// first — which is where a reviewer sees it. Keep it that way: no `access`, no `refresh`, and no
// open-ended `Record<string, unknown>` bag that would smuggle either past the compiler.

export type UsageWindowView = {
  // `five_hour` / `seven_day` for the fixed windows, or the model's display name for a dynamic
  // per-model weekly one (e.g. "Fable") — whatever the provider normalizer produced.
  label: string
  utilization: number
  // ISO-8601 as Anthropic reports it. Absent means this window never told us when it clears, and
  // the dashboard must render "unknown" rather than fabricate a countdown.
  resetsAt?: string
}

export type UsageAccountView = {
  // A PREFIX of the account uuid, never the whole id: it is enough to correlate a row with a
  // `master:lease-served` log line, and the full id is the handle those leases name.
  idPrefix: string
  label: string
  // EMPTY when this account has no entry in the current snapshot. Never a synthetic 0% window —
  // the poller omits accounts it failed on, and rendering that absence as "idle" would point the
  // operator at the pool's least-known account as if it were its emptiest.
  windows: UsageWindowView[]
  // The explicit companion to an empty `windows`: distinguishes "polled, reports no windows" from
  // "not in this snapshot at all", which look identical otherwise.
  hasUsage: boolean
  coolingDown: boolean
  excluded: boolean
  needsReauth: boolean
  // The stored token's own expiry — the instant the master must have refreshed by. Absent for a
  // record that has never carried one.
  expiresAt?: number
}

export type UsageSnapshotView = {
  at: number
  // The scheduler's OWN verdict, not a threshold the dashboard re-derives: true means selection has
  // already stopped ranking by these numbers, so the page must stop presenting them as current.
  stale: boolean
  accounts: UsageAccountView[]
}
