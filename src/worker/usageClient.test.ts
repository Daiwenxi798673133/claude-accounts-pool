import { expect, test } from "bun:test"
import { createUsageClient, parseUsageSnapshotView, usageFailureMessage } from "./usageClient.ts"

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

// THE FORWARD-COMPATIBILITY GATE, and the reason a holder-tracking master can be rolled out while
// every worker still runs the old build. This parser IS what is deployed on those workers: it picks
// the fields it knows and constructs from them, so a field added to the payload later is dropped
// rather than treated as schema-invalid — and schema-invalid is not a soft failure here, it takes the
// whole snapshot down to a "无法识别的响应" toast and leaves the panel with nothing to draw.
//
// `holders` used to be the field that made this concrete; it has a rule of its own now, so the
// assertion stands on an arbitrary unknown key instead — as its original note said, what must hold
// is the RULE, not this one field's luck.
test("parseUsageSnapshotView tolerates fields a newer master added, dropping them", () => {
  const fromNewerMaster = {
    ...validView,
    accounts: [{ ...validView.accounts[0], somethingNotInventedYet: 42 }],
  }

  const parsed = parseUsageSnapshotView(fromNewerMaster)

  expect(parsed).toBeDefined()
  expect(parsed?.accounts.length).toBe(1)
  // Dropped, NOT carried through: this parser has no rule for the field, and passing an unvalidated
  // value into a view the dialog trusts is the one thing parse-don't-validate exists to prevent.
  expect((parsed?.accounts[0] as Record<string, unknown>).somethingNotInventedYet).toBeUndefined()
  // The fields it DOES know still land, so tolerating the unknown one cost nothing.
  expect(parsed?.accounts[0].idPrefix).toBe("eaaa1a79")
  expect(parsed?.accounts[0].windows[0].utilization).toBe(32)
})

test("parseUsageSnapshotView carries holders through", () => {
  const withHolders = {
    ...validView,
    accounts: [{ ...validView.accounts[0], holders: ["laptop-1", "mba-m2"] }],
  }
  expect(parseUsageSnapshotView(withHolders)?.accounts[0].holders).toEqual(["laptop-1", "mba-m2"])
})

// THE DISTINCTION THE FIELD EXISTS FOR. A master predating holder tracking sends no `holders` at
// all, which is not the same fact as "nobody holds this" — defaulting to `[]` here would report a
// count that master never computed, and the panel keys its 在用 summary off exactly this difference.
test("parseUsageSnapshotView keeps an absent holders absent, never []", () => {
  const parsed = parseUsageSnapshotView(validView)
  expect(parsed?.accounts[0].holders).toBeUndefined()
  expect(parsed?.accounts[0]).not.toHaveProperty("holders")
})

// THE REGRESSION THIS FILE EXISTS TO CATCH, and it escaped once: this parser REBUILDS the row field
// by field, so `pinnedBy` shipped end-to-end — master, wire, dashboard — while the panel still saw
// `undefined` on every row, because nothing here copied it. A field added to UsageAccountView needs a
// line in the constructed object AND a case here, or it silently stops at this boundary.
test("parseUsageSnapshotView carries pinnedBy through, and keeps an absent one absent", () => {
  const withPins = {
    ...validView,
    accounts: [{ ...validView.accounts[0], holders: ["laptop-1", "mba-m2"], pinnedBy: ["mba-m2"] }],
  }
  expect(parseUsageSnapshotView(withPins)?.accounts[0].pinnedBy).toEqual(["mba-m2"])

  // A master predating pins sends none, which is not "nobody pinned it" — the panel and the page both
  // render the two the same way, but only one of them is a fact this master computed.
  const parsed = parseUsageSnapshotView(validView)
  expect(parsed?.accounts[0].pinnedBy).toBeUndefined()
  expect(parsed?.accounts[0]).not.toHaveProperty("pinnedBy")
})

test("parseUsageSnapshotView rejects a malformed pinnedBy", () => {
  for (const pinnedBy of ["laptop-1", 42, [1, 2], ["ok", 7], {}]) {
    const bad = { ...validView, accounts: [{ ...validView.accounts[0], pinnedBy }] }
    expect(parseUsageSnapshotView(bad)).toBeUndefined()
  }
  const empty = { ...validView, accounts: [{ ...validView.accounts[0], pinnedBy: [] }] }
  expect(parseUsageSnapshotView(empty)?.accounts[0].pinnedBy).toEqual([])
})

// Same strictness as `windows`: a half-readable roster rendered as if complete would understate who
// is on that account, and holder count is now a selection input, not decoration.
test("parseUsageSnapshotView rejects a malformed holders", () => {
  for (const holders of ["laptop-1", 42, [1, 2], ["ok", 7], {}]) {
    const bad = { ...validView, accounts: [{ ...validView.accounts[0], holders }] }
    expect(parseUsageSnapshotView(bad)).toBeUndefined()
  }
  // An empty list is VALID and means nobody — that is the whole point of it not being absent.
  const empty = { ...validView, accounts: [{ ...validView.accounts[0], holders: [] }] }
  expect(parseUsageSnapshotView(empty)?.accounts[0].holders).toEqual([])
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

// THE WORDING LIVES WITH THE UNION so both panels say the same thing. The opencode dialog and the
// senpi /usage panel are two front-ends over one transport, and a machine's operator may well use
// both — the same fault answering with two different Chinese sentences reads as two different bugs.
test("every usage failure kind has a message", () => {
  expect(usageFailureMessage({ kind: "unreachable", detail: "boom" })).toContain("连不上")
  expect(usageFailureMessage({ kind: "http", detail: "HTTP 500" })).toContain("稍后重试")
  expect(usageFailureMessage({ kind: "bad-response", detail: "junk" })).toContain("无法识别")
})

// NOT PHRASED AS AN ERROR: the master's refresh throttle exists because a forced sweep calls
// Anthropic once per account, so a 429 means the guard is working. The countdown is what makes that
// legible — without it a throttled refresh reads as a broken refresh key.
test("a throttled refresh reports the countdown when the master sent one", () => {
  expect(usageFailureMessage({ kind: "throttled", retryAfterMs: 12_000 })).toContain("12")
  // Rounded UP: telling the operator to wait 12 seconds when 12.4 remain sends them back too early.
  expect(usageFailureMessage({ kind: "throttled", retryAfterMs: 11_200 })).toContain("12")
  // A throttle we cannot put a number on is still a throttle, and must not claim "0 秒".
  expect(usageFailureMessage({ kind: "throttled" })).not.toContain("0 秒")
})
