import { expect, test } from "bun:test"
import type { LeaseRefusal } from "../cloud/protocol.ts"
import type { LeaseOutcome } from "./leaseClient.ts"
import { createManualSwitch } from "./manualSwitch.ts"

const NOW = 1_900_000_000_000
const LEASE = { accountId: "eaaa1a79-4c1d-4f6e-9a52-6b7c8d9e0f11", access: "sk-ant-oat01-leased", expiresAt: NOW + 3_600_000 }

type LeaseCall = { reason: string; preferredAccountIdPrefix: string; attempts: number }
type Written = { access: string; expires: number; accountId: string }
type Toasted = { variant: string; message: string }

// The collaborators are recorders, not mocks with canned assertions: what matters here is WHETHER a
// credential was written and WHAT the operator was told, and both are observable as values.
function harness(outcome: LeaseOutcome) {
  const leases: LeaseCall[] = []
  const written: Written[] = []
  const toasts: Toasted[] = []
  const manual = createManualSwitch({
    client: {
      async lease(input) {
        leases.push(input)
        return outcome
      },
    },
    writeLease: async (input) => {
      written.push(input)
    },
    toast: (input) => {
      toasts.push(input)
    },
    now: () => NOW,
  })
  return { manual, leases, written, toasts }
}

test("a manual switch names the account, writes the lease and reports the account by label", async () => {
  const { manual, leases, written, toasts } = harness({ ok: true, lease: LEASE })

  const result = await manual.switchTo({ prefix: "eaaa1a79", label: "vince.dai3@potentia.ai" })

  expect(result).toEqual({ ok: true, accountId: LEASE.accountId })
  // `prelease`, NOT `ratelimit`: the account being left is healthy — the operator simply chose another
  // one — and `ratelimit` would have the master cool a perfectly good account, shrinking pool capacity
  // for every other worker because one person changed their mind.
  // ONE attempt, because a human is watching a dialog for the verdict.
  expect(leases).toEqual([{ reason: "prelease", preferredAccountIdPrefix: "eaaa1a79", attempts: 1 }])
  // ACCESS + EXPIRY ONLY as the credential — INV-CLOUD-1. There is no refresh field on this seam to
  // leak, and the write shape is identical to the renewal loop's, so a manual switch cannot produce
  // a credential a scheduled one could not. `accountId` is the operator's chosen account travelling
  // to the seam's bookkeeping half, which is what lets /usage mark this row on the NEXT process too.
  expect(written).toEqual([{ access: LEASE.access, expires: LEASE.expiresAt, accountId: LEASE.accountId }])
  expect(toasts).toHaveLength(1)
  expect(toasts[0].variant).toBe("success")
  expect(toasts[0].message).toContain("vince.dai3@potentia.ai")
  // The success message SAYS the choice may not survive the next renewal. There is no worker→account
  // affinity in this pool by design, so staying silent would let the operator discover the rotation
  // as a bug.
  expect(toasts[0].message).toContain("轮换")
  // Never the credential itself, in any message the operator can screenshot.
  expect(toasts[0].message).not.toContain(LEASE.access)
})

test("every refusal reason gets its own message and writes nothing", async () => {
  // The four reasons have four different remedies — wait it out, re-login on the master, refresh the
  // list, fix the roster — so one generic "切号失败" would send the operator to fix the wrong thing.
  const refusals: LeaseRefusal[] = ["unknown", "ambiguous", "cooling", "needs-reauth"]
  const messages = new Set<string>()

  for (const refused of refusals) {
    const { manual, written, toasts } = harness({ ok: false, failure: { kind: "refused", refused } })

    const result = await manual.switchTo({ prefix: "eaaa1a79", label: "vince.dai3@potentia.ai" })

    expect(result).toEqual({ ok: false })
    // NOT SILENT: the acceptance criterion for this feature is that an unservable account always says
    // so, because the panel has already closed by the time this runs.
    expect(toasts).toHaveLength(1)
    expect(toasts[0].variant).toBe("error")
    expect(toasts[0].message.length).toBeGreaterThan(0)
    // The existing lease is untouched — a refused switch must leave the worker on the working account
    // it already had, never half-way between two.
    expect(written).toEqual([])
    messages.add(toasts[0].message)
  }

  // Four distinct sentences, not four copies of one.
  expect(messages.size).toBe(refusals.length)
})

test("a transport failure is reported in switch wording and writes nothing", async () => {
  const { manual, written, toasts } = harness({ ok: false, failure: { kind: "unreachable", detail: "ECONNREFUSED" } })

  const result = await manual.switchTo({ prefix: "eaaa1a79", label: "vince.dai3@potentia.ai" })

  expect(result).toEqual({ ok: false })
  expect(written).toEqual([])
  // "未切号", not the rate-limit path's "已停在当前账号": nothing moved, and the wording has to match
  // what actually happened or the operator cannot tell which state they are in.
  expect(toasts[0].message).toContain("未切号")
})

test("an already-expired lease is refused rather than written", async () => {
  const { manual, written, toasts } = harness({ ok: false, failure: { kind: "auth" } })
  expect((await manual.switchTo({ prefix: "a", label: "a@example.test" })).ok).toBe(false)
  expect(written).toEqual([])
  expect(toasts).toHaveLength(1)

  // And the same refusal for a lease that arrived DEAD. This is the sharpest case in the module: a
  // past `expires` is exactly the state in which the local auth provider starts refreshing the
  // sentinel itself and becomes a second refresher of the master's one-time-use chain — so an expired
  // replacement is strictly worse than the working lease we already hold.
  const dead = harness({ ok: true, lease: { ...LEASE, expiresAt: NOW } })
  const result = await dead.manual.switchTo({ prefix: "eaaa1a79", label: "vince.dai3@potentia.ai" })

  expect(result).toEqual({ ok: false })
  expect(dead.written).toEqual([])
  expect(dead.toasts[0].variant).toBe("error")
})

test("a lease for a DIFFERENT account than the one named is refused, not written", async () => {
  // Given: a master that predates this feature. Its parser destructures only the three fields it
  // knows, so `preferredAccountIdPrefix` is silently ignored and it answers 200 with its own RANKED
  // pick — a real deployment state, since master and workers upgrade independently.
  const { manual, written, toasts } = harness({ ok: true, lease: { ...LEASE, accountId: "ffff9999-someone-else" } })

  const result = await manual.switchTo({ prefix: "eaaa1a79", label: "vince.dai3@potentia.ai" })

  // Then: NOTHING is written and the switch reports failure. Writing it would put the worker on an
  // account the operator did not choose while telling them the switch succeeded — they would then
  // attribute the next turn's usage to the wrong subscription, which is precisely what the server's
  // 409 exists to prevent. The invariant holds on BOTH ends, so a half-upgraded pool is still safe.
  expect(result).toEqual({ ok: false })
  expect(written).toEqual([])
  expect(toasts).toHaveLength(1)
  expect(toasts[0].variant).toBe("error")
  expect(toasts[0].message).toContain("未切号")
})
