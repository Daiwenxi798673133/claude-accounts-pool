// Un-stick a pool-fed env slot that senpi has permanently auth-blocked.
//
// senpi's claude-sdk-oauth marks a slot `blockReason: "auth_error"` after a 401 and — for an
// env-sourced slot — PERSISTS it into auth.json's `slotState[<slot>]` (see failover.js persistBlock).
// That block is deliberately sticky: affinity.js clearExpiredBlocks retains auth blocks "until login
// refreshes the slot", and isBlocked() treats auth_error as blocked regardless of time. But a pool
// env slot has no login: the keeper silently overwrites CLAUDE_CODE_OAUTH_TOKEN with a fresh lease,
// which senpi never re-evaluates. So one transient 401 (a cold-start race, or a master-rotation gap
// where the published token was revoked before the keeper renewed) sidelines the pool account
// forever, and every turn falls onto senpi's own login accounts — the account the pool leased then
// shows 0% while a login account absorbs everything.
//
// This clears that sticky auth_error the moment we publish a lease we believe valid, so the healed
// slot rejoins selection.
//
// A RATE-LIMIT BLOCK IS CLEARED TOO, BUT ONLY ONCE THE SLOT'S ACCOUNT HAS CHANGED. senpi keys the
// block by SLOT NAME — an env slot's account name is the literal string "env" (accounts.js), never
// anything derived from the token — so a pool that multiplexes N accounts through one slot leaves the
// dead account's block sitting on top of its replacement. Reported from a live session: the operator
// hit a limit, switched account in /usage, and every turn still failed with "All Claude accounts are
// currently blocked" until the block expired. With `accounts: []` on the provider, one blocked slot
// IS "all accounts blocked" — the whole pool stops for up to MAX_RATE_LIMIT_BLOCK_MS (48h).
//
// The account having CHANGED is what makes that safe, and the distinction is the whole design: while
// the SAME account still occupies the slot its block is real and must stand, or clearing it would
// hammer a throttled account once per turn for as long as the limit lasts. Only a block describing an
// occupant that is no longer there is stale.
//
// WRITES senpi's auth.json — a live credentials file a SECOND omo process also writes. So it takes
// senpi's OWN lock (proper-lockfile with the same policy as dist/core/lockfile-policy.js) to stay
// mutually exclusive with senpi's read-modify-write and never clobber a concurrent token rotation.
// Everything else is best-effort: a lease must never fail because this could not run.
import { chmodSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { lock } from "proper-lockfile"
import { log } from "../logger.ts"

// senpi's provider id for the Claude Pro/Max OAuth pool. A stable string, not imported: the
// extension takes no dependency on senpi (see senpi-extension.ts).
export const CLAUDE_SDK_OAUTH_PROVIDER_ID = "claude-sdk-oauth"

// A byte-for-byte mirror of senpi's FILE_STORAGE_LOCK_OPTIONS. The values are load-bearing for
// MUTUAL EXCLUSION, not politeness: proper-lockfile refreshes a held lock's mtime every `update` ms
// and a contender steals after `stale` ms of no refresh, so a window narrower than senpi's would let
// this steal senpi's live lock (and vice versa). `realpath: false` matches senpi and also lets the
// lock resolve without walking symlinks.
const LOCK_OPTIONS = { realpath: false, stale: 30_000, update: 10_000 } as const

// The auth.json senpi actually reads. Its agent dir wins unconditionally in senpi's resolveAgentDir
// when the env var is set, and omo exports it into the extension's own environment; SENPI_ before
// OMO_ mirrors leaseCache's precedence. Undefined when neither is set — outside omo there is no
// senpi auth.json to touch, which is not a fault.
export function senpiAuthPath(env: NodeJS.ProcessEnv): string | undefined {
  const dir = env.SENPI_CODING_AGENT_DIR ?? env.OMO_CODING_AGENT_DIR
  return dir ? join(dir, "auth.json") : undefined
}

// Which blocks this call is entitled to drop. `auth-only` is the steady-state publish, where the slot
// still holds the same account; `account-changed` is a swap, where any block on the slot described the
// previous occupant.
export type BlockClearScope = "auth-only" | "account-changed"

type SlotBlock = { blockReason?: string; blockedUntil?: number }
type OAuthCredential = { slotState?: Record<string, SlotBlock>; [key: string]: unknown }

// Returns the credential file with the slot's sticky auth_error removed, or undefined when there is
// nothing to clear — so the caller writes (and contends the lock) ONLY on the rare recovery turn,
// never on the steady-state publish. A malformed file throws to the caller, which leaves it to senpi.
export function withoutSlotBlock(raw: string, slotName: string, scope: BlockClearScope): string | undefined {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const credential = parsed[CLAUDE_SDK_OAUTH_PROVIDER_ID]
  if (credential === null || typeof credential !== "object") return undefined
  const slotState = (credential as OAuthCredential).slotState
  if (slotState === undefined || typeof slotState !== "object") return undefined
  const entry = slotState[slotName]
  if (!entry) return undefined
  // The sticky kind always: it has no expiry and no login can ever clear a pool-fed slot.
  // Anything else only on a swap, where the block cannot describe the token now in the slot.
  const stale = entry.blockReason === "auth_error" || scope === "account-changed"
  if (!stale) return undefined
  const nextSlotState = { ...slotState }
  delete nextSlotState[slotName]
  const nextCredential: OAuthCredential = { ...(credential as OAuthCredential) }
  if (Object.keys(nextSlotState).length === 0) delete nextCredential.slotState
  else nextCredential.slotState = nextSlotState
  // `null, 2` matches senpi's own writer so the file's shape is unchanged for a human diffing it.
  return JSON.stringify({ ...parsed, [CLAUDE_SDK_OAUTH_PROVIDER_ID]: nextCredential }, null, 2)
}

export async function clearEnvSlotBlock(
  slotName: string,
  scope: BlockClearScope,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const path = senpiAuthPath(env)
  if (path === undefined) return
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return // no auth.json yet — senpi has blocked nothing
  }
  // Cheap pre-check OUTSIDE the lock: only a block this call may drop is worth contending for a lock a
  // running senpi may hold. The common publish finds nothing and never touches the file.
  let precheck: string | undefined
  try {
    precheck = withoutSlotBlock(raw, slotName, scope)
  } catch {
    return // a malformed auth.json is senpi's to own, not ours to rewrite
  }
  if (precheck === undefined) return
  let release: (() => Promise<void>) | undefined
  try {
    release = await lock(path, { ...LOCK_OPTIONS, retries: { retries: 3, minTimeout: 20, maxTimeout: 200 } })
    // Re-read UNDER the lock and recompute: the pre-check was unlocked, so senpi may have changed the
    // block in the gap. Write only if it still needs clearing, against the authoritative content.
    let cleared: string | undefined
    try {
      cleared = withoutSlotBlock(readFileSync(path, "utf-8"), slotName, scope)
    } catch {
      cleared = undefined
    }
    if (cleared !== undefined) {
      // Plain write under the lock, exactly as senpi's own FileAuthStorageBackend does (same 0600).
      writeFileSync(path, cleared, { encoding: "utf-8", mode: 0o600 })
      chmodSync(path, 0o600)
      log.info("senpi:env-slot-unblocked", { slotName, scope })
    }
  } catch (error) {
    log.warn("senpi:env-slot-unblock-fail", { slotName, scope, error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (release) await release().catch(() => {})
  }
}
