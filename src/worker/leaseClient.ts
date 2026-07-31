// Worker → master transport. TRANSPORT ONLY: this module never touches auth.json or the
// account library, so a bad answer from the master can never reach a credential file
// through here — the caller decides what to persist.
//
// NOTHING THROWS ACROSS THIS BOUNDARY. Every fault becomes a value in LeaseFailure, because
// the caller is a renewal loop whose whole job is to keep running: a thrown error there is
// either swallowed by a catch-all (silently killing renewal) or kills the loop outright.
// A union forces each case to be answered explicitly instead.
import type { ErrorBody, LeaseReason, LeaseRefusal, LeaseRequest, LeaseResponse, RateLimitReport } from "../cloud/protocol.ts"
import { CLOUD_ROUTES } from "../cloud/protocol.ts"
import { LEASE_BACKOFF_BASE_MS, LEASE_BACKOFF_CAP_MS, NETWORK_TIMEOUT_MS } from "../constants.ts"
import { log, redactBody, redactHeaders } from "../logger.ts"

export type LeaseFailure =
  | { kind: "auth" } // 401 — pool key rejected
  | { kind: "no-account" } // 503 — master has no account available
  | { kind: "refused"; refused: LeaseRefusal } // 409 — we NAMED an account the master will not serve
  | { kind: "unreachable"; detail: string } // network / retries exhausted
  | { kind: "bad-response"; detail: string } // unparseable or schema-invalid body

export type LeaseOutcome = { ok: true; lease: LeaseResponse } | { ok: false; failure: LeaseFailure }

export type LeaseClientDeps = {
  // Injected, never defaulted to the global: a client built without an explicit transport
  // would silently talk to the real network in tests.
  fetchImpl: typeof fetch
  sleep: (ms: number) => Promise<void>
  masterUrl: string
  poolKey: string
  workerId: string
}

// 8 attempts = 7 delays: 5s, 10s, 20s, 40s, 80s, 160s, then 300s CLAMPED (5000*2^6 = 320000
// would overshoot the cap). Bounded rather than infinite so the caller gets a decisive
// answer it can act on — it owns the decision to try again later, not this module.
const MAX_LEASE_ATTEMPTS = 8

function backoffFor(completedAttempt: number): number {
  return Math.min(LEASE_BACKOFF_BASE_MS * 2 ** completedAttempt, LEASE_BACKOFF_CAP_MS)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// The master's own wording when it bothered to send one; a redacted snippet otherwise.
// redactBody, not the raw text: an error body can echo back a token-shaped string.
function detailOf(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Partial<ErrorBody>
    if (typeof parsed.error === "string" && parsed.error.length > 0) return `HTTP ${status}: ${parsed.error}`
  } catch {}
  return `HTTP ${status}: ${redactBody(body, 200)}`
}

// A table keyed by LeaseRefusal, mirroring the server's own LEASE_REASONS guard: a reason added to
// the protocol becomes a COMPILE error here instead of silently degrading to "bad response".
const LEASE_REFUSALS: Record<LeaseRefusal, true> = { unknown: true, ambiguous: true, cooling: true, "needs-reauth": true }

// A 409 whose body does not name a reason we know is treated as a BAD RESPONSE, never guessed at:
// the reason IS the message the operator acts on, so inventing one would send them to fix the wrong
// thing (re-login for an account that is merely cooling, say).
function parseRefusal(body: string): LeaseRefusal | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const refused = parsed?.["refused"]
    if (typeof refused === "string" && Object.hasOwn(LEASE_REFUSALS, refused)) return refused as LeaseRefusal
  } catch {}
  return undefined
}

// A 200 is NOT proof of a usable lease. The worker writes these three fields straight into
// its opencode auth.json, where a missing/blank access or a NaN expiry becomes a broken
// login that no later retry repairs — so a malformed body is refused HERE, while it is
// still just a failed request.
function parseLease(raw: unknown): LeaseResponse | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { accountId, access, expiresAt } = raw as Record<string, unknown>
  if (typeof accountId !== "string" || accountId.length === 0) return undefined
  if (typeof access !== "string" || access.length === 0) return undefined
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return undefined
  return { accountId, access, expiresAt }
}

// Either a terminal answer, or a transient fault worth another attempt.
type Attempt = { retry: false; outcome: LeaseOutcome } | { retry: true; detail: string }

const RETRY: (detail: string) => Attempt = (detail) => ({ retry: true, detail })
const DONE: (outcome: LeaseOutcome) => Attempt = (outcome) => ({ retry: false, outcome })

export function createLeaseClient(deps: LeaseClientDeps): {
  lease(input: {
    reason: LeaseReason
    currentAccountId?: string
    // The account the operator named in a worker's /usage panel, as the prefix that panel showed.
    preferredAccountIdPrefix?: string
    // How many times to try before giving up. INTERACTIVE CALLERS PASS 1: an operator who just
    // pressed enter is watching a dialog, and the ladder below can spend minutes reaching its
    // verdict. Only the background renewal loop can afford that, so only it takes the default.
    attempts?: number
  }): Promise<LeaseOutcome>
  reportRateLimit(input: { accountId: string; headers: Record<string, string>; resetsAt?: number }): Promise<boolean>
} {
  // A configured base URL routinely carries a trailing slash; CLOUD_ROUTES paths are absolute.
  const base = deps.masterUrl.replace(/\/+$/, "")

  function requestInit(payload: LeaseRequest | RateLimitReport): RequestInit {
    return {
      method: "POST",
      headers: { Authorization: `Bearer ${deps.poolKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      // Bounded so a black-holed connection cannot park the worker's renewal loop forever;
      // an abort surfaces as a transport fault and is retried like any other.
      signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
    }
  }

  async function attemptLease(payload: LeaseRequest): Promise<Attempt> {
    let res: Response
    try {
      res = await deps.fetchImpl(`${base}${CLOUD_ROUTES.lease}`, requestInit(payload))
    } catch (error) {
      // Transport fault — the master may simply be restarting. Retryable.
      return RETRY(errorMessage(error))
    }

    // 401 and 503 are ANSWERS, not symptoms: the pool key will not become valid by waiting,
    // and a master that says "no account" has already consulted its full roster. Retrying
    // either would burn the caller's recovery window on a verdict we already have.
    if (res.status === 401) {
      log.error("lease:auth-rejected", { status: res.status })
      return DONE({ ok: false, failure: { kind: "auth" } })
    }
    if (res.status === 503) {
      log.warn("lease:no-account", { status: res.status })
      return DONE({ ok: false, failure: { kind: "no-account" } })
    }

    const text = await res.text().catch(() => "")
    // 409 — this request NAMED an account and the master will not serve that one. Terminal, and kept
    // out of the generic 4xx branch below because the refusal reason is the entire message the
    // operator needs; collapsing it into "bad response" would tell them the pool is broken instead.
    if (res.status === 409) {
      const refused = parseRefusal(text)
      if (refused === undefined) {
        log.error("lease:refusal-schema-invalid", { body: redactBody(text, 200) })
        return DONE({ ok: false, failure: { kind: "bad-response", detail: detailOf(res.status, text) } })
      }
      log.warn("lease:refused", { refused })
      return DONE({ ok: false, failure: { kind: "refused", refused } })
    }
    if (res.status >= 500) {
      log.warn("lease:server-error", { status: res.status, body: redactBody(text, 200) })
      return RETRY(detailOf(res.status, text))
    }
    if (!res.ok) {
      // Any other 4xx means this request is wrong (bad route, bad payload) — repeating it
      // verbatim cannot help, so it is reported as a bad exchange rather than retried.
      log.error("lease:rejected", { status: res.status, body: redactBody(text, 200) })
      return DONE({ ok: false, failure: { kind: "bad-response", detail: detailOf(res.status, text) } })
    }

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return DONE({ ok: false, failure: { kind: "bad-response", detail: `unparseable body: ${redactBody(text, 200)}` } })
    }
    const lease = parseLease(raw)
    if (!lease) {
      log.error("lease:schema-invalid", { body: redactBody(text, 200) })
      return DONE({ ok: false, failure: { kind: "bad-response", detail: `schema-invalid body: ${redactBody(text, 200)}` } })
    }
    // Never log `lease.access` — it is a live credential.
    log.info("lease:granted", { accountId: lease.accountId, expiresAt: lease.expiresAt })
    return DONE({ ok: true, lease })
  }

  return {
    async lease(input): Promise<LeaseOutcome> {
      const payload: LeaseRequest = {
        workerId: deps.workerId,
        reason: input.reason,
        ...(input.currentAccountId === undefined ? {} : { currentAccountId: input.currentAccountId }),
        ...(input.preferredAccountIdPrefix === undefined ? {} : { preferredAccountIdPrefix: input.preferredAccountIdPrefix }),
      }
      const maxAttempts = input.attempts ?? MAX_LEASE_ATTEMPTS
      let detail = "no attempt made"
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const result = await attemptLease(payload)
        if (!result.retry) return result.outcome
        detail = result.detail
        // The final failure is reported, not slept on: a trailing delay would just stall
        // the caller after the decision is already made.
        if (attempt < maxAttempts - 1) await deps.sleep(backoffFor(attempt))
      }
      log.error("lease:exhausted", { attempts: maxAttempts, detail })
      return { ok: false, failure: { kind: "unreachable", detail } }
    },

    async reportRateLimit(input): Promise<boolean> {
      // Best-effort telemetry on the caller's RECOVERY path: no retry, no throw, no backoff.
      // Losing a report costs the master one data point; delaying the switch costs the user
      // a stalled session.
      const payload: RateLimitReport = {
        workerId: deps.workerId,
        accountId: input.accountId,
        headers: input.headers,
        ...(input.resetsAt === undefined ? {} : { resetsAt: input.resetsAt }),
      }
      try {
        const res = await deps.fetchImpl(`${base}${CLOUD_ROUTES.ratelimit}`, requestInit(payload))
        if (!res.ok) {
          log.warn("lease:ratelimit-report-rejected", { status: res.status })
          return false
        }
        // Header KEYS only — values are quota telemetry the master reads, not something we echo.
        log.info("lease:ratelimit-reported", { accountId: input.accountId, headerKeys: redactHeaders(input.headers) })
        return true
      } catch (error) {
        log.warn("lease:ratelimit-report-fail", { error: errorMessage(error) })
        return false
      }
    },
  }
}
