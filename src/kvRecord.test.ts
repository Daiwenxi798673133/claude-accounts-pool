import { expect, test } from "bun:test"
import { writeKvRecord, type KvLike } from "./kvRecord.ts"

// 照 opencode 的 api.kv 行为造的假 kv:set 一个对象是【浅合并】进已有对象,值为 undefined 才删键
// (Solid store setter 的语义,issue #99)。用普通的"替换"kv 测不出这个 bug。
function solidLikeKv(): KvLike & { raw: () => Record<string, unknown> } {
  const store: Record<string, unknown> = {}
  return {
    get: <V>(key: string, fallback?: V): V => (key in store ? (store[key] as V) : (fallback as V)),
    set: (key, value) => {
      const existing = store[key]
      if (typeof existing === "object" && existing !== null && typeof value === "object" && value !== null) {
        for (const [k, v] of Object.entries(value)) {
          if (v === undefined) delete (existing as Record<string, unknown>)[k]
          else (existing as Record<string, unknown>)[k] = v
        }
      } else {
        store[key] = value
      }
    },
    raw: () => JSON.parse(JSON.stringify(store)) as Record<string, unknown>,
  }
}

test("浅合并的 kv 上,直接 set 一个快照删不掉旧键 —— 这就是 bug 本身", () => {
  const kv = solidLikeKv()
  kv.set("book", { a: 1, b: 2 })
  kv.set("book", { b: 2 })
  expect(kv.raw().book).toEqual({ a: 1, b: 2 })
})

test("writeKvRecord:快照里没有的键真的从存储里消失", () => {
  const kv = solidLikeKv()
  writeKvRecord(kv, "book", { a: 1, b: 2 })
  writeKvRecord(kv, "book", { b: 3 })
  expect(kv.raw().book).toEqual({ b: 3 })
  writeKvRecord(kv, "book", {})
  expect(kv.raw().book).toEqual({})
})

test("writeKvRecord:在替换语义的 kv 上同样正确(undefined 序列化时被丢掉)", () => {
  const store = new Map<string, unknown>()
  const kv: KvLike = { get: <V>(k: string, f?: V) => (store.has(k) ? (store.get(k) as V) : (f as V)), set: (k, v) => void store.set(k, v) }
  writeKvRecord(kv, "book", { a: 1 })
  writeKvRecord(kv, "book", { b: 2 })
  expect(JSON.parse(JSON.stringify(store.get("book")))).toEqual({ b: 2 })
})

test("writeKvRecord:存储里原来不是对象(没有、或坏了)也照常写", () => {
  const kv = solidLikeKv()
  kv.set("book", "garbage")
  writeKvRecord(kv, "book", { a: 1 })
  expect(kv.raw().book).toEqual({ a: 1 })
})
