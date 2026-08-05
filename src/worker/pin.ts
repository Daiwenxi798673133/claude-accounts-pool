// THE PIN: the operator pressed `p` on a row of this worker's /usage panel, so this machine keeps
// naming that account on every renewal instead of taking the master's ranked pick — until its quota
// is actually spent.
//
// WHY A MODULE AND NOT A FIELD ON THE KEEPER. Three separate paths must agree on the pin (the renewal
// loop, the stale-lease recovery, the manual switch), and exactly ONE of them must own the decision to
// GIVE IT UP. That decision is the whole risk of the feature: an account can stop being servable for
// reasons that have nothing to do with this worker — somebody else's rate-limit report cooled it, the
// operator deleted it from the pool, its refresh chain broke — and a worker that keeps naming an
// account the master keeps refusing NEVER RENEWS AGAIN. Its lease then lapses, and a lapsed `expires`
// is the one state in which the local auth provider refreshes the sentinel itself (see leaseKeeper's
// header). So the fallback below is not a nicety; it is what keeps a pin from bricking a worker.
//
// The pin holds an id PREFIX, never a full account id: it comes from the panel, which is rendered from
// UsageAccountView and carries nothing else, and the wire wants a prefix anyway.
import type { LeaseReason } from "../cloud/protocol.ts"
import { log } from "../logger.ts"
import type { LeaseOutcome } from "./leaseClient.ts"

export type PinStore = {
  get: () => string | undefined
  // `undefined` clears it. Persisted by the implementation, because a pin the operator set before
  // lunch must survive the OpenCode restart they did after it.
  set: (idPrefix: string | undefined) => void
}

export type PinnedLeaseDeps = {
  client: {
    lease(input: {
      reason: LeaseReason
      currentAccountId?: string
      preferredAccountIdPrefix?: string
      pinned?: boolean
    }): Promise<LeaseOutcome>
  }
  pin: PinStore
  // NEVER FAIL SILENTLY: dropping a pin reverses an instruction the operator gave by hand, so it has
  // to be said out loud. Not named in the message — a worker holds a prefix, not the email the panel
  // showed, and echoing eight hex characters at somebody would explain nothing.
  toast: (input: { variant: "warning"; message: string }) => void
}

const DROPPED_TOAST = "钉住的账号已无法租借（可能额度已满或被移出账号池），已自动解除钉住并按用量轮换"

// The lease verb every AUTOMATIC path should use in place of `client.lease`. Unpinned, it is exactly
// `client.lease`. Pinned, it names the account and falls back ONCE to a ranked pick if the master
// refuses it.
export function createPinnedLease(deps: PinnedLeaseDeps) {
  return async function lease(input: { reason: LeaseReason; currentAccountId?: string }): Promise<LeaseOutcome> {
    const pinned = deps.pin.get()
    if (pinned === undefined) return deps.client.lease(input)
    const outcome = await deps.client.lease({ ...input, preferredAccountIdPrefix: pinned, pinned: true })
    // ONLY a `refused` gives the pin up. Every other failure — unreachable, bad-response, no-account —
    // says nothing about whether THIS account is servable, and abandoning the operator's pin over a
    // network blip would be a silent policy change made by a dropped packet.
    if (outcome.ok || outcome.failure.kind !== "refused") return outcome
    log.warn("pin:dropped", { idPrefix: pinned, refused: outcome.failure.refused })
    deps.pin.set(undefined)
    deps.toast({ variant: "warning", message: DROPPED_TOAST })
    return deps.client.lease(input)
  }
}
