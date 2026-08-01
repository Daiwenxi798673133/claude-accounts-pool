import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { POOLKEY_SLIDE_MIN_INTERVAL_MS, POOLKEY_TTL_MS } from "../constants.ts"
import { createRegistry, type PoolKeyRecord, type RegistryDeps } from "./registry.ts"

// In-memory Map-backed kv stub matching the opencode plugin `api.kv` shape exactly
// (get<V>(key, fallback?): V; set(key, value): void) — NOT a real TuiPluginApi. `writes` counts
// set() calls: several guarantees here are about how OFTEN the registry persists, not just what
// it persists, and a counter is the only way to observe that.
function createKvStub(): { kv: RegistryDeps["kv"]; store: Map<string, unknown>; writes: () => number } {
  const store = new Map<string, unknown>()
  let writes = 0
  return {
    kv: {
      get<V>(key: string, fallback?: V): V {
        return (store.has(key) ? store.get(key) : fallback) as V
      },
      set(key: string, value: unknown): void {
        writes += 1
        store.set(key, value)
      },
    },
    store,
    writes: () => writes,
  }
}

const POOL_KEYS_KV_KEY = "claude-accounts-usage.master.poolkeys"
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex")
const persistedMap = (store: Map<string, unknown>) => store.get(POOL_KEYS_KV_KEY) as Record<string, PoolKeyRecord>

test("register issues sequential worker id and one-time plaintext key", () => {
  const { kv, store } = createKvStub()
  const registry = createRegistry({ kv })

  const first = registry.register("first-machine")
  const second = registry.register("second-machine")

  expect(first.workerId).toBe("worker-1")
  expect(second.workerId).toBe("worker-2")
  expect(first.key).not.toBe(second.key)
  expect(first.key.length).toBeGreaterThan(0)

  // Persisted state holds only the digest, never the plaintext — a dump of the kv store
  // must not recover a key that was already handed out.
  const persisted = persistedMap(store)
  expect(persisted["worker-1"].digest).toBe(sha256Hex(first.key))
  expect(persisted["worker-1"].digest).not.toBe(first.key)
  expect(persisted["worker-1"].label).toBe("first-machine")
  expect(registry.list().map((worker) => worker.workerId)).toEqual(["worker-1", "worker-2"])
})

test("verify maps valid key to workerId", () => {
  const { kv } = createKvStub()
  const registry = createRegistry({ kv })
  const { workerId, key } = registry.register("laptop")

  expect(registry.verify(`Bearer ${key}`)).toBe(workerId)
  // Scheme match is case-insensitive.
  expect(registry.verify(`bearer ${key}`)).toBe(workerId)
  expect(registry.verify(`BEARER ${key}`)).toBe(workerId)
})

test("verify rejects unknown and empty keys", () => {
  const { kv } = createKvStub()
  const registry = createRegistry({ kv })
  registry.register("laptop")

  expect(registry.verify(undefined)).toBeUndefined()
  expect(registry.verify(null)).toBeUndefined()
  expect(registry.verify("")).toBeUndefined()
  expect(registry.verify("Bearer ")).toBeUndefined()
  expect(registry.verify("Bearer")).toBeUndefined()
  expect(registry.verify("Basic dGVzdDp0ZXN0")).toBeUndefined()
  expect(registry.verify("Bearer not-a-real-key")).toBeUndefined()
})

// A gap in the issued ids is REACHABLE: revoking a worker (the stated reason pool keys are
// per-worker at all) or hand-editing the kv leaves e.g. {worker-1, worker-3}. Deriving the next
// id from the ENTRY COUNT then re-mints "worker-3" and silently overwrites a live worker's
// digest — that worker's key stops working with no error anywhere. The next id must therefore
// come from the highest issued number, never from how many entries happen to remain.
// This fixture also seeds BARE STRINGS on purpose: that is the legacy on-disk shape, so this test
// doubles as proof that the gap rule survives the migration.
test("register never reuses an id when the issued sequence has gaps", () => {
  const { kv, store } = createKvStub()
  const survivingDigest = sha256Hex("worker-3-key-issued-earlier")
  store.set(POOL_KEYS_KV_KEY, { "worker-1": sha256Hex("worker-1-key"), "worker-3": survivingDigest })

  const registry = createRegistry({ kv })
  const minted = registry.register("fresh-machine")

  expect(minted.workerId).toBe("worker-4")
  // The pre-existing worker-3 digest must survive untouched.
  const persisted = persistedMap(store)
  expect(persisted["worker-3"].digest).toBe(survivingDigest)
  expect(Object.keys(persisted).sort()).toEqual(["worker-1", "worker-3", "worker-4"])
})

test("keys persist as sha256 across reload", () => {
  const { kv, store } = createKvStub()
  const registryBeforeReload = createRegistry({ kv })
  const { workerId, key } = registryBeforeReload.register("laptop")

  // Simulate a process restart: a FRESH registry instance built from the SAME kv backing
  // store must still recognize a key issued by a previous instance.
  const registryAfterReload = createRegistry({ kv })
  expect(registryAfterReload.verify(`Bearer ${key}`)).toBe(workerId)
  expect(registryAfterReload.list().map((worker) => worker.workerId)).toEqual([workerId])

  const persisted = persistedMap(store)
  expect(persisted[workerId].digest).toMatch(/^[0-9a-f]{64}$/)
})

// The EXACT shape sitting in the deployed master's kv right now: one bare 64-hex digest under
// "worker-1", belonging to a machine that is leasing today. If the migration mis-reads it, that
// machine loses access the moment this ships.
test("a legacy bare-string entry from the deployed master still verifies", () => {
  const { kv, store } = createKvStub()
  store.set(POOL_KEYS_KV_KEY, { "worker-1": sha256Hex("some-key") })

  const registry = createRegistry({ kv })

  expect(registry.verify("Bearer some-key")).toBe("worker-1")
})

test("migration materialises every bare entry once, preserving each digest byte-for-byte", () => {
  const { kv, store, writes } = createKvStub()
  const legacyOne = sha256Hex("key-one")
  const legacyTwo = sha256Hex("key-two")
  store.set(POOL_KEYS_KV_KEY, { "worker-1": legacyOne, "worker-2": legacyTwo })
  const now = 1_700_000_000_000
  const registry = createRegistry({ kv, now: () => now })

  expect(registry.list()).toHaveLength(2)

  const persisted = persistedMap(store)
  expect(persisted["worker-1"]).toEqual({
    digest: legacyOne,
    label: "legacy",
    issuedAt: now,
    expiresAt: now + POOLKEY_TTL_MS,
  })
  expect(persisted["worker-2"].digest).toBe(legacyTwo)
  expect(writes()).toBe(1)

  // The whole-map migration is ONE-TIME per instance: later calls must not rewrite it.
  registry.list()
  expect(registry.verify("Bearer key-one")).toBe("worker-1")
  expect(writes()).toBe(1)
})

// createRegistry also runs in processes that never act as master. Migrating eagerly in the
// constructor would write to their kv for no reason, so construction alone must be inert.
test("a registry that is constructed but never called writes nothing", () => {
  const { kv, store, writes } = createKvStub()
  const legacy = { "worker-1": sha256Hex("live-key") }
  store.set(POOL_KEYS_KV_KEY, legacy)

  createRegistry({ kv })

  expect(writes()).toBe(0)
  expect(store.get(POOL_KEYS_KV_KEY)).toEqual(legacy)
})

test("an expired key is refused at its expiry instant and pruned from the map", () => {
  const { kv, store } = createKvStub()
  let now = 1_700_000_000_000
  const registry = createRegistry({ kv, now: () => now })
  const { workerId, key, expiresAt } = registry.register("laptop")
  expect(expiresAt).toBe(now + POOLKEY_TTL_MS)

  // One ms before expiry the key is still good. A full TTL has passed since the window was last
  // stamped, so this verify also slides it — which is what sets the next expiry instant below.
  now = expiresAt - 1
  expect(registry.verify(`Bearer ${key}`)).toBe(workerId)
  const slidExpiry = persistedMap(store)[workerId].expiresAt

  // At the expiry instant itself (not one ms past it) the key is refused AND removed.
  now = slidExpiry
  expect(registry.verify(`Bearer ${key}`)).toBeUndefined()
  expect(persistedMap(store)[workerId]).toBeUndefined()
})

test("a verify past the slide interval moves the persisted expiry to now + TTL", () => {
  const { kv, store } = createKvStub()
  let now = 1_700_000_000_000
  const registry = createRegistry({ kv, now: () => now })
  const { workerId, key } = registry.register("laptop")

  now += POOLKEY_SLIDE_MIN_INTERVAL_MS + 1
  expect(registry.verify(`Bearer ${key}`)).toBe(workerId)

  expect(persistedMap(store)[workerId].expiresAt).toBe(now + POOLKEY_TTL_MS)
})

test("verifies inside one slide interval cost no write beyond the migration and the first slide", () => {
  const { kv, store, writes } = createKvStub()
  let now = 1_700_000_000_000
  store.set(POOL_KEYS_KV_KEY, { "worker-1": sha256Hex("live-key") })
  const registry = createRegistry({ kv, now: () => now })

  // First call migrates (one write) and stamps the window at `now`, so it cannot also slide.
  expect(registry.verify("Bearer live-key")).toBe("worker-1")
  expect(writes()).toBe(1)

  // Past the floor: this one slide is persisted.
  now += POOLKEY_SLIDE_MIN_INTERVAL_MS + 1
  expect(registry.verify("Bearer live-key")).toBe("worker-1")
  expect(writes()).toBe(2)

  // Two more verifies inside the fresh interval. A worker leases every few minutes, so persisting
  // each of these would turn one lease into one kv write.
  now += 60_000
  expect(registry.verify("Bearer live-key")).toBe("worker-1")
  now += 60_000
  expect(registry.verify("Bearer live-key")).toBe("worker-1")
  expect(writes()).toBe(2)
})

// list() runs at install time (`registry.list().length` in the master's log line), so it must be
// read-only: a prune write there would fire on every master start.
test("list omits expired entries and never writes", () => {
  const { kv, store, writes } = createKvStub()
  const now = 1_700_000_000_000
  // Seeded as FULL records, so there is nothing to migrate and the write count must stay at zero.
  store.set(POOL_KEYS_KV_KEY, {
    "worker-1": { digest: sha256Hex("live"), label: "laptop", issuedAt: now - 1_000, expiresAt: now + 1_000 },
    "worker-2": { digest: sha256Hex("dead"), label: "old-ci", issuedAt: now - POOLKEY_TTL_MS, expiresAt: now },
  })
  const registry = createRegistry({ kv, now: () => now })

  expect(registry.list()).toEqual([
    { workerId: "worker-1", label: "laptop", issuedAt: now - 1_000, expiresAt: now + 1_000 },
  ])
  expect(writes()).toBe(0)
})

// INV-CLOUD-3 under expiry: the prune inside register() must not be able to lower the next id.
// Computing it from the POST-prune map here would mint "worker-1" — an id already handed out.
test("register keeps numbering above the highest id ever issued even when a prune empties the map", () => {
  const { kv, store } = createKvStub()
  const now = 1_700_000_000_000
  store.set(POOL_KEYS_KV_KEY, {
    "worker-1": { digest: sha256Hex("dead-1"), label: "gone", issuedAt: now - POOLKEY_TTL_MS, expiresAt: now - 1 },
    "worker-7": { digest: sha256Hex("dead-7"), label: "gone", issuedAt: now - POOLKEY_TTL_MS, expiresAt: now - 1 },
  })
  const registry = createRegistry({ kv, now: () => now })

  const minted = registry.register("fresh-machine")

  expect(minted.workerId).toBe("worker-8")
  expect(minted.expiresAt).toBe(now + POOLKEY_TTL_MS)
  expect(Object.keys(persistedMap(store))).toEqual(["worker-8"])
})

// The other half of that guarantee, pinned because it is the SURPRISING half: the id survives a
// prune only for as long as the record does. Once a verify() has already carried the highest entry
// out of the map, a later register() sees a lower ceiling and hands that number out again. Safe —
// the pruned digest is gone, so nothing that could still authenticate is overwritten — but it means
// `worker-N` is a slot, not a durable audit identity, and a reader who assumes otherwise is wrong.
test("an id IS handed out again once an earlier verify pruned the record that held it", () => {
  const { kv, store } = createKvStub()
  let now = 1_700_000_000_000
  const registry = createRegistry({ kv, now: () => now })
  const first = registry.register("laptop-a")
  expect(first.workerId).toBe("worker-1")

  // Past its expiry, and NOT renewed in between: verify refuses it and prunes it in that same call.
  now += POOLKEY_TTL_MS
  expect(registry.verify(`Bearer ${first.key}`)).toBeUndefined()
  expect(persistedMap(store)).toEqual({})

  expect(registry.register("laptop-b").workerId).toBe("worker-1")
  expect(persistedMap(store)["worker-1"]?.label).toBe("laptop-b")
})
