// The guard that stops a REVOKED-BUT-UNEXPIRED access token from being published a second time.
//
// WHY IT HAS TO EXIST, as one chain:
//   * Anthropic revokes the previously issued access token the instant a refresh succeeds, so a
//     token can be DEAD while its `expiresAt` is still hours out. Dead and live are byte-identical.
//   * The master serves its CACHED access token whenever the horizon is wide enough — see
//     src/master/refresher.ts's resolve(), which returns `account.access` unchanged while
//     `expires - now > MASTER_REFRESH_THRESHOLD_MS + minHorizonMs` — and the lease route asks for no
//     more than LEASE_RENEW_BUFFER_MS. Re-leasing the same account therefore returns the same corpse,
//     byte for byte, until it finally expires. There is no "mint me a new one" on this wire.
//   * senpi's auth_error block is the ONLY local evidence that a published token is dead. The turn
//     audit records that token in `deadAccess` and invalidates the slot — but nothing compared the
//     MASTER'S answer against that set, so the very next lease republished it: 401 → clear block →
//     invalidate → re-lease the identical corpse, once per turn, for the whole life of the token.
//     Measured on a live worker as two full cycles inside eight minutes.
//
// THE RETRY DROPS THE PIN AND THE NAMED ACCOUNT, deliberately. A prefix short-circuits the master's
// ranking completely (leaseServer's named-account path), so asking again by name is asking for the
// same corpse a third time. Only an exclusion moves this slot onto an account whose token is alive.
import { log } from "../logger.ts"
import type { LeaseOutcome } from "../worker/leaseClient.ts"

export type DeadLeaseRequest = {
  reason: "prelease" | "ratelimit"
  currentAccountId?: string
  preferredAccountIdPrefix?: string
  pinned?: boolean
  excludeAccountIds?: readonly string[]
}

export type DeadLeaseDeps = {
  lease: (input: DeadLeaseRequest) => Promise<LeaseOutcome>
  // A LIVE reference, not a copy: the turn audit adds to this set between renewals, and a snapshot
  // taken at wiring time would be empty for exactly the turn that needs it.
  deadAccess: ReadonlySet<string>
}

export async function leaseLiveAccess(deps: DeadLeaseDeps, input: DeadLeaseRequest): Promise<LeaseOutcome> {
  const first = await deps.lease(input)
  if (!first.ok || !deps.deadAccess.has(first.lease.access)) return first

  const accountId = first.lease.accountId
  // accountId only. The access token is a live credential even when it is a dead one.
  log.warn("senpi:lease-dead-access", { accountId, pinned: input.pinned === true })
  const retry = await deps.lease({
    reason: input.reason,
    // KEPT while the prefix and the pin are dropped: this names the account being LEFT, which is the
    // master's rotation anchor and a different question from "do not give me this one".
    ...(input.currentAccountId === undefined ? {} : { currentAccountId: input.currentAccountId }),
    excludeAccountIds: [...(input.excludeAccountIds ?? []), accountId],
  })
  if (!retry.ok) return retry
  if (deps.deadAccess.has(retry.lease.access)) {
    log.error("senpi:lease-dead-access-twice", { accountId: retry.lease.accountId })
    return { ok: false, failure: { kind: "dead-access", accountId: retry.lease.accountId } }
  }
  return retry
}
