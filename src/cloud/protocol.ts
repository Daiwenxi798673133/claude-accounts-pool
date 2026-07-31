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
