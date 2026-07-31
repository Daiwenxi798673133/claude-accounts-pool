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

// The `r` key's transport. A recording fake, not fetchReturning, because the POST-ness of the request
// is itself load-bearing: the master answers a GET on this route with 405 precisely so a pasted link
// cannot provoke a real sweep, so a client that forgot the method would never refresh at all.
function fetchRecording(status: number, body: string): { impl: typeof fetch; calls: Array<{ url: string; method?: string }> } {
  const calls: Array<{ url: string; method?: string }> = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), method: init?.method })
    return new Response(body, { status })
  }) as unknown as typeof fetch
  return { impl, calls }
}

test("refreshSnapshot POSTs the refresh route and returns the fresh snapshot", async () => {
  const { impl, calls } = fetchRecording(200, JSON.stringify(validView))
  const client = createUsageClient({ fetchImpl: impl, masterUrl: "http://m:8787/" })

  const outcome = await client.refreshSnapshot()

  expect(outcome.ok).toBe(true)
  if (outcome.ok) expect(outcome.view.accounts[0].idPrefix).toBe("eaaa1a79")
  // The trailing slash on masterUrl must not double up: CLOUD_ROUTES paths are absolute.
  expect(calls).toEqual([{ url: "http://m:8787/v1/usage/refresh", method: "POST" }])
})

test("refreshSnapshot reports throttled with the master's wait, not a failure", async () => {
  const { impl } = fetchRecording(429, '{"error":"refresh throttled","retryAfterMs":21000}')
  const client = createUsageClient({ fetchImpl: impl, masterUrl: "http://m:8787" })

  const outcome = await client.refreshSnapshot()

  // A 429 here is the master's throttle working as designed — the guard exists because a forced sweep
  // calls Anthropic once per account and its 429 is charged to the master's egress IP, i.e. to every
  // account at once. Reporting it as `http` would tell the operator the pool is broken.
  expect(outcome).toEqual({ ok: false, failure: { kind: "throttled", retryAfterMs: 21_000 } })
})

test("refreshSnapshot still reports throttled when the master sent no usable wait", async () => {
  const { impl } = fetchRecording(429, "throttled")
  const client = createUsageClient({ fetchImpl: impl, masterUrl: "http://m:8787" })

  const outcome = await client.refreshSnapshot()

  // Read leniently, unlike every other body in this module: a throttle we cannot put a countdown on
  // is still a throttle, and refusing it would report "unrecognised data" for the one case where the
  // master is behaving correctly. The field is ABSENT rather than zero, so the message can degrade to
  // "稍后再试" instead of promising "0 秒".
  expect(outcome).toEqual({ ok: false, failure: { kind: "throttled" } })
})

test("refreshSnapshot rejects a 200 whose body is not a snapshot", async () => {
  const { impl } = fetchRecording(200, '{"at":1,"stale":false}')
  const client = createUsageClient({ fetchImpl: impl, masterUrl: "http://m:8787" })

  // The refresh path runs through the SAME schema check as the read path — the dialog trusts these
  // fields, and a sweep does not make a malformed payload safe to render.
  const outcome = await client.refreshSnapshot()
  expect(outcome.ok).toBe(false)
  if (!outcome.ok) expect(outcome.failure.kind).toBe("bad-response")
})
