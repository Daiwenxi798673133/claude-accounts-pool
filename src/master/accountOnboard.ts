// Browser-driven onboarding: mint a Claude PKCE authorization URL, then trade the code the operator
// pastes back for a real {access, refresh, expires} chain and file it in the account library.
//
// WHY THIS EXISTS AT ALL. Onboarding used to require shell access to the master: an admin ran
// `opencode auth login` on that box and the keeper's capture absorbed whatever landed in auth.json.
// That is still supported and still the path makeOnboardingCapture serves. This module is the second
// door — a pool owner holding only a browser can grow the pool — and it exists BESIDE that one rather
// than replacing it.
//
// NOTHING HERE TOUCHES THE NETWORK OR THE DISK. `authorize`, `exchange`, `fetchProfile` and `absorb`
// are all injected, for the same reason nothing in LeaseServerDeps has a default: a real exchange
// mints a live credential against a paid account, so a default-constructed collaborator in a test
// would do it for real. install.ts is the only file that supplies the live implementations.
//
// THE PKCE VERIFIER NEVER LEAVES THIS PROCESS. It is held here, keyed by an opaque pendingId, and the
// browser is given only that id. Handing the verifier to the page would let the page finish the
// exchange itself and keep the tokens, which would end the property the whole cloud design rests on:
// the master is the ONLY holder of a real refresh token.

import type { AuthToken } from "../accounts.ts"
import { ONBOARD_ADD_MIN_INTERVAL_MS, ONBOARD_MAX_ATTEMPTS, ONBOARD_MAX_PENDING, ONBOARD_PENDING_TTL_MS } from "../constants.ts"
import { log } from "../logger.ts"
import type { Subscription } from "../profile.ts"

export type AuthorizeResult = { url: string; redirectUri: string; state: string; verifier: string }

export type ExchangeResult = { type: "success"; refresh: string; access: string; expires: number } | { type: "failed" }

export type OnboardProfile = { uuid: string; email: string; subscription?: Subscription }

export type AccountOnboardDeps = {
  // ex-machina's `authorize('max')`. Pro/Max, never `console`: a console-mode chain is an API-key
  // credential for a workspace, not the subscription this pool leases out.
  authorize: () => Promise<AuthorizeResult>
  // ex-machina's `exchange`. It collapses every failure — unparseable paste, state mismatch, spent
  // code, HTTP error — into a bare `failed`, so the taxonomy this module reports outward can only be
  // as fine as that. Deliberately not re-implemented to recover the detail: a second exchange
  // implementation is a second place the PKCE contract can drift from the one that mints the URL.
  exchange: (input: string, verifier: string, redirectUri: string, expectedState: string) => Promise<ExchangeResult>
  // Identifies the account behind the chain. The uuid is the account library's primary key, so this
  // call is not optional decoration — without it there is nothing to file the tokens under.
  fetchProfile: (access: string) => Promise<OnboardProfile>
  // Writes the chain into the library and reports whether that uuid was already present. Takes the
  // cross-process auth lock in production, which is why it is a single injected step rather than a
  // load/modify/save this module drives itself.
  absorb: (input: { profile: OnboardProfile; token: AuthToken }) => Promise<{ existing: boolean }>
  // Opaque, unguessable pendingId. Injected so a test can assert on stable ids; production passes
  // crypto.randomUUID. It must stay unguessable: guessing a live id lets a third party spend the
  // operator's session.
  newId: () => string
  // Every time read in this module goes through it — a stray Date.now() would escape the injected
  // clock and make the TTL and the throttle untestable without real sleeps.
  now: () => number
}

// One live PKCE session. `attempts` counts REFUSED exchanges only: a successful one spends the
// authorization code upstream, so the session is destroyed rather than counted.
type Pending = {
  verifier: string
  redirectUri: string
  state: string
  expiresAt: number
  attempts: number
}

// What the caller of `add` is told. A union rather than a thrown error, because every arm is an
// ordinary outcome the page must render differently — and because a throw would tempt a handler into
// answering 500 for what is usually a typo.
export type AddOutcome =
  | { ok: true; idPrefix: string; label: string; existing: boolean }
  // The id names no live session: it was never issued, it aged out, it was evicted by
  // ONBOARD_MAX_PENDING, or a previous attempt already spent it.
  | { ok: false; reason: "unknown-pending" }
  // Issued, but ONBOARD_PENDING_TTL_MS has passed. Kept DISTINCT from unknown-pending so the page can
  // say "the link went stale" instead of implying the operator mistyped something.
  | { ok: false; reason: "expired" }
  // ONBOARD_MAX_ATTEMPTS refusals on this session. The session is gone; the operator needs a new URL.
  | { ok: false; reason: "exhausted" }
  // Anthropic (or the paste) said no. The one recoverable arm — the session survives if it has
  // attempts left.
  | { ok: false; reason: "rejected"; attemptsLeft: number }
  // The exchange SUCCEEDED and the profile lookup did not. The rarest and worst arm: a real chain was
  // minted and cannot be filed, and the authorization code behind it is already spent, so no retry of
  // this paste can work. The operator must start over.
  | { ok: false; reason: "profile-failed" }
  // Refused before anything was attempted, to protect this master's egress IP.
  | { ok: false; reason: "throttled"; retryAfterMs: number }

export type AccountOnboard = {
  start: () => Promise<{ url: string; pendingId: string; expiresAt: number }>
  add: (pendingId: string, code: string) => Promise<AddOutcome>
  // Test-only observability. Named for what it is so nobody mistakes it for part of the wire contract.
  pendingCount: () => number
}

// The dashboard shows an id PREFIX, never the uuid a lease names. Eight characters, matching
// usageView's redaction, so a row on the page and a `master:lease-served` log line still correlate.
function idPrefix(uuid: string): string {
  return uuid.slice(0, 8)
}

export function createAccountOnboard(deps: AccountOnboardDeps): AccountOnboard {
  const pendings = new Map<string, Pending>()
  // Server-wide, not per-session and not per-caller: what it protects is the single egress IP that
  // every account's refresh shares, so one impatient presser must throttle everyone.
  let lastAttemptAt = 0

  // Called on both routes rather than on a timer: the store is capped at ONBOARD_MAX_PENDING, so a
  // full sweep is trivially cheap, and a timer would keep a reference alive that has to be disposed.
  function prune(): void {
    const at = deps.now()
    for (const [id, pending] of pendings) {
      if (pending.expiresAt <= at) pendings.delete(id)
    }
  }

  async function start(): Promise<{ url: string; pendingId: string; expiresAt: number }> {
    prune()
    // Insertion order IS age order (Map preserves it and no entry is ever re-inserted), so the first
    // key is the oldest. Evicting the oldest rather than refusing the request is what keeps an
    // abandoned dialog — the common case, since closing the modal tells the server nothing — from
    // locking the operator out of onboarding for a full TTL.
    while (pendings.size >= ONBOARD_MAX_PENDING) {
      const oldest = pendings.keys().next()
      if (oldest.done) break
      pendings.delete(oldest.value)
      log.info("master:onboard-evicted")
    }
    const authorization = await deps.authorize()
    const pendingId = deps.newId()
    const expiresAt = deps.now() + ONBOARD_PENDING_TTL_MS
    pendings.set(pendingId, {
      verifier: authorization.verifier,
      redirectUri: authorization.redirectUri,
      state: authorization.state,
      expiresAt,
      attempts: 0,
    })
    // NEITHER the verifier NOR the state is logged. Both are live PKCE secrets for this session, and
    // the log file is shared with everything else the plugin writes.
    log.info("master:onboard-started", { pendingId, expiresAt, pendings: pendings.size })
    return { url: authorization.url, pendingId, expiresAt }
  }

  async function add(pendingId: string, code: string): Promise<AddOutcome> {
    // LOOKUP BEFORE PRUNE, and the order is the whole reason `expired` is distinguishable from
    // `unknown-pending`. Pruning first would evict this very session and leave the lookup below
    // reporting "no such handle" for one that merely aged out — telling an operator they mistyped
    // something when the truth is that their link went stale. Holding the reference across the prune
    // costs nothing: the entry is removed from the map either way, and the object still answers for
    // its own deadline.
    const pending = pendings.get(pendingId)
    prune()
    // Checked BEFORE the throttle: an unknown id costs nothing and reaches no network, so making the
    // operator wait to be told they need a new link would be gratuitous.
    if (!pending) {
      log.warn("master:onboard-unknown-pending", { pendingId })
      return { ok: false, reason: "unknown-pending" }
    }
    if (pending.expiresAt <= deps.now()) {
      // Already gone — `prune` above removed it. Deleted again rather than assumed, because the
      // deadline test here and the one inside `prune` must never be allowed to drift apart.
      pendings.delete(pendingId)
      log.warn("master:onboard-expired", { pendingId })
      return { ok: false, reason: "expired" }
    }
    // The CONCURRENCY half of the attempt cap. The ordinary path retires a spent session below, the
    // instant its last attempt is refused, so a sequential caller never reaches this branch. Two
    // requests in flight together can: both read the count before either increments it, and this is
    // what stops the second one from buying an extra POST on a session that is already finished.
    if (pending.attempts >= ONBOARD_MAX_ATTEMPTS) {
      pendings.delete(pendingId)
      log.warn("master:onboard-exhausted", { pendingId, at: "pre-attempt" })
      return { ok: false, reason: "exhausted" }
    }
    const elapsed = deps.now() - lastAttemptAt
    if (elapsed < ONBOARD_ADD_MIN_INTERVAL_MS) {
      // Costs no attempt and leaves the session intact: the caller was refused before Anthropic was
      // ever asked, so charging them for it would burn a legitimate operator's retries.
      const retryAfterMs = ONBOARD_ADD_MIN_INTERVAL_MS - elapsed
      log.debug("master:onboard-throttled", { retryAfterMs })
      return { ok: false, reason: "throttled", retryAfterMs }
    }

    // Stamped and counted BEFORE the await, both for the same reason: two requests in flight would
    // otherwise each read the pre-attempt state and both proceed, defeating the rate cap and the
    // attempt cap at once.
    lastAttemptAt = deps.now()
    pending.attempts += 1

    // `pending.state` is passed as the expected state, which is what makes this a CSRF-checked
    // exchange rather than a blind one: without it, a code phished from a different authorization
    // could be redeemed against this session's verifier.
    const exchanged = await deps.exchange(code, pending.verifier, pending.redirectUri, pending.state)
    if (exchanged.type === "failed") {
      const attemptsLeft = ONBOARD_MAX_ATTEMPTS - pending.attempts
      // Retired the moment its last attempt is spent, and reported as `exhausted` rather than as a
      // `rejected` with nothing left: the two call for different words on screen. "Rejected" invites
      // another paste into the field the operator is looking at, which is right while retries remain
      // and a dead end once they do not — at that point the only thing that helps is a new link.
      if (attemptsLeft <= 0) {
        pendings.delete(pendingId)
        log.warn("master:onboard-exhausted", { pendingId, at: "last-attempt" })
        return { ok: false, reason: "exhausted" }
      }
      // Otherwise the session SURVIVES on purpose: the overwhelmingly likely cause is a truncated
      // paste, and destroying it would send the operator back through the whole browser round trip
      // for a mistake they can fix where they stand.
      log.warn("master:onboard-rejected", { pendingId, attemptsLeft })
      return { ok: false, reason: "rejected", attemptsLeft }
    }

    // SPENT. An authorization code is single-use upstream, so from here the session can never succeed
    // again regardless of what happens below — deleting it now means a retry is told "get a new link"
    // instead of being sent to Anthropic to be refused.
    pendings.delete(pendingId)

    let profile: OnboardProfile
    try {
      profile = await deps.fetchProfile(exchanged.access)
    } catch (error) {
      // The chain is real and is now dropped on the floor. Logged at warn with NO token material: the
      // access token expires on its own, and the operator has to redo the browser round trip.
      log.warn("master:onboard-profile-fail", { pendingId, error: error instanceof Error ? error.message : String(error) })
      return { ok: false, reason: "profile-failed" }
    }

    const token: AuthToken = { refresh: exchanged.refresh, access: exchanged.access, expires: exchanged.expires }
    const { existing } = await deps.absorb({ profile, token })
    // The email is already on the dashboard for every account in the pool, so logging the label adds
    // no disclosure; the tokens are never named.
    log.info("master:onboard-absorbed", { uuid: profile.uuid, label: profile.email, existing })
    return { ok: true, idPrefix: idPrefix(profile.uuid), label: profile.email, existing }
  }

  return { start, add, pendingCount: () => pendings.size }
}
