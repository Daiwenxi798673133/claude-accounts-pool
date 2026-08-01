import { expect, test } from "bun:test"
import type { AnthropicOauth, StoredAccount } from "../accounts.ts"
import { MASTER_WARM_SPACING_MS, SENTINEL_REFRESH } from "../constants.ts"
import { installMasterKeeper, makeOnboardingCapture } from "./keeper.ts"

// NOT ONE REAL NETWORK CALL AND NOT ONE REAL FILE READ LIVES IN THIS FILE, for the same safety
// reason refresher.test.ts states: a POST at TOKEN_URL CONSUMES a one-time-use refresh token and
// rotates the chain, so a stray request could permanently strand one of the owner's paid accounts.
// The warm loop therefore never refreshes anything itself — it drives the injected refresher, which
// is the system's ONLY refresher — and the onboarding capture reads its tip through an injected
// reader rather than the real auth.json.

const NOW = 1_800_000_000_000 // frozen clock ⇒ every expiry below is exact, not "roughly now"

// A REAL macrotask gap. Any implementation that fired the sweep with Promise.all would interleave
// here, which is exactly what the trace assertions below are built to catch.
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

// No `provider` field on purpose: these are LEGACY-shaped records, the ones providerOf() reads as
// anthropic and a hand-rolled `provider === "anthropic"` filter silently drops.
function account(id: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return { id, label: id, refresh: `refresh-${id}`, ...extra }
}

// ---- ACCEPTANCE CRITERION -----------------------------------------------------------------------
// Two guarantees in one trace, because they are one behaviour: the master has NO single "active
// account" (it runs no inference — the account library is the source of truth), so the sweep covers
// EVERY anthropic account rather than only the inactive ones; and it walks them ONE AT A TIME with
// MASTER_WARM_SPACING_MS between them, because concurrent refreshes of different accounts still
// share this host's egress IP and the token endpoint rate-limits by IP.
test("warm loop refreshes every account serially with spacing through refresher", async () => {
  const trace: string[] = []
  let inflight = 0
  let maxInflight = 0
  const accounts = [
    account("a"),
    // `b` FAILS. One dead chain must never abort the sweep — every account after it still gets
    // warmed, and the spacing around it is unchanged.
    account("b"),
    account("c"),
    // A ChatGPT record. Its refresh token would be POSTed to platform.claude.com by the refresher,
    // whose 400 then falsely brands this healthy account needs-reauth — so it must never be swept.
    account("z", { provider: "openai" }),
  ]

  const keeper = installMasterKeeper({
    refresher: {
      getFreshAccess: async (accountId: string) => {
        inflight++
        maxInflight = Math.max(maxInflight, inflight)
        trace.push(`start:${accountId}`)
        await tick()
        trace.push(`end:${accountId}`)
        inflight--
        if (accountId === "b") throw new Error("refresh token revoked (invalid_grant)")
        return { access: `fresh-${accountId}`, expiresAt: NOW + 900_000 }
      },
    },
    loadAccounts: async () => accounts,
    capture: async () => {
      trace.push("capture")
    },
    // The injected sleep RECORDS instead of waiting: the spacing contract is observable without a
    // single real timer, so this test cannot become the slow one nobody runs.
    sleep: async (ms: number) => {
      trace.push(`sleep:${ms}`)
    },
  })

  await keeper.tickOnce()
  keeper.dispose()

  // Never two refreshes in the air at once. The refresher's single-flight map protects one account
  // from itself; only this serial loop protects the shared IP from the whole roster.
  expect(maxInflight).toBe(1)
  expect(trace).toEqual([
    // Onboarding runs BEFORE the sweep so an account that just landed is warmed in the same tick.
    "capture",
    "start:a",
    "end:a",
    `sleep:${MASTER_WARM_SPACING_MS}`,
    "start:b",
    "end:b",
    `sleep:${MASTER_WARM_SPACING_MS}`,
    "start:c",
    "end:c",
    // No trailing sleep: spacing sits BETWEEN accounts, and `z` was filtered out before the loop,
    // so `c` is the last account and nothing follows it to be spaced from.
  ])
})

test("warm loop skips an account whose chain is already known dead", async () => {
  const warmed: string[] = []
  const keeper = installMasterKeeper({
    refresher: {
      getFreshAccess: async (accountId: string) => {
        warmed.push(accountId)
        return { access: `fresh-${accountId}`, expiresAt: NOW + 900_000 }
      },
    },
    loadAccounts: async () => [account("a"), account("dead", { needsReauth: true })],
    capture: async () => {},
    sleep: async () => {},
  })

  await keeper.tickOnce()
  keeper.dispose()

  // This sweep visits every account every five minutes. Re-POSTing a chain already judged revoked
  // would therefore be a permanent, guaranteed-400 drip at an endpoint that rate-limits by IP —
  // and this host's single IP is what every account in the pool refreshes through.
  expect(warmed).toEqual(["a"])
})

test("onboarding capture stores real refresh and refuses sentinel", async () => {
  // Onboarding: an admin runs `opencode auth login` on the master via the ex-machina PKCE flow,
  // which writes a REAL credential into the master's local auth.json. Capture absorbs it into the
  // account library — and must refuse a lease's sentinel, which is what a WORKER's entry carries.
  const tips: (AnthropicOauth | undefined)[] = [
    { type: "oauth", refresh: "real-refresh", access: "access-1", expires: NOW + 3_600_000 },
    // INV-CLOUD-1. Deliberately given a FUTURE expiry: a live lease looks perfectly fresh, so the
    // sentinel has to be refused on its VALUE, before any freshness test can wave it through.
    { type: "oauth", refresh: SENTINEL_REFRESH, access: "leased-access", expires: NOW + 3_600_000 },
    // Same real chain again — an unchanged tip is not news and must not re-enter the library.
    { type: "oauth", refresh: "real-refresh", access: "access-1", expires: NOW + 3_600_000 },
    // Expired: cannot be verified against the profile endpoint, so it is skipped rather than
    // archived on faith (a later successful use re-freshens auth.json and it is picked up then).
    { type: "oauth", refresh: "stale-refresh", access: "access-2", expires: NOW - 1 },
  ]
  let reads = 0
  const absorbed: number[] = []

  const capture = makeOnboardingCapture({
    readAuthTip: async () => tips[reads++],
    absorb: async () => {
      absorbed.push(reads)
    },
    now: () => NOW,
  })

  await capture()
  // The real chain reached the account library.
  expect(absorbed).toEqual([1])

  await capture()
  await capture()
  await capture()
  // ...and NOTHING else did. A sentinel absorbed here would put a non-token in the library, where
  // it would be POSTed to Anthropic as a refresh forever (branding a healthy account needs-reauth)
  // and would make this master look like it holds a credential it does not have.
  expect(absorbed).toEqual([1])
  expect(reads).toBe(4)
})
