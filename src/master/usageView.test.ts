import { expect, test } from "bun:test"
import type { StoredAccount } from "../accounts.ts"
import type { UsageResponse } from "../usage.ts"
import type { UsageSnapshot } from "./scheduler.ts"
import { buildUsageView } from "./usageView.ts"

// A full-shaped record on purpose: `access` and `refresh` are populated with values that would be
// unmistakable in the output, so the "no token ever leaves here" claim below is a real measurement
// rather than a fixture that happened to have nothing to leak.
function account(id: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return {
    id,
    label: `${id}@example.test`,
    refresh: `sk-ant-ort01-${id}`,
    access: `sk-ant-oat01-${id}`,
    expires: 1_900_000_000_000,
    ...extra,
  }
}

function snapshot(entries: Array<[string, UsageResponse]>, extra?: Partial<UsageSnapshot>): UsageSnapshot {
  return { at: 1_700_000_000_000, stale: false, byId: new Map(entries), ...extra }
}

const never = (): boolean => false
const unheld = (): string[] => []

test("joins roster, snapshot and cooldown into one anthropic-only view", () => {
  const view = buildUsageView({
    accounts: [
      account("aaaaaaaa-1111-2222-3333-444444444444"),
      // A ChatGPT record: `/api/oauth/usage` is Anthropic's endpoint, so this account can never have
      // a snapshot entry and would render as a permanently unknown row. It has NO `provider` twin in
      // this fixture by accident — the legacy-shaped record above is what providerOf must still read
      // as anthropic, so a hand-rolled `provider === "anthropic"` filter fails this case both ways.
      account("cccccccc-9999-9999-9999-999999999999", { provider: "openai" }),
    ],
    snapshot: snapshot([
      [
        "aaaaaaaa-1111-2222-3333-444444444444",
        {
          five_hour: { utilization: 12.5, resets_at: "2026-08-01T00:00:00Z" },
          seven_day: { utilization: 61 },
          seven_day_opus: null,
          scoped: [{ label: "Fable", utilization: 100, resets_at: "2026-08-05T00:00:00Z" }],
        },
      ],
      // An entry for the openai account, which must STILL not produce a row: filtering on the
      // roster's provider rather than on the snapshot's keys is what keeps the pool honest.
      ["cccccccc-9999-9999-9999-999999999999", { five_hour: { utilization: 3 } }],
    ]),
    isCoolingDown: never,
    holdersOf: unheld,
  })

  expect(view.at).toBe(1_700_000_000_000)
  expect(view.stale).toBe(false)
  expect(view.accounts).toHaveLength(1)

  const [row] = view.accounts
  // A PREFIX, never the whole id — enough to correlate with a `master:lease-served` log line.
  expect(row.idPrefix).toBe("aaaaaaaa")
  expect(row.label).toBe("aaaaaaaa-1111-2222-3333-444444444444@example.test")
  expect(row.hasUsage).toBe(true)
  expect(row.expiresAt).toBe(1_900_000_000_000)
  expect(row.coolingDown).toBe(false)
  expect(row.needsReauth).toBe(false)
  expect(row.excluded).toBe(false)

  // The dynamic per-model weekly window rides along with its own label, and the null window is
  // DROPPED rather than emitted as 0% — a synthetic zero row would read as the emptiest bar on the
  // page for a window the account does not even have.
  expect(row.windows).toEqual([
    { label: "five_hour", utilization: 12.5, resetsAt: "2026-08-01T00:00:00Z" },
    { label: "seven_day", utilization: 61 },
    { label: "Fable", utilization: 100, resetsAt: "2026-08-05T00:00:00Z" },
  ])
})

test("a null resets_at from the API is omitted, not forwarded as null", () => {
  // The cast mirrors the ONE at the real boundary: fetchUsage does `(await res.json()) as
  // UsageResponse` with no validation, so `resets_at?: string` is a claim about the payload, not a
  // proof. MEASURED against the live endpoint: a window sitting at 0% really answers
  // `"resets_at": null`, which is why this fixture is not a hypothetical.
  const withNull = { five_hour: { utilization: 0, resets_at: null } } as unknown as UsageResponse

  const view = buildUsageView({
    accounts: [account("zero")],
    snapshot: snapshot([["zero", withNull]]),
    isCoolingDown: never,
    holdersOf: unheld,
  })

  // The KEY IS ABSENT, not present-and-null. UsageWindowView promises "absent or a string", so a
  // forwarded null would break any consumer testing with `in` or `hasOwn` — while still rendering
  // fine in our own page (null is falsy), which is exactly how this would survive unnoticed.
  const [window] = view.accounts[0].windows
  expect(window).toEqual({ label: "five_hour", utilization: 0 })
  expect(Object.hasOwn(window, "resetsAt")).toBe(false)
  expect(JSON.stringify(view)).not.toContain("null")
})

test("an account missing from the snapshot is unknown, never zero", () => {
  const accounts = [account("kept"), account("missing")]
  const view = buildUsageView({
    accounts,
    snapshot: snapshot([["kept", { five_hour: { utilization: 50 } }]]),
    isCoolingDown: never,
    holdersOf: unheld,
  })

  // The poller OMITS accounts whose usage fetch failed (a 429 on /api/oauth/usage lasts minutes), so
  // this is the steady-state case, not an edge one. `hasUsage: false` with NO windows is the honest
  // rendering; a 0%-utilization row would point the operator at the pool's least-known account as
  // though it were its emptiest.
  expect(view.accounts.map((row) => [row.idPrefix, row.hasUsage, row.windows.length])).toEqual([
    ["kept", true, 1],
    ["missing", false, 0],
  ])
})

test("cooldown, reauth and excluded flags come through, and a token never does", () => {
  const view = buildUsageView({
    accounts: [
      account("cool"),
      account("reauth", { needsReauth: true }),
      account("skip", { excluded: true }),
      // No stored expiry: the field is OMITTED rather than sent as 0, which the page would render as
      // a token that expired in 1970.
      account("nodate", { expires: undefined }),
    ],
    // Cooling is the SCHEDULER's verdict, not something re-derived from utilization here: an account
    // can be cooling on a deadline-less rate-limit report while its last snapshot still reads 3%.
    snapshot: snapshot([["cool", { five_hour: { utilization: 3 } }]], { stale: true }),
    isCoolingDown: (accountId) => accountId === "cool",
    holdersOf: unheld,
  })

  expect(view.stale).toBe(true)
  expect(view.accounts.map((row) => row.coolingDown)).toEqual([true, false, false, false])
  expect(view.accounts.map((row) => row.needsReauth)).toEqual([false, true, false, false])
  expect(view.accounts.map((row) => row.excluded)).toEqual([false, false, true, false])
  expect(Object.hasOwn(view.accounts[3], "expiresAt")).toBe(false)

  // 🔴 THE RED LINE, asserted on the SERIALISED payload because that is what actually crosses the
  // wire: no `access`, no `refresh`, no full account id — and the fixtures above deliberately carry
  // recognisable `sk-ant-` values, so this fails loudly the day someone spreads a StoredAccount into
  // a row "just to add one field".
  const wire = JSON.stringify(view)
  expect(wire).not.toContain("sk-ant-")
  expect(wire).not.toContain("access")
  expect(wire).not.toContain("refresh")
})
