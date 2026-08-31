// A warm copy of the last lease each senpi token slot held, so a cold start has a credential
// BEFORE senpi asks whether the provider is usable.
//
// WHY THIS EXISTS. senpi resolves provider availability while it is starting a turn, which is
// EARLIER than any hook an extension can await — `turn_start` fires after that question has already
// been answered. So a lease that begins when the extension loads cannot win: against a master on
// the same host it happened to land in time, against one across a VPN it does not, and the run dies
// with "No API key found for claude-sdk-oauth" while the pool sits there full of accounts.
//
// THE READ IS DELIBERATELY SYNCHRONOUS. An async read reintroduces exactly the race it exists to
// remove — the file would still be in flight when the availability check ran. Writes are async
// because nothing waits on them.
//
// A CACHED TOKEN IS A LIVE CREDENTIAL. The file is written 0600 through atomicWriteJson, and a
// token whose expiry has passed is dropped on read rather than published: senpi does not refresh an
// env slot, so a stale value would be sent upstream and answered 401.
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { atomicWriteJson } from "../accounts.ts"
import { LEASE_RENEW_BUFFER_MS } from "../constants.ts"
import { log } from "../logger.ts"

export type CachedLease = { accountId: string; access: string; expires: number }

const CACHE_FILE = "senpi-lease-cache.json"
const CACHE_VERSION = 1

// ONE DIRECTORY, OWNED BY THE POOL, RESOLVED THE SAME WAY FROM EVERYWHERE. An earlier version
// preferred senpi's agent dir (omo's launcher exports it) so state would sit beside the engine's.
// That split the feature in half: the setup command of the day ran OUTSIDE omo and never saw those
// variables, so it wrote the config to the home directory while the extension — running inside senpi,
// where the launcher does export them — looked in the agent dir and found nothing. "Configure once"
// silently did nothing. That command is gone, but the rule outlives it: anything reading or writing
// this state from outside a senpi process hits the same wall. Tidiness is not worth a split brain;
// the override stays for a worker that really does keep pool state elsewhere.
export function leaseCacheDir(env: NodeJS.ProcessEnv): string {
  return env.CAP_LEASE_CACHE_DIR ?? join(homedir(), ".claude-accounts-pool")
}

export function leaseCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(leaseCacheDir(env), CACHE_FILE)
}

function isCachedLease(value: unknown, at: number): value is CachedLease {
  if (typeof value !== "object" || value === null) return false
  const { accountId, access, expires } = value as Record<string, unknown>
  if (typeof accountId !== "string" || accountId.length === 0) return false
  if (typeof access !== "string" || access.length === 0) return false
  // Strictly greater: an expiry equal to now is already spent, the same judgement the keeper makes
  // before it agrees to write a lease at all.
  return typeof expires === "number" && Number.isFinite(expires) && expires > at
}

/**
 * Every slot whose cached lease is still usable. Unreadable file, wrong version, malformed entry and
 * expired entry all read as "nothing cached" — a cold start is a normal state, not a fault.
 */
export function readLeaseCache(env: NodeJS.ProcessEnv = process.env, at: number = Date.now()): Map<string, CachedLease> {
  const usable = new Map<string, CachedLease>()
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(leaseCachePath(env), "utf-8"))
  } catch {
    return usable
  }
  if (typeof raw !== "object" || raw === null) return usable
  const { version, slots } = raw as Record<string, unknown>
  if (version !== CACHE_VERSION || typeof slots !== "object" || slots === null) return usable
  for (const [slotName, entry] of Object.entries(slots as Record<string, unknown>)) {
    if (isCachedLease(entry, at)) usable.set(slotName, entry)
  }
  return usable
}

/**
 * The cached lease for `slotName` that is worth taking INSTEAD of spending a lease on the master, or
 * undefined. Called from inside the machine-wide slot lock, where a lease another senpi host published
 * is final — adopting it is what converges N hosts onto ONE account per slot instead of booking N.
 *
 * Four ways to answer no, and each is load-bearing:
 *   * `pinned` — the operator named this account by hand, so adopting somebody else's pick would
 *     reverse that instruction silently, and the master would never get the chance to refuse it.
 *   * nothing cached for this slot, which is an ordinary cold start.
 *   * the token is one this process already saw a 401 on. A REVOKED token is byte-identical to a live
 *     one and its horizon is still in the future, so the cache cannot rule it out on its own; without
 *     this the recovery path would invalidate a dead token and adopt the same bytes straight back.
 *   * already inside its own renewal window, where adopting would leave the slot due again at once.
 */
export function adoptableLease(input: {
  cached: Map<string, CachedLease>
  slotName: string
  deadAccess: ReadonlySet<string>
  pinned: boolean
  at: number
}): CachedLease | undefined {
  if (input.pinned) return undefined
  const shared = input.cached.get(input.slotName)
  if (shared === undefined) return undefined
  if (input.deadAccess.has(shared.access)) return undefined
  return shared.expires - input.at >= LEASE_RENEW_BUFFER_MS ? shared : undefined
}

/**
 * Best effort, and deliberately so: this file is an optimisation for the NEXT process, never the
 * source of truth for this one. A failure to persist must not fail the lease that just landed.
 */
export async function writeLeaseCache(slots: Map<string, CachedLease>, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  try {
    await atomicWriteJson(leaseCachePath(env), { version: CACHE_VERSION, slots: Object.fromEntries(slots) })
  } catch (error) {
    log.warn("senpi:lease-cache-write-fail", { error: error instanceof Error ? error.message : String(error) })
  }
}
