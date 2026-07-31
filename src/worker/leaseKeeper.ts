// Worker-side resident loop that keeps a LEASED access token fresh — plus the FAIL-SAFE that
// refuses to let a stale credential state cause damage.
//
// WHY THIS IS THE CORRECTNESS CORE OF A WORKER, as one chain:
//   * A central master holds every account's real OAuth refresh token and is the ONLY refresher.
//     Workers lease short-lived access tokens over HTTP and hold no chain of their own.
//   * The local auth provider (@ex-machina/opencode-anthropic-auth) refreshes whenever
//     `!access || !expires || expires < Date.now()` — ZERO buffer — and re-reads auth.json on
//     EVERY request. There is no config flag that turns that off.
//   * Therefore the ONLY lever a worker has is to keep `expires` in the FUTURE. The moment it
//     slips into the past, that provider POSTs the token endpoint with our sentinel refresh and
//     this machine becomes a SECOND refresher of a one-time-use chain — the failure that rotates
//     the master's token out from under it and permanently locks it out of the account.
//
// So this module NEVER refreshes; it only leases. It names the Anthropic token endpoint NOWHERE
// (enforced by an automated grep over src/worker/): there is no code path here that could POST it,
// by construction rather than by discipline.
//
// The plugin API does not let a TUI plugin intercept or abort an outgoing model request, so this
// keeper cannot block traffic. Its job is (a) keep the lease fresh so the situation never arises,
// and (b) when it cannot, write NOTHING and tell the user plainly.
import { LEASE_BACKOFF_BASE_MS, LEASE_BACKOFF_CAP_MS, LEASE_CHECK_INTERVAL_MS, LEASE_RENEW_BUFFER_MS } from "../constants.ts"
import { log, redactBody } from "../logger.ts"
import type { LeaseFailure, LeaseOutcome } from "./leaseClient.ts"

export type LeaseKeeperDeps = {
  // Structural, not the concrete client: this loop needs exactly one verb, and narrowing the
  // dependency to it is what lets every test drive the loop without a transport at all.
  client: { lease(input: { reason: "prelease" | "ratelimit"; currentAccountId?: string }): Promise<LeaseOutcome> }
  readAuth: () => Promise<{ access?: string; expires?: number } | undefined>
  // The `{kind:"lease"}` write seam — access + expiry and NOTHING else. A worker has no real
  // refresh token to pass, and that is precisely why it cannot leak, replay or revoke one.
  writeLease: (input: { access: string; expires: number }) => Promise<void>
  toast: (input: { variant: "warning" | "error"; message: string }) => void
  sleep: (ms: number) => Promise<void>
  // Injected clock so every expiry comparison below is testable at a frozen instant.
  now?: () => number
}

type AuthSnapshot = Awaited<ReturnType<LeaseKeeperDeps["readAuth"]>>

// Why a renewal did not land. Kept as a union so the fail-safe below answers each case
// explicitly instead of collapsing "the master is unreachable" into "the master lied".
type Setback = { kind: "stale" } | { kind: "failure"; failure: LeaseFailure }

// Chinese, because every user-facing string in this plugin is. Names the CONSEQUENCE ("停止请求
// 以避免污染账号池"), not the mechanism: the user's only useful move is to stop and fix the master.
const STRANDED_TOAST = "云模式：无法从 master 续租访问令牌，已停止请求以避免污染账号池"

// A distinct message on purpose: this one means the master ANSWERED and its answer was unusable,
// which is a master-side defect the user must go look at, not a network blip to wait out.
const STALE_TOAST = "云模式：master 返回的访问令牌已过期，已拒绝写入，请检查 master 状态"

// Renewal is due while the lease still WORKS — never after it breaks. LEASE_RENEW_BUFFER_MS
// must always exceed LEASE_CHECK_INTERVAL_MS (asserted in the test) because we only get to
// notice an approaching expiry once per check: a buffer narrower than one interval could let a
// lease lapse between two looks, and a lapsed `expires` is exactly the state that turns the
// local auth provider into a second refresher.
function renewalDue(auth: AuthSnapshot, at: number): boolean {
  // No access or no expiry at all — a worker that has never leased, or an entry someone
  // truncated. Lease NOW rather than wait for a renewal window that will never open.
  if (!auth?.access || !auth.expires) return true
  return auth.expires - at < LEASE_RENEW_BUFFER_MS
}

// Whether the credential currently on disk can still serve a request. `expires === 0` and a
// missing access both read as unusable, which is the same judgement the auth provider makes.
function stillUsable(auth: AuthSnapshot, at: number): boolean {
  if (!auth?.access || auth.expires === undefined) return false
  return auth.expires > at
}

// 5s → 10s → 20s … clamped at 300s. `priorFailures` is the count BEFORE this one, so the first
// failure sleeps the base. A master that has been down a while is usually down deliberately, so
// the ceiling stops a crowd of workers hammering a box someone is working on.
function backoffFor(priorFailures: number): number {
  return Math.min(LEASE_BACKOFF_BASE_MS * 2 ** priorFailures, LEASE_BACKOFF_CAP_MS)
}

// `in` narrowing rather than a per-variant branch: this only extracts a diagnostic string, and
// redactBody because an `unreachable` detail can echo a URL or a token-shaped fragment back.
function detailOf(failure: LeaseFailure): string {
  return "detail" in failure ? redactBody(failure.detail, 200) : failure.kind
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function installLeaseKeeper(deps: LeaseKeeperDeps): { dispose: () => void; tickOnce: () => Promise<void> } {
  const clock = deps.now ?? Date.now
  // Consecutive failed renewals, reset ONLY by a write that actually landed. A stale answer
  // counts as a failure: treating it as success would reset the backoff and hammer a broken
  // master once per check interval forever.
  let failures = 0
  let disposed = false
  // A failed tick SLEEPS inside itself, so without this guard the interval would stack ticks on
  // top of a sleeping one and each would lease again — multiplying load on the master exactly
  // when it is least able to take it.
  let ticking = false
  // The account the master last told us we hold. Passed back as `currentAccountId` so a renewal
  // is understood as "keep me on this one" rather than as a fresh, unattributed request.
  let heldAccountId: string | undefined

  // THE FAIL-SAFE. Fires only when the credential on disk is ALREADY unusable and we just failed
  // to replace it — i.e. the auth provider is now one request away from trying to refresh the
  // sentinel itself. While the current lease still works this stays silent: a toast on every
  // check interval would train the user to ignore the one that matters.
  function reportSetback(setback: Setback, auth: AuthSnapshot): void {
    // A FRESH read of the clock: the question is whether the access is expired at THIS moment,
    // not whether it was when this tick started.
    if (stillUsable(auth, clock())) return
    log.error("worker:lease-failed", {
      // Never the access token — only the shape of the fault and the instant that lapsed.
      setback: setback.kind,
      detail: setback.kind === "failure" ? detailOf(setback.failure) : "expired-instant",
      expires: auth?.expires ?? 0,
    })
    deps.toast({ variant: "error", message: STRANDED_TOAST })
  }

  // Undefined = renewed (or disposed mid-flight); a Setback = nothing was written.
  async function renew(): Promise<Setback | undefined> {
    const outcome = await deps.client.lease({
      reason: "prelease",
      ...(heldAccountId === undefined ? {} : { currentAccountId: heldAccountId }),
    })
    if (!outcome.ok) return { kind: "failure", failure: outcome.failure }
    const lease = outcome.lease
    // VALIDATE BEFORE WRITING, strictly `>`: an instant equal to now is already spent. A master
    // that hands back a stale expiry must never be trusted into the credential file — writing it
    // would put this worker into the very state the whole module exists to prevent, instantly and
    // by our own hand. Refusing leaves a still-valid (or already-broken) entry untouched, which
    // is strictly safer than replacing it with a known-dead one.
    if (lease.expiresAt <= clock()) {
      log.warn("worker:lease-stale", { accountId: lease.accountId, expiresAt: lease.expiresAt, now: clock() })
      deps.toast({ variant: "warning", message: STALE_TOAST })
      return { kind: "stale" }
    }
    // dispose() may have landed while the request was in flight. Past this line we would be
    // writing a credential file on behalf of a keeper the host has already torn down.
    if (disposed) return undefined
    await deps.writeLease({ access: lease.access, expires: lease.expiresAt })
    heldAccountId = lease.accountId
    failures = 0
    // accountId and expiry only. `lease.access` is a live credential and is never logged.
    log.info("worker:lease-renewed", { accountId: lease.accountId, expiresAt: lease.expiresAt })
    return undefined
  }

  // Exported for tests AND for a later e2e harness; the interval below simply calls it. There is
  // deliberately no tick at install time: the caller owns the startup lease (it may need to run
  // before other wiring), and an implicit first tick would race every test that installs a keeper.
  async function tickOnce(): Promise<void> {
    if (disposed || ticking) return
    ticking = true
    try {
      const auth = await deps.readAuth()
      if (!renewalDue(auth, clock())) return
      const setback = await renew()
      if (!setback) return
      // Report FIRST, then back off: the user should hear about a stranded credential now, not
      // after a delay that can be five minutes long.
      reportSetback(setback, auth)
      failures += 1
      await deps.sleep(backoffFor(failures - 1))
    } finally {
      ticking = false
    }
  }

  const interval = setInterval(() => {
    // writeLease reaches a real file, so it can genuinely reject (full disk, bad permissions).
    // An unhandled rejection here would surface as a crash in the plugin HOST, taking the TUI
    // with it — so the loop's boundary swallows and records instead.
    void tickOnce().catch((error) => log.warn("worker:lease-tick-fail", { error: errorMessage(error) }))
  }, LEASE_CHECK_INTERVAL_MS)
  // unref so a keeper nobody disposed cannot hold the process open (same as installTokenKeeper).
  interval.unref?.()
  log.info("worker:lease-keeper-installed", { checkMs: LEASE_CHECK_INTERVAL_MS, bufferMs: LEASE_RENEW_BUFFER_MS })

  return {
    dispose() {
      disposed = true
      clearInterval(interval)
    },
    tickOnce,
  }
}
