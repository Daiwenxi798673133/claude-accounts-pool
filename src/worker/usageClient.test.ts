import { expect, test } from "bun:test"
import { createUsageClient, parseUsageSnapshotView } from "./usageClient.ts"

const validView = {
  at: 1785500000000,
  stale: false,
  accounts: [
    {
      idPrefix: "eaaa1a79",
      label: "vince.dai3@potentia.ai",
      windows: [
        { label: "five_hour", utilization: 32, resetsAt: "2026-07-31T07:30:00Z" },
        { label: "seven_day", utilization: 3 },
      ],
      hasUsage: true,
      coolingDown: false,
      excluded: false,
      needsReauth: false,
      expiresAt: 1785503606003,
    },
  ],
}

// Bun's global Response satisfies the fetch return type; the cast keeps the fake to the one method
// createUsageClient actually calls without fabricating fetch's static surface (preconnect, etc.).
function fetchReturning(status: number, body: string): typeof fetch {
  return (async () => new Response(body, { status })) as unknown as typeof fetch
}
function fetchThrowing(): typeof fetch {
  return (async () => {
    throw new Error("ECONNREFUSED")
  }) as unknown as typeof fetch
}

test("parseUsageSnapshotView accepts a well-formed snapshot", () => {
  const parsed = parseUsageSnapshotView(validView)
  expect(parsed).toBeDefined()
  expect(parsed?.accounts.length).toBe(1)
  expect(parsed?.accounts[0].windows[0].utilization).toBe(32)
  expect(parsed?.accounts[0].windows[1].resetsAt).toBeUndefined()
})

test("parseUsageSnapshotView rejects a null or mistyped envelope", () => {
  expect(parseUsageSnapshotView(null)).toBeUndefined()
  expect(parseUsageSnapshotView({ at: "x", stale: false, accounts: [] })).toBeUndefined()
  expect(parseUsageSnapshotView({ at: 1, stale: "no", accounts: [] })).toBeUndefined()
  expect(parseUsageSnapshotView({ at: 1, stale: false, accounts: "nope" })).toBeUndefined()
})

test("parseUsageSnapshotView rejects an account with a malformed window", () => {
  const bad = {
    ...validView,
    accounts: [{ ...validView.accounts[0], windows: [{ label: "five_hour", utilization: "high" }] }],
  }
  expect(parseUsageSnapshotView(bad)).toBeUndefined()
})

test("parseUsageSnapshotView rejects an account missing a boolean flag", () => {
  const account = { ...validView.accounts[0] } as Record<string, unknown>
  delete account.coolingDown
  expect(parseUsageSnapshotView({ ...validView, accounts: [account] })).toBeUndefined()
})

test("fetchSnapshot returns ok on a valid 200", async () => {
  const client = createUsageClient({ fetchImpl: fetchReturning(200, JSON.stringify(validView)), masterUrl: "http://m:8787/" })
  const outcome = await client.fetchSnapshot()
  expect(outcome.ok).toBe(true)
  if (outcome.ok) expect(outcome.view.accounts[0].label).toBe("vince.dai3@potentia.ai")
})

test("fetchSnapshot reports unreachable when the transport throws", async () => {
  const client = createUsageClient({ fetchImpl: fetchThrowing(), masterUrl: "http://m:8787" })
  const outcome = await client.fetchSnapshot()
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect(outcome.failure.kind).toBe("unreachable")
})

test("fetchSnapshot reports http on a non-2xx answer", async () => {
  const client = createUsageClient({ fetchImpl: fetchReturning(503, '{"error":"x"}'), masterUrl: "http://m:8787" })
  const outcome = await client.fetchSnapshot()
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect(outcome.failure.kind).toBe("http")
})

test("fetchSnapshot reports bad-response on an unparseable body", async () => {
  const client = createUsageClient({ fetchImpl: fetchReturning(200, "not json"), masterUrl: "http://m:8787" })
  const outcome = await client.fetchSnapshot()
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect(outcome.failure.kind).toBe("bad-response")
})

test("fetchSnapshot reports bad-response on a schema-invalid body", async () => {
  const client = createUsageClient({ fetchImpl: fetchReturning(200, '{"at":1,"stale":false}'), masterUrl: "http://m:8787" })
  const outcome = await client.fetchSnapshot()
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect(outcome.failure.kind).toBe("bad-response")
})
