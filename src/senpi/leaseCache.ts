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
import { log } from "../logger.ts"

export type CachedLease = { accountId: string; access: string; expires: number }

const CACHE_FILE = "senpi-lease-cache.json"
const CACHE_VERSION = 1

// omo's launcher exports both of these into senpi's environment, so a worker started through `omo`
// lands next to the engine state it belongs to. The explicit override comes first for a worker that
// keeps pool state somewhere else, and the home-directory fallback is what a bare `senpi` gets.
function cacheDir(env: NodeJS.ProcessEnv): string {
  return env.CAP_LEASE_CACHE_DIR ?? env.SENPI_CODING_AGENT_DIR ?? env.OMO_CODING_AGENT_DIR ?? join(homedir(), ".claude-accounts-pool")
}

export function leaseCachePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(cacheDir(env), CACHE_FILE)
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
