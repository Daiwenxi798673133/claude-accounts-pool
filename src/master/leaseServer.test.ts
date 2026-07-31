import { expect, test } from "bun:test"
import type { StoredAccount } from "../accounts.ts"
import { LEASE_RENEW_BUFFER_MS, MASTER_MIN_REMAINING_MS, ONBOARD_ADD_MIN_INTERVAL_MS } from "../constants.ts"
import { CLOUD_ROUTES } from "../cloud/protocol.ts"
import type { LeaseRequest, LeaseResponse, RateLimitReport, ThrottledBody, UsageSnapshotView } from "../cloud/protocol.ts"
import { createAccountOnboard } from "./accountOnboard.ts"
import { startLeaseServer, USAGE_REFRESH_MIN_INTERVAL_MS } from "./leaseServer.ts"
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
  // One entry per NAMED pick. Kept apart from `picks` because the whole claim of the preference path
  // is that ranked selection is not consulted at all, and one shared log could not show that.
  preferred: Array<{ ids: string[]; prefix: string }>
  // One entry per usage sweep the server actually asked for — the only way to tell "the master went
  // and polled Anthropic" apart from "the page re-read the snapshot it already had".
  sweeps: number[]
  snapshotAt: () => number
  advance: (ms: number) => void
  // Every code string the onboarding exchange was handed. Empty means the route refused BEFORE
  // reaching out, which is the distinction the throttle and the session-lifecycle cases turn on.
  exchanged: string[]
}

function startHarness(options?: {
  accounts?: StoredAccount[]
  cooled?: string[]
  preAborted?: boolean
  accountExpiresAt?: number
  usage?: UsageSnapshot
  // The one paste the fake exchange accepts. Anything else comes back `failed`, exactly as
  // ex-machina's own exchange collapses every refusal.
  goodCode?: string
  onboardProfile?: { uuid: string; email: string }
  profileThrows?: boolean
}): Harness {
  const accounts = options?.accounts ?? [account("acct-a"), account("acct-b")]
  const accountExpiresAt = options?.accountExpiresAt ?? ACCOUNT_EXPIRES_AT
  const cooled = new Set(options?.cooled ?? [])
  // Empty and STALE by default — the shape a master has before its first poll completes. Every
  // lease case below therefore runs against a server whose dashboard data is absent, proving the two
  // concerns share a port without sharing a failure mode.
  let usage: UsageSnapshot = options?.usage ?? { at: 0, stale: true, byId: new Map() }
  // FROZEN by default so the refresh throttle can be stepped deliberately; `advance` is the only way
  // time moves. Anchored to the real clock because the lease cases express their fixtures in it.
  let nowMs = Date.now()
  const clock = (): number => nowMs
  const sweeps: number[] = []
  const reports: Harness["reports"] = []
  const refreshed: string[] = []
  const picks: Harness["picks"] = []
  const preferred: Harness["preferred"] = []
  const controller = new AbortController()
  if (options?.preAborted) controller.abort()

  const goodCode = options?.goodCode ?? "good-code#the-state"
  const onboardProfile = options?.onboardProfile ?? { uuid: "11111111-2222-3333-4444-555555555555", email: "new@example.test" }
  const exchanged: string[] = []
  let pendingSeq = 0
  // The REAL onboard state machine over fake collaborators, not a stub of the whole thing: the
  // session lifecycle (TTL, attempt cap, single-use) is precisely what these HTTP cases exist to
  // observe from the outside, and a stub returning canned outcomes would assert nothing about it.
  const accountOnboard = createAccountOnboard({
    authorize: async () => ({
      url: "https://claude.ai/oauth/authorize?state=the-state",
      redirectUri: "https://platform.claude.com/oauth/code/callback",
      state: "the-state",
      verifier: "verifier-under-test",
    }),
    exchange: async (input) => {
      exchanged.push(input)
      return input === goodCode ? { type: "success", refresh: "refresh-new", access: "access-new", expires: clock() + 3600_000 } : { type: "failed" }
    },
    fetchProfile: async () => {
      if (options?.profileThrows) throw new Error("profile endpoint said no")
      return onboardProfile
    },
    absorb: async () => ({ existing: false }),
    newId: () => `pending-${++pendingSeq}`,
    now: clock,
  })

  const server = startLeaseServer({
    scheduler: {
      pickAccount({ accounts: pool, exclude }) {
        picks.push({ ids: pool.map((a) => a.id), ...(exclude === undefined ? {} : { exclude }) })
        return pool.find((a) => a.id !== exclude && !cooled.has(a.id))
      },
      // Mirrors the real scheduler's verdicts (scheduler.test.ts owns proving those), reading the SAME
      // `cooled` set as the pick filter and isCoolingDown so a row shown as 冷却中, an account skipped
      // by selection, and a refused switch can never disagree in this harness. `excluded` is
      // deliberately NOT a refusal, exactly as in the real one.
      pickPreferred({ accounts: pool, prefix }) {
        preferred.push({ ids: pool.map((a) => a.id), prefix })
        const matches = pool.filter((a) => a.id.startsWith(prefix))
        if (matches.length === 0) return { ok: false, refusal: "unknown" }
        if (matches.length > 1) return { ok: false, refusal: "ambiguous" }
        const target = matches[0]
        if (target.needsReauth === true) return { ok: false, refusal: "needs-reauth" }
        if (cooled.has(target.id)) return { ok: false, refusal: "cooling" }
        return { ok: true, account: target }
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
    // Stands in for the usage poller's tickOnce. It ADVANCES THE SNAPSHOT INSTANT, because that is
    // the real thing a completed sweep changes — a fake that only counted calls could not tell the
    // difference between the route sweeping and the route lying about it.
    refreshUsage: async () => {
      sweeps.push(clock())
      usage = { at: clock(), stale: false, byId: usage.byId }
    },
    accountOnboard,
    now: clock,
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
    preferred,
    sweeps,
    snapshotAt: () => usage.at,
    advance: (ms: number) => {
      nowMs += ms
    },
    exchanged,
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

test("lease naming an account serves THAT account and never consults ranked selection", async () => {
  // Given: a pool whose ranked pick would answer acct-a (the fake returns the first servable account,
  // as the 200 case above establishes) — so acct-b is only reachable by NAMING it
  const harness = startHarness()
  try {
    // When: the operator pressed enter on acct-b's row, which carries only the id PREFIX
    const res = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-b" } satisfies LeaseRequest,
      `Bearer ${POOL_KEY}`,
    )

    // Then: acct-b, minted through the very same path a scheduled lease uses
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accountId: "acct-b", access: "sk-ant-oat01-acct-b", expiresAt: EXPIRES_AT })
    expect(harness.refreshed).toEqual(["acct-b"])
    expect(harness.preferred).toEqual([{ ids: ["acct-a", "acct-b"], prefix: "acct-b" }])

    // AND THE LOAD-BEARING ASSERTION: ranked selection was not consulted at all. A named account that
    // still went through pickAccount would be silently re-ranked, and the operator would be told the
    // switch succeeded while holding whichever account the pool preferred.
    expect(harness.picks).toEqual([])
  } finally {
    harness.stop()
  }
})

test("lease naming an unservable account is refused 409 with the reason, never substituted", async () => {
  // Given: acct-b is spent (a worker just reported its limit) and acct-c cannot mint a token at all
  const harness = startHarness({ accounts: [account("acct-a"), account("acct-b"), { ...account("acct-c"), needsReauth: true }] })
  try {
    await post(
      harness.base,
      CLOUD_ROUTES.ratelimit,
      { workerId: WORKER_ID, accountId: "acct-b", headers: {} } satisfies RateLimitReport,
      `Bearer ${POOL_KEY}`,
    )

    // When / Then: each refusal names ITS OWN reason. The reason is the whole message the operator
    // acts on — waiting out a cooldown and re-logging-in on the master are different remedies, so a
    // single generic refusal would send them to fix the wrong thing.
    const cooling = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-b" } satisfies LeaseRequest,
      `Bearer ${POOL_KEY}`,
    )
    expect(cooling.status).toBe(409)
    expect(await cooling.json()).toEqual({ error: expect.any(String), refused: "cooling" })

    const reauth = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-c" } satisfies LeaseRequest,
      `Bearer ${POOL_KEY}`,
    )
    expect(reauth.status).toBe(409)
    expect(await reauth.json()).toEqual({ error: expect.any(String), refused: "needs-reauth" })

    const gone = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-z" } satisfies LeaseRequest,
      `Bearer ${POOL_KEY}`,
    )
    expect(gone.status).toBe(409)
    expect(await gone.json()).toEqual({ error: expect.any(String), refused: "unknown" })

    const ambiguous = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-" } satisfies LeaseRequest,
      `Bearer ${POOL_KEY}`,
    )
    expect(ambiguous.status).toBe(409)
    expect(await ambiguous.json()).toEqual({ error: expect.any(String), refused: "ambiguous" })

    // NOT 503 for any of them: a 503 tells the worker's client "the pool is momentarily spent, come
    // back", when the truth is that repeating this exact request can never succeed.
    // And NOTHING WAS MINTED OR SUBSTITUTED — no token for the named account, and no fallback pick.
    expect(harness.refreshed).toEqual([])
    expect(harness.picks).toEqual([])
  } finally {
    harness.stop()
  }
})

test("lease with an empty preferred prefix is malformed, not a match-anything wildcard", async () => {
  // Given: a client that sent the field but left it blank — a row whose prefix somehow came through
  // empty, which must not degrade into "any account will do"
  const harness = startHarness()
  try {
    // When
    const res = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "" },
      `Bearer ${POOL_KEY}`,
    )

    // Then: 400 at the boundary. An empty prefix matches every account, so it would resolve to
    // `ambiguous` on this pool but succeed BY LUCK on a single-account one — behaviour that differs
    // per pool size is exactly what a boundary check exists to prevent.
    expect(res.status).toBe(400)
    expect(harness.preferred).toEqual([])
    expect(harness.picks).toEqual([])
    expect(harness.refreshed).toEqual([])
  } finally {
    harness.stop()
  }
})

test("a named account is still refused when its horizon is already spent", async () => {
  // Given: the refresher hands back a token so close to expiry that the INV-CLOUD-4 floor leaves less
  // than one worker check interval of usable life
  const harness = startHarness({ accountExpiresAt: Date.now() + MASTER_MIN_REMAINING_MS + 1_000 })
  try {
    // When: the operator names it anyway
    const res = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-a" } satisfies LeaseRequest,
      `Bearer ${POOL_KEY}`,
    )

    // Then: the same 503 the scheduled path answers. The horizon check is NOT a selection rule the
    // preference may override — a dead-on-arrival lease dooms the worker twice (revoked token now,
    // sentinel self-refresh next), and an operator's pick cannot make that safe.
    expect(res.status).toBe(503)
    expect(harness.refreshed).toEqual(["acct-a"])
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

test("usage is public, and that did not open the credential routes", async () => {
  const harness = dashboardHarness(false)
  try {
    // Given: an anonymous caller with no Authorization header whatsoever. When: it asks for the
    // dashboard's JSON.
    const anonymous = await fetch(`${harness.base}${CLOUD_ROUTES.usage}`)

    // Then: it is SERVED — a deliberate owner decision recorded on CLOUD_ROUTES.usage, resting on
    // the payload being read-only and credential-free.
    expect(anonymous.status).toBe(200)
    expect(await anonymous.text()).not.toContain("sk-ant-")

    // AND THE WHOLE POINT OF THIS CASE: the very same anonymous caller is still refused by the two
    // routes that mint credentials and move pool state. A keyless dashboard must never become the
    // reason a keyless lease works — that would turn a monitoring convenience into an open
    // credential dispenser.
    const lease = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)
    const ratelimit = await post(harness.base, CLOUD_ROUTES.ratelimit, {
      workerId: WORKER_ID,
      accountId: "acct-live",
      headers: {},
    } satisfies RateLimitReport)
    expect(lease.status).toBe(401)
    expect(ratelimit.status).toBe(401)
    // Nothing was minted and no pool state moved, which is the consequence the statuses stand for.
    expect(harness.refreshed).toEqual([])
    expect(harness.reports).toEqual([])
  } finally {
    harness.stop()
  }
})

test("usage returns the whole pool with no token in it", async () => {
  const harness = dashboardHarness(false)
  try {
    // When: fetched the way the page itself fetches it — no credential of any kind.
    const res = await fetch(`${harness.base}${CLOUD_ROUTES.usage}`)

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
    const res = await fetch(`${harness.base}${CLOUD_ROUTES.usage}`)

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

test("refresh sweeps now and answers with what that sweep collected", async () => {
  // Given: a snapshot that is already stale — the situation the button exists for.
  const harness = dashboardHarness(true)
  try {
    const before = harness.snapshotAt()

    // When: the button's request, with no credential of any kind.
    const res = await fetch(`${harness.base}${CLOUD_ROUTES.usageRefresh}`, { method: "POST" })

    // Then: a sweep really ran, and the response carries ITS result rather than the snapshot that was
    // already sitting there. Pressing 刷新 and getting the same instant back would be a button that
    // lies about having done something — the failure this route exists to avoid.
    expect(res.status).toBe(200)
    const view = (await res.json()) as UsageSnapshotView
    expect(harness.sweeps).toHaveLength(1)
    expect(view.at).toBeGreaterThan(before)
    expect(view.at).toBe(harness.snapshotAt())
    expect(view.stale).toBe(false)
    expect(view.accounts).toHaveLength(3)
    // Still no credential in the payload — the route being keyless makes this stricter, not looser.
    expect(JSON.stringify(view)).not.toContain("sk-ant-")
  } finally {
    harness.stop()
  }
})

test("refresh is throttled server-wide and says how long to wait", async () => {
  const harness = dashboardHarness(false)
  const url = `${harness.base}${CLOUD_ROUTES.usageRefresh}`
  try {
    expect((await fetch(url, { method: "POST" })).status).toBe(200)
    expect(harness.sweeps).toHaveLength(1)

    // A second press inside the window is REFUSED, and the refusal is what makes a keyless route that
    // reaches Anthropic defensible at all: `/api/oauth/usage` answers a burst with a 429 that lasts
    // minutes and is charged to this master's egress IP — i.e. to every account in the pool at once.
    const throttled = await fetch(url, { method: "POST" })
    expect(throttled.status).toBe(429)
    const body = (await throttled.json()) as ThrottledBody
    expect(body.retryAfterMs).toBeGreaterThan(0)
    expect(body.retryAfterMs).toBeLessThanOrEqual(USAGE_REFRESH_MIN_INTERVAL_MS)
    // The header for anything speaking plain HTTP, in whole seconds; the body's exact ms is what the
    // page counts down. Both, because a disabled button with no stated reason is the thing to avoid.
    expect(throttled.headers.get("retry-after")).toBe(String(Math.ceil(body.retryAfterMs / 1000)))
    // NO sweep happened — that, not the status code, is the property being protected.
    expect(harness.sweeps).toHaveLength(1)

    // One millisecond short of the window: still refused. Exactly at it: allowed. Both asserted so
    // that neither a `<` / `<=` slip nor a throttle that never lifts can pass.
    harness.advance(USAGE_REFRESH_MIN_INTERVAL_MS - 1)
    expect((await fetch(url, { method: "POST" })).status).toBe(429)
    harness.advance(1)
    expect((await fetch(url, { method: "POST" })).status).toBe(200)
    expect(harness.sweeps).toHaveLength(2)
  } finally {
    harness.stop()
  }
})

test("a GET can never trigger a sweep", async () => {
  const harness = dashboardHarness(false)
  try {
    // When: the refresh path is fetched the way a browser, a link scanner or a chat-app unfurler
    // would speculatively fetch any URL it sees.
    const res = await fetch(`${harness.base}${CLOUD_ROUTES.usageRefresh}`)

    // Then: refused, and — the assertion that matters — NOTHING was polled. If a GET swept, merely
    // pasting the dashboard's link into a chat window could provoke upstream traffic for every
    // account in the pool. 405 rather than 404 so the fault is legible as "wrong method" instead of
    // reading like a master too old to have the button.
    expect(res.status).toBe(405)
    expect(harness.sweeps).toEqual([])

    // And the READ route is deliberately exempt from that rule: it is safe to GET precisely because
    // it sweeps nothing.
    expect((await fetch(`${harness.base}${CLOUD_ROUTES.usage}`)).status).toBe(200)
    expect(harness.sweeps).toEqual([])
  } finally {
    harness.stop()
  }
})

test("dashboard serves a data-free HTML page, repeatedly", async () => {
  const harness = dashboardHarness(false)
  try {
    // When: a browser navigates to the dashboard.
    const res = await fetch(`${harness.base}${CLOUD_ROUTES.dashboard}`)

    // Then: the document itself embeds NO pool data and NO key — it fetches the JSON route at
    // runtime. That is what lets one string be built at startup and shared by every viewer, and it
    // keeps the page out of the "leaks on disclosure" class entirely.
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toContain("text/html")
    const body = await res.text()
    expect(body).toContain("<!doctype html>")
    expect(body).toContain(CLOUD_ROUTES.usage)
    // Both routes and the throttle window are INJECTED into the page, so the countdown it shows can
    // never drift from the window the server actually enforces.
    expect(body).toContain(CLOUD_ROUTES.usageRefresh)
    expect(body).toContain(String(USAGE_REFRESH_MIN_INTERVAL_MS))
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

// ── 添加账号 (web onboarding) ──────────────────────────────────────────────────────────────────
// These two routes are the first on this server that WRITE while being KEYLESS, so what the cases
// below pin down is mostly the refusals: which requests are turned away before anything leaves the
// machine, and what the browser is — and is not — told.

test("both onboarding routes are keyless, and refuse a GET", async () => {
  const harness = startHarness()
  try {
    // Given/When: no Authorization header at all — the same omission that earns a 401 on lease
    const authorize = await post(harness.base, CLOUD_ROUTES.accountAuthorize, {})

    // Then: served. That contrast with the 401 above is the deliberate design of this port: the
    // dashboard and everything reachable from it is open, while minting a credential FOR A WORKER
    // is not.
    expect(authorize.status).toBe(200)

    // And: neither route answers a GET. `accountAdd` reaches platform.claude.com, so a speculatively
    // fetched link must not provoke it; `accountAuthorize` evicts pending sessions, so a link
    // unfurler must not be able to knock out an operator's half-finished login either.
    for (const route of [CLOUD_ROUTES.accountAuthorize, CLOUD_ROUTES.accountAdd]) {
      const got = await fetch(`${harness.base}${route}`)
      expect(got.status).toBe(405)
    }
    // And the GETs changed nothing: no exchange was attempted by either.
    expect(harness.exchanged).toEqual([])
  } finally {
    harness.stop()
  }
})

test("authorize hands back a link and a handle, and never the PKCE verifier", async () => {
  const harness = startHarness()
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.accountAuthorize, {})

    // Then
    expect(res.status).toBe(200)
    const body = (await res.json()) as { url: string; pendingId: string; expiresAt: number }
    expect(body.url).toContain("claude.ai/oauth/authorize")
    expect(body.pendingId).toBe("pending-1")
    expect(body.expiresAt).toBeGreaterThan(0)

    // And: the verifier stays on this machine. It is the preimage of the challenge in that URL, so a
    // browser holding it could redeem the code itself — which would end the property the whole cloud
    // design rests on, that the master is the only holder of a real refresh token.
    expect(JSON.stringify(body)).not.toContain("verifier-under-test")
  } finally {
    harness.stop()
  }
})

test("a good code adds the account and the answer carries no token", async () => {
  const harness = startHarness()
  try {
    // Given: a session the operator has just been handed
    const started = (await (await post(harness.base, CLOUD_ROUTES.accountAuthorize, {})).json()) as { pendingId: string }

    // When: the code from the authorize page comes back
    const res = await post(harness.base, CLOUD_ROUTES.accountAdd, { pendingId: started.pendingId, code: "good-code#the-state" })

    // Then
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({ idPrefix: "11111111", label: "new@example.test", existing: false })

    // And: PRIVACY. The exchange just minted a live access token and a one-time-use refresh token,
    // and neither appears in what the page is told — AccountAddResponse has no field either could be
    // assigned to, and this asserts the shape actually shipped matches that promise.
    const raw = JSON.stringify(body)
    expect(raw).not.toContain("access-new")
    expect(raw).not.toContain("refresh-new")
    // The id is a PREFIX, never the uuid a lease names.
    expect(raw).not.toContain("11111111-2222-3333-4444-555555555555")
  } finally {
    harness.stop()
  }
})

test("whitespace around a pasted code is tolerated, an empty one is refused", async () => {
  const harness = startHarness()
  try {
    const started = (await (await post(harness.base, CLOUD_ROUTES.accountAuthorize, {})).json()) as { pendingId: string }

    // Given/When: a paste carrying the newline a copied line usually brings with it
    const res = await post(harness.base, CLOUD_ROUTES.accountAdd, { pendingId: started.pendingId, code: "  good-code#the-state\n" })

    // Then: accepted — whitespace is an artefact of how the value was moved, not part of the code
    expect(res.status).toBe(200)
    expect(harness.exchanged).toEqual(["good-code#the-state"])

    // And: an all-whitespace paste is an EMPTY paste, refused at the boundary without reaching out
    const blank = await post(harness.base, CLOUD_ROUTES.accountAdd, { pendingId: started.pendingId, code: "   " })
    expect(blank.status).toBe(400)
    expect(harness.exchanged).toHaveLength(1)
  } finally {
    harness.stop()
  }
})

test("a malformed body and an unknown handle are separated by status", async () => {
  const harness = startHarness()
  try {
    // Given/When: a body that is not the contract at all
    const malformed = await post(harness.base, CLOUD_ROUTES.accountAdd, { nope: true })
    // Then: 400 — the caller's fault, and it cost the master nothing
    expect(malformed.status).toBe(400)

    // When: a well-formed request naming a session that does not exist
    const unknown = await post(harness.base, CLOUD_ROUTES.accountAdd, { pendingId: "pending-nope", code: "whatever" })

    // Then: 410 GONE, not 400. The page keys off exactly this split — a 400 keeps the pasted value on
    // screen for another try, a 410 means only a new link can help — so collapsing them would either
    // strand an operator on a dead session or throw away a live one over a typo.
    expect(unknown.status).toBe(410)

    // And neither reached Anthropic.
    expect(harness.exchanged).toEqual([])
  } finally {
    harness.stop()
  }
})

test("a rejected code answers 400 and leaves the session usable", async () => {
  const harness = startHarness()
  try {
    const started = (await (await post(harness.base, CLOUD_ROUTES.accountAuthorize, {})).json()) as { pendingId: string }

    // When: the operator pastes something truncated
    const bad = await post(harness.base, CLOUD_ROUTES.accountAdd, { pendingId: started.pendingId, code: "truncated" })

    // Then: 400 — recoverable, so the dialog keeps the field
    expect(bad.status).toBe(400)

    // And: the very same session still accepts the right value once the rate floor has passed
    harness.advance(ONBOARD_ADD_MIN_INTERVAL_MS)
    const good = await post(harness.base, CLOUD_ROUTES.accountAdd, { pendingId: started.pendingId, code: "good-code#the-state" })
    expect(good.status).toBe(200)
  } finally {
    harness.stop()
  }
})

test("the add route throttles, naming the wait in a header and in the body", async () => {
  const harness = startHarness()
  try {
    const started = (await (await post(harness.base, CLOUD_ROUTES.accountAuthorize, {})).json()) as { pendingId: string }
    await post(harness.base, CLOUD_ROUTES.accountAdd, { pendingId: started.pendingId, code: "truncated" })

    // When: a second attempt lands immediately, with the clock frozen
    const res = await post(harness.base, CLOUD_ROUTES.accountAdd, { pendingId: started.pendingId, code: "good-code#the-state" })

    // Then: 429, with the wait on BOTH channels — Retry-After in whole seconds for anything speaking
    // plain HTTP, the exact millisecond figure for the dialog's own countdown
    expect(res.status).toBe(429)
    expect(res.headers.get("retry-after")).toBe(String(Math.ceil(ONBOARD_ADD_MIN_INTERVAL_MS / 1000)))
    const body = (await res.json()) as ThrottledBody
    expect(body.retryAfterMs).toBeGreaterThan(0)
    expect(body.retryAfterMs).toBeLessThanOrEqual(ONBOARD_ADD_MIN_INTERVAL_MS)

    // And the point of the throttle: the refusal happened WITHOUT a second POST to Anthropic. On a
    // keyless route this is what stops a drip of requests from becoming a 400-storm against the token
    // endpoint, whose block would be charged to this master's IP and cost every account its refresh.
    expect(harness.exchanged).toEqual(["truncated"])
  } finally {
    harness.stop()
  }
})

test("a profile failure after a successful exchange answers 502", async () => {
  // Given: an upstream that will hand over tokens and then fail to say whose they are
  const harness = startHarness({ profileThrows: true })
  try {
    const started = (await (await post(harness.base, CLOUD_ROUTES.accountAuthorize, {})).json()) as { pendingId: string }

    // When
    const res = await post(harness.base, CLOUD_ROUTES.accountAdd, { pendingId: started.pendingId, code: "good-code#the-state" })

    // Then: 502, not 500 and not 400. The failure is upstream's and it lands AFTER the code was
    // spent, so the operator must be told to start over rather than invited to re-paste a code that
    // can no longer work.
    expect(res.status).toBe(502)
    expect(await res.json()).toEqual({ error: expect.any(String) })
  } finally {
    harness.stop()
  }
})

// TRIPWIRES, NOT BEHAVIOUR PROOFS — and deliberately so. The page's logic lives in an embedded ES5
// script with no DOM harness in this repo, so what these two cases can assert is that each REVIEWED
// DECISION is still present in the served document. Behaviour is proved against real Chromium
// out-of-band. Each marker below is here because removing it silently reintroduces a shipped bug, so
// a later "simplification" has to delete an assertion — and read why it exists — to get past CI.
test("the dashboard wakes up instead of waiting out its own poll interval", async () => {
  const harness = dashboardHarness(false)
  try {
    const body = await (await fetch(`${harness.base}${CLOUD_ROUTES.dashboard}`)).text()

    // A sweep can now land that this page never sees coming: a worker pressing `r` and another
    // operator's tab both drive POST /v1/usage/refresh, and the scheduled poll lands on its own. At
    // 60s the snapshot instant could sit a whole minute behind the pool while the local tick counted
    // its age UP — the page reporting staleness it had already been told about.
    expect(body).toContain("var RELOAD_MS = 5000")
    expect(body).not.toContain("var RELOAD_MS = 60000")

    // THE INTERVAL ALONE CANNOT FIX IT, because the tab is HIDDEN for the whole workflow: the
    // operator is in the terminal when they press `r`. Chrome clamps a hidden page's timers to about
    // one minute (intensive throttling, after 5 minutes hidden) and Page Lifecycle may freeze them
    // outright, so a hidden tab's 5s interval is worth no more than the 60s one it replaced. These
    // three listeners are what actually repairs the reported case, and NONE of them is redundant:
    //   • visibilitychange — same-window tab switch back; also the only one Chrome's native window
    //     occlusion tracking fires, which arrives WITHOUT focus.
    //   • focus — the macOS case, and the one the issue is really about: while the browser window
    //     sits behind the terminal, visibilityState stays "visible", so visibilitychange NEVER
    //     fires and only a Cmd-Tab focus event reports the operator coming back.
    //   • pageshow/persisted — bfcache restore, where Chrome and Firefox re-emit visibilitychange
    //     but Safari historically does not.
    expect(body).toContain('addEventListener("visibilitychange"')
    expect(body).toContain('window.addEventListener("focus"')
    expect(body).toContain('window.addEventListener("pageshow"')
    expect(body).toContain("event.persisted")

    // Single-flight. Waking on THREE events means one switch can fire two of them at once, and a
    // faster interval makes overlapping GETs ordinary rather than rare. It also guards `errorText`,
    // which the monotonic check below cannot: a slow FAILED response landing after a fresh success
    // would otherwise paint "拉取失败" over data that is fine.
    expect(body).toContain("if (loading) return")

    // Monotonic snapshot. The 刷新 button's POST is a SECOND in-flight channel single-flight cannot
    // see, so a slow GET carrying an older instant can land after it and roll the timestamp
    // backwards — the exact symptom this whole change exists to remove. `at === 0` is exempt because
    // that is how a restarted master says it has not swept yet; without the exemption that honest
    // notice would be suppressed forever.
    expect(body).toContain("payload.at === 0 || !latest || payload.at >= latest.at")
  } finally {
    harness.stop()
  }
})

test("the dashboard reports a fresh snapshot in seconds, not as a flat sub-minute bucket", async () => {
  const harness = dashboardHarness(false)
  try {
    const body = await (await fetch(`${harness.base}${CLOUD_ROUTES.dashboard}`)).text()

    // Without this, two sweeps less than a minute apart BOTH render "不到 1 分" and a correct fix
    // still looks broken: the operator presses `r`, the page really does refetch, and the line they
    // are watching does not move. Seconds plus the existing 1s tick is what makes the refresh
    // visible at the moment it lands.
    expect(body).toContain('Math.floor(ageMs / 1000) + " 秒"')

    // Clamped, because the instant comes from the MASTER's clock and the age is computed against the
    // BROWSER's. A few seconds of skew between two hosts is ordinary and must read as "0 秒", never
    // as a negative age.
    expect(body).toContain("Math.max(0, Date.now() - latest.at)")

    // fmtSpan is deliberately NOT the place for this: fmtLeft's per-account token countdown shares
    // it, so widening it would change a surface this issue never asked about.
    expect(body).toContain("function fmtSpan(ms)")
  } finally {
    harness.stop()
  }
})

test("the dashboard page carries the onboarding routes and still leaks nothing", async () => {
  const harness = startHarness()
  try {
    const body = await (await fetch(`${harness.base}${CLOUD_ROUTES.dashboard}`)).text()

    // Both onboarding routes are INJECTED into the page from the same frozen table the server
    // dispatches on, so a renamed route cannot leave a silently dead button behind.
    expect(body).toContain(CLOUD_ROUTES.accountAuthorize)
    expect(body).toContain(CLOUD_ROUTES.accountAdd)
    expect(body).toContain("添加账号")

    // And the page is still a shell: adding a credential-handling flow to it must not have put a
    // credential, an account or a key into the document.
    expect(body).not.toContain("verifier-under-test")
    expect(body).not.toContain(POOL_KEY)
    expect(body).not.toContain("example.test")
  } finally {
    harness.stop()
  }
})
