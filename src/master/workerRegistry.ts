// The master's book of KNOWN worker labels, and the whole of what it buys: ACCOUNTABILITY, NOT
// ACCESS CONTROL. A workerId is self-declared and nothing on this wire authenticates it, so this
// book cannot keep a machine out of the pool — it can only say whether anyone ever told the pool
// that label was expected. That is the fault it was added for: a one-off diagnostic probe leased an
// account under `vince-diagnose`, nobody reclaimed the hold, and afterwards nothing on this master
// could answer "whose was that".
//
// PHASE ONE IS OBSERVE-ONLY. Nothing here refuses anything: leaseServer logs an unregistered label
// and serves it anyway. Refusing is a separate change with a failure mode of its own — leaseClient
// classifies an unfamiliar status as a transient fault and backs off for ~10 minutes, so "you are
// not registered" would reach the operator as 连不上云端账号池 — and is deliberately not wired here.
//
// A MAP, NOT A PLAIN OBJECT, for the membership test: a worker labelled `constructor` or `toString`
// must answer false, and `{}[label] !== undefined` answers true for both.

import { log } from "../logger.ts"

// Same namespace as the scheduler's cooldown book, because it is the same store and the same
// process: a grep for `claude-accounts-usage.master.` finds everything this master persists.
export const WORKER_REGISTRY_KV_KEY = "claude-accounts-usage.master.workers"

export type RegisteredWorker = { workerId: string; registeredAt: number }

export type WorkerRegistryDeps = {
  kv: { get: <V>(key: string, fallback?: V) => V; set: (key: string, value: unknown) => void }
  now?: () => number
}

export type WorkerRegistry = {
  isRegistered: (workerId: string) => boolean
  register: (workerId: string) => { existing: boolean }
  list: () => RegisteredWorker[]
}

export function createWorkerRegistry(deps: WorkerRegistryDeps): WorkerRegistry {
  const now = deps.now ?? Date.now
  const registered = new Map<string, number>()

  // The stored value is a CLAIM, not a proof — it came back from an untyped JSON store — hence the
  // per-entry shape check. A malformed instant drops that one label rather than the whole book: the
  // book is monitoring data, and losing all of it because one entry rotted is the worse failure.
  const stored = deps.kv.get<Record<string, number>>(WORKER_REGISTRY_KV_KEY, {})
  for (const [workerId, registeredAt] of Object.entries(stored ?? {})) {
    if (typeof registeredAt !== "number" || !Number.isFinite(registeredAt)) continue
    registered.set(workerId, registeredAt)
  }

  function persist(): void {
    const snapshot: Record<string, number> = {}
    for (const [workerId, registeredAt] of registered) snapshot[workerId] = registeredAt
    deps.kv.set(WORKER_REGISTRY_KV_KEY, snapshot)
  }

  return {
    isRegistered: (workerId) => registered.has(workerId),
    // The label's SHAPE is checked at the HTTP boundary (isWorkerLabel), which is also the only
    // caller: this store keeps whatever key it is handed, so validating twice would put the rule in
    // two places and let them drift.
    register: (workerId) => {
      if (registered.has(workerId)) return { existing: true }
      // The FIRST registration is the fact worth keeping, so a re-register above returns before this
      // and never moves the instant. "When was this machine first expected" survives; "when did
      // somebody last press the button" was never asked for.
      registered.set(workerId, now())
      persist()
      log.info("master:worker-registered", { workerId })
      return { existing: false }
    },
    // Registrations never expire and are never swept: unlike a cooldown, the entry is a statement
    // about a machine rather than about a deadline, and a label that stops leasing is exactly the
    // one an operator still wants to be able to look up.
    list: () => [...registered].map(([workerId, registeredAt]) => ({ workerId, registeredAt })),
  }
}
