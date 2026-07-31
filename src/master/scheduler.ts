import { providerOf, type StoredAccount } from "../accounts.ts"
import { MASTER_USAGE_POLL_INTERVAL_MS } from "../constants.ts"
import { latestMaxedReset, PROVIDERS, scoreWindows } from "../providers.ts"
import type { UsageResponse } from "../usage.ts"

// Which account should the next lease use? That is the whole job of this module: no network, no
// token handling, no disk. Usage snapshots arrive from outside via setUsageCache.
//
// The cooldown model below is REIMPLEMENTED from src/autoswitch.ts rather than imported, and that
// is deliberate: autoswitch owns TUI concerns (it takes a TuiPluginApi, subscribes to session
// events, toasts, opens dialogs, re-prompts sessions), so importing it here would drag a whole TUI
// runtime into a headless master process and make this module untestable without one. Only the
// proven slice is carried over — the two-map cooldown book and the pool filter — and the shared
// PURE helpers (scoreWindows / latestMaxedReset / PROVIDERS.anthropic.normalize) really are
// imported, so scoring and reset resolution keep exactly one implementation.
//
// DELIBERATELY NO STICKINESS. There is no worker→account affinity anywhere in this file: the owner
// chose maximum throughput (usage-based rotation) over prompt-cache locality. Do not add one.

const COOLDOWN_KV_KEY = "claude-accounts-usage.master.cooldown"

// A snapshot older than two whole poll intervals means POLLING is broken, not that the accounts are
// idle — `/api/oauth/usage` is known to stay angry long past the request that upset it. Ranking by
// numbers that stale keeps aiming every worker at an account that has since been drained, so past
// this age the pick falls back to round-robin. Derived from the poll interval so changing the poll
// cadence cannot silently invalidate this window.
const USAGE_CACHE_TTL_MS = 2 * MASTER_USAGE_POLL_INTERVAL_MS

export type SchedulerDeps = {
  kv: { get: <V>(key: string, fallback?: V) => V; set: (key: string, value: unknown) => void }
  // Injected so tests can drive recovery deterministically. EVERY time read in this module goes
  // through it; a stray Date.now() would silently escape the injected clock.
  now?: () => number
}

export type UsageSnapshotEntry = { id: string; usage: UsageResponse }

export type PickInput = {
  accounts: StoredAccount[]
  // The account the caller is leaving (the worker's current lease), excluded from this pick and
  // used as the rotation anchor. NOT an affinity record — nothing here remembers the worker.
  exclude?: string
}

export type Scheduler = {
  pickAccount: (input: PickInput) => StoredAccount | undefined
  reportRateLimit: (accountId: string, resetsAt?: number) => void
  setUsageCache: (entries: UsageSnapshotEntry[]) => void
  isCoolingDown: (accountId: string) => boolean
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now
  // Cooling with a KNOWN deadline. The only map that is ever persisted, because it is the only one
  // holding an instant that survives a restart.
  const cooldown = new Map<string, number>()
  // Cooling with an UNKNOWN deadline (INV-M2). The SOLE encoding of "cooling, deadline unknown" —
  // never a sentinel inside `cooldown`, never handed to scheduleRecovery, where a fabricated
  // deadline clamps to ~1ms and fires a FALSE recovery. Mirrors autoswitch's cooldownPending.
  const cooldownPending = new Set<string>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  let usageCache: { at: number; byId: Map<string, UsageResponse> } = { at: 0, byId: new Map() }
  // Rotation cursor for the no-usage-data path. An id, not an index, so it stays meaningful when
  // the caller's account list changes shape between picks.
  let lastPickedId: string | undefined

  function persistCooldown(): void {
    const at = now()
    const snapshot: Record<string, number> = {}
    for (const [id, until] of cooldown) if (until > at) snapshot[id] = until
    deps.kv.set(COOLDOWN_KV_KEY, snapshot)
  }

  // Estimated recovery, exactly as in autoswitch: the deadline came from the caller (or from a
  // usage snapshot's resets_at), so an elapsed timer means the quota SHOULD be back. We do not
  // re-verify against the API before clearing — the account simply rejoins selection.
  function scheduleRecovery(id: string, until: number): void {
    const existing = recoveryTimers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      recoveryTimers.delete(id)
      cooldown.delete(id)
      persistCooldown()
    }, Math.max(0, until - now()))
    // The pool's recovery clock must never be the reason a process stays alive; the master's HTTP
    // server owns that decision.
    timer.unref?.()
    recoveryTimers.set(id, timer)
  }

  function markCooldown(id: string, until?: number): void {
    if (until !== undefined && Number.isFinite(until)) {
      cooldownPending.delete(id)
      cooldown.set(id, until)
      persistCooldown()
      scheduleRecovery(id, until)
      return
    }
    // INV-M2: an unknown deadline must never DOWNGRADE a known one. Two workers holding the same
    // account both hit the limit; only one response carried an authoritative reset. Letting the
    // second report erase it would also cancel the scheduled recovery and strand the account until
    // the next usage poll.
    const active = cooldown.get(id)
    if (active !== undefined && active > now()) return
    // An expired-but-unswept entry is leaving the map, so the store has to hear about it.
    if (cooldown.delete(id)) persistCooldown()
    cooldownPending.add(id)
  }

  function clearCooldown(id: string): void {
    const timer = recoveryTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      recoveryTimers.delete(id)
    }
    cooldownPending.delete(id)
    if (cooldown.delete(id)) persistCooldown()
  }

  function isCoolingDown(id: string): boolean {
    if (cooldownPending.has(id)) return true
    const until = cooldown.get(id)
    return until !== undefined && until > now()
  }

  // Pinned to the anthropic normalizer, matching the anthropic-only pool in pickAccount. `undefined`
  // scores +Infinity — the honest unknown, which sorts last rather than being guessed at.
  function score(id: string): number {
    const usage = usageCache.byId.get(id)
    return scoreWindows(usage ? PROVIDERS.anthropic.normalize(usage) : undefined)
  }

  // Lowest utilization wins; `undefined` means "rank tells us nothing, rotate instead".
  // Reduce rather than sort: two accounts with no snapshot both score +Infinity, and
  // `Infinity - Infinity` is NaN — a comparator returning NaN leaves the order engine-defined.
  // A strict `<` keeps the earlier candidate and stays deterministic.
  function rankByUsage(candidates: StoredAccount[], at: number): StoredAccount | undefined {
    if (at - usageCache.at > USAGE_CACHE_TTL_MS) return undefined
    // A snapshot covering none of the candidates is not data: every score would be +Infinity and
    // the "ranking" would freeze selection onto whichever account happens to come first.
    if (!candidates.some((account) => usageCache.byId.has(account.id))) return undefined
    let best = candidates[0]
    let bestScore = score(best.id)
    for (const account of candidates) {
      const value = score(account.id)
      if (value < bestScore) {
        best = account
        bestScore = value
      }
    }
    return best
  }

  // Anchor = the caller's `exclude` when given (it names the account the worker is leaving, fresher
  // than our own bookkeeping), else the last account handed out. Rotation walks the FULL pool order
  // rather than the candidate list, so a cooling account still holds its slot and the survivors keep
  // their relative turn order instead of reshuffling every time someone cools.
  function roundRobin(pool: StoredAccount[], candidates: StoredAccount[], exclude?: string): StoredAccount {
    const anchor = exclude ?? lastPickedId
    const start = anchor === undefined ? -1 : pool.findIndex((account) => account.id === anchor)
    for (let offset = 1; offset <= pool.length; offset++) {
      const id = pool[(start + offset + pool.length) % pool.length].id
      const match = candidates.find((account) => account.id === id)
      if (match) return match
    }
    // Unreachable while candidates ⊆ pool, which pickAccount guarantees; kept as the total return.
    return candidates[0]
  }

  function pickAccount(input: PickInput): StoredAccount | undefined {
    const at = now()
    // INV-M1: a lease is written into the worker's auth.json `anthropic` entry, so the pool is
    // ANTHROPIC-only. Read through providerOf, never `account.provider === "anthropic"`: every
    // record written before multi-provider support lacks the field and would be dropped.
    const pool = input.accounts.filter((account) => providerOf(account) === "anthropic")
    const candidates = pool.filter(
      (account) => account.id !== input.exclude && !isCoolingDown(account.id) && !account.excluded && !account.needsReauth,
    )
    if (candidates.length === 0) return undefined
    const picked = rankByUsage(candidates, at) ?? roundRobin(pool, candidates, input.exclude)
    lastPickedId = picked.id
    return picked
  }

  function setUsageCache(entries: UsageSnapshotEntry[]): void {
    const byId = new Map<string, UsageResponse>()
    for (const entry of entries) byId.set(entry.id, entry.usage)
    usageCache = { at: now(), byId }
    // The ONLY path that can resolve a deadline-less cooldown, so an INV-M2 exclusion is never
    // permanent: a fresh snapshot either supplies the real reset (upgrade to a timed cooldown, and
    // automatic recovery becomes possible again) or shows the account is no longer at the limit
    // (drop it). An account MISSING from the snapshot taught us nothing and keeps cooling —
    // absence of data is not evidence of recovery.
    for (const id of [...cooldownPending]) {
      const usage = byId.get(id)
      if (!usage) continue
      const resetsAt = latestMaxedReset(PROVIDERS.anthropic.normalize(usage), now())
      if (resetsAt !== undefined) markCooldown(id, resetsAt)
      else clearCooldown(id)
    }
  }

  // Restore on construction so a master restart does not re-lease accounts that are still spent.
  // The stored type is a claim, not a proof (it came back from an untyped JSON store), hence the
  // runtime shape check; already-expired entries are DROPPED rather than restored, since they are
  // not cooldowns any more and carrying them would grow the stored object without bound.
  const stored = deps.kv.get<Record<string, number>>(COOLDOWN_KV_KEY, {})
  const startedAt = now()
  for (const [id, until] of Object.entries(stored ?? {})) {
    if (typeof until !== "number" || until <= startedAt) continue
    cooldown.set(id, until)
    scheduleRecovery(id, until)
  }

  return {
    pickAccount,
    reportRateLimit: (accountId: string, resetsAt?: number) => markCooldown(accountId, resetsAt),
    setUsageCache,
    isCoolingDown,
  }
}
