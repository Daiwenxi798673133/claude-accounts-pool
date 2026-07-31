import { expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { createRegistry, type RegistryDeps } from "./registry.ts"

// In-memory Map-backed kv stub matching the opencode plugin `api.kv` shape exactly
// (get<V>(key, fallback?): V; set(key, value): void) — NOT a real TuiPluginApi.
function createKvStub(): { kv: RegistryDeps["kv"]; store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  return {
    kv: {
      get<V>(key: string, fallback?: V): V {
        return (store.has(key) ? store.get(key) : fallback) as V
      },
      set(key: string, value: unknown): void {
        store.set(key, value)
      },
    },
    store,
  }
}

const POOL_KEYS_KV_KEY = "claude-accounts-usage.master.poolkeys"
const sha256Hex = (value: string) => createHash("sha256").update(value).digest("hex")

test("register issues sequential worker id and one-time plaintext key", () => {
  const { kv, store } = createKvStub()
  const registry = createRegistry({ kv })

  const first = registry.register()
  const second = registry.register()

  expect(first.workerId).toBe("worker-1")
  expect(second.workerId).toBe("worker-2")
  expect(first.poolKey).not.toBe(second.poolKey)
  expect(first.poolKey.length).toBeGreaterThan(0)

  // Persisted state holds only the digest, never the plaintext — a dump of the kv store
  // must not recover a key that was already handed out.
  const persisted = store.get(POOL_KEYS_KV_KEY) as Record<string, string>
  expect(persisted["worker-1"]).toBe(sha256Hex(first.poolKey))
  expect(persisted["worker-1"]).not.toBe(first.poolKey)
  expect(registry.list()).toEqual(["worker-1", "worker-2"])
})

test("verify maps valid key to workerId", () => {
  const { kv } = createKvStub()
  const registry = createRegistry({ kv })
  const { workerId, poolKey } = registry.register()

  expect(registry.verify(`Bearer ${poolKey}`)).toBe(workerId)
  // Scheme match is case-insensitive.
  expect(registry.verify(`bearer ${poolKey}`)).toBe(workerId)
  expect(registry.verify(`BEARER ${poolKey}`)).toBe(workerId)
})

test("verify rejects unknown and empty keys", () => {
  const { kv } = createKvStub()
  const registry = createRegistry({ kv })
  registry.register()

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
test("register never reuses an id when the issued sequence has gaps", () => {
  const { kv, store } = createKvStub()
  const survivingDigest = sha256Hex("worker-3-key-issued-earlier")
  store.set(POOL_KEYS_KV_KEY, { "worker-1": sha256Hex("worker-1-key"), "worker-3": survivingDigest })

  const registry = createRegistry({ kv })
  const minted = registry.register()

  expect(minted.workerId).toBe("worker-4")
  // The pre-existing worker-3 digest must survive untouched.
  const persisted = store.get(POOL_KEYS_KV_KEY) as Record<string, string>
  expect(persisted["worker-3"]).toBe(survivingDigest)
  expect(Object.keys(persisted).sort()).toEqual(["worker-1", "worker-3", "worker-4"])
})

test("keys persist as sha256 across reload", () => {
  const { kv, store } = createKvStub()
  const registryBeforeReload = createRegistry({ kv })
  const { workerId, poolKey } = registryBeforeReload.register()

  // Simulate a process restart: a FRESH registry instance built from the SAME kv backing
  // store must still recognize a key issued by a previous instance.
  const registryAfterReload = createRegistry({ kv })
  expect(registryAfterReload.verify(`Bearer ${poolKey}`)).toBe(workerId)
  expect(registryAfterReload.list()).toEqual([workerId])

  const persisted = store.get(POOL_KEYS_KV_KEY) as Record<string, string>
  expect(persisted[workerId]).toMatch(/^[0-9a-f]{64}$/)
})
