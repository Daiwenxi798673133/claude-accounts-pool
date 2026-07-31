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
  // GET — the read-only usage dashboard's JSON, and GET / its HTML page. Both are master↔OPERATOR,
  // not master↔worker: no leaseClient calls either. They live in this table anyway because the
  // server's route map is a `Record<Route, RouteHandler>` derived from it, which is what makes
  // "every route this master answers, and whether it needs a key" readable in one place.
  //
  // BOTH ARE UNAUTHENTICATED BY DELIBERATE DESIGN, unlike the two POSTs above. They are read-only
  // and carry NO credential, so the most a reader gains is the pool's roster and how much of each
  // subscription is left — a disclosure the pool owner accepted knowingly. The cost is real and
  // must not be forgotten: the bind address is the operator's choice and is NOT necessarily
  // loopback, so every peer that can reach the lease port can enumerate the pool, account emails
  // included. What narrows that is the BIND ADDRESS, not a key on these two routes.
  usage: "/v1/usage",
  dashboard: "/",
  // POST — the dashboard's "刷新" button: run ONE usage sweep now instead of waiting out the poll
  // interval, then answer with the resulting snapshot.
  //
  // POST, NOT GET, even though the payload is the same as `usage`. This is the one dashboard route
  // with a side effect that leaves the machine — it makes the master call Anthropic once per account
  // — and browsers, link scanners and chat-app unfurlers all speculatively GET a URL they see. A GET
  // here would let a pasted link provoke upstream traffic; a POST cannot be triggered that way.
  //
  // Also keyless, which only holds because the server throttles it (see leaseServer.ts): the usage
  // endpoint answers a burst with a 429 that lasts minutes and is charged to this master's egress IP,
  // i.e. to EVERY account in the pool at once. The throttle, not a key, is what bounds that.
  usageRefresh: "/v1/usage/refresh",
  // POST ×2 — the dashboard's "添加账号" flow, which ONBOARDS a new Claude account into the pool
  // through the browser instead of requiring an `opencode auth login` on the master's own console.
  //
  // THESE TWO BREAK THE "PURELY READ-ONLY DASHBOARD" PROPERTY, and that is a deliberate, recorded
  // reversal by the pool owner rather than an oversight — docs/cloud-mode.md used to promise
  // "纯只读:不切号、不删号、不签 key" and that sentence has been amended along with this table. What
  // they do NOT relax is anything about `lease`: minting a credential FOR A WORKER still needs a key.
  //
  // Both POST for the same reason usageRefresh is: `accountAdd` reaches platform.claude.com, so a GET
  // would let a pasted link provoke upstream traffic. `accountAuthorize` makes no network call at all,
  // but it MUTATES the pending-session store, and a route that a link scanner can drive into evicting
  // the operator's half-finished login is a route that looks broken for reasons nobody can see.
  //
  // Keyless, matching the rest of the dashboard, which is what keeps "open the browser and click"
  // true. Three bounds replace the key, all in src/constants.ts: ONBOARD_MAX_PENDING caps the memory
  // an anonymous flood can occupy, ONBOARD_MAX_ATTEMPTS caps the outbound POSTs each session can
  // provoke, and ONBOARD_ADD_MIN_INTERVAL_MS caps their rate. What is deliberately NOT claimed here is
  // that an anonymous peer cannot ADD AN ACCOUNT — it can, if it owns a Claude login and can reach
  // this port. The bind address is what narrows that, exactly as for `usage`.
  accountAuthorize: "/v1/account/authorize",
  accountAdd: "/v1/account/add",
} as const)

// Why the worker is asking. `prelease` is the routine path (startup or renewal before the
// current lease expires); `ratelimit` says the leased account is spent and the master must
// hand out a DIFFERENT one rather than re-issuing the same account's token.
export type LeaseReason = "prelease" | "ratelimit"

export type LeaseRequest = {
  workerId: string
  reason: LeaseReason
  currentAccountId?: string
  // THE OPERATOR NAMED AN ACCOUNT — they pressed enter on a row of a worker's `/usage` panel, so
  // serve that account instead of whatever the scheduler would have ranked or rotated to.
  //
  // A PREFIX, never a full account id, and that is not an accident: the panel is rendered from
  // UsageAccountView, which carries `idPrefix` precisely because `/v1/usage` is UNAUTHENTICATED and
  // must not publish full ids. So the worker can only ever name what it was shown, and turning that
  // prefix back into an account happens on THIS route, which requires a pool key.
  //
  // REFUSED, NEVER SUBSTITUTED. A prefix matching nothing, matching several accounts, or naming one
  // that cannot be served is answered with a LeaseRefusedBody — never by falling back to a normal
  // pick. A worker that asked for account A and was handed B would report a switch that did not
  // happen, and the operator would attribute the next turn's usage to the wrong subscription.
  preferredAccountIdPrefix?: string
}

// Why a NAMED account could not be served. A closed union rather than a message string: the worker
// renders each case as its own Chinese toast (the remedies differ — wait, re-login, or look again),
// and a free-text reason would collapse them into one unactionable line.
export type LeaseRefusal =
  | "unknown" // the prefix matches no account in the pool
  | "ambiguous" // it matches more than one, so which row the operator meant is not knowable
  | "cooling" // the account is rate-limited; its quota is spent even though its token is fine
  | "needs-reauth" // its refresh chain is broken, so no access token can be minted for it at all

// `refused` is the field the worker branches on; `error` stays human-readable for anything reading
// this route with curl.
export type LeaseRefusedBody = ErrorBody & { refused: LeaseRefusal }

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

// The refresh route's 429 body. Carries the wait explicitly so the page can SAY it ("N 秒后可再刷新")
// rather than leaving a button that looks broken — the same rule that killed the "重置未知"
// placeholder: never let the UI imply something is wrong when the truth is simply "not yet".
export type ThrottledBody = ErrorBody & { retryAfterMs: number }

// ── Onboarding payloads (the 添加账号 flow) ──────────────────────────────────────────────────────
// SAME PRIVACY RULE AS THE DASHBOARD VIEW BELOW, and here it is sharper, because this flow HANDLES a
// real credential: the exchange yields an access token and a one-time-use refresh token. Neither may
// ever be named by a type in this file. The browser's whole job is to relay an authorization code it
// already has; it is never told what that code turned into.

export type AuthorizeStartResponse = {
  // The claude.ai URL the operator must open. Public by construction — it carries the globally-shared
  // Claude Code client_id, the PKCE challenge (a hash, not the verifier) and an opaque state — which
  // is precisely why it can be shown on an unauthenticated page.
  url: string
  // An opaque handle for the server-side session, and DELIBERATELY not the verifier or the state:
  // those two are what make the exchange the master's to perform, and a browser holding them could
  // complete the exchange itself against Anthropic and keep the tokens. Sending only a lookup key is
  // what keeps this master the sole holder of every refresh token in the pool.
  pendingId: string
  // Absolute epoch-ms. Sent so the dialog can say the link has gone stale rather than letting the
  // operator finish a browser round trip only to be refused with no explanation.
  expiresAt: number
}

export type AccountAddRequest = {
  pendingId: string
  // Whatever the operator pasted. NOT narrowed to a bare code on purpose: Anthropic's manual-callback
  // page has shown this value as `code#state`, as a full redirect URL, and as a query string across
  // versions, and the exchange helper accepts all three. Rejecting two of the shapes here would turn
  // an upstream page change into "the button does nothing".
  code: string
}

export type AccountAddResponse = {
  // The SAME redacted identity shape the usage view uses — an id PREFIX, never the account uuid the
  // leases name.
  idPrefix: string
  label: string
  // true when this uuid was already in the pool, i.e. the operator re-authorised an existing account
  // rather than adding a new one. Reported instead of being silently treated as success, because the
  // two outcomes call for different words on screen and hiding the difference is how an operator ends
  // up believing the pool grew when it did not.
  existing: boolean
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
