import type { StoredAccount } from "../accounts.ts"
import { CLIENT_ID, MASTER_MIN_REMAINING_MS, NETWORK_TIMEOUT_MS, TOKEN_URL } from "../constants.ts"
import { log, redactBody, redactHeaders } from "../logger.ts"

// The ONE refresher on the master, and the reason the cloud architecture is safe at all.
// Anthropic's OAuth refresh token is one-time-use and ROTATES on every refresh: two concurrent
// refreshes of the SAME account mean the loser POSTs an already-spent tip, gets invalid_grant,
// and the account is stranded until a human re-logs in. Anthropic's own CLI needed a
// cross-process lock for exactly this. Workers never hold a usable refresh token, so the whole
// system's guarantee reduces to the in-flight map below — every master-side refresh (the HTTP
// lease handler AND the background warm loop) must funnel through getFreshAccess.

export type MasterToken = { access: string; refresh: string; expires: number }

// Fetch's CALL SIGNATURE only, derived from the ambient declaration so it never drifts. A bare
// `typeof fetch` cannot be satisfied by a plain function here: Bun augments the global with
// statics (`preconnect`), so every test fake would have to fabricate them. The real `fetch`
// satisfies this type unchanged, so narrowing costs production callers nothing.
export type FetchLike = (...args: Parameters<typeof fetch>) => ReturnType<typeof fetch>

export type RefresherDeps = {
  // NO DEFAULT ON PURPOSE. A `= fetch` fallback would let a test that forgot to inject fire a
  // real POST at TOKEN_URL, consuming and rotating a live refresh token on a paid account.
  fetchImpl: FetchLike
  loadAccount: (accountId: string) => Promise<StoredAccount | undefined>
  persist: (accountId: string, token: MasterToken) => Promise<void>
  now?: () => number
}

export type FreshAccess = { access: string; expiresAt: number }

export type Refresher = { getFreshAccess(accountId: string): Promise<FreshAccess> }

// 1 initial attempt + 2 retries, and ONLY for the two failure classes that leave the stored tip
// unspent (5xx / transport). Fixed delay rather than exponential: the ceiling here is one keeper
// tick, not an outage-riding budget, and jitter would make the retry count untestable.
const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 200

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Sibling of usage.ts's RefreshRevokedError and openai-token.ts's OpenaiRefreshRevokedError,
// deliberately given its OWN name rather than re-using theirs: two classes sharing one name would
// make cross-module `instanceof` silently false, which is how a live account gets branded dead.
// Thrown ONLY for a 400 `invalid_grant`, i.e. the stored tip can NEVER work again. `refresh`
// rides along so a caller can check the dead tip is still the one on record before flagging.
export class MasterRefreshRevokedError extends Error {
  readonly revoked = true as const
  constructor(
    readonly accountId: string,
    readonly refresh: string,
  ) {
    super(`master refresh token revoked (invalid_grant) for ${accountId}`)
    this.name = "MasterRefreshRevokedError"
  }
}

// Module-private: `status` exists solely to feed the retry gate. Callers see the same
// `token refresh failed (<status>)` message usage.ts has always produced, so nothing downstream
// has to pattern-match a new type to keep working.
class RefreshHttpError extends Error {
  constructor(readonly status: number) {
    super(`token refresh failed (${status})`)
    this.name = "RefreshHttpError"
  }
}

// Transport-level fault (DNS/TCP/TLS, or the NETWORK_TIMEOUT_MS abort): the endpoint may never
// have seen the request, so this is the one class where the stored tip is very likely unspent.
class RefreshNetworkError extends Error {
  constructor(cause: unknown) {
    super("token refresh transport failure", { cause })
    this.name = "RefreshNetworkError"
  }
}

function isInvalidGrant(body: string): boolean {
  try {
    return (JSON.parse(body) as { error?: string }).error === "invalid_grant"
  } catch {
    return false
  }
}

// FAIL CLOSED — a whitelist, never a blacklist. Anything not named here (a 4xx, a revoked chain,
// a 200 whose body we could not use) may ALREADY have consumed and rotated the stored tip, and
// re-POSTing a spent tip answers invalid_grant, which strands the account for good. 429 is
// covered by the 4xx rule on purpose: it is the one 4xx people reflexively retry, and the token
// endpoint rate-limits by IP, so a retry deepens the block for every account behind it.
function isRetryable(error: unknown): boolean {
  if (error instanceof RefreshHttpError) return error.status >= 500
  return error instanceof RefreshNetworkError
}

export function createRefresher(deps: RefresherDeps): Refresher {
  const now = deps.now ?? Date.now
  // Keyed by ACCOUNT ID, not by refresh string (which is how usage.ts keys its map): the tip
  // rotates on every success, so a tip-keyed entry would dedupe nothing across a rotation.
  const inflight = new Map<string, Promise<FreshAccess>>()

  // WHY THIS DUPLICATES usage.ts's doRefreshToken — do NOT "helpfully" merge them:
  //  1. DEPENDENCY INJECTION. The single-flight guarantee is the deliverable, and it can only be
  //     proven by a test that never touches the network — so the POST must go through
  //     `deps.fetchImpl`. usage.ts calls the global `fetch`, and rewiring it would mean pushing a
  //     dep bag through every one of its exported functions.
  //  2. FILE OWNERSHIP. usage.ts is owned by a parallel change set; editing it here would be a
  //     merge conflict, and this module must land independently.
  // usage.ts stays the WORKER-side path (on-disk store + cross-process auth lock); this is the
  // MASTER-side path (injected persist, no lock needed because it is the only refresher).
  async function postRefresh(accountId: string, refresh: string): Promise<MasterToken> {
    // PRIVACY: never log the request body — it carries the refresh token verbatim.
    log.debug("master-refresher:refresh-start", { accountId })
    let res: Response
    try {
      res = await deps.fetchImpl(TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, */*",
          "User-Agent": "axios/1.13.6",
        },
        body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
        signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
      })
    } catch (cause) {
      log.warn("master-refresher:refresh-transport-fail", { accountId })
      throw new RefreshNetworkError(cause)
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      const headers: Record<string, string> = {}
      res.headers.forEach((value, key) => {
        headers[key] = value
      })
      log.warn("master-refresher:refresh-failed", {
        accountId,
        status: res.status,
        headerKeys: redactHeaders(headers),
        body: redactBody(body),
      })
      if (res.status === 400 && isInvalidGrant(body)) {
        log.warn("master-refresher:refresh-revoked", { accountId })
        throw new MasterRefreshRevokedError(accountId, refresh)
      }
      throw new RefreshHttpError(res.status)
    }

    const json = (await res.json().catch(() => undefined)) as
      | { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }
      | undefined
    // A 200 without BOTH tokens is the worst case in the whole system: the POST succeeded, so the
    // stored tip is already spent, yet its replacement is unknown. Refuse loudly — persisting a
    // blank (or the spent) tip strands the account, and isRetryable() deliberately excludes this.
    if (typeof json?.access_token !== "string" || typeof json.refresh_token !== "string") {
      log.error("master-refresher:refresh-malformed", { accountId, status: res.status })
      throw new Error(`token refresh returned no token (${res.status})`)
    }
    if (typeof json.expires_in !== "number" || !Number.isFinite(json.expires_in)) {
      // No fallback lifetime: a guessed expiry that outlives the real token would make the master
      // hand out dead access tokens and report them as fresh, which is worse than failing here.
      log.error("master-refresher:refresh-no-expiry", { accountId, status: res.status })
      throw new Error(`token refresh returned no expires_in (${res.status})`)
    }
    log.debug("master-refresher:refresh-result", { accountId, status: res.status })
    return { access: json.access_token, refresh: json.refresh_token, expires: now() + json.expires_in * 1000 }
  }

  async function refreshWithRetry(accountId: string, refresh: string): Promise<MasterToken> {
    // `for (;;)` rather than a bounded loop with a trailing throw: every exit is a return or a
    // throw from inside, so there is no unreachable "last error" branch to keep correct.
    for (let attempt = 1; ; attempt++) {
      try {
        return await postRefresh(accountId, refresh)
      } catch (error) {
        if (attempt >= MAX_ATTEMPTS || !isRetryable(error)) throw error
        log.warn("master-refresher:refresh-retry", { accountId, attempt })
        await sleep(RETRY_DELAY_MS)
      }
    }
  }

  async function resolve(accountId: string): Promise<FreshAccess> {
    const account = await deps.loadAccount(accountId)
    if (!account) throw new Error(`unknown account ${accountId}`)
    // STRICT `>` against the floor: a token sitting exactly on MASTER_MIN_REMAINING_MS is
    // refreshed rather than leased, because a worker that receives it must immediately come back.
    if (account.access && account.expires && account.expires - now() > MASTER_MIN_REMAINING_MS) {
      return { access: account.access, expiresAt: account.expires }
    }
    const fresh = await refreshWithRetry(accountId, account.refresh)
    // Persist BEFORE returning, never after: from the instant the POST succeeded the rotated tip
    // is the ONLY usable one, so a crash between handing out the access token and writing the tip
    // would leave the master holding a spent refresh — the exact permanent-strand failure.
    await deps.persist(accountId, fresh)
    log.info("master-refresher:refreshed", { accountId, remainingMs: fresh.expires - now() })
    return { access: fresh.access, expiresAt: fresh.expires }
  }

  return {
    getFreshAccess(accountId: string): Promise<FreshAccess> {
      const existing = inflight.get(accountId)
      if (existing) return existing
      // The ENTIRE load → freshness check → POST → persist chain is the flight, not just the POST.
      // Registering only around the POST would be useless: `await loadAccount` is an async
      // boundary, so every concurrent caller would clear the freshness check before any of them
      // reached the map. Note this body is synchronous up to the `set` — `resolve()` suspends at
      // its first await and returns a promise, so no caller can slip in between.
      const flight = resolve(accountId).finally(() => {
        // Cleared on BOTH fulfilment and rejection. Leaving a rejected promise behind would make
        // every later caller re-await a dead promise, i.e. the account would be permanently
        // unrefreshable for the life of the process — a self-inflicted outage worse than the
        // original failure.
        inflight.delete(accountId)
      })
      inflight.set(accountId, flight)
      return flight
    },
  }
}
