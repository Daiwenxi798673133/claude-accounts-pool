// Writing a whole record (id → value) into opencode's TUI `api.kv` so that entries which LEFT really go.
//
// `api.kv.set(key, value)` is a Solid store setter underneath (opencode: `set(g,k){l(g,k); …}` with
// `[e, l] = createStore(…)`). Solid SHALLOW-MERGES an object value into what is already there — it never
// replaces it. So writing "the snapshot of what should be stored now" removes nothing: a cooldown cleared
// early, an entry that expired, an affinity that lapsed all stay in kv.json, and whatever is still in the
// future comes back on the next restart. Measured on the master (issue #99): the cooldown book still held
// the eaaa1a79 deadline the poll had just cleared, next to entries that expired in August.
//
// The only delete Solid offers through that setter is an explicit `undefined`. So every key that is in
// the store but not in the snapshot is written as `undefined`. A store that REPLACES instead (the tests'
// in-memory kv) serializes those away just the same, so this is correct under both semantics.
export type KvLike = {
  get: <V>(key: string, fallback?: V) => V
  set: (key: string, value: unknown) => void
}

export function writeKvRecord(kv: KvLike, key: string, snapshot: Record<string, unknown>): void {
  const previous = kv.get<unknown>(key, undefined)
  const next: Record<string, unknown> = { ...snapshot }
  if (typeof previous === "object" && previous !== null && !Array.isArray(previous)) {
    for (const id of Object.keys(previous)) if (!Object.hasOwn(snapshot, id)) next[id] = undefined
  }
  kv.set(key, next)
}
