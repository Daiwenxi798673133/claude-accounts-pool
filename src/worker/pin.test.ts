import { expect, test } from "bun:test"
import type { LeaseOutcome } from "./leaseClient.ts"
import { createPinnedLease, type PinStore } from "./pin.ts"

const LEASE: LeaseOutcome = { ok: true, lease: { accountId: "acct-1234-full", access: "sk-ant-x", expiresAt: 1 } }

type Ask = { reason: string; currentAccountId?: string; preferredAccountIdPrefix?: string; pinned?: boolean }

function setup(pinnedAt: string | undefined, outcomes: LeaseOutcome[]) {
  const asks: Ask[] = []
  const toasts: string[] = []
  let pinned = pinnedAt
  const pin: PinStore = {
    get: () => pinned,
    set: (idPrefix) => {
      pinned = idPrefix
    },
  }
  const lease = createPinnedLease({
    client: {
      lease: async (input) => {
        asks.push({ ...input })
        // Shifted, not indexed: the fallback's SECOND call must be able to answer differently from the
        // first, which is the whole behaviour under test.
        return outcomes.shift() ?? LEASE
      },
    },
    pin,
    toast: (input) => toasts.push(input.message),
  })
  return { lease, asks, toasts, pinOf: () => pinned }
}

test("no pin means the request is passed through untouched", async () => {
  const { lease, asks, toasts } = setup(undefined, [LEASE])

  await lease({ reason: "prelease", currentAccountId: "acct-1234-full" })

  // NOTHING added. A `pinned:false` here would be a lie on the wire (this worker has no opinion), and
  // a `preferredAccountIdPrefix` would turn every routine renewal into a named request the master
  // could refuse.
  expect(asks).toEqual([{ reason: "prelease", currentAccountId: "acct-1234-full" }])
  expect(toasts).toEqual([])
})

test("a pin names its account on every ask", async () => {
  const { lease, asks } = setup("acct-123", [LEASE])

  await lease({ reason: "prelease", currentAccountId: "acct-1234-full" })

  // BOTH fields: the prefix is what makes the master serve this account instead of ranking, and the
  // flag is what makes it record the hold as one that will not move.
  expect(asks).toEqual([
    { reason: "prelease", currentAccountId: "acct-1234-full", preferredAccountIdPrefix: "acct-123", pinned: true },
  ])
})

test("a REFUSED pin is dropped, announced, and the ask retried unpinned", async () => {
  // Given: the pinned account cooled (somebody else's rate-limit report), so the master refuses it
  const { lease, asks, toasts, pinOf } = setup("acct-123", [
    { ok: false, failure: { kind: "refused", refused: "cooling" } },
    LEASE,
  ])

  const outcome = await lease({ reason: "prelease", currentAccountId: "acct-1234-full" })

  // Then: the second ask carries NO pin — this is the difference between a worker that rotates on and
  // one that names a refused account forever, never renews, and lets its lease lapse into the state
  // where the local auth provider starts refreshing the sentinel itself.
  expect(asks).toEqual([
    { reason: "prelease", currentAccountId: "acct-1234-full", preferredAccountIdPrefix: "acct-123", pinned: true },
    { reason: "prelease", currentAccountId: "acct-1234-full" },
  ])
  expect(outcome.ok).toBe(true)
  // The pin is GONE from the store, not merely skipped for this one ask: the operator's standing
  // instruction has been reversed, so the next renewal must not resurrect it.
  expect(pinOf()).toBeUndefined()
  // NEVER SILENTLY: reversing an instruction the operator gave by hand has to be said out loud, in
  // Chinese like every other user-facing string here.
  expect(toasts).toHaveLength(1)
  expect(/[\u4e00-\u9fff]/.test(toasts[0])).toBe(true)
  // …and it must not echo the id prefix, which would explain nothing to somebody reading emails.
  expect(toasts[0]).not.toContain("acct-123")
})

test("a transport fault keeps the pin and does not retry", async () => {
  const { lease, asks, toasts, pinOf } = setup("acct-123", [{ ok: false, failure: { kind: "unreachable", detail: "ECONNREFUSED" } }])

  const outcome = await lease({ reason: "prelease" })

  // ONE ask, pin intact. An unreachable master says nothing about whether THIS account is servable,
  // and abandoning the operator's pin over a dropped packet would be a policy change made by the
  // network. Same for `no-account` and `bad-response`: only a 409 is evidence about the account.
  expect(asks).toHaveLength(1)
  expect(outcome.ok).toBe(false)
  expect(pinOf()).toBe("acct-123")
  expect(toasts).toEqual([])
})
