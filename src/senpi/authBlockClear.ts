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
// slot rejoins selection. Only auth_error is cleared: a real rate-limit block (blockedUntil) is left
// for senpi's own clearExpiredBlocks to expire, or a genuinely throttled account would be hammered.
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

type SlotBlock = { blockReason?: string; blockedUntil?: number }
type OAuthCredential = { slotState?: Record<string, SlotBlock>; [key: string]: unknown }

// Returns the credential file with the slot's sticky auth_error removed, or undefined when there is
// nothing to clear — so the caller writes (and contends the lock) ONLY on the rare recovery turn,
// never on the steady-state publish. A malformed file throws to the caller, which leaves it to senpi.
export function withoutAuthBlock(raw: string, slotName: string): string | undefined {
  const parsed = JSON.parse(raw) as Record<string, unknown>
  const credential = parsed[CLAUDE_SDK_OAUTH_PROVIDER_ID]
  if (credential === null || typeof credential !== "object") return undefined
  const slotState = (credential as OAuthCredential).slotState
  if (slotState === undefined || typeof slotState !== "object") return undefined
  const entry = slotState[slotName]
  // Only the sticky kind. A `blockedUntil` rate-limit is senpi's to expire.
  if (!entry || entry.blockReason !== "auth_error") return undefined
  const nextSlotState = { ...slotState }
  delete nextSlotState[slotName]
  const nextCredential: OAuthCredential = { ...(credential as OAuthCredential) }
  if (Object.keys(nextSlotState).length === 0) delete nextCredential.slotState
  else nextCredential.slotState = nextSlotState
  // `null, 2` matches senpi's own writer so the file's shape is unchanged for a human diffing it.
  return JSON.stringify({ ...parsed, [CLAUDE_SDK_OAUTH_PROVIDER_ID]: nextCredential }, null, 2)
}

export async function clearEnvSlotAuthBlock(slotName: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const path = senpiAuthPath(env)
  if (path === undefined) return
  let raw: string
  try {
    raw = readFileSync(path, "utf-8")
  } catch {
    return // no auth.json yet — senpi has blocked nothing
  }
  // Cheap pre-check OUTSIDE the lock: only a sticky auth_error on this slot is worth contending for a
  // lock a running senpi may hold. The common publish finds nothing and never touches the file.
  let precheck: string | undefined
  try {
    precheck = withoutAuthBlock(raw, slotName)
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
      cleared = withoutAuthBlock(readFileSync(path, "utf-8"), slotName)
    } catch {
      cleared = undefined
    }
    if (cleared !== undefined) {
      // Plain write under the lock, exactly as senpi's own FileAuthStorageBackend does (same 0600).
      writeFileSync(path, cleared, { encoding: "utf-8", mode: 0o600 })
      chmodSync(path, 0o600)
      log.info("senpi:env-slot-unblocked", { slotName })
    }
  } catch (error) {
    log.warn("senpi:env-slot-unblock-fail", { slotName, error: error instanceof Error ? error.message : String(error) })
  } finally {
    if (release) await release().catch(() => {})
  }
}
