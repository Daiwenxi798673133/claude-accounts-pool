import { expect, test } from "bun:test"
import { createWorkerRegistry, WORKER_REGISTRY_KV_KEY } from "./workerRegistry.ts"

// An in-memory stand-in for api.kv with the same two verbs the scheduler's book uses, kept as a Map
// so a test can read back exactly what was persisted rather than trusting the registry's own answer.
function fakeKv(seed?: unknown): { store: Map<string, unknown>; kv: { get: <V>(key: string, fallback?: V) => V; set: (key: string, value: unknown) => void } } {
  const store = new Map<string, unknown>()
  if (seed !== undefined) store.set(WORKER_REGISTRY_KV_KEY, seed)
  return {
    store,
    kv: {
      get: <V>(key: string, fallback?: V): V => (store.has(key) ? (store.get(key) as V) : (fallback as V)),
      set: (key: string, value: unknown): void => {
        store.set(key, value)
      },
    },
  }
}

test("未登记的标签答 false，登记之后答 true 并落进 kv", () => {
  // Given
  const { store, kv } = fakeKv()
  const registry = createWorkerRegistry({ kv, now: () => 1_700_000_000_000 })

  // When / Then
  expect(registry.isRegistered("vince-diagnose")).toBe(false)
  expect(registry.register("vince-diagnose")).toEqual({ existing: false })
  expect(registry.isRegistered("vince-diagnose")).toBe(true)
  expect(store.get(WORKER_REGISTRY_KV_KEY)).toEqual({ "vince-diagnose": 1_700_000_000_000 })
})

test("重复登记回报 existing 且不改动首次登记时刻", () => {
  // Given
  let clock = 1_700_000_000_000
  const { store, kv } = fakeKv()
  const registry = createWorkerRegistry({ kv, now: () => clock })
  registry.register("vince-local")

  // When
  clock += 60_000
  const again = registry.register("vince-local")

  // Then
  expect(again).toEqual({ existing: true })
  expect(store.get(WORKER_REGISTRY_KV_KEY)).toEqual({ "vince-local": 1_700_000_000_000 })
  expect(registry.list()).toEqual([{ workerId: "vince-local", registeredAt: 1_700_000_000_000 }])
})

test("从 kv 恢复已登记名单，坏条目只丢自己那一条", () => {
  // Given: the shape a store returns after somebody hand-edited it, or after a version that wrote
  // another type. Only the rotten entry may be lost — the book is monitoring data, and dropping all
  // of it because one instant went bad is the worse failure.
  const { kv } = fakeKv({ "bond-local": 1_700_000_000_000, "mephisto": "yesterday", "lilith": Number.NaN })
  const registry = createWorkerRegistry({ kv })

  // Then
  expect(registry.isRegistered("bond-local")).toBe(true)
  expect(registry.isRegistered("mephisto")).toBe(false)
  expect(registry.isRegistered("lilith")).toBe(false)
  expect(registry.list()).toEqual([{ workerId: "bond-local", registeredAt: 1_700_000_000_000 }])
})

test("Object.prototype 上的名字不算已登记", () => {
  // Given: the reason the book is a Map. `{}["constructor"] !== undefined` is true, so a plain
  // object would report every one of these labels as registered without anyone registering them —
  // and under phase two that becomes a label that walks straight through the gate.
  const { kv } = fakeKv()
  const registry = createWorkerRegistry({ kv })

  // Then
  expect(registry.isRegistered("constructor")).toBe(false)
  expect(registry.isRegistered("toString")).toBe(false)
  expect(registry.isRegistered("__proto__")).toBe(false)
})

test("kv 里没有名单时构造出空名单，不抛异常", () => {
  // Given: a master booting for the first time after the upgrade, where api.kv answers the fallback.
  const { store, kv } = fakeKv()
  const registry = createWorkerRegistry({ kv })

  // Then: an EMPTY book, and nothing written until somebody registers — an untouched key is how a
  // reader tells "nobody has registered anything" from "this master never had a book".
  expect(registry.list()).toEqual([])
  expect(store.has(WORKER_REGISTRY_KV_KEY)).toBe(false)
})
