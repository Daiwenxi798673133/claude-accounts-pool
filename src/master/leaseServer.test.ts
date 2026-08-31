import { expect, test } from "bun:test"
import type { StoredAccount } from "../accounts.ts"
import { LEASE_RENEW_BUFFER_MS, MASTER_REFRESH_THRESHOLD_MS, ONBOARD_ADD_MIN_INTERVAL_MS } from "../constants.ts"
import { CLOUD_ROUTES } from "../cloud/protocol.ts"
import type { LeaseRequest, LeaseResponse, RateLimitReport, ThrottledBody, UsageSnapshotView, WorkerRegisterResponse } from "../cloud/protocol.ts"
import { createAccountOnboard } from "./accountOnboard.ts"
import { createAccountRemove } from "./accountRemove.ts"
import { startLeaseServer, USAGE_REFRESH_MIN_INTERVAL_MS } from "./leaseServer.ts"
import { RATELIMIT_ADOPTION_GRACE_MS } from "./scheduler.ts"
import type { UsageSnapshot } from "./scheduler.ts"
import { createWorkerRegistry } from "./workerRegistry.ts"

// A REAL Bun.serve on an EPHEMERAL port, driven by REAL fetch. The deliverable here is HTTP
// behaviour (status codes, boundary refusals, empty-body 204), and a handler invoked directly as
// a function would prove none of it — Bun, not our code, decides how a 204 or a dead socket looks
// on the wire. Port 0 (never a literal) so two checkouts running `bun test` at once cannot
// collide; the assigned port is read back off the server object.
//
// The two collaborators are hand-built stubs, NOT the real modules: the real refresher would
// POST a live refresh token at Anthropic, and the real scheduler drags a kv store in.
// The scheduler stub is a small honest FAKE (a cooled-id set + a filter) rather than a mock
// returning canned answers, because test 5's whole claim is that a report CHANGES the next pick.

const WORKER_ID = "worker-1"
// The horizon a worker RECEIVES — deliberately still named EXPIRES_AT, because that is what lands
// in its auth.json and what the cases below assert. Since INV-CLOUD-4 the account's own expiry is a
// DIFFERENT instant, so the fixture is expressed from the horizon BACKWARDS: what the refresher
// reports sits MASTER_REFRESH_THRESHOLD_MS later than what the master is willing to advertise. That also
// makes the default fixture distinguishing — a server that echoed the account expiry would answer
// ACCOUNT_EXPIRES_AT here and fail the 200 case below.
const EXPIRES_AT = 1_900_000_000_000
const ACCOUNT_EXPIRES_AT = EXPIRES_AT + MASTER_REFRESH_THRESHOLD_MS

const account = (id: string): StoredAccount => ({ id, label: `${id}@example.test`, refresh: `refresh-${id}` })

type Harness = {
  base: string
  stop: () => void
  abort: () => void
  reports: Array<{ accountId: string; resetsAt?: number }>
  refreshed: string[]
  picks: Array<{ ids: string[]; exclude?: string; workerId?: string; excludeIds?: readonly string[] }>
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
  // The ids the delete path really removed, and the roster it removed them from. A refusal that
  // still emptied a slot would be invisible from the status code alone.
  deleted: string[]
  roster: () => string[]
  // Who the master believes holds what, right now. A snapshot copy rather than the live map, so a
  // case cannot assert against a book that has moved on since it looked.
  book: () => Array<[string, string]>
  // The labels the master has been told to expect. Kept apart from `book` because leasing is not
  // registering: a harness where one implied the other could not show that.
  registered: () => string[]
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
  // A refresher that cannot mint — a revoked chain, or a 429 cooldown with nothing cached.
  refreshThrows?: boolean
  // Labels already in the master's book when the server starts.
  registeredWorkers?: string[]
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
  const leases = new Map<string, { accountId: string; expiresAt: number; pinned: boolean; adoptedAt: number }>()
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

  const deleted: string[] = []
  const backedUp: string[] = []
  // The REAL removal state machine over an in-memory roster, for the same reason accountOnboard is
  // real here: the refusals (prefix ambiguity, the label confirmation) are what these HTTP cases
  // exist to observe from the outside, and a stub returning canned outcomes would assert nothing
  // about them. accountRemove.test.ts owns proving the ORDER of backup and delete.
  const accountRemove = createAccountRemove({
    loadAccounts: async () => accounts,
    backup: async (target) => {
      backedUp.push(target.id)
    },
    remove: async (id) => {
      const index = accounts.findIndex((entry) => entry.id === id)
      if (index < 0) return undefined
      deleted.push(id)
      return accounts.splice(index, 1)[0]
    },
  })

  // The REAL book over an in-memory kv, for the same reason accountOnboard and accountRemove are
  // real here: these cases assert what the ROUTE does to it, and a stub answering canned values
  // would prove nothing about persistence or about a repeat registration.
  const kvStore = new Map<string, unknown>()
  const workerRegistry = createWorkerRegistry({
    kv: {
      get: <V>(key: string, fallback?: V): V => (kvStore.has(key) ? (kvStore.get(key) as V) : (fallback as V)),
      set: (key: string, value: unknown): void => {
        kvStore.set(key, value)
      },
    },
    now: clock,
  })
  for (const workerId of options?.registeredWorkers ?? []) workerRegistry.register(workerId)

  const server = startLeaseServer({
    scheduler: {
      pickAccount({ accounts: pool, exclude, workerId, excludeIds }) {
        picks.push({
          ids: pool.map((a) => a.id),
          ...(exclude === undefined ? {} : { exclude }),
          ...(workerId === undefined ? {} : { workerId }),
          ...(excludeIds === undefined ? {} : { excludeIds }),
        })
        return pool.find((a) => a.id !== exclude && excludeIds?.includes(a.id) !== true && !cooled.has(a.id))
      },
      // A REAL book, not a spy list: these cases assert that a refused lease books nothing, which a
      // recorder that only appends could not distinguish from one that books and never releases.
      recordLease({ workerId, accountId, expiresAt, pinned }) {
        const held = leases.get(workerId)
        leases.set(workerId, {
          accountId,
          expiresAt,
          pinned,
          adoptedAt: held?.accountId === accountId ? held.adoptedAt : clock(),
        })
      },
      // Mirrors the real rule (scheduler.test.ts owns proving it) so the HTTP cases can drive the
      // whole misattribution route — report discarded AND rotation skipped — from the outside.
      justAdopted: (workerId, accountId) => {
        const held = leases.get(workerId)
        return held?.accountId === accountId && clock() - held.adoptedAt < RATELIMIT_ADOPTION_GRACE_MS
      },
      holdersOf: (accountId) => [...leases].filter(([, hold]) => hold.accountId === accountId).map(([workerId]) => workerId),
      pinnersOf: (accountId) =>
        [...leases].filter(([, hold]) => hold.accountId === accountId && hold.pinned).map(([workerId]) => workerId),
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
      reportRateLimit(accountId, resetsAt, workerId) {
        if (workerId !== undefined) {
          const held = leases.get(workerId)
          if (held?.accountId === accountId && clock() - held.adoptedAt < RATELIMIT_ADOPTION_GRACE_MS) return
        }
        reports.push({ accountId, ...(resetsAt === undefined ? {} : { resetsAt }) })
        cooled.add(accountId)
      },
      getUsageSnapshot: () => usage,
      // The SAME `cooled` set the pick filter reads, so a dashboard row claiming "冷却中" and an
      // account being skipped by selection can never disagree in this harness.
      isCoolingDown: (accountId) => cooled.has(accountId),
    },
    workerRegistry,
    refresher: {
      async getFreshAccess(accountId) {
        refreshed.push(accountId)
        if (options?.refreshThrows) throw new Error("master refresh token revoked (invalid_grant) for " + accountId)
        return { access: `sk-ant-oat01-${accountId}`, expiresAt: accountExpiresAt }
      },
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
    accountRemove,
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
    deleted,
    roster: () => accounts.map((entry) => entry.id),
    book: () => [...leases].map(([workerId, hold]) => [workerId, hold.accountId]),
    registered: () => workerRegistry.list().map((entry) => entry.workerId),
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

test("lease is served to a caller that presents no credential at all", async () => {
  // Given: a running master and a worker carrying nothing but its own request
  const harness = startHarness()
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)

    // Then: the roster IS consulted and a live token IS minted for a caller that proved nothing.
    // That is the design and not a lapse — reaching the port is the whole of the entitlement, so
    // this case is the one that fails the day someone reintroduces an application-layer gate
    // without also deciding how a worker would ever get past it.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ accountId: "acct-a", access: "sk-ant-oat01-acct-a", expiresAt: EXPIRES_AT })
    expect(harness.picks).toEqual([{ ids: ["acct-a", "acct-b"], workerId: WORKER_ID }])
    expect(harness.refreshed).toEqual(["acct-a"])
    // And: the served lease is BOOKED, which is what lets the next pick steer away from acct-a.
    expect(harness.book()).toEqual([[WORKER_ID, "acct-a"]])

    // And: the same caller gets 200 on health, which may not leak in exchange — it is a readiness
    // probe a worker calls BEFORE it trusts a master URL (and an ops liveness check calls forever),
    // so it must say nothing: no account ids, no worker list, no counts.
    const health = await fetch(`${harness.base}${CLOUD_ROUTES.health}`)
    expect(health.status).toBe(200)
    expect(await health.json()).toEqual({ ok: true })
  } finally {
    harness.stop()
  }
})

test("a malformed lease body is refused 400 before anything is picked or minted", async () => {
  const harness = startHarness()
  try {
    // Given/When: well-formed JSON carrying a `reason` the protocol does not define
    const res = await post(harness.base, CLOUD_ROUTES.lease, { workerId: WORKER_ID, reason: "whenever" })

    // Then: 400. An unknown reason is refused rather than defaulted, because `prelease` and
    // `ratelimit` differ in whether the named account is EXCLUDED from the pick — silently
    // defaulting would re-issue a spent account to the worker that just hit its limit.
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: expect.any(String) })

    // AND THE ORDERING, which is what this case exists for: the parse runs FIRST. A malformed
    // request is the caller's fault and must cost the master nothing — no pick, no mint — or a
    // caller sending garbage in a loop drives real work on every one of them.
    expect(harness.picks).toEqual([])
    expect(harness.refreshed).toEqual([])
  } finally {
    harness.stop()
  }
})

test("no Authorization header is required, and a stray one is ignored rather than refused", async () => {
  // Given: two callers that differ ONLY in whether they present a bearer credential
  const harness = startHarness()
  try {
    // When
    const bare = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)
    const stray = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE, "Bearer left-over-from-an-older-tui-json")

    // Then: BOTH served, and served identically. This server evaluates no application-layer
    // credential, so a header the caller happens to send is not a claim it can accept or reject —
    // a worker still sending one from an older config must not be locked out, and a stranger
    // inventing one must not be let in. The bind address is the whole of the access control.
    expect(bare.status).toBe(200)
    expect(stray.status).toBe(200)
    expect(await bare.json()).toEqual(await stray.json())
    // And both really reached the pool: two leases were served, not two cheap refusals.
    expect(harness.refreshed).toEqual(["acct-a", "acct-a"])
  } finally {
    harness.stop()
  }
})

test("a ratelimit report is accepted with no credential and really cools the account", async () => {
  // Given: a worker on its recovery path, presenting nothing
  const harness = startHarness()
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.ratelimit, {
      workerId: WORKER_ID,
      accountId: "acct-a",
      headers: {},
      resetsAt: 1_787_903_707_000,
    } satisfies RateLimitReport)

    // Then: 204 with no body, and the cooldown actually applied. A refusal here would be worse than
    // it looks: the report is how a spent account leaves selection, so a route that turned it away
    // would leave the worker re-leasing the very account that just hit its limit.
    expect(res.status).toBe(204)
    expect(await res.text()).toBe("")
    expect(harness.reports).toEqual([{ accountId: "acct-a", resetsAt: 1_787_903_707_000 }])
  } finally {
    harness.stop()
  }
})

test("bytes that are not JSON are a 400 on both credential routes, never a 500", async () => {
  const harness = startHarness()
  try {
    // When: a body that no parser can read reaches each of the two routes that move pool state
    const lease = await post(harness.base, CLOUD_ROUTES.lease, "{not json")
    const ratelimit = await post(harness.base, CLOUD_ROUTES.ratelimit, "{not json")

    // Then: 400 on both. A 500 is the failure to avoid, not a cosmetic difference — the worker's
    // client treats a 5xx as a transient fault and retries the identical bytes forever, so an
    // unhandled parse throw would turn one malformed request into a permanent retry loop.
    expect(lease.status).toBe(400)
    expect(ratelimit.status).toBe(400)
    expect(await lease.json()).toEqual({ error: expect.any(String) })
    expect(await ratelimit.json()).toEqual({ error: expect.any(String) })

    // And neither cost the master anything: no token minted, no account cooled.
    expect(harness.refreshed).toEqual([])
    expect(harness.reports).toEqual([])
  } finally {
    harness.stop()
  }
})

test("a workerId outside the label pattern is refused on both credential routes", async () => {
  const harness = startHarness()
  try {
    // Given: the one field on this wire that reaches the LOG FILE, carrying exactly what a log
    // injection needs — path traversal, spaces, and (below) a forged line break.
    const forged = "bad id/../with spaces"

    // When
    const lease = await post(harness.base, CLOUD_ROUTES.lease, { workerId: forged, reason: "prelease" } satisfies LeaseRequest)
    const ratelimit = await post(harness.base, CLOUD_ROUTES.ratelimit, {
      workerId: forged,
      accountId: "acct-a",
      headers: {},
    } satisfies RateLimitReport)

    // Then: refused at the boundary, before the label can be written anywhere. Nothing
    // authenticates this string, so the narrowing is the only thing standing between an anonymous
    // caller and arbitrary lines in the operator's log.
    expect(lease.status).toBe(400)
    expect(ratelimit.status).toBe(400)
    expect(harness.refreshed).toEqual([])
    expect(harness.reports).toEqual([])

    // And a newline is refused for the same reason, which is the shape that actually forges a
    // second log entry rather than merely dirtying one.
    const injected = await post(harness.base, CLOUD_ROUTES.lease, { workerId: "ok\nmaster:lease-served", reason: "prelease" } satisfies LeaseRequest)
    expect(injected.status).toBe(400)

    // And the value on the other side of the rule is ACCEPTED, so the pattern is proven to be a
    // rule rather than a blanket refusal of every workerId.
    const allowed = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)
    expect(allowed.status).toBe(200)
  } finally {
    harness.stop()
  }
})

test("lease returns 200 with accountId access expiresAt", async () => {
  // Given: a pool with two healthy accounts
  const harness = startHarness()
  try {
    // When: a worker renews the account it already holds, under a name nothing corroborates
    const res = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: "worker-impersonated", reason: "prelease", currentAccountId: "acct-a" } satisfies LeaseRequest,
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
    expect(harness.picks).toEqual([{ ids: ["acct-a", "acct-b"], workerId: "worker-impersonated" }])

    // The workerId DOES reach selection now — but only so the holder count can discount this worker's
    // own outstanding lease. It can never make an account more attractive, only stop the requester
    // from counting as its own competition, so a forged label buys the caller nothing here: with an
    // empty book every candidate has zero holders either way and the answer is the ranked one.
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
    )

    // When / Then: each refusal names ITS OWN reason. The reason is the whole message the operator
    // acts on — waiting out a cooldown and re-logging-in on the master are different remedies, so a
    // single generic refusal would send them to fix the wrong thing.
    const cooling = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-b" } satisfies LeaseRequest,
    )
    expect(cooling.status).toBe(409)
    expect(await cooling.json()).toEqual({ error: expect.any(String), refused: "cooling" })

    const reauth = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-c" } satisfies LeaseRequest,
    )
    expect(reauth.status).toBe(409)
    expect(await reauth.json()).toEqual({ error: expect.any(String), refused: "needs-reauth" })

    const gone = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-z" } satisfies LeaseRequest,
    )
    expect(gone.status).toBe(409)
    expect(await gone.json()).toEqual({ error: expect.any(String), refused: "unknown" })

    const ambiguous = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-" } satisfies LeaseRequest,
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
  const harness = startHarness({ accountExpiresAt: Date.now() + MASTER_REFRESH_THRESHOLD_MS + 1_000 })
  try {
    // When: the operator names it anyway
    const res = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-a" } satisfies LeaseRequest,
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
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)

    // Then: 503, kept DISTINCT from the 400 and the 409 above. All three refuse, but the worker
    // client acts on them differently — a 400 and a 409 mean "this exact request can never
    // succeed, stop", a 503 means "come back later, the pool is momentarily spent". Collapsing
    // them would either strand a healthy worker or make it hammer a master with a dead request.
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
    const first = (await (await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)).json()) as LeaseResponse
    expect(first.accountId).toBe("acct-a")

    // When: the worker has held acct-a long enough to actually spend it — a report arriving within
    // RATELIMIT_ADOPTION_GRACE_MS of the lease is the MISATTRIBUTED case and gets its own test below.
    harness.advance(RATELIMIT_ADOPTION_GRACE_MS)
    // And: acct-a hits its subscription limit and the worker reports it
    const report: RateLimitReport = {
      workerId: WORKER_ID,
      accountId: "acct-a",
      headers: { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": "1787903707" },
      resetsAt: 1_787_903_707_000,
    }
    const ack = await post(harness.base, CLOUD_ROUTES.ratelimit, report)

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
    )
    expect(second.status).toBe(200)
    expect(((await second.json()) as LeaseResponse).accountId).toBe("acct-b")
    expect(harness.picks[1]).toEqual({ ids: ["acct-a", "acct-b"], exclude: "acct-a", workerId: WORKER_ID })
    // And: the book MOVED rather than grew — one worker, one account, so the spent acct-a is released
    // by the very write that takes acct-b. Nothing on the wire says "release".
    expect(harness.book()).toEqual([[WORKER_ID, "acct-b"]])
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

test("one anonymous caller reaches the read route and the two that move pool state alike", async () => {
  const harness = dashboardHarness(false)
  try {
    // Given: an anonymous caller with no Authorization header whatsoever. When: it asks for the
    // dashboard's JSON.
    const anonymous = await fetch(`${harness.base}${CLOUD_ROUTES.usage}`)

    // Then: it is SERVED — a deliberate owner decision recorded on CLOUD_ROUTES.usage, resting on
    // the payload being read-only and credential-free.
    expect(anonymous.status).toBe(200)
    expect(await anonymous.text()).not.toContain("sk-ant-")

    // AND THE WHOLE POINT OF THIS CASE: the very same anonymous caller also gets a live token out
    // of `lease` and cools an account through `ratelimit`. The read route is not a narrower
    // exception carved into an otherwise gated port — the port has ONE tier, and this is what
    // "the bind address is the entire access control" costs when it is written down as a test.
    const lease = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)
    // Past the misattribution window, so what this case proves is the ABSENT gate and not the guard
    // that would have discarded a report landing in the same instant as its lease.
    harness.advance(RATELIMIT_ADOPTION_GRACE_MS)
    const ratelimit = await post(harness.base, CLOUD_ROUTES.ratelimit, {
      workerId: WORKER_ID,
      accountId: "acct-live",
      headers: {},
    } satisfies RateLimitReport)
    expect(lease.status).toBe(200)
    expect(ratelimit.status).toBe(204)
    // A token really was minted and pool state really moved, which is what those statuses stand for.
    expect(harness.refreshed).toEqual(["acct-live"])
    expect(harness.reports).toEqual([{ accountId: "acct-live" }])
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
      // EMPTY, not absent: nobody has leased this account, which is a different fact from a master
      // that cannot say who holds it. The page renders no badge for the former and none for the
      // latter either, but selection ranks by the former and must not by the latter.
      holders: [],
      // Same rule, same reason — and empty here even though `holders` is too, which is the pair a
      // renderer needs in order to tell "held but free to rotate" from "held and staying".
      pinnedBy: [],
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

    // Then: the document itself embeds NO pool data — it fetches the JSON route at runtime. That
    // is what lets one string be built at startup and shared by every viewer, and it keeps the page
    // out of the "leaks on disclosure" class entirely.
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
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)

    // Then: the advertised instant is the master's own refresh point, NOT the account's expiry.
    // Refreshing REVOKES the access token it replaces (measured: old access 200 → refresh → the
    // same old access 401), so a lease that claimed validity past the moment the master becomes
    // eligible to refresh would be advertising a token the master itself is about to kill.
    expect(res.status).toBe(200)
    const lease = (await res.json()) as LeaseResponse
    expect(lease.expiresAt).toBe(accountExpiresAt - MASTER_REFRESH_THRESHOLD_MS)

    // And the consequence that equality exists for: the worker renews at
    // `horizon - LEASE_RENEW_BUFFER_MS`, which must land a full buffer BEFORE the master rotates.
    // Subtracting anything SMALLER than the refresher's own trigger inverts this — rotation first,
    // renewal long after — leaving a window in which the worker holds a revoked token and believes
    // it is fine.
    const masterRotatesAt = accountExpiresAt - MASTER_REFRESH_THRESHOLD_MS
    const workerRenewsAt = lease.expiresAt - LEASE_RENEW_BUFFER_MS
    expect(masterRotatesAt - workerRenewsAt).toBeGreaterThanOrEqual(LEASE_RENEW_BUFFER_MS)
  } finally {
    harness.stop()
  }
})

test("lease is refused when the horizon would already be in the past", async () => {
  // Given: an account expiring INSIDE the master's own refresh floor, so the INV-CLOUD-4 horizon
  // (expiry − MASTER_REFRESH_THRESHOLD_MS) lies behind us and there is no usable lease to hand out.
  const harness = startHarness({ accountExpiresAt: Date.now() + 60_000 })
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)

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

// ---- ACCEPTANCE CRITERION (issue #37): a bad account must never look like a bad master ---------
test("a refresher that cannot mint answers 503, never 500", async () => {
  // Given: the picked account's chain is dead, so minting throws out of the lease path
  const harness = startHarness({ refreshThrows: true })
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)

    // Then: 503 — "the pool has nothing right now". An escaping throw is answered 500, which the
    // worker's client classifies as a transient SERVER fault and retries for ~10 minutes before
    // reporting 连不上云端账号池 — accusing the network and the master while both are healthy.
    expect(res.status).toBe(503)
    expect(await res.json()).toEqual({ error: expect.any(String) })
    expect(harness.refreshed).toEqual(["acct-a"])
  } finally {
    harness.stop()
  }
})

test("a named account whose chain is dead is refused with 503 rather than 500", async () => {
  // The operator's own pick reaches serveLease by a different route, so it needs its own witness:
  // the preference path used to be the shorter way to a 500.
  const harness = startHarness({ refreshThrows: true })
  try {
    const res = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "prelease", preferredAccountIdPrefix: "acct-b" } satisfies LeaseRequest,
    )

    expect(res.status).toBe(503)
    expect(harness.refreshed).toEqual(["acct-b"])
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
    // Given/When: no Authorization header at all
    const authorize = await post(harness.base, CLOUD_ROUTES.accountAuthorize, {})

    // Then: served, like every other route on this port. What makes these two worth their own
    // cases is not the absence of a credential but that they WRITE while keyless — so the bounds
    // inside accountOnboard, not a gate out here, are the whole of the defence.
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
    // credential or an account into the document.
    expect(body).not.toContain("verifier-under-test")
    expect(body).not.toContain("example.test")
  } finally {
    harness.stop()
  }
})

test("the delete route is POST-only, and a GET moves nothing", async () => {
  // Given: a two-account pool
  const harness = startHarness()
  try {
    // When: something GETs the URL — a pasted link, a chat unfurler, a speculative prefetch
    const res = await fetch(`${harness.base}${CLOUD_ROUTES.accountDelete}`)

    // Then: 405, and the pool is intact. 405 rather than 404 because the route exists and the fault
    // is the method — a 404 would read as "this master is too old to have the button".
    expect(res.status).toBe(405)
    expect(harness.deleted).toEqual([])
    expect(harness.roster()).toEqual(["acct-a", "acct-b"])
  } finally {
    harness.stop()
  }
})

test("a delete request missing its confirmation is refused 400 before the roster is touched", async () => {
  const harness = startHarness()
  try {
    // When: the prefix alone, i.e. exactly what a caller who skipped the dialog would send
    const res = await post(harness.base, CLOUD_ROUTES.accountDelete, { idPrefix: "acct-a" })

    // Then: 400. The label is not an optional nicety — it is the confirmation, and a request that
    // omits it has not confirmed anything.
    expect(res.status).toBe(400)
    expect(harness.deleted).toEqual([])
    expect(harness.roster()).toEqual(["acct-a", "acct-b"])
  } finally {
    harness.stop()
  }
})

test("a prefix matching two accounts is refused 409 ambiguous rather than deleting one of them", async () => {
  // Given: a prefix both fixture accounts share
  const harness = startHarness()
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.accountDelete, { idPrefix: "acct-", label: "acct-a@example.test" })

    // Then: refused, with the machine-readable code the page branches on. Resolving to the first
    // match would delete whichever record sorted earlier — and unlike a wrong switch, that cannot be
    // undone by trying again.
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: expect.any(String), refused: "ambiguous" })
    expect(harness.deleted).toEqual([])
    expect(harness.roster()).toEqual(["acct-a", "acct-b"])
  } finally {
    harness.stop()
  }
})

test("a confirmation naming a different account deletes nothing", async () => {
  // Given: acct-a's prefix carrying acct-b's address — a stale page, or a misread row
  const harness = startHarness()
  try {
    const res = await post(harness.base, CLOUD_ROUTES.accountDelete, { idPrefix: "acct-a", label: "acct-b@example.test" })

    // Then: refused, and NEITHER account is gone. This is the case that makes the dialog's typing
    // step load-bearing rather than browser-side ceremony a direct POST could skip.
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: expect.any(String), refused: "label-mismatch" })
    expect(harness.roster()).toEqual(["acct-a", "acct-b"])
  } finally {
    harness.stop()
  }
})

test("a prefix naming nobody is refused 409 unknown", async () => {
  const harness = startHarness()
  try {
    const res = await post(harness.base, CLOUD_ROUTES.accountDelete, { idPrefix: "acct-z", label: "acct-z@example.test" })

    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: expect.any(String), refused: "unknown" })
    expect(harness.roster()).toEqual(["acct-a", "acct-b"])
  } finally {
    harness.stop()
  }
})

test("a confirmed delete removes the account from the pool the dashboard and the leases both read", async () => {
  // Given: a two-account pool, and a caller presenting no credential at all — the same entitlement
  // every other route on this server grants, which is the bind address and nothing else
  const harness = startHarness()
  try {
    // When
    const res = await post(harness.base, CLOUD_ROUTES.accountDelete, { idPrefix: "acct-a", label: "acct-a@example.test" })

    // Then: 200, answering with the SAME redacted identity shape the add route uses — an id prefix
    // and the label, never the record's tokens.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ idPrefix: "acct-a", label: "acct-a@example.test" })
    expect(harness.deleted).toEqual(["acct-a"])

    // AND IT REALLY LEFT THE POOL, which is the half a status code cannot show: the usage view is
    // built from the same roster selection reads, so an account still listed here would still be
    // leasable — a delete that only satisfied the dialog.
    const view = (await (await fetch(`${harness.base}${CLOUD_ROUTES.usage}`)).json()) as UsageSnapshotView
    expect(view.accounts.map((entry) => entry.label)).toEqual(["acct-b@example.test"])
  } finally {
    harness.stop()
  }
})

test("the dashboard page carries the delete route and still leaks nothing", async () => {
  const harness = startHarness()
  try {
    const body = await (await fetch(`${harness.base}${CLOUD_ROUTES.dashboard}`)).text()

    // Injected from the same frozen table the server dispatches on, so a renamed route cannot leave
    // a silently dead button behind.
    expect(body).toContain(CLOUD_ROUTES.accountDelete)
    expect(body).toContain("删除账号")

    // The picker is built in the BROWSER from /v1/usage, never baked into the document: a page that
    // shipped the roster would publish the pool's email addresses to anyone who fetched the shell.
    expect(body).not.toContain("example.test")
  } finally {
    harness.stop()
  }
})

test("a pin without a named account is malformed, never a pin on whatever gets ranked", async () => {
  const harness = startHarness()
  try {
    const res = await post(harness.base, CLOUD_ROUTES.lease, { workerId: WORKER_ID, reason: "prelease", pinned: true })

    // 400 at the boundary rather than a silently ignored flag. A pin is a claim about a SPECIFIC
    // account and the worker does not yet know what a ranked pick will hand back — so serving this as
    // an ordinary lease would answer 200 to a `p` press that reserved nothing, which the operator
    // would then see confirmed by a success toast and contradicted by the pool an hour later.
    expect(res.status).toBe(400)
    expect(harness.picks).toEqual([])
    expect(harness.preferred).toEqual([])
    expect(harness.refreshed).toEqual([])
  } finally {
    harness.stop()
  }
})

test("a non-boolean pin is refused, not coerced", async () => {
  const harness = startHarness()
  try {
    const res = await post(harness.base, CLOUD_ROUTES.lease, {
      workerId: WORKER_ID,
      reason: "prelease",
      preferredAccountIdPrefix: "acct-a",
      pinned: "yes",
    })

    // Truthiness is not consent: `"false"` is truthy too, so a coercing parser would turn a worker's
    // un-pin into a pin. Refused for the same reason `reason` is strictly checked.
    expect(res.status).toBe(400)
    expect(harness.preferred).toEqual([])
  } finally {
    harness.stop()
  }
})

test("a pinned lease reaches the dashboard as pinnedBy, and an un-pin removes it again", async () => {
  const harness = dashboardHarness(false)
  try {
    const pinLease = (pinned: boolean) =>
      post(
        harness.base,
        CLOUD_ROUTES.lease,
        { workerId: "laptop-1", reason: "prelease", preferredAccountIdPrefix: "acct-live", pinned } satisfies LeaseRequest,
      )
    const rowOf = async () => {
      const view = JSON.parse(await (await fetch(`${harness.base}${CLOUD_ROUTES.usage}`)).text()) as UsageSnapshotView
      return view.accounts.find((row) => row.idPrefix === "acct-liv")
    }

    // Before any lease: held by nobody, pinned by nobody. The two empty arrays are what let the page
    // tell those apart from a master that does not track either.
    expect((await rowOf())?.holders).toEqual([])
    expect((await rowOf())?.pinnedBy).toEqual([])

    expect((await pinLease(true)).status).toBe(200)
    const pinnedRow = await rowOf()
    // The 📌 badge's data, and the SUBSET invariant both renderers depend on: a pinner is always also
    // a holder, so the page decorates one chip rather than drawing a second list.
    expect(pinnedRow?.holders).toEqual(["laptop-1"])
    expect(pinnedRow?.pinnedBy).toEqual(["laptop-1"])

    // The un-pin: the same request with the flag off. The hold survives — the worker is still using
    // the account — but the reservation is gone, which is precisely what the badge must stop claiming.
    expect((await pinLease(false)).status).toBe(200)
    const unpinnedRow = await rowOf()
    expect(unpinnedRow?.holders).toEqual(["laptop-1"])
    expect(unpinnedRow?.pinnedBy).toEqual([])
  } finally {
    harness.stop()
  }
})

// Regression for #59, at the level the incident actually happened: three sessions of one machine —
// same workerId, one shared auth.json, therefore one shared token — each hit the wall on `acct-a`
// within seconds, but each read its "current account" from a record a sibling had already rewritten.
// Unguarded, that walked the worker down the whole roster and cooled two healthy accounts.
test("a machine's sibling sessions cannot cascade one exhausted account into the whole roster", async () => {
  const harness = startHarness({ accounts: [account("acct-a"), account("acct-b"), account("acct-c")] })
  try {
    // Given: the worker has been on acct-a long enough to spend it
    const first = (await (await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)).json()) as LeaseResponse
    expect(first.accountId).toBe("acct-a")
    harness.advance(RATELIMIT_ADOPTION_GRACE_MS)

    // When: session 1 reports the real exhaustion and is moved off
    await post(harness.base, CLOUD_ROUTES.ratelimit, { workerId: WORKER_ID, accountId: "acct-a", headers: {} } satisfies RateLimitReport)
    const second = (await (
      await post(harness.base, CLOUD_ROUTES.lease, { workerId: WORKER_ID, reason: "ratelimit", currentAccountId: "acct-a" } satisfies LeaseRequest)
    ).json()) as LeaseResponse
    expect(second.accountId).toBe("acct-b")

    // And: three seconds later session 2 handles ITS copy of the same failure, by which time the
    // shared record already names acct-b — the misattribution this guard exists to catch.
    harness.advance(3_000)
    const ack = await post(harness.base, CLOUD_ROUTES.ratelimit, { workerId: WORKER_ID, accountId: "acct-b", headers: {} } satisfies RateLimitReport)
    const third = await post(
      harness.base,
      CLOUD_ROUTES.lease,
      { workerId: WORKER_ID, reason: "ratelimit", currentAccountId: "acct-b" } satisfies LeaseRequest,
    )

    // Then: the report is still ACKED — it is best-effort telemetry and the worker must not retry it —
    // but only the genuine exhaustion reached the cooldown book.
    expect(ack.status).toBe(204)
    expect(harness.reports).toEqual([{ accountId: "acct-a" }])

    // And: no rotation either — acct-b comes straight back and acct-c, untouched by any of this, is
    // not dragged in. Ranked selection is not consulted AT ALL, which is the assertion that would
    // have caught the first attempt at this fix: merely dropping the exclusion still rotates, because
    // round-robin's cursor has already moved past acct-b.
    expect(third.status).toBe(200)
    expect(((await third.json()) as LeaseResponse).accountId).toBe("acct-b")
    expect(harness.book()).toEqual([[WORKER_ID, "acct-b"]])
    expect(harness.picks.length).toBe(2)
  } finally {
    harness.stop()
  }
})

test("excludeAccountIds reaches the pick, so a second lease serves a DIFFERENT account", async () => {
  const harness = startHarness()
  try {
    // Given: the worker already holds acct-a and asks for one more slot
    const res = await post(harness.base, CLOUD_ROUTES.lease, {
      workerId: WORKER_ID,
      reason: "prelease",
      excludeAccountIds: ["acct-a"],
    })

    // Then: served, and it is the OTHER account — the whole point of a multi-slot worker
    expect(res.status).toBe(200)
    expect((await res.json()).accountId).toBe("acct-b")
    // AND the list arrived at the scheduler rather than being dropped at the boundary, which a
    // status-only assertion could not tell apart on a two-account pool.
    expect(harness.picks).toEqual([{ ids: ["acct-a", "acct-b"], workerId: WORKER_ID, excludeIds: ["acct-a"] }])
  } finally {
    harness.stop()
  }
})

test("a malformed excludeAccountIds is refused 400 before anything is picked or minted", async () => {
  const harness = startHarness()
  try {
    // Given/When: the right container, a member of the wrong type
    const res = await post(harness.base, CLOUD_ROUTES.lease, {
      workerId: WORKER_ID,
      reason: "prelease",
      excludeAccountIds: ["acct-a", 7],
    })

    // Then: 400 rather than a sanitised list. Dropping the bad member would let the pick hand back
    // an account this worker already holds, so one subscription would fill two token slots while
    // the dashboard reported two independent holds.
    expect(res.status).toBe(400)
    expect(harness.picks).toEqual([])
    expect(harness.refreshed).toEqual([])

    // AND the container itself must be an array: a bare string is the shape a hand-written client
    // reaches for first, and `"acct-a".includes(id)` would silently match substrings.
    const notArray = await post(harness.base, CLOUD_ROUTES.lease, {
      workerId: WORKER_ID,
      reason: "prelease",
      excludeAccountIds: "acct-a",
    })
    expect(notArray.status).toBe(400)
    expect(harness.picks).toEqual([])
  } finally {
    harness.stop()
  }
})

test("未登记的 worker 照常发牌，只留下一条可查的告警", async () => {
  // Given: a book that knows this machine but not the probe — the shape of the real incident, where a
  // one-off diagnostic label leased an account and left nothing behind but its hold.
  const harness = startHarness({ registeredWorkers: [WORKER_ID] })
  try {
    // When
    const stranger = await post(harness.base, CLOUD_ROUTES.lease, {
      workerId: "vince-diagnose",
      reason: "prelease",
    } satisfies LeaseRequest)

    // Then: SERVED. Phase one records the fact and changes no outcome — refusing here would reach the
    // operator through leaseClient's backoff as 连不上云端账号池, not as "this label is not registered".
    expect(stranger.status).toBe(200)
    expect(harness.book()).toEqual([["vince-diagnose", "acct-a"]])
    // AND leasing is not registering: a ledger that enrolled whoever showed up could only ever
    // confirm what had already happened.
    expect(harness.registered()).toEqual([WORKER_ID])
  } finally {
    harness.stop()
  }
})

test("登记 worker：首次 existing=false，重复 existing=true，并出现在 /v1/usage 的名单里", async () => {
  // Given
  const harness = startHarness()
  try {
    // When
    const first = await post(harness.base, CLOUD_ROUTES.workerRegister, { workerId: "vince-diagnose" })
    const again = await post(harness.base, CLOUD_ROUTES.workerRegister, { workerId: "vince-diagnose" })

    // Then
    expect(first.status).toBe(200)
    expect(await first.json()).toEqual({ workerId: "vince-diagnose", existing: false } satisfies WorkerRegisterResponse)
    // 200 and NOT 409: the book already says what the operator wanted it to say, and a refusal offers
    // a remedy for a state that needs none.
    expect(again.status).toBe(200)
    expect(await again.json()).toEqual({ workerId: "vince-diagnose", existing: true } satisfies WorkerRegisterResponse)

    // The page marks the holders that are NOT in this list, so the list has to reach it — and it
    // carries labels only, never the book's own registeredAt bookkeeping.
    const view = (await (await fetch(`${harness.base}${CLOUD_ROUTES.usage}`)).json()) as UsageSnapshotView
    expect(view.registeredWorkers).toEqual(["vince-diagnose"])
    expect(JSON.stringify(view)).not.toContain("registeredAt")
  } finally {
    harness.stop()
  }
})

test("登记路由拒绝畸形标签与非 POST，且一条都不记", async () => {
  // Given
  const harness = startHarness()
  try {
    // When
    const malformed = await post(harness.base, CLOUD_ROUTES.workerRegister, { workerId: "bad id/../with spaces" })
    const missing = await post(harness.base, CLOUD_ROUTES.workerRegister, {})
    const notJson = await post(harness.base, CLOUD_ROUTES.workerRegister, "{")
    const read = await fetch(`${harness.base}${CLOUD_ROUTES.workerRegister}`)

    // Then: 400 for every shape fault. A label the book holds but no lease can ever equal would read
    // as an unregistered worker forever, and the operator would keep pressing the button on it.
    expect([malformed.status, missing.status, notJson.status]).toEqual([400, 400, 400])
    // 405 rather than 404: the latter reads as "this master is too old to have the route", which is
    // the one thing that is not wrong here.
    expect(read.status).toBe(405)
    expect(harness.registered()).toEqual([])
  } finally {
    harness.stop()
  }
})

test("陌生标签的限流上报同样被记下，而报告仍然生效", async () => {
  // Given
  const harness = startHarness({ registeredWorkers: [WORKER_ID] })
  try {
    // When: the CHEAPER surface to abuse — a report needs no token at all and cools an account out of
    // selection for every worker in the pool.
    const res = await post(harness.base, CLOUD_ROUTES.ratelimit, {
      workerId: "vince-diagnose",
      accountId: "acct-a",
      headers: {},
    } satisfies RateLimitReport)

    // Then: still believed, because phase one changes no outcome anywhere — the cooled account is
    // duly skipped by the next pick.
    expect(res.status).toBe(204)
    expect(harness.reports).toEqual([{ accountId: "acct-a" }])
    const next = await post(harness.base, CLOUD_ROUTES.lease, PRELEASE)
    expect(((await next.json()) as LeaseResponse).accountId).toBe("acct-b")
  } finally {
    harness.stop()
  }
})
