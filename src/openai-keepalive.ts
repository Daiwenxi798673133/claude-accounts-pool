import {
  applyToken,
  loadAccounts,
  providerOf,
  readOpenaiSlotState,
  saveAccounts,
  withAuthLock,
  type OpenaiOauth,
  type OpenaiSlotRead,
  type StoredAccount,
} from "./accounts.ts"
import { INACTIVE_REFRESH_THRESHOLD_MS, OPENAI_KEEPALIVE_ENABLED, OPENAI_QUARANTINE_MS } from "./constants.ts"
import { log } from "./logger.ts"
import { OPENAI_ID_PREFIX } from "./openai-slot.ts"
import { OpenaiRefreshFailedError, OpenaiRefreshRevokedError, refreshOpenaiToken } from "./openai-token.ts"

// KEEP-ALIVE REFRESH OF INACTIVE CHATGPT ACCOUNTS — the highest-risk path in this plugin. Read the
// slot-protocol header in openai-slot.ts before changing anything here.
//
// The single fact everything below rests on: codex (OpenCode's own built-in plugin) refreshes the
// auth.json `openai` entry LAZILY inside its per-request fetch wrapper, does NOT take our file
// lock, and touches ONLY whatever account currently OCCUPIES that entry. OpenAI rotates the refresh
// token on every use and answers a replayed one with `refresh_token_reused`, which revokes the WHOLE
// token family — the account is then permanently dead and the user must re-login. Safety therefore
// cannot come from the lock (codex ignores it); it comes from refusing to touch any chain codex
// might also touch.
//
// INV-O1, evaluated ENTIRELY inside ONE withAuthLock hold, against a FRESH read of auth.json:
//   refreshable(X) ⇔ (slot absent OR (X.accountId !== slot.accountId AND X.refresh !== slot.refresh))
//                    AND X has an accountId
//                    AND now - (X.lastActiveAt ?? 0) > OPENAI_QUARANTINE_MS
//                    AND !X.needsReauth
//                    AND X is near expiry (INACTIVE_REFRESH_THRESHOLD_MS)
//                    AND X is not in a 429 backoff
// Every term REFUSES when in doubt. There is no term here whose absence merely degrades us: each
// one is the difference between skipping a refresh and bricking a user's account.

const REFRESH_429_COOLDOWN_MS = 5 * 60_000

const refresh429Cooldown = new Map<string, number>()

export type OpenaiKeepaliveSkip =
  | "flag-off"
  | "not-found"
  | "not-openai"
  | "no-account-id"
  | "accountid-drift"
  | "slot-unreadable"
  | "slot-occupant"
  | "unknown-history"
  | "quarantine"
  | "needs-reauth"
  | "not-stale"
  | "cooldown-429"

export type OpenaiKeepaliveOutcome = { refreshed: boolean; skipped?: OpenaiKeepaliveSkip; needsReauth?: boolean }

// INV-O1's exclusion term. `slot` MUST come from a read taken inside the CURRENT lock hold.
// BOTH comparisons are required and EITHER match refuses: accountId catches the ordinary case, and
// refresh-string equality catches a slot whose accountId is missing or has drifted away from the
// record's. Note `account.accountId === slot.accountId` is also true when BOTH are undefined — that
// is deliberate, it is the "cannot tell these apart" case and refusing is the only safe answer.
function isSlotOccupant(account: StoredAccount, slot: OpenaiOauth): boolean {
  return account.accountId === slot.accountId || account.refresh === slot.refresh
}

// Same rule as usage.ts's isStale(account, INACTIVE_REFRESH_THRESHOLD_MS), re-stated rather than
// imported: importing usage.ts here would put Anthropic's refreshToken (platform.claude.com) in
// scope of the one module that handles ChatGPT refresh tokens, which is exactly the cross-provider
// disclosure INV-P1 exists to make unrepresentable.
function isStale(account: StoredAccount): boolean {
  return !account.access || !account.expires || account.expires < Date.now() + INACTIVE_REFRESH_THRESHOLD_MS
}

function isRefresh429Cooldown(refresh: string): boolean {
  const until = refresh429Cooldown.get(refresh)
  if (!until) return false
  if (Date.now() >= until) {
    refresh429Cooldown.delete(refresh)
    return false
  }
  return true
}

// Returns the reason this account must NOT be refreshed, or undefined when INV-O1 holds for it.
// EVERY branch here fails CLOSED: an input that is missing, malformed or unreadable must produce a
// refusal, never permission. "Unknown ⇒ allow" anywhere in this function is a bug of the worst kind
// available in this codebase, because what it permits is a POST that can permanently kill a user's
// account. Conjuncts below are ordered cheapest-first only for the quality of the logged reason.
function refuse(account: StoredAccount, read: OpenaiSlotRead, now: number): OpenaiKeepaliveSkip | undefined {
  // INV-P1 choke point, same role as switchToAccount's: a caller handing an anthropic id here would
  // POST that account's refresh token to auth.openai.com, and the resulting 400 would brand a
  // healthy Claude account as needing re-login.
  if (providerOf(account) !== "openai") return "not-openai"
  // STRICTER THAN THE INV-O1 FORMULA, on purpose. A record with no accountId cannot be compared to
  // the slot by identity, so the only thing left between it and the occupant is refresh-string
  // equality — and that compares the CURRENT tip only. A STALE copy of the occupant's family passes
  // that test and still kills the account when POSTed, because `refresh_token_reused` revokes the
  // FAMILY, not just the one token. Nothing we write can produce such a record (absorbOpenaiSlot
  // requires an accountId, and switchToOpenaiAccount refuses a target without one), so refusing
  // costs no real coverage and removes the whole class. Never relax this to "warn and continue".
  if (!account.accountId) return "no-account-id"
  // INV-O1 rests on account.accountId being HONEST, and this is the one place that can check it
  // cheaply: absorbOpenaiSlot keys every record it creates as `openai:<accountId>` and never
  // rewrites accountId afterwards, so a record whose id and accountId disagree has had one of the
  // two changed behind the other's back. Why a DRIFTED-but-present accountId is lethal rather than
  // merely untidy: if such a record's refresh is a STALE tip of the OCCUPANT's family, it defeats
  // both halves of the slot comparison at once (the accountId differs, and a stale tip differs from
  // the current one) — and revocation is FAMILY-scoped, so POSTing it kills the live occupant.
  // RESIDUAL that cannot be closed from here: a record created with an accountId that never matched
  // its chain in the first place would still pass. Nothing can produce one today, and keeping it
  // that way is exactly why the refresh below deliberately does not write fresh.accountId.
  if (account.id !== `${OPENAI_ID_PREFIX}${account.accountId}`) return "accountid-drift"
  // FAIL CLOSED on ignorance. This used to read `if (slot && isSlotOccupant(...))`, where a slot we
  // could not READ arrived as the same undefined as a slot that is genuinely empty — and the effect
  // of that `slot &&` was to skip the occupant check entirely, i.e. "we cannot see the slot,
  // therefore no chain is codex's". That inverts INV-O1's premise. An unreadable slot may still hold
  // a live occupant, so nothing is refreshable until we can see it again.
  if (read.state === "unreadable") return "slot-unreadable"
  // Only a DEFINITIVELY empty slot may skip the occupant check, and then the reasoning is sound
  // rather than assumed: no `openai` key, a `{type:"api"}` key, or an entry carrying no refresh all
  // mean codex holds no chain it could rotate, so every stored chain really is ours alone.
  if (read.state === "oauth" && isSlotOccupant(account, read.slot)) return "slot-occupant"
  // THE QUARANTINE, and it is NOT redundant with the check above — do not delete it as such. A
  // switch EVICTS an account from the slot while a codex request for it may still be in flight, and
  // that request will rotate the tip we just captured; refreshing inside that window is precisely
  // the replay we must never perform. lastActiveAt is stamped by absorbOpenaiSlot and is
  // PERSISTED, so "switch, quit immediately, relaunch" cannot reset it. No stamp at all ⇒ this
  // record has never been seen in the slot ⇒ not quarantined.
  //
  // WALL-CLOCK DEPENDENCE, accepted and undefendable with a persisted timestamp: this is INV-O1's
  // only time-based conjunct. A BACKWARD clock jump is safe (the delta reads negative, i.e. still
  // quarantined). A FORWARD jump larger than the window ages every stamp out at once and voids the
  // quarantine wholesale. The exposure is bounded: the CURRENT slot occupant is unaffected because
  // its protection is the accountId / refresh comparison above, which has no clock in it — so only
  // evicted and middle occupants are exposed, and any scenario able to move the clock that far
  // (long sleep, VM resume, NTP step) has almost certainly already killed those accounts' in-flight
  // codex requests along with their sockets.
  // FAIL CLOSED on a stamp that is absent or not a finite number, instead of the old `?? 0` reading
  // an absent stamp as "infinitely long ago" — the same unknown-⇒-allow shape as the slot check
  // above. Every openai record this codebase writes is created BY absorbOpenaiSlot, which stamps it
  // in the same breath, so a record without a usable stamp is one we did not write (a hand-edited
  // store) and its slot history is precisely the unknown the quarantine exists to refuse. It costs
  // nothing real: such a record becomes eligible as soon as it has been seen in the slot once.
  if (typeof account.lastActiveAt !== "number" || !Number.isFinite(account.lastActiveAt)) return "unknown-history"
  if (now - account.lastActiveAt <= OPENAI_QUARANTINE_MS) return "quarantine"
  if (account.needsReauth) return "needs-reauth"
  if (!isStale(account)) return "not-stale"
  if (isRefresh429Cooldown(account.refresh)) return "cooldown-429"
  return undefined
}

// Caller MUST already hold withAuthLock — it is sequential, not reentrant, so this never takes it.
async function flagRevoked(id: string, error: OpenaiRefreshRevokedError): Promise<OpenaiKeepaliveOutcome> {
  // Re-read BEFORE flagging, exactly as acquireInactiveAccess does. If another process rotated this
  // record while our POST was in flight, the account is perfectly healthy and the loser is us:
  // adopt the winner's tip instead of branding a live account dead. Reachable when our hold was
  // stolen after LOCK_STALE_MS (the machine slept inside the critical section). NEVER adopt a record
  // that is itself flagged — that would clear another process's dead-chain verdict.
  const latest = await loadAccounts()
  const rec = latest.accounts.find((item) => item.id === id)
  if (rec && !rec.needsReauth && rec.refresh !== error.refresh) {
    log.info("openai-keepalive:adopt-foreign-rotation", { id, label: rec.label })
    return { refreshed: false }
  }
  if (rec && !rec.needsReauth) {
    rec.needsReauth = true
    await saveAccounts(latest)
    log.warn("openai-keepalive:needs-reauth", { id, label: rec.label, code: error.code })
  }
  return { refreshed: false, needsReauth: true }
}

export async function keepOpenaiAccountFresh(id: string): Promise<OpenaiKeepaliveOutcome> {
  // Dark by default (see OPENAI_KEEPALIVE_ENABLED). Checked BEFORE withAuthLock so a dark build is
  // inert down to not even contending for the lock.
  if (!OPENAI_KEEPALIVE_ENABLED) return { refreshed: false, skipped: "flag-off" }
  return withAuthLock(async () => {
    // A FRESH read of auth.json, inside the lock, on EVERY call. This looks like something to hoist
    // out of the lock or to replace with file.openaiActiveId — do NEITHER. openaiActiveId is our own
    // bookkeeping and can be stale for reasons ranging from an out-of-band `opencode auth login` to
    // another OpenCode instance having switched accounts; believing it over the file on disk is
    // exactly how INV-O1 gets fooled into refreshing the live slot occupant.
    const read = await readOpenaiSlotState()
    const file = await loadAccounts()
    const account = file.accounts.find((item) => item.id === id)
    if (!account) return { refreshed: false, skipped: "not-found" }

    const skipped = refuse(account, read, Date.now())
    if (skipped) {
      log.debug("openai-keepalive:skip", { id, reason: skipped })
      if (skipped === "needs-reauth") return { refreshed: false, skipped, needsReauth: true }
      return { refreshed: false, skipped }
    }

    try {
      // The POST and its persist stay inside this one hold: a rotated token that is obtained but not
      // written is a LOST CHAIN TIP, and its family is then unrecoverable because nobody anywhere
      // holds a live token for it.
      //
      // A CRASH BETWEEN THE POST AND THE PERSIST is accepted deliberately, with NO watermark. That
      // family is already gone by the argument above, so there is nothing left to protect. The next
      // tick makes exactly ONE probe with the pre-rotation token, gets `refresh_token_reused` /
      // `invalid_grant`, and flows into the needsReauth path below — so the UI honestly says
      // "需重新登录" instead of retry-looping forever. That probe's own family revocation destroys
      // only tokens nobody holds, so it cannot deepen the loss.
      const fresh = await refreshOpenaiToken(account.refresh)
      // applyToken, never a spread-merge: it clears needsReauth atomically with the token write.
      //
      // fresh.accountId is deliberately NOT written, and this is a SAFETY rule, not tidiness. INV-O1
      // depends on account.accountId being HONEST: a record whose accountId is present but WRONG,
      // holding a stale tip of the slot occupant's family, satisfies both halves of the slot
      // comparison (accountId differs; a stale tip differs from the current one) and would be
      // POSTed — and because `refresh_token_reused` revokes the whole FAMILY, that POST kills the
      // live occupant, not just this record. The `accountid-drift` refusal above is the structural
      // half of the defence; this is the other half, because it is what keeps drift from arising in
      // the first place. Writing accountId here would ALSO desynchronise the record from its own id
      // (absorbOpenaiSlot keys records by `openai:<accountId>`), which is precisely the state that
      // refusal detects. Any future wave that starts writing accountId from a refresh response
      // reopens this path — do not.
      applyToken(account, { kind: "full", token: fresh })
      await saveAccounts(file)
      log.info("openai-keepalive:refreshed", { id, label: account.label, expires: fresh.expires })
      return { refreshed: true }
    } catch (error) {
      // Same backoff the anthropic refresh path applies to a 429, keyed by the refresh token rather
      // than the account so a rotation cannot inherit the previous tip's cooldown.
      if (error instanceof OpenaiRefreshFailedError && error.status === 429) {
        refresh429Cooldown.set(account.refresh, Date.now() + REFRESH_429_COOLDOWN_MS)
      }
      if (error instanceof OpenaiRefreshRevokedError) return flagRevoked(id, error)
      // Transient (5xx / network / malformed 200): rethrow untouched. Branding the account here
      // would turn a passing outage into a permanent "需重新登录", and the record still holds its
      // un-rotated token, so the next tick simply retries.
      throw error
    }
  })
}
