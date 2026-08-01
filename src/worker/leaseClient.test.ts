import { expect, test } from "bun:test"
import { CLOUD_ROUTES } from "../cloud/protocol.ts"
import { LEASE_BACKOFF_BASE_MS, LEASE_BACKOFF_CAP_MS } from "../constants.ts"
import { createLeaseClient } from "./leaseClient.ts"

const MASTER = "https://master.internal:8443"
const WORKER_ID = "worker-01"

type Call = { url: string; init: RequestInit }

// Every test injects its own fetch: this module must never reach a real socket, and the
// recorded calls are what the assertions below are actually about (route, headers, body).
function fakeFetch(handler: (attempt: number) => Promise<Response>): { impl: typeof fetch; calls: Call[] } {
  const calls: Call[] = []
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} })
    return handler(calls.length - 1)
  }) as unknown as typeof fetch
  return { impl, calls }
}

// Backoff is asserted by RECORDING every delay rather than by measuring elapsed time —
// a wall-clock assertion would be both slow (10+ minutes here) and flaky.
function sleepRecorder(): { delays: number[]; sleep: (ms: number) => Promise<void> } {
  const delays: number[] = []
  return {
    delays,
    sleep: async (ms: number) => {
      delays.push(ms)
    },
  }
}

function headersOf(call: Call): Record<string, string> {
  return call.init.headers as Record<string, string>
}

function bodyOf(call: Call): unknown {
  return JSON.parse(String(call.init.body))
}

test("lease sends no Authorization header and parses 200 body", async () => {
  // Given: the master answers one well-formed lease
  const lease = { accountId: "acct-7", access: "sk-ant-oat01-leased", expiresAt: 1_900_000_000_000 }
  const { impl, calls } = fakeFetch(async () => new Response(JSON.stringify(lease), { status: 200 }))
  const { delays, sleep } = sleepRecorder()
  const client = createLeaseClient({ fetchImpl: impl, sleep, masterUrl: MASTER, workerId: WORKER_ID })

  // When: the worker leases because the account it was using just hit a limit
  const out = await client.lease({ reason: "ratelimit", currentAccountId: "acct-spent" })

  // Then: the parsed lease comes back, and the request carried no bearer credential + the spent id
  expect(out).toEqual({ ok: true, lease })
  expect(calls).toHaveLength(1)
  expect(calls[0].url).toBe(`${MASTER}${CLOUD_ROUTES.lease}`)
  expect(calls[0].init.method).toBe("POST")
  expect(headersOf(calls[0]).Authorization).toBeUndefined()
  expect(headersOf(calls[0])["Content-Type"]).toBe("application/json")
  expect(bodyOf(calls[0])).toEqual({ workerId: WORKER_ID, reason: "ratelimit", currentAccountId: "acct-spent" })
  // A success must never sleep — backoff is for faults only.
  expect(delays).toEqual([])
})

test("maps 401 to bad-response and does not retry", async () => {
  // Given: the master rejects this request for a reason it does not special-case
  const { impl, calls } = fakeFetch(async () => new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }))
  const { delays, sleep } = sleepRecorder()
  const client = createLeaseClient({ fetchImpl: impl, sleep, masterUrl: MASTER, workerId: WORKER_ID })

  // When
  const out = await client.lease({ reason: "prelease" })

  // Then: a decisive answer — surfaced as a generic bad response, with NO retry
  expect(out).toEqual({ ok: false, failure: { kind: "bad-response", detail: expect.stringContaining("401") } })
  expect(calls).toHaveLength(1)
  expect(delays).toEqual([])
})

test("maps 503 to typed no-account error", async () => {
  // Given: the master has no account left to hand out
  const { impl, calls } = fakeFetch(async () => new Response(JSON.stringify({ error: "pool exhausted" }), { status: 503 }))
  const { delays, sleep } = sleepRecorder()
  const client = createLeaseClient({ fetchImpl: impl, sleep, masterUrl: MASTER, workerId: WORKER_ID })

  // When
  const out = await client.lease({ reason: "ratelimit", currentAccountId: "acct-spent" })

  // Then: distinct from a transport fault, and NOT retried — 503 here is an answer, not a
  // symptom, so hammering it would only delay the caller's own fallback.
  expect(out).toEqual({ ok: false, failure: { kind: "no-account" } })
  expect(calls).toHaveLength(1)
  expect(delays).toEqual([])
})

test("retries with exponential backoff up to cap then surfaces typed failure", async () => {
  // Given: the master is down — alternating transport faults and 5xx, the two transient classes
  const { impl, calls } = fakeFetch(async (attempt) => {
    if (attempt % 2 === 0) throw new Error(`ECONNREFUSED#${attempt}`)
    return new Response("upstream boom", { status: 500 })
  })
  const { delays, sleep } = sleepRecorder()
  const client = createLeaseClient({ fetchImpl: impl, sleep, masterUrl: MASTER, workerId: WORKER_ID })

  // When
  const out = await client.lease({ reason: "prelease" })

  // Then: doubling from the base, clamped at the cap (5000*2^6 = 320000 would overshoot),
  // and one fewer sleep than attempts — the last failure is reported, not slept on.
  expect(delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000])
  expect(delays[0]).toBe(LEASE_BACKOFF_BASE_MS)
  expect(delays[delays.length - 1]).toBe(LEASE_BACKOFF_CAP_MS)
  expect(calls).toHaveLength(delays.length + 1)
  expect(out).toEqual({ ok: false, failure: { kind: "unreachable", detail: expect.stringContaining("500") } })
})

test("ratelimit report posts diagnostic headers", async () => {
  // Given: the quota headers the plugin scraped off the limit response
  const quota = {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": "1787903707",
  }
  const report = { accountId: "acct-spent", headers: quota, resetsAt: 1_787_903_707_000 }
  const accepted = fakeFetch(async () => new Response(null, { status: 204 }))
  const { sleep } = sleepRecorder()
  const base = { sleep, masterUrl: MASTER, workerId: WORKER_ID }

  // When
  const ok = await createLeaseClient({ ...base, fetchImpl: accepted.impl }).reportRateLimit(report)

  // Then: raw headers reach the master verbatim — it, not the worker, owns the interpreting
  expect(ok).toBe(true)
  expect(accepted.calls[0].url).toBe(`${MASTER}${CLOUD_ROUTES.ratelimit}`)
  expect(headersOf(accepted.calls[0]).Authorization).toBeUndefined()
  expect(bodyOf(accepted.calls[0])).toEqual({ workerId: WORKER_ID, ...report })

  // Best-effort telemetry: a rejecting master and a dead socket both answer false without
  // throwing and without retrying, so the caller's recovery path is never blocked by it.
  const rejected = fakeFetch(async () => new Response("nope", { status: 500 }))
  expect(await createLeaseClient({ ...base, fetchImpl: rejected.impl }).reportRateLimit(report)).toBe(false)
  expect(rejected.calls).toHaveLength(1)

  const dead = fakeFetch(async () => {
    throw new Error("ECONNRESET")
  })
  expect(await createLeaseClient({ ...base, fetchImpl: dead.impl }).reportRateLimit(report)).toBe(false)
  expect(dead.calls).toHaveLength(1)
})

test("lease carries the named prefix and maps 409 to a typed refusal", async () => {
  // Given: the master refuses the account the operator named because it is spent
  const { impl, calls } = fakeFetch(
    async () => new Response('{"error":"account is rate-limited","refused":"cooling"}', { status: 409 }),
  )
  const { delays, sleep } = sleepRecorder()
  const client = createLeaseClient({ fetchImpl: impl, sleep, masterUrl: MASTER, workerId: WORKER_ID })

  // When: the panel asks for that one account, with a single attempt because a human is watching
  const out = await client.lease({ reason: "prelease", preferredAccountIdPrefix: "eaaa1a79", attempts: 1 })

  // Then: the reason survives the wire as a value the caller can turn into ONE precise sentence.
  // Collapsing it into `bad-response` would tell the operator the pool is broken when the truth is
  // "that account is busy, pick another".
  expect(out).toEqual({ ok: false, failure: { kind: "refused", refused: "cooling" } })
  // The prefix went out as sent — never expanded, never replaced by a full id the panel never saw.
  expect(bodyOf(calls[0])).toEqual({ workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "eaaa1a79" })
  // TERMINAL: a 409 says this exact request can never succeed, so retrying it would only make the
  // operator wait out a backoff ladder for an answer already given.
  expect(calls).toHaveLength(1)
  expect(delays).toEqual([])
})

test("a 409 without a recognisable reason degrades to bad-response rather than a guess", async () => {
  // Given: a master that refused but did not say why (a version mismatch, say)
  const { impl } = fakeFetch(async () => new Response('{"error":"nope"}', { status: 409 }))
  const { sleep } = sleepRecorder()
  const client = createLeaseClient({ fetchImpl: impl, sleep, masterUrl: MASTER, workerId: WORKER_ID })

  // When
  const out = await client.lease({ reason: "prelease", preferredAccountIdPrefix: "acct-x", attempts: 1 })

  // Then: NOT a fabricated reason. The reason is the remedy the operator acts on, so inventing one
  // would send them to re-login for an account that is merely cooling.
  expect(out).toEqual({ ok: false, failure: { kind: "bad-response", detail: expect.stringContaining("409") } })
})

test("attempts caps the retry ladder for interactive callers", async () => {
  // Given: a master that is simply down
  const { impl, calls } = fakeFetch(async () => {
    throw new Error("ECONNREFUSED")
  })
  const { delays, sleep } = sleepRecorder()
  const client = createLeaseClient({ fetchImpl: impl, sleep, masterUrl: MASTER, workerId: WORKER_ID })

  // When: the panel's switch asks once
  const out = await client.lease({ reason: "prelease", preferredAccountIdPrefix: "acct-a", attempts: 1 })

  // Then: one request, NO sleep, immediate verdict. The default ladder spends over ten minutes before
  // answering — correct for the background renewal loop, unusable for an operator who just pressed
  // enter and is waiting for a toast.
  expect(calls).toHaveLength(1)
  expect(delays).toEqual([])
  expect(out).toEqual({ ok: false, failure: { kind: "unreachable", detail: expect.stringContaining("ECONNREFUSED") } })
})
