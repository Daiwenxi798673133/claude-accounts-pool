// The MACHINE-WIDE critical section for one senpi token slot.
//
// WHY slotRoster.ts IS NOT ENOUGH. That file serialises the K slots inside ONE process, which was the
// whole story while a machine ran one senpi host. It does not: omo runs a TUI host, a `--mode rpc`
// shared host and one host per detached session, and every one of them loads this extension and
// installs its own keeper. Measured on one laptop: five hosts, all reading the same
// senpi-worker.json, so all leasing under the SAME workerId and the SAME slot name. Each mutated only
// its own process.env, each whole-file-overwrote senpi-lease-cache.json from its own map, and the
// master booked all five as ONE holder — so its exclusion set and holder count were wrong by
// construction. Worse, the process HOLDING a token stopped being the process RENEWING it, which is
// what defeats the lease horizon (INV-CLOUD-4): the horizon keeps a token ahead of the master's
// rotation only if whoever holds it is also whoever renews it.
//
// DECLINES INSTEAD OF WAITING, and that is the load-bearing decision. A lease can legitimately take
// ~10 minutes inside one call (leaseClient retries 8 times with a 5s→300s backoff), so a contender
// that blocked would be stuck behind a master outage for that long, then lease anyway — turning one
// slow renewal into N. A contender that declines simply does nothing this tick: the winner publishes
// into the shared cache and the loser adopts it on its next tick, or takes the lock itself if the
// winner failed. Skipping a tick is free; piling on is the bug.
//
// NOT withAuthLock (wrong resource, and it is not reentrant) and NOT senpi's auth.json lock — those
// 30s/10s parameters are a byte-for-byte mirror of senpi's own policy because they must be MUTUALLY
// exclusive with senpi's read-modify-write. This lock protects the pool's own file and answers to
// nobody else, so it gets its own parameters and its own lock target.
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { lock } from "proper-lockfile"
import { log } from "../logger.ts"
import { leaseCacheDir } from "./leaseCache.ts"

// `stale` only matters when a holder DIES: proper-lockfile refreshes a held lock's mtime every
// `update` ms, so a legitimate ten-minute hold is never stolen. 60s/15s therefore buys recovery from a
// killed host within a minute while leaving three refreshes of slack for a busy event loop.
const LOCK_OPTIONS = { realpath: false, stale: 60_000, update: 15_000 } as const

// Deliberately tiny: this budget is how long a contender waits before deciding to skip its tick, and a
// skipped tick costs nothing. Anything longer would reintroduce the queueing this module exists to
// avoid.
const LOCK_RETRIES = { retries: 2, minTimeout: 50, maxTimeout: 200 } as const

// proper-lockfile locks `<target>.lock`, so the target only has to exist. One file per SLOT, not one
// per machine: two slots renewing at once are not in conflict, and a single lock would serialise them
// for no reason.
function slotLockTarget(slotName: string, env: NodeJS.ProcessEnv): string {
  const dir = leaseCacheDir(env)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const target = join(dir, `senpi-slot-${slotName}.lock`)
  // `wx` so an existing target is left exactly as it is — the file is a lock anchor and carries no
  // content anyone reads.
  try {
    writeFileSync(target, "", { flag: "wx", mode: 0o600 })
  } catch {
    // Already there, which is the steady state.
  }
  return target
}

/**
 * Runs `fn` while this machine's lock for `slotName` is held. Answers `false` WITHOUT running it when
 * another process holds the lock, which the caller must treat as "not now" rather than as a failure:
 * nothing was attempted, so there is no setback to report and no backoff to charge.
 *
 * A lock we cannot even set up (unwritable directory) also answers `false`. Running `fn` unprotected
 * would be the one outcome this module exists to prevent, and the caller's next tick retries anyway.
 */
export async function withSlotLock(
  slotName: string,
  fn: () => Promise<void>,
  env: NodeJS.ProcessEnv = process.env,
): Promise<boolean> {
  let release: (() => Promise<void>) | undefined
  try {
    release = await lock(slotLockTarget(slotName, env), { ...LOCK_OPTIONS, retries: LOCK_RETRIES })
  } catch (error) {
    log.info("senpi:slot-lock-declined", { slotName, reason: error instanceof Error ? error.message : String(error) })
    return false
  }
  try {
    await fn()
    return true
  } finally {
    await release().catch(() => {})
  }
}
