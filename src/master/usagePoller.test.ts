import { expect, test } from "bun:test"
import type { StoredAccount } from "../accounts.ts"
import type { UsageResponse } from "../usage.ts"
import type { UsageSnapshotEntry } from "./scheduler.ts"
import { installUsagePoller, USAGE_POLL_429_COOLDOWN_MS, USAGE_POLL_INITIAL_DELAY_MS, USAGE_POLL_SPACING_MS } from "./usagePoller.ts"

// Zero network: `fetchUsageFor` is injected and has NO default, so a test that forgot to supply it
// is a compile error rather than a live request at `/api/oauth/usage` — an endpoint with known
// PERSISTENT-429 behaviour, i.e. one stray burst degrades the real master's ranking for minutes.

const NOW = 1_800_000_000_000

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// Legacy-shaped (no `provider`), so a hand-rolled `provider === "anthropic"` filter cannot pass.
function account(id: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return { id, label: id, refresh: `refresh-${id}`, ...extra }
}

function usage(utilization: number): UsageResponse {
  return { five_hour: { utilization } }
}

// VERBATIM the message src/usage.ts's fetchUsage throws for a non-ok response
// (`usage request failed (${res.status})`). That string IS the contract this poller reads the
// status out of, so pinning it here means a change on that side fails this test instead of
// silently disabling the cooldown.
const usageError = (status: number): Error => new Error(`usage request failed (${status})`)

test("polls accounts serially with inter-account delay", async () => {
  const trace: string[] = []
  let inflight = 0
  let maxInflight = 0
  const accounts = [account("a"), account("b"), account("c")]

  const poller = installUsagePoller({
    loadAccounts: async () => accounts,
    fetchUsageFor: async (target: StoredAccount) => {
      inflight++
      maxInflight = Math.max(maxInflight, inflight)
      trace.push(`fetch:${target.id}`)
      await tick()
      trace.push(`done:${target.id}`)
      inflight--
      return usage(10)
    },
    scheduler: {
      setUsageCache: () => {
        trace.push("cache")
      },
    },
    sleep: async (ms: number) => {
      trace.push(`sleep:${ms}`)
    },
    now: () => NOW,
  })

  await poller.tickOnce()
  poller.dispose()

  // Serial, with spacing BETWEEN accounts and none trailing the last one. Parallelising the sweep
  // would put the whole roster's requests on one egress IP inside one instant, which is precisely
  // how this endpoint is provoked into the persistent 429 the cooldown below then has to ride out.
  expect(maxInflight).toBe(1)
  expect(trace).toEqual([
    "fetch:a",
    "done:a",
    `sleep:${USAGE_POLL_SPACING_MS}`,
    "fetch:b",
    "done:b",
    `sleep:${USAGE_POLL_SPACING_MS}`,
    "fetch:c",
    "done:c",
    // ONE snapshot handed to the scheduler at the END of the sweep, never one per account: a
    // half-swept cache would rank the roster on a mix of fresh and missing entries.
    "cache",
  ])
})

test("applies per-account 429 cooldown and skips cooled accounts", async () => {
  const attempts: string[] = []
  const snapshots: UsageSnapshotEntry[][] = []
  let clock = NOW
  const accounts = [account("a"), account("b")]

  const poller = installUsagePoller({
    loadAccounts: async () => accounts,
    fetchUsageFor: async (target: StoredAccount) => {
      attempts.push(target.id)
      if (target.id === "a") throw usageError(429)
      return usage(20)
    },
    scheduler: {
      setUsageCache: (entries: UsageSnapshotEntry[]) => snapshots.push(entries),
    },
    sleep: async () => {},
    now: () => clock,
  })

  await poller.tickOnce()
  // `a`'s 429 does not stop the sweep: `b` is still polled and still reported.
  expect(attempts).toEqual(["a", "b"])
  expect(snapshots.at(-1)).toEqual([{ id: "b", usage: usage(20) }])

  await poller.tickOnce()
  // `a` is SKIPPED — the cooldown is per-account, so `b` keeps its normal cadence. The usage
  // endpoint stays angry well past the request that upset it, so retrying `a` now makes it worse.
  expect(attempts).toEqual(["a", "b", "b"])

  clock += USAGE_POLL_429_COOLDOWN_MS + 1
  await poller.tickOnce()
  // Cooldown lapsed ⇒ `a` rejoins the sweep in its original position. A cooldown that never
  // expired would exile the account from every future ranking.
  expect(attempts).toEqual(["a", "b", "b", "a", "b"])

  poller.dispose()
})

// ---- ACCEPTANCE CRITERION (issue #37): the dashboard must not be blind after a restart ---------
test("sweeps shortly after install instead of one whole interval later", async () => {
  const fetched: string[] = []
  const poller = installUsagePoller({
    loadAccounts: async () => [account("a")],
    fetchUsageFor: async (target: StoredAccount) => {
      fetched.push(target.id)
      return usage(7)
    },
    scheduler: { setUsageCache: () => {} },
    sleep: async () => {},
    now: () => NOW,
  })

  try {
    // A bare setInterval left the first sweep MASTER_USAGE_POLL_INTERVAL_MS away, so every restart
    // spent five minutes serving a dashboard reading 本轮无数据 for every account.
    expect(USAGE_POLL_INITIAL_DELAY_MS).toBeLessThan(10_000)
    await new Promise((resolve) => setTimeout(resolve, USAGE_POLL_INITIAL_DELAY_MS + 50))
    expect(fetched).toEqual(["a"])
  } finally {
    poller.dispose()
  }
})

test("never polls an account whose chain is known dead", async () => {
  const fetched: string[] = []
  const accounts = [account("a"), account("dead", { needsReauth: true })]

  const poller = installUsagePoller({
    loadAccounts: async () => accounts,
    fetchUsageFor: async (target: StoredAccount) => {
      fetched.push(target.id)
      return usage(11)
    },
    scheduler: { setUsageCache: () => {} },
    sleep: async () => {},
    now: () => NOW,
  })

  await poller.tickOnce()
  poller.dispose()

  // Every fetch here goes through the refresher, so polling a dead chain buys a guaranteed refresh
  // failure and no snapshot entry — while costing a POST at an endpoint that punishes this host's
  // whole pool by IP. The dashboard states their case from the flag instead.
  expect(fetched).toEqual(["a"])
})

test("feeds scheduler usage cache", async () => {
  const fetched: string[] = []
  const snapshots: UsageSnapshotEntry[][] = []
  const accounts = [
    account("a"),
    account("b"), // fails with a 500 — a transient fault, not a rate limit
    // A ChatGPT record: `/api/oauth/usage` is Anthropic's, and the scheduler's pool is
    // anthropic-only (INV-M1), so this must never be handed to the fetcher at all.
    account("z", { provider: "openai" }),
  ]

  const poller = installUsagePoller({
    loadAccounts: async () => accounts,
    fetchUsageFor: async (target: StoredAccount) => {
      fetched.push(target.id)
      if (target.id === "b") throw usageError(500)
      return usage(42)
    },
    scheduler: {
      setUsageCache: (entries: UsageSnapshotEntry[]) => snapshots.push(entries),
    },
    sleep: async () => {},
    now: () => NOW,
  })

  await poller.tickOnce()

  expect(fetched).toEqual(["a", "b"])
  expect(snapshots.length).toBe(1)
  // ONLY successfully-fetched entries. A failed fetch must NEVER arrive as zero utilization: the
  // scheduler ranks by lowest utilization, so a broken account reported as 0% would look like the
  // emptiest one in the pool and attract every single lease. Absent instead scores +Infinity —
  // the honest unknown, which sorts last.
  expect(snapshots[0]).toEqual([{ id: "a", usage: usage(42) }])

  poller.dispose()
  await poller.tickOnce()
  // dispose() must stop a later tick from mutating anything — no extra fetch, no stale snapshot
  // overwriting the scheduler's cache after the master has moved on.
  expect(fetched).toEqual(["a", "b"])
  expect(snapshots.length).toBe(1)
})
