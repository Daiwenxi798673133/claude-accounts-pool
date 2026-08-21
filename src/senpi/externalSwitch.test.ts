import { expect, test } from "bun:test"
import { detectExternalSwitches, externalSwitchNotice } from "./externalSwitch.ts"
import type { CachedLease } from "./leaseCache.ts"

function lease(accountId: string): CachedLease {
  return { accountId, access: `access-for-${accountId}`, expires: 1_800_000_000_000 }
}

// THE WHOLE POINT OF THE MODULE. A second process (the CLI, another senpi, the master's own
// dashboard driving a lease) writes the cache; this process still publishes the old token. Without
// a detection the operator switches "successfully" somewhere else and this omo keeps billing the
// account it was left on.
test("a cache naming a different account than the slot holds is an external switch", () => {
  const switches = detectExternalSwitches({
    cached: new Map([["env", lease("acct-new-1111")]]),
    held: [{ slotName: "env", accountId: "acct-old-0000" }],
  })

  expect(switches).toEqual([{ slotName: "env", from: "acct-old-0000", to: lease("acct-new-1111") }])
})

// THE FALSE-POSITIVE LOCK, and it is the case that decides whether this feature is usable at all:
// our own panel switch writes the cache BEFORE the next turn runs, so cache == keeper is the steady
// state. Reporting that as an external switch would fire a warning after every switch the operator
// just performed themselves.
test("a cache agreeing with the slot is not a switch", () => {
  expect(
    detectExternalSwitches({
      cached: new Map([["env", lease("acct-same-2222")]]),
      held: [{ slotName: "env", accountId: "acct-same-2222" }],
    }),
  ).toEqual([])
})

// A slot holding NOTHING is the cold-start path, not a switch: installLeaseKeeper's own startup
// lease is what fills it, and adopting here would race that with no benefit. Only a slot that HAS
// an account can have been switched away from one.
test("a slot holding nothing yet is left to the startup lease", () => {
  expect(
    detectExternalSwitches({
      cached: new Map([["env", lease("acct-new-1111")]]),
      held: [{ slotName: "env" }],
    }),
  ).toEqual([])
})

// readLeaseCache already drops expired and malformed entries, so an absent slot means "nothing
// usable on disk" — which is no evidence of a switch and must never clear a live lease.
test("a slot with no cache entry is not a switch", () => {
  expect(
    detectExternalSwitches({
      cached: new Map(),
      held: [{ slotName: "env", accountId: "acct-old-0000" }],
    }),
  ).toEqual([])
})

// MULTI-SLOT, and the reason the result is a list: with K slots the cache can have moved one of
// them and left the others alone. Adopting the untouched ones would republish a token they already
// hold, and reporting them would tell the operator about a switch that did not happen.
test("only the slots whose account actually moved are reported", () => {
  const switches = detectExternalSwitches({
    cached: new Map([
      ["env", lease("acct-a-1111")],
      ["env-2", lease("acct-c-3333")],
    ]),
    held: [
      { slotName: "env", accountId: "acct-a-1111" },
      { slotName: "env-2", accountId: "acct-b-2222" },
    ],
  })

  expect(switches).toEqual([{ slotName: "env-2", from: "acct-b-2222", to: lease("acct-c-3333") }])
})

// Cache entries for slots this process does not run (a previous launch with CAP_SENPI_SLOTS=4, now
// 1) are ignored rather than adopted: there is no keeper and no environment variable to publish
// them into, so acting on one would book an account nothing can spend.
test("cache entries for slots this process does not run are ignored", () => {
  expect(
    detectExternalSwitches({
      cached: new Map([
        ["env", lease("acct-same-2222")],
        ["env-4", lease("acct-orphan-9999")],
      ]),
      held: [{ slotName: "env", accountId: "acct-same-2222" }],
    }),
  ).toEqual([])
})

// The notice names BOTH ends because the operator's question on seeing it is "off what, onto what".
// Eight characters is what the panel shows in its id column, so the two surfaces agree.
test("the notice names the account left and the account taken, at panel width", () => {
  const message = externalSwitchNotice({
    slotName: "env",
    from: "eaaa1a79-1111-2222-3333-444455556666",
    to: lease("af008f89-aaaa-bbbb-cccc-ddddeeeeffff"),
  })

  expect(message).toContain("eaaa1a79")
  expect(message).toContain("af008f89")
  // Never the full uuid: the panel identifies an account by its 8-char prefix and a 36-char id in a
  // toast is noise the operator cannot match against anything on screen.
  expect(message).not.toContain("eaaa1a79-1111")
})

// K>1 makes "which slot" load-bearing: the same notice text for two slots would leave the operator
// unable to tell whether the account they were watching is the one that moved.
test("the notice names the slot when there is more than one", () => {
  expect(externalSwitchNotice({ slotName: "env-2", from: "aaaaaaaa", to: lease("bbbbbbbb") })).toContain("env-2")
})
