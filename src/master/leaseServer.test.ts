import { expect, test } from "bun:test"
import type { StoredAccount } from "../accounts.ts"
import { LEASE_RENEW_BUFFER_MS, MASTER_MIN_REMAINING_MS } from "../constants.ts"
import { CLOUD_ROUTES } from "../cloud/protocol.ts"
import type { LeaseRequest, LeaseResponse, RateLimitReport, UsageSnapshotView } from "../cloud/protocol.ts"
import { startLeaseServer } from "./leaseServer.ts"
import type { UsageSnapshot } from "./scheduler.ts"

// A REAL Bun.serve on an EPHEMERAL port, driven by REAL fetch. The deliverable here is HTTP
// behaviour (status codes, auth gating, empty-body 204), and a handler invoked directly as a
// function would prove none of it — Bun, not our code, decides how a 204 or a dead socket looks
// on the wire. Port 0 (never a literal) so two checkouts running `bun test` at once cannot
// collide; the assigned port is read back off the server object.
//
// The three collaborators are hand-built stubs, NOT the real modules: the real refresher would
// POST a live refresh token at Anthropic, and the real registry/scheduler drag a kv store in.
// The scheduler stub is a small honest FAKE (a cooled-id set + a filter) rather than a mock
// returning canned answers, because test 5's whole claim is that a report CHANGES the next pick.

const POOL_KEY = "pool-key-under-test"
const WORKER_ID = "worker-1"
// The horizon a worker RECEIVES — deliberately still named EXPIRES_AT, because that is what lands
// in its auth.json and what the cases below assert. Since INV-CLOUD-4 the account's own expiry is a
// DIFFERENT instant, so the fixture is expressed from the horizon BACKWARDS: what the refresher
// reports sits MASTER_MIN_REMAINING_MS later than what the master is willing to advertise. That also
// makes the default fixture distinguishing — a server that echoed the account expiry would answer
// ACCOUNT_EXPIRES_AT here and fail the 200 case below.
const EXPIRES_AT = 1_900_000_000_000
const ACCOUNT_EXPIRES_AT = EXPIRES_AT + MASTER_MIN_REMAINING_MS

const account = (id: string): StoredAccount => ({ id, label: `${id}@example.test`, refresh: `refresh-${id}` })

type Harness = {
  base: string
  stop: () => void
  abort: () => void
  reports: Array<{ accountId: string; resetsAt?: number }>
  refreshed: string[]
  picks: Array<{ ids: string[]; exclude?: string }>
}

function startHarness(options?: {
  accounts?: StoredAccount[]
  cooled?: string[]
  preAborted?: boolean
  accountExpiresAt?: number
  usage?: UsageSnapshot
}): Harness {
  const accounts = options?.accounts ?? [account("acct-a"), account("acct-b")]
  const accountExpiresAt = options?.accountExpiresAt ?? ACCOUNT_EXPIRES_AT
  const cooled = new Set(options?.cooled ?? [])
  // Empty and STALE by default — the shape a master has before its first poll completes. Every
  // lease case below therefore runs against a server whose dashboard data is absent, proving the two
  // concerns share a port without sharing a failure mode.
  const usage: UsageSnapshot = options?.usage ?? { at: 0, stale: true, byId: new Map() }
  const reports: Harness["reports"] = []
  const refreshed: string[] = []
  const picks: Harness["picks"] = []
  const controller = new AbortController()
  if (options?.preAborted) controller.abort()

  const server = startLeaseServer({
    scheduler: {
      pickAccount({ accounts: pool, exclude }) {
        picks.push({ ids: pool.map((a) => a.id), ...(exclude === undefined ? {} : { exclude }) })
        return pool.find((a) => a.id !== exclude && !cooled.has(a.id))
      },
      reportRateLimit(accountId, resetsAt) {
        reports.push({ accountId, ...(resetsAt === undefined ? {} : { resetsAt }) })
        cooled.add(accountId)
      },
      getUsageSnapshot: () => usage,
      // The SAME `cooled` set the pick filter reads, so a dashboard row claiming "冷却中" and an
      // account being skipped by selection can never disagree in this harness.
      isCoolingDown: (accountId) => cooled.has(accountId),
    },
    refresher: {
      async getFreshAccess(accountId) {
        refreshed.push(accountId)
        return { access: `sk-ant-oat01-${accountId}`, expiresAt: accountExpiresAt }
      },
    },
    registry: {
      verify: (header) => (header === `Bearer ${POOL_KEY}` ? WORKER_ID : undefined),
    },
    loadAccounts: async () => accounts,
    // Loopback only — a test must never expose a lease endpoint on a real interface.
    hostname: "127.0.0.1",
    port: 0,
    signal: controller.signal,
  })

  return {
    base: `http://127.0.0.1:${server.port}`,
    stop: server.stop,
    abort: () => controller.abort(),
    reports,
    refreshed,
    picks,
  }
}

function post(base: string, route: string, body: unknown, authorization?: string): Promise<Response> {
  return fetch(`${base}${route}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

const PRELEASE: LeaseRequest = { workerId: WORKER_ID, reason: "prelease" }

test("lease without pool key returns 401", async () => {
  // Given: a running master and a worker that forgot (or never had) a pool key
  const harness = startHarness()
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)

    // Then: refused before anything is decided — the roster was never consulted and no token
    // was minted, so an unauthenticated caller learns nothing about the pool's existence.
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: expect.any(String) })
    expect(harness.picks).toEqual([])
    expect(harness.refreshed).toEqual([])

    // And: the SAME missing credential answers 200 on health. That contrast is the point of the
    // route being unauthenticated — it is a readiness probe a worker calls BEFORE it has been
    // issued a key (and an ops liveness check calls forever), so it may not require one. It
    // therefore also may not leak: no account ids, no worker list, no counts.
    const health = await fetch(`${harness.base}${CLOUD_ROUTES.health}`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
  } finally {
    harness.stop()
  }
})

test("lease with wrong key returns 401", async () => {
  // Given: a revoked/typo'd key that the registry does not recognise
  const harness = startHarness()
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE, "Bearer not-the-pool-key")

    // Then: identical treatment to no key at all — the response must not become an oracle that
    // distinguishes "absent" from "wrong" for someone probing the endpoint.
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: expect.any(String) })
    expect(harness.picks).toEqual([])

    // AUTH IS CHECKED BEFORE THE BODY IS PARSED. Garbage under a bad key must still answer 401,
    // never 400: a 400 here would confirm the key was accepted and turn body-shape errors into a
    // key-guessing oracle. (Asserted inside this case because the six cases are fixed; the two
    // statuses below are one ordering invariant, not two behaviours.)
    const garbageUnauthed = await post(harness.base, CLOUD_ROUTES.lease, "{not json", "Bearer not-the-pool-key")
    expect(garbageUnauthed.status).toBe(401)

    // Past auth, the same garbage is a 400 — a body we cannot parse is the CALLER's fault and
    // must never surface as a 500, which the worker client would retry as a transient fault.
    const garbageAuthed = await post(harness.base, CLOUD_ROUTES.lease, "{not json", `Bearer ${POOL_KEY}`)
    expect(garbageAuthed.status).toBe(400)
    expect(await garbageAuthed.json()).toEqual({ error: expect.any(String) })
    expect(harness.refreshed).toEqual([])
  } finally {
    harness.stop()
  }
})

test("lease with valid key returns 200 with accountId access expiresAt", async () => {
  // Given: a pool with two healthy accounts
  const harness = startHarness()
  try {
    // When: a worker renews the account it already holds, and LIES about who it is in the body
    const res = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: "worker-impersonated", reason: "prelease", currentAccountId: "acct-a" } satisfies LeaseRequest,
      `Bearer ${POOL_KEY}`,
    )

    // Then: exactly the three fields the worker writes into its auth.json, freshly minted for
    // the account the scheduler chose.
    expect(res.status).toBe(200)
    const lease = (await res.json()) as LeaseResponse
    expect(lease).toEqual({ accountId: "acct-a", access: "sk-ant-oat01-acct-a", expiresAt: EXPIRES_AT })
    expect(harness.refreshed).toEqual(["acct-a"])

    // A `prelease` carries NO exclusion EVEN THOUGH the request named a current account: the
    // routine renewal path is allowed — and expected — to hand back the very account the worker
    // already holds. acct-b exists precisely so this is a distinguishing fixture: an
    // implementation that excluded `currentAccountId` regardless of reason would answer acct-b
    // here and rotate the pool on every routine renewal.
    expect(harness.picks).toEqual([{ ids: ["acct-a", "acct-b"] }])

    // The spoofed workerId changed nothing: identity comes from the KEY, and the body is a
    // client-supplied string anyone holding a key could forge.
    expect(lease.accountId).toBe("acct-a")
  } finally {
    harness.stop()
  }
})

test("lease returns 503 when scheduler has no available account", async () => {
  // Given: every account in the roster is already cooling — the roster is NOT empty, so the 503
  // below is the scheduler's verdict rather than an artifact of an unconfigured master.
  const harness = startHarness({ cooled: ["acct-a", "acct-b"] })
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE, `Bearer ${POOL_KEY}`)

    // Then: 503, kept DISTINCT from the 401 above. Both are refusals, but the worker client acts
    // on them differently — a 401 means "your key will never work, stop", a 503 means "come back
    // later, the pool is momentarily spent". Collapsing them would either strand a healthy worker
    // or make it hammer a master that rejected it.
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: expect.any(String) })
    // No token was minted for an account that cannot serve.
    expect(harness.refreshed).toEqual([])
  } finally {
    harness.stop()
  }
})

test("ratelimit report cools the account and next lease picks another", async () => {
  const harness = startHarness()
  try {
    // Given: a worker holding acct-a
    const first = (await (await post(harness.base, CLOUD_ROUTES.lease, PRELEASE, `Bearer ${POOL_KEY}`)).json()) as LeaseResponse
    expect(first.accountId).toBe("acct-a")

    // When: acct-a hits its subscription limit and the worker reports it
    const report: RateLimitReport = {
      workerId: WORKER_ID,
      accountId: "acct-a",
      headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": "1787903707" },
      resetsAt: 1_787_903_707_000,
    }
    const ack = await post(harness.base, CLOUD_ROUTES.ratelimit, report, `Bearer ${POOL_KEY}`)

    // Then: 204 with NO body — the worker's client only reads `res.ok`, and a body here would be
    // state the master does not owe a best-effort telemetry call.
    expect(ack.status).toBe(204)
    expect(await ack.text()).toBe("")
    // The reset instant is forwarded verbatim: only a known deadline can schedule recovery.
    expect(harness.reports).toEqual([{ accountId: "acct-a", resetsAt: 1_787_903_707_000 }])

    // And: the follow-up lease names the spent account, which must be EXCLUDED from the pick —
    // re-issuing acct-a would send the worker straight back into the same limit.
    const second = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "ratelimit", currentAccountId: "acct-a" } satisfies LeaseRequest,
      `Bearer ${POOL_KEY}`,
    )
    expect(second.status).toBe(200)
    expect(((await second.json()) as LeaseResponse).accountId).toBe("acct-b")
    expect(harness.picks[1]).toEqual({ ids: ["acct-a", "acct-b"], exclude: "acct-a" })
    expect(harness.refreshed).toEqual(["acct-a", "acct-b"])
  } finally {
    harness.stop()
  }
})

test("server aborts on lifecycle signal", async () => {
  // Given: a live server reachable on its ephemeral port
  const harness = startHarness()
  expect((await fetch(`${harness.base}${CLOUD_ROUTES.health}`)).status).toBe(200)

  // When: the plugin lifecycle signal fires (opencode disposing the plugin)
  harness.abort()
  await Bun.sleep(20)

  // Then: the listener is gone. This server holds every account's lease authority, so it must
  // die WITH the plugin process rather than keep a port open past dispose.
  await expect(fetch(`${harness.base}${CLOUD_ROUTES.health}`)).rejects.toThrow()

  // And: a signal that was ALREADY aborted before start must never serve either — an
  // `addEventListener("abort")` on a settled signal silently never fires, which is exactly how
  // a server outlives the process that owns it.
  const preAborted = startHarness({ preAborted: true })
  await expect(fetch(`${preAborted.base}${CLOUD_ROUTES.health}`)).rejects.toThrow()
})

// A pool-shaped roster for the dashboard cases: a live account, one that is cooling, and one the
// snapshot does not cover. Tokens are populated with recognisable values so the "no credential
// reaches this payload" assertion below is a measurement, not a fixture that had nothing to leak.
const dashboardAccounts: StoredAccount[] = [
  { id: "acct-live", label: "live@example.test", refresh: "sk-ant-ort01-live", access: "sk-ant-oat01-live", expires: EXPIRES_AT },
  { id: "acct-cool", label: "cool@example.test", refresh: "sk-ant-ort01-cool", access: "sk-ant-oat01-cool", expires: EXPIRES_AT },
  { id: "acct-dark", label: "dark@example.test", refresh: "sk-ant-ort01-dark" },
]

const POLLED_AT = 1_700_000_000_000

function dashboardHarness(stale: boolean): Harness {
  return startHarness({
    accounts: dashboardAccounts,
    cooled: ["acct-cool"],
    usage: {
      at: POLLED_AT,
      stale,
      // `acct-dark` is deliberately absent: the poller omits accounts whose usage fetch failed.
      byId: new Map([
        ["acct-live", { five_hour: { utilization: 21, resets_at: "2026-08-01T00:00:00Z" }, seven_day: { utilization: 44 } }],
        ["acct-cool", { five_hour: { utilization: 100, resets_at: "2026-08-01T03:00:00Z" } }],
      ]),
    },
  })
}

test("usage requires the same pool key as the lease routes", async () => {
  const harness = dashboardHarness(false)
  try {
    // Given: the dashboard's JSON names every account in the pool and how much of each subscription
    // is left. When: it is asked for with no key, and then with a wrong one.
    const anonymous = await fetch(`${harness.base}${CLOUD_ROUTES.usage}`)
    const wrongKey = await fetch(`${harness.base}${CLOUD_ROUTES.usage}`, { headers: { Authorization: "Bearer not-the-pool-key" } })

    // Then: 401 both times, identically — that roster is reconnaissance a stolen or guessed key
    // wants, so this route may not be the one place the pool answers an anonymous caller.
    expect(anonymous.status).toBe(401)
    expect(wrongKey.status).toBe(401)
    expect(await anonymous.json()).toEqual({ error: expect.any(String) })
    expect(await wrongKey.json()).toEqual({ error: expect.any(String) })
  } finally {
    harness.stop()
  }
})

test("usage returns the whole pool with no token in it", async () => {
  const harness = dashboardHarness(false)
  try {
    // When
    const res = await fetch(`${harness.base}${CLOUD_ROUTES.usage}`, { headers: { Authorization: `Bearer ${POOL_KEY}` } })

    // Then
    expect(res.status).toBe(200)
    const raw = await res.text()
    const view = JSON.parse(raw) as UsageSnapshotView
    expect(view.at).toBe(POLLED_AT)
    expect(view.stale).toBe(false)

    // 🔴 THE RED LINE, asserted on the RAW BYTES that crossed the socket rather than on a parsed
    // object: no access token, no refresh token, no full account id. The fixture's tokens all start
    // `sk-ant-`, so this fails the day a row is built by spreading a StoredAccount.
    expect(raw).not.toContain("sk-ant-")
    expect(raw).not.toContain("acct-live")

    // Every anthropic account gets a row, in ROSTER order, keyed by an id PREFIX.
    expect(view.accounts.map((row) => row.idPrefix)).toEqual(["acct-liv", "acct-coo", "acct-dar"])
    expect(view.accounts.map((row) => row.label)).toEqual(["live@example.test", "cool@example.test", "dark@example.test"])

    // The cooling account is flagged from the SCHEDULER's verdict — not inferred from its 100%
    // window, which is exactly the case where the two would agree and hide a wrong implementation.
    // `acct-live` proves the flag is not simply always true.
    expect(view.accounts.map((row) => row.coolingDown)).toEqual([false, true, false])

    // The account the poller could not reach is UNKNOWN, not idle: no windows and hasUsage false.
    // A synthetic 0% row here would render as the emptiest bar on the page.
    expect(view.accounts[2]).toEqual({
      idPrefix: "acct-dar",
      label: "dark@example.test",
      windows: [],
      hasUsage: false,
      coolingDown: false,
      excluded: false,
      needsReauth: false,
    })

    // And the served rows carry the real windows, including each one's reset instant.
    expect(view.accounts[0].windows).toEqual([
      { label: "five_hour", utilization: 21, resetsAt: "2026-08-01T00:00:00Z" },
      { label: "seven_day", utilization: 44 },
    ])
    expect(view.accounts[0].expiresAt).toBe(EXPIRES_AT)

    // Serving the dashboard consulted the roster but minted NOTHING: it reads the usage poller's
    // existing snapshot, so an operator refreshing the page can never provoke Anthropic's usage
    // endpoint (whose 429 lasts minutes for every account behind this master's egress IP).
    expect(harness.refreshed).toEqual([])
    expect(harness.picks).toEqual([])
  } finally {
    harness.stop()
  }
})

test("usage marks a stale snapshot instead of presenting it as current", async () => {
  const harness = dashboardHarness(true)
  try {
    const res = await fetch(`${harness.base}${CLOUD_ROUTES.usage}`, { headers: { Authorization: `Bearer ${POOL_KEY}` } })

    // The scheduler's own staleness verdict is forwarded verbatim. Without it the page would draw a
    // confident green bar from numbers selection has already stopped trusting — a monitoring surface
    // that lies is worse than no monitoring surface.
    expect(res.status).toBe(200)
    const view = (await res.json()) as UsageSnapshotView
    expect(view.stale).toBe(true)
    // The data itself is still served: the operator needs to see WHAT went stale, not an empty page.
    expect(view.accounts).toHaveLength(3)
  } finally {
    harness.stop()
  }
})

test("dashboard serves an inert HTML shell without a key, repeatedly", async () => {
  const harness = dashboardHarness(false)
  try {
    // Given: a browser navigating to a URL cannot send an Authorization header. When: it asks for the
    // dashboard with no credential at all.
    const res = await fetch(`${harness.base}${CLOUD_ROUTES.dashboard}`)

    // Then: it is served — and what it is served contains NO pool data whatsoever, which is the only
    // reason a keyless route is acceptable on the port that also hands out live credentials.
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<!doctype html>")
    expect(body).toContain(CLOUD_ROUTES.usage)
    expect(body).not.toContain("example.test")
    expect(body).not.toContain("sk-ant-")
    expect(body).not.toContain("acct-")
    expect(body).not.toContain(POOL_KEY)

    // A SECOND request must work too. A Response body is a single-use stream, so a handler that
    // hoisted one shared Response out of the closure would serve the first browser and then fail
    // every reload — the kind of break no single-fetch test would ever see.
    const reload = await fetch(`${harness.base}${CLOUD_ROUTES.dashboard}`)
    expect(reload.status).toBe(200)
    expect(await reload.text()).toBe(body)

    // An unknown path is still a 404: adding a route at "/" must not turn the server into a catch-all
    // that answers every probe with a page.
    const missing = await fetch(`${harness.base}/not-a-route`)
    expect(missing.status).toBe(404)
  } finally {
    harness.stop()
  }
})

test("lease horizon never outlives the master refresh point", async () => {
  // Given: an account whose access token is REALLY good for another 8 hours — nowhere near any
  // threshold, so an earlier horizon in the answer can only be INV-CLOUD-4 and not a stale fixture.
  const accountExpiresAt = Date.now() + 8 * 60 * 60_000
  const harness = startHarness({ accountExpiresAt })
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE, `Bearer ${POOL_KEY}`)

    // Then: the advertised instant is the master's own refresh point, NOT the account's expiry.
    // Refreshing REVOKES the access token it replaces (measured: old access 200 → refresh → the
    // same old access 401), so a lease that claimed validity past the moment the master becomes
    // eligible to refresh would be advertising a token the master itself is about to kill.
    expect(res.status).toBe(200)
    const lease = (await res.json()) as LeaseResponse
    expect(lease.expiresAt).toBe(accountExpiresAt - MASTER_MIN_REMAINING_MS)

    // And the consequence that equality exists for: the worker renews at
    // `horizon - LEASE_RENEW_BUFFER_MS`, which must land a full buffer BEFORE the master rotates.
    // The old behaviour inverted this — rotation at T-10min, renewal at T-5min — leaving a
    // five-minute window in which the worker held a revoked token and believed it was fine.
    const masterRotatesAt = accountExpiresAt - MASTER_MIN_REMAINING_MS
    const workerRenewsAt = lease.expiresAt - LEASE_RENEW_BUFFER_MS
    expect(masterRotatesAt - workerRenewsAt).toBeGreaterThanOrEqual(LEASE_RENEW_BUFFER_MS)
  } finally {
    harness.stop()
  }
})

test("lease is refused when the horizon would already be in the past", async () => {
  // Given: an account expiring INSIDE the master's own refresh floor, so the INV-CLOUD-4 horizon
  // (expiry − MASTER_MIN_REMAINING_MS) lies behind us and there is no usable lease to hand out.
  const harness = startHarness({ accountExpiresAt: Date.now() + 60_000 })
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE, `Bearer ${POOL_KEY}`)

    // Then: 503 rather than a dead-on-arrival credential. A worker writes the horizon into
    // auth.json, where the local provider refreshes on `expires < Date.now()` with ZERO buffer
    // against INV-CLOUD-1's sentinel — so serving a spent horizon breaks it twice over, while a
    // 503 puts it on the back-off path it already implements.
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: expect.any(String) })

    // And the refusal is the HORIZON's, not the scheduler's: an account WAS picked and its token
    // WAS minted. That is what separates this 503 from the spent-pool 503 above, where
    // `refreshed` stays empty.
    expect(harness.refreshed).toEqual(["acct-a"])
  } finally {
    harness.stop()
  }
})
