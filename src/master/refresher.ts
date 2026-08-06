import type { StoredAccount } from "../accounts.ts"
import {
  CLIENT_ID,
  MASTER_MIN_REMAINING_MS,
  MASTER_REFRESH_429_COOLDOWN_MS,
  MASTER_REFRESH_THRESHOLD_MS,
  NETWORK_TIMEOUT_MS,
  TOKEN_URL,
} from "../constants.ts"
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

// What the store made of a dead tip. `adopted` is the CROSS-PROCESS GUARD's answer: another writer
// had already rotated this account, so the tip we POSTed merely lost a race and the account is
// healthy — the record's current token comes back instead of a needs-reauth verdict.
export type RefreshRevokedOutcome = { adopted?: { access?: string; expires?: number } }

export type RefresherDeps = {
  // NO DEFAULT ON PURPOSE. A `= fetch` fallback would let a test that forgot to inject fire a
  // real POST at TOKEN_URL, consuming and rotating a live refresh token on a paid account.
  fetchImpl: FetchLike
  loadAccount: (accountId: string) => Promise<StoredAccount | undefined>
  persist: (accountId: string, token: MasterToken) => Promise<void>
  // Called ONCE per lost chain, and injected for the same reason `persist` is: flagging is a
  // read-modify-write that has to happen under the SAME cross-process auth lock as the token write,
  // and that lock lives in the composition root. Owning it here would drag the account store and
  // the lock into a module whose entire test surface is a fake fetch.
  onRefreshRevoked: (accountId: string, deadRefresh: string) => Promise<RefreshRevokedOutcome>
  now?: () => number
}

export type FreshAccess = { access: string; expiresAt: number }

// `minHorizonMs` is the caller's own floor on how much validity it needs BEYOND the master's next
// rotation point. The warm loop and the usage poller need none (0); the lease server needs enough
// that the lease it derives is holdable for a full renewal cycle. Without it a caller can be handed
// a cached token that is a second away from the rotation threshold.
export type Refresher = { getFreshAccess(accountId: string, minHorizonMs?: number): Promise<FreshAccess> }

// 1 initial attempt + 2 retries, and ONLY for the failure classes that leave the stored tip unspent
// (5xx / a POST that never left the machine). Fixed delay rather than exponential: the ceiling here
// is one keeper tick, not an outage-riding budget, and jitter would make the retry count untestable.
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

// Transport-level fault: no HTTP status came back, so whether the endpoint saw the request is a
// question only the underlying cause can answer — see requestNeverLeft.
class RefreshNetworkError extends Error {
  constructor(cause: unknown) {
    super("token refresh transport failure", { cause })
    this.name = "RefreshNetworkError"
  }
}

// The ONLY transport faults that prove the POST never reached the wire, so the stored tip is
// certainly unspent. Bun reports DNS failure and TCP refusal alike as `ConnectionRefused` (both
// verified against this runtime); a timeout abort surfaces as DOMException `TimeoutError` and a
// mid-flight drop as `ECONNRESET`, and in BOTH of those the request was already sent — Anthropic
// may have consumed the tip and rotated the chain while the response never made it home.
function requestNeverLeft(cause: unknown): boolean {
  return (cause as { code?: unknown } | null | undefined)?.code === "ConnectionRefused"
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
  if (error instanceof RefreshNetworkError) return requestNeverLeft(error.cause)
  return false
}

export function createRefresher(deps: RefresherDeps): Refresher {
  const now = deps.now ?? Date.now
  // Keyed by ACCOUNT ID, not by refresh string (which is how usage.ts keys its map): the tip
  // rotates on every success, so a tip-keyed entry would dedupe nothing across a rotation.
  const inflight = new Map<string, Promise<FreshAccess>>()
  // ONE deadline for the whole pool, not a per-account map like usage.ts's: that map keys by refresh
  // token because it guards a SUBSCRIPTION on a personal machine, while what a 429 tells this
  // process is that ITS IP is blocked — and every account in the pool leaves through that IP.
  let blockedUntil = 0

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
      // Logged because it is what decides the retry, and reading it off a bare line meant timing the
      // gap between two of them.
      const { name, code } = (cause ?? {}) as { name?: unknown; code?: unknown }
      log.warn("master-refresher:refresh-transport-fail", { accountId, errName: name, errCode: code })
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
      if (res.status === 429) {
        blockedUntil = now() + MASTER_REFRESH_429_COOLDOWN_MS
        log.warn("master-refresher:refresh-cooldown", { accountId, until: blockedUntil })
      }
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

  function leasableAccess(token: { access?: string; expires?: number }): FreshAccess | undefined {
    if (!token.access || !token.expires) return undefined
    return token.expires - now() > MASTER_MIN_REMAINING_MS ? { access: token.access, expiresAt: token.expires } : undefined
  }

  async function resolve(accountId: string, minHorizonMs: number): Promise<FreshAccess> {
    const account = await deps.loadAccount(accountId)
    if (!account) throw new Error(`unknown account ${accountId}`)
    // A chain already judged dead is never POSTed again. The warm loop walks EVERY account every
    // five minutes, so without this a single dead account would drip a guaranteed-400 at the token
    // endpoint forever — from the one egress IP the whole pool shares. Thrown, not returned as a
    // stale access token: the scheduler already excludes flagged accounts, so reaching here at all
    // means a race, and answering it with a credential nobody can renew only defers the failure.
    if (account.needsReauth) {
      log.debug("master-refresher:skip-needs-reauth", { accountId })
      throw new MasterRefreshRevokedError(accountId, account.refresh)
    }
    // PROACTIVE, not last-ditch: rotate once the token is half spent, plus whatever headroom the
    // caller asked for. STRICT `>` so a token sitting exactly on the threshold rotates.
    if (account.access && account.expires && account.expires - now() > MASTER_REFRESH_THRESHOLD_MS + minHorizonMs) {
      return { access: account.access, expiresAt: account.expires }
    }
    // 429 means this HOST is rate-limited, so the whole pool waits — see MASTER_REFRESH_429_COOLDOWN_MS.
    // The cached token is still handed out while it clears the lease floor: refusing outright would
    // take the pool down for five minutes over a token that is perfectly usable for hours.
    if (now() < blockedUntil) {
      const cached = leasableAccess(account)
      log.warn("master-refresher:refresh-blocked-429", { accountId, served: cached !== undefined })
      if (cached) return cached
      throw new Error(`token refresh cooling down after 429 for ${accountId}`)
    }
    const previousMintedAt = account.refreshMintedAt
    let fresh: MasterToken
    try {
      fresh = await refreshWithRetry(accountId, account.refresh)
    } catch (error) {
      if (!(error instanceof MasterRefreshRevokedError)) throw error
      const { adopted } = await deps.onRefreshRevoked(accountId, error.refresh)
      // Deliberately NOT re-POSTing the adopted tip in this same flight: the winner already rotated
      // it, so a second POST would be the very double-refresh this whole module exists to prevent.
      // An adopted token too close to expiry falls through to the throw, and the account is left
      // UNFLAGGED — the next call refreshes the adopted tip normally.
      const usable = adopted && leasableAccess(adopted)
      if (usable) return usable
      throw error
    }
    // Persist BEFORE returning, never after: from the instant the POST succeeded the rotated tip
    // is the ONLY usable one, so a crash between handing out the access token and writing the tip
    // would leave the master holding a spent refresh — the exact permanent-strand failure.
    await deps.persist(accountId, fresh)
    const lifetimeMs = fresh.expires - now()
    log.info("master-refresher:refreshed", {
      accountId,
      remainingMs: lifetimeMs,
      // The age of the tip this rotation just replaced. THE point of recording it: a chain that
      // dies at ~8h every time is one that rotation does not rejuvenate, and that is a completely
      // different bug from one that dies after days.
      ...(previousMintedAt === undefined ? {} : { previousTicketAgeMs: now() - previousMintedAt }),
    })
    // Anthropic shortening the token lifetime below the rotation threshold would make EVERY tick
    // eligible to refresh EVERY account — a rotation storm against one egress IP, and a lease
    // horizon permanently in the past. Loud on purpose: the fix is to lower the threshold, and
    // nothing in this process can decide that on its own.
    if (lifetimeMs <= MASTER_REFRESH_THRESHOLD_MS) {
      log.error("master-refresher:lifetime-below-threshold", { accountId, lifetimeMs })
    }
    return { access: fresh.access, expiresAt: fresh.expires }
  }

  return {
    getFreshAccess(accountId: string, minHorizonMs = 0): Promise<FreshAccess> {
      // Keyed by account ID ALONE, deliberately: what single-flight protects is the one-time-use
      // tip, and that is per account. A caller joining a flight started with a smaller minHorizon
      // can therefore receive less headroom than it asked for — the lease server's own horizon
      // check catches that and answers 503, which is one retry, not a lost chain.
      const existing = inflight.get(accountId)
      if (existing) return existing
      // The ENTIRE load → freshness check → POST → persist chain is the flight, not just the POST.
      // Registering only around the POST would be useless: `await loadAccount` is an async
      // boundary, so every concurrent caller would clear the freshness check before any of them
      // reached the map. Note this body is synchronous up to the `set` — `resolve()` suspends at
      // its first await and returns a promise, so no caller can slip in between.
      const flight = resolve(accountId, minHorizonMs).finally(() => {
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
