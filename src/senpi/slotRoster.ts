// Who holds which senpi token slot, and the ONE critical section that keeps two slots off the same
// account.
//
// A senpi worker fills several CLAUDE_CODE_OAUTH_TOKEN* variables so the harness can rotate between
// accounts locally. Each slot runs its own installLeaseKeeper — that reuse is what makes the fail-safe,
// the backoff, the stale-lease refusal and the dispose race come for free, and it also gives every
// slot an independent failure counter, so one dead account cannot throttle the others.
//
// The cost of that reuse is this file. K keepers install K intervals that fire at nearly the same
// instant, so two slots would compute "what am I already holding" before either recorded its answer,
// both would exclude the same set, and both would be served the SAME account: one subscription
// feeding two slots while the master's book shows two independent holders.
//
// So the exclusion set and the claim are not two operations a caller sequences correctly — they are
// one section this module owns. `claim` exists only inside the callback withSlot hands out, which is
// what makes the interleaving unrepresentable rather than merely avoided.
export type SlotClaimContext = {
  // Everything held by slots OTHER than this one. This slot's own current account is absent on
  // purpose: a renewal that keeps the account it already has is the expected answer, and excluding it
  // would rotate every slot off a perfectly good account once per renewal window.
  excludeAccountIds: readonly string[]
  claim: (accountId: string) => void
}

export type SlotRoster = {
  withSlot: <T>(slotName: string, fn: (ctx: SlotClaimContext) => Promise<T>) => Promise<T>
  heldAccountIds: () => string[]
}

export function createSlotRoster(): SlotRoster {
  const bySlot = new Map<string, string>()
  // Serialises every section, not just concurrent ones: a queue that only engaged under contention
  // would make the race timing-dependent and therefore untestable.
  let tail: Promise<unknown> = Promise.resolve()

  function contextFor(slotName: string): SlotClaimContext {
    const others: string[] = []
    for (const [slot, accountId] of bySlot) {
      if (slot !== slotName) others.push(accountId)
    }
    return {
      excludeAccountIds: others,
      claim: (accountId) => {
        bySlot.set(slotName, accountId)
      },
    }
  }

  return {
    withSlot(slotName, fn) {
      // Chained on BOTH settlements: a rejected section must not break the queue for every slot
      // behind it — that would strand the whole worker on one slot's transport fault.
      const run = tail.then(
        () => fn(contextFor(slotName)),
        () => fn(contextFor(slotName)),
      )
      tail = run.then(
        () => undefined,
        () => undefined,
      )
      return run
    },
    heldAccountIds: () => [...bySlot.values()],
  }
}
