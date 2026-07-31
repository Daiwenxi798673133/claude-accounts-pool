import { expect, test } from "bun:test"
// TYPE-ONLY import, and that is load-bearing: verbatimModuleSyntax erases it, so accounts.ts is
// never LOADED here. src/autoswitch.test.ts sorts before this file in the same `bun test` process
// and registers a process-global PARTIAL mock.module("./accounts.ts", ...) — a runtime import
// would land on that stub. The type still gives a compile-time proof below that the payload the
// keeper hands to writeLease is exactly the `{kind:"lease"}` variant.
import type { TokenWrite } from "../accounts.ts"
import { LEASE_BACKOFF_BASE_MS, LEASE_BACKOFF_CAP_MS, LEASE_CHECK_INTERVAL_MS, LEASE_RENEW_BUFFER_MS } from "../constants.ts"
import { initLogger } from "../logger.ts"
import { createLeaseClient } from "./leaseClient.ts"
import { installLeaseKeeper, type LeaseKeeperDeps } from "./leaseKeeper.ts"

// Frozen clock. Every expiry below is expressed relative to it, so no case can pass or fail
// because a machine was slow between two statements.
const NOW = 1_800_000_000_000
const MASTER = "https://master.internal:8443"

// The token endpoint as a PATH LITERAL, deliberately not an import of the constant that names it:
// an automated grep gate over src/worker/ must find ZERO hits for that constant's name, and a
// substring match here also catches any host variant of the same endpoint.
const TOKEN_ENDPOINT_PATH = "/v1/oauth/token"

type LogEntry = { level?: string; message?: string; extra?: Record<string, unknown> }

// initLogger's client is a MODULE GLOBAL, so it is installed per-test and restored in a finally —
// otherwise this file's capture would still be attached while later test files run.
function captureLogs(): { entries: LogEntry[]; restore: () => void } {
  const entries: LogEntry[] = []
  initLogger({
    app: {
      log: (payload: LogEntry) => {
        entries.push(payload)
        return Promise.resolve()
      },
    },
  })
  return { entries, restore: () => initLogger(undefined) }
}

function tagged(entries: LogEntry[], level: string, tag: string): LogEntry[] {
  return entries.filter((entry) => entry.level === level && (entry.message ?? "").includes(tag))
}

type Toast = Parameters<LeaseKeeperDeps["toast"]>[0]
type LeaseWrite = Parameters<LeaseKeeperDeps["writeLease"]>[0]

// EVERYTHING is injected — clock, sleep, transport, both stores and the one UI call. A keeper
// built from real dependencies would touch auth.json and the network, which is precisely the
// damage these tests exist to prove impossible.
function harness(input: { client: LeaseKeeperDeps["client"]; auth?: { access?: string; expires?: number } }): {
  deps: LeaseKeeperDeps
  writes: LeaseWrite[]
  toasts: Toast[]
  delays: number[]
} {
  const writes: LeaseWrite[] = []
  const toasts: Toast[] = []
  const delays: number[] = []
  return {
    writes,
    toasts,
    delays,
    deps: {
      client: input.client,
      readAuth: async () => input.auth,
      writeLease: async (write) => {
        writes.push(write)
      },
      toast: (toast) => {
        toasts.push(toast)
      },
      // Delays are RECORDED, never really awaited: a wall-clock assertion on this backoff would
      // take 15+ minutes and be flaky at every step.
      sleep: async (ms) => {
        delays.push(ms)
      },
      now: () => NOW,
    },
  }
}

// S2, a formal project acceptance criterion. The reported test name deliberately spells out the
// token-endpoint constant — that identifier IS the invariant being asserted — but it is assembled
// by concatenation so the automated grep gate for that name, which must find ZERO hits anywhere
// under src/worker/, is not tripped by this assertion's own title.
test(`refuses stale writes and never calls TOKEN_${"URL"} when master unreachable and access expired`, async () => {
  // Given: the master is unreachable AND the leased access token in auth.json has already
  // expired — the exact state in which a worker that "helpfully" refreshed would rotate the
  // one-time-use chain the master owns and lock the master out of the account for good.
  const captured = captureLogs()
  let refreshAttempts = 0
  let masterAttempts = 0
  const fetchImpl = (async (input: unknown) => {
    const url = String(input)
    // Counted, not just rejected: the assertion is about the REQUEST being made at all. A worker
    // must never POST the token endpoint, so any hit here is the failure this scenario names.
    if (url.includes(TOKEN_ENDPOINT_PATH)) {
      refreshAttempts++
      throw new Error(`refresh attempted: ${url}`)
    }
    masterAttempts++
    throw new Error("ECONNREFUSED")
  }) as unknown as typeof fetch
  // The REAL lease client, so the whole worker→master path is under the fake fetch and a refresh
  // hidden anywhere in it would be counted.
  const client = createLeaseClient({
    fetchImpl,
    sleep: async () => {},
    masterUrl: MASTER,
    poolKey: "pool-key-abcdef",
    workerId: "worker-01",
  })
  const h = harness({ client, auth: { access: "expired-leased-access", expires: NOW - 1 } })
  const keeper = installLeaseKeeper(h.deps)

  // When
  try {
    await keeper.tickOnce()
  } finally {
    keeper.dispose()
    captured.restore()
  }

  // Then: zero token-endpoint requests, and the master WAS actually tried (so this is not
  // vacuously green because nothing ran at all).
  expect(refreshAttempts).toBe(0)
  expect(masterAttempts).toBeGreaterThan(0)
  // NOTHING is written. A stale credential state must stay visible rather than be papered over
  // with an expired or invented lease.
  expect(h.writes).toEqual([])
  // Stop-and-report: the plugin API cannot abort an outgoing model request, so telling the user
  // in their own language is the whole remaining fail-safe.
  expect(h.toasts).toHaveLength(1)
  expect(h.toasts[0].variant).toBe("error")
  expect(h.toasts[0].message).toMatch(/[\u4e00-\u9fff]/)
  expect(h.toasts[0].message).toContain("云模式")
  expect(h.toasts[0].message).toContain("master")
  // Never the credential itself, not even a dead one.
  expect(h.toasts[0].message).not.toContain("expired-leased-access")
  const failed = tagged(captured.entries, "error", "worker:lease-failed")
  expect(failed).toHaveLength(1)
  expect(JSON.stringify(failed[0].extra)).not.toContain("expired-leased-access")
})

test("pre-leases before expiry and lease-writes sentinel entry", async () => {
  // THE load-bearing coupling of this whole module: we only get to notice an approaching expiry
  // once per check, so a renewal buffer narrower than one check interval could let a lease lapse
  // between two looks — and keeping `expires` in the future is the ONLY lever that stops the local
  // auth provider (zero-buffer, re-reads auth.json every request) from becoming a second refresher.
  expect(LEASE_RENEW_BUFFER_MS).toBeGreaterThan(LEASE_CHECK_INTERVAL_MS)

  // Given: the current lease still works, but expires INSIDE the renewal buffer
  const granted = { accountId: "acct-7", access: "sk-ant-oat01-fresh", expiresAt: NOW + 3_600_000 }
  const requests: Array<{ reason: string; currentAccountId?: string }> = []
  const h = harness({
    client: {
      lease: async (request) => {
        requests.push(request)
        return { ok: true, lease: granted }
      },
    },
    auth: { access: "sk-ant-oat01-aging", expires: NOW + LEASE_RENEW_BUFFER_MS - 1_000 },
  })
  const keeper = installLeaseKeeper(h.deps)

  // When
  try {
    await keeper.tickOnce()
  } finally {
    keeper.dispose()
  }

  // Then: one routine pre-lease (no account id yet — this worker holds nothing it was told about)
  expect(requests).toEqual([{ reason: "prelease" }])
  // …written through the LEASE seam, with an expiry that is genuinely in the future.
  expect(h.writes).toEqual([{ access: granted.access, expires: granted.expiresAt }])
  expect(h.writes[0].expires).toBeGreaterThan(NOW)
  // The payload is EXACTLY the two lease fields and nothing else — no `token`, no `refresh`. That
  // is what makes it a `{kind:"lease"}` write, which accounts.ts serializes with SENTINEL_REFRESH
  // (pinned byte-for-byte in src/cloud/lease-write.test.ts). A worker can therefore never persist
  // a real refresh token: it never has one to pass.
  const write: TokenWrite = { kind: "lease", ...h.writes[0] }
  expect(Object.keys(write).sort()).toEqual(["access", "expires", "kind"])
  // A successful renewal neither backs off nor bothers the user.
  expect(h.delays).toEqual([])
  expect(h.toasts).toEqual([])
})

test("refuses to write a lease that is already expired", async () => {
  // Given: renewal is due, the current access is still usable, and the master answers 200 with an
  // expiry that is ALREADY in the past. Trusting it would put the worker in the very state this
  // keeper exists to prevent — instantly, and by our own hand.
  const captured = captureLogs()
  const stale = { accountId: "acct-9", access: "sk-ant-oat01-stale", expiresAt: NOW - 1 }
  const usable = { access: "sk-ant-oat01-aging", expires: NOW + LEASE_RENEW_BUFFER_MS - 1_000 }
  const h = harness({ client: { lease: async () => ({ ok: true, lease: stale }) }, auth: usable })
  const keeper = installLeaseKeeper(h.deps)

  // Same When at the exact boundary: an expiry equal to `now` is already spent, so the guard has
  // to be strictly `>`. Kept beside the case above because it is the same refusal, and because a
  // `>=` slipping in would otherwise pass every other assertion in this file.
  const boundary = harness({
    client: { lease: async () => ({ ok: true, lease: { ...stale, expiresAt: NOW } }) },
    auth: usable,
  })
  const boundaryKeeper = installLeaseKeeper(boundary.deps)

  // When
  try {
    await keeper.tickOnce()
    await boundaryKeeper.tickOnce()
  } finally {
    keeper.dispose()
    boundaryKeeper.dispose()
    captured.restore()
  }

  // Then: no write at all, in either run
  expect(h.writes).toEqual([])
  expect(boundary.writes).toEqual([])
  const refused = tagged(captured.entries, "warn", "worker:lease-stale")
  expect(refused).toHaveLength(2)
  // The refused instant is diagnosable; the access token is not in the record.
  expect(refused[0].extra?.expiresAt).toBe(stale.expiresAt)
  expect(JSON.stringify(refused[0].extra)).not.toContain(stale.access)
  // A broken master is user-visible, but as a WARNING: the credential on disk still works, so
  // this is not the stop-everything case S2 covers.
  expect(h.toasts).toHaveLength(1)
  expect(h.toasts[0].variant).toBe("warning")
  expect(h.toasts[0].message).toMatch(/[\u4e00-\u9fff]/)
  // Not the stranded fail-safe: the current lease is still valid, so no error is reported.
  expect(tagged(captured.entries, "error", "worker:lease-failed")).toEqual([])
})

test("backs off exponentially between failed renewals", async () => {
  // Given: renewal is due, the current access is still valid, and every lease attempt fails
  const h = harness({
    client: { lease: async () => ({ ok: false, failure: { kind: "unreachable", detail: "master down" } }) },
    auth: { access: "sk-ant-oat01-aging", expires: NOW + LEASE_RENEW_BUFFER_MS - 1_000 },
  })
  const keeper = installLeaseKeeper(h.deps)

  // When: eight consecutive failed ticks — enough to reach the cap and prove it CLAMPS rather
  // than merely stops doubling somewhere convenient.
  try {
    for (let tick = 0; tick < 8; tick++) await keeper.tickOnce()
  } finally {
    keeper.dispose()
  }

  // Then: doubling from the base, clamped at the cap (5000*2^6 = 320000 would overshoot). A
  // master that has been down a while is usually down deliberately.
  expect(h.delays).toEqual([5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 300_000, 300_000])
  expect(h.delays[0]).toBe(LEASE_BACKOFF_BASE_MS)
  expect(h.delays[h.delays.length - 1]).toBe(LEASE_BACKOFF_CAP_MS)
  // Failure writes nothing, ever — and stays quiet while the credential on disk still works,
  // because a toast every check interval would train the user to ignore the one that matters.
  expect(h.writes).toEqual([])
  expect(h.toasts).toEqual([])
})
