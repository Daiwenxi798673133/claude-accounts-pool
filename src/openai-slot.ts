import {
  activeIdOf,
  applyToken,
  atomicWriteJson,
  getAuthJsonPath,
  loadAccounts,
  providerOf,
  readJson,
  readOpenaiSlotState,
  saveAccounts,
  setActiveIdOf,
  withAuthLock,
  type AccountsFile,
  type AuthToken,
  type OpenaiOauth,
  type StoredAccount,
} from "./accounts.ts"
import { log } from "./logger.ts"

// THE OPENAI SLOT PROTOCOL. auth.json's `openai` entry (the "slot") has TWO independent
// writers:
//   - codex, OpenCode's own built-in plugin: refreshes LAZILY inside its per-request fetch
//     wrapper, ONLY for whatever account currently occupies the slot, and writes back through
//     OpenCode's API — it does NOT take our file lock.
//   - us.
// OpenAI refresh tokens ROTATE on use and the server answers `refresh_token_reused` for a
// replayed one, which revokes the WHOLE token family: the account is then permanently dead
// and the user must re-login. Safety therefore does NOT come from our lock (codex ignores
// it); it comes from one structural fact — CODEX ONLY EVER TOUCHES THE SLOT OCCUPANT.
//
// INV-O1 (mutual exclusion): we never refresh a chain codex might also refresh. Enforced in
//   wave 2b via OPENAI_QUARANTINE_MS measured from `lastActiveAt`, which absorbOpenaiSlot
//   below is responsible for stamping — get that stamp wrong and 2b's exclusion is void.
// INV-O2 (the tip is never destroyed): any write that overwrites the slot MUST, inside the
//   same lock and beforehand, capture the entry currently in the slot into the store keyed by
//   slot.accountId. A rotated token is only ever superseded, never dropped.
// INV-O3 (adopt, never re-assert): when the slot's occupant disagrees with our
//   `openaiActiveId`, THE SLOT IS THE TRUTH — capture it and move `openaiActiveId` to match.
//   Never rewrite what we merely believed was active back into the slot; blindly re-asserting
//   stale bookkeeping is the exact failure mode that bricked accounts in farion1231/cc-switch.

// Namespaces the store id so a captured ChatGPT account can never collide with the Anthropic
// profile uuid an anthropic record uses as its own id. Exported because it is also the ONLY
// machine-checkable link between a record's id and its accountId, which openai-keepalive.ts uses to
// refuse a record whose two identities have drifted apart (see its accountid-drift refusal).
export const OPENAI_ID_PREFIX = "openai:"

// The label absorbOpenaiSlot writes on INSERT, and the ONLY string backfillOpenaiLabel is
// allowed to overwrite. BOTH sides must derive it from here and neither may re-spell the shape
// by hand: if the writer and the recogniser ever drift apart the backfill stops matching, every
// ChatGPT row keeps its placeholder forever, and nothing fails loudly to say so.
export function placeholderOpenaiLabel(accountId: string): string {
  return `ChatGPT ${accountId.slice(0, 8)}`
}

type OpenaiSlotToken = AuthToken & { accountId: string }

// In-memory upsert of the slot occupant into the store. Locates the record by
// slot.accountId, NOT by openaiActiveId: OpenAI's auth entry carries its own account
// identity, which is strictly better than the anthropic path (that one needs a network
// profile call to identify the chain, and mis-attributes it whenever auth.json drifted out of
// band). Returns undefined when the slot cannot be attributed at all — such an entry is
// unstorable, and therefore also unoverwritable (see commitSlot).
// Deliberately does NOT touch openaiActiveId: INV-O3's adoption belongs to captureInLock
// only, because commitSlot absorbs an occupant it is EVICTING that same instant.
function absorbOpenaiSlot(file: AccountsFile, slot: OpenaiOauth): StoredAccount | undefined {
  const { refresh, accountId } = slot
  if (!refresh || !accountId) return undefined
  let record = file.accounts.find((item) => providerOf(item) === "openai" && item.accountId === accountId)
  if (!record) {
    // Placeholder label: the email lives behind a /wham/usage call and this path makes NO
    // network call, so it is left improvable rather than fabricated. Written on INSERT only,
    // so a later capture never clobbers a label the user renamed by hand.
    record = { id: `${OPENAI_ID_PREFIX}${accountId}`, label: placeholderOpenaiLabel(accountId), refresh, provider: "openai", accountId }
    file.accounts.push(record)
  }
  applyToken(record, { kind: "full", token: { refresh, access: slot.access, expires: slot.expires } })
  // INV-O1's foundation: "this record occupied the slot at time T" is what wave 2b's
  // OPENAI_QUARANTINE_MS is measured from. Stamped on every capture, not only on change.
  record.lastActiveAt = Date.now()
  return record
}

// Commits `token` into the slot. The caller MUST already hold withAuthLock — that lock is not
// reentrant, so this never takes it itself, exactly like writeAuthAnthropic.
//
// COMPACT READ-MODIFY-WRITE, deliberately: the read below is the LAST thing before
// atomicWriteJson and nothing but local filesystem I/O may come between them. codex rewrites
// the whole file without our lock, so this window is the only one in which its concurrent
// write can be clobbered; holding it to milliseconds instead of "the length of a network
// call" is the entire mitigation. Do NOT hoist this read, and never await a network call
// inside it.
async function commitSlot(token: OpenaiSlotToken, seenRefresh: string | undefined): Promise<void> {
  const path = await getAuthJsonPath()
  const auth = (await readJson<Record<string, unknown>>(path)) ?? {}
  const entry = auth["openai"]
  const raw = entry && typeof entry === "object" ? (entry as { type?: unknown }) : undefined

  // The `openai` key is SHARED between the ChatGPT OAuth flow and a plain API key. Silently
  // overwriting a key the user pasted would destroy it with no way to recover it.
  if (raw?.type === "api") throw new Error("auth.json 的 openai 条目是 API key,拒绝覆盖")
  const slot = raw?.type === "oauth" ? (entry as OpenaiOauth) : undefined
  // A refresh token we cannot attribute to any record: capture keys by accountId, so
  // overwriting this would drop an unidentifiable chain tip for good (INV-O2 forbids it).
  if (slot?.refresh && !slot.accountId) throw new Error("auth.json 的 openai 条目缺少 accountId,无法归档,拒绝覆盖")

  if (slot?.refresh && slot.refresh !== seenRefresh) {
    // INV-O2: codex rotated the tip between the caller's capture and this final read. Absorb
    // the NEWER tip before overwriting it — local files only, no network (see above).
    const file = await loadAccounts()
    if (absorbOpenaiSlot(file, slot)) {
      await saveAccounts(file)
      log.info("openai-slot:absorb-midflight-rotation")
    }
  }

  auth["openai"] = { type: "oauth", access: token.access ?? "", refresh: token.refresh, expires: token.expires ?? 0, accountId: token.accountId }
  await atomicWriteJson(path, auth)
  log.info("openai-slot:commit", { hasAccess: Boolean(token.access), expires: token.expires ?? 0 })
}

// Reads the slot and upserts its occupant into the store. NEVER throws when auth.json is missing,
// carries no `openai` entry, holds an api key, or holds an oauth entry we cannot attribute — this
// runs from a background tick and must not be able to break it.
//
// It is NO LONGER a pure no-op on those shapes, and that is the point: every one of them means the
// slot no longer holds what we believed was active, i.e. an eviction happened. The old early
// returns walked past those cases before anything could stamp a quarantine clock, so an occupant
// displaced by an `{type:"api"}` paste (or by a file we momentarily could not read) stayed frozen at
// whenever it was last seen and became refreshable the moment that stamp aged out.
// Caller MUST already hold withAuthLock.
async function captureInLock(): Promise<StoredAccount | undefined> {
  const read = await readOpenaiSlotState()
  const file = await loadAccounts()
  const record = read.state === "oauth" ? absorbOpenaiSlot(file, read.slot) : undefined
  const believedId = activeIdOf(file, "openai")

  // INV-O1, THE BROAD QUARANTINE. Fires whenever the occupant is not the record we believed was
  // active — including when there is no attributable occupant AT ALL, which is what makes the
  // unusable-slot shapes above stamp instead of slipping through.
  //
  // It stamps EVERY openai record, not only the one believedId names, and that is a deliberate
  // policy choice. We see the slot only at discrete moments, so an account that took the slot and
  // lost it again BETWEEN two of our observations is invisible to us and unstampable by name;
  // quarantining the whole pool closes that entire CLASS of holes instead of the single instance we
  // happened to witness. The cost is provably near zero: OPENAI_QUARANTINE_MS sits far below
  // INACTIVE_REFRESH_THRESHOLD_MS, the threshold that gates refreshing at all, so a quarantined
  // account is still refreshed while it holds 15+ minutes of validity — the quarantine can delay a
  // refresh but never STARVE one. Weigh that against the failure mode being avoided: a PERMANENTLY
  // DEAD account, on a path with zero real-machine coverage. Over-quarantining is the unambiguously
  // safe direction, the same asymmetry this codebase already applies to cooldowns ("over-cooling
  // only delays an account rejoining selection"). Do NOT narrow this back to believedId alone.
  const evicted = believedId !== record?.id
  if (evicted) {
    const at = Date.now()
    for (const item of file.accounts) if (providerOf(item) === "openai") item.lastActiveAt = at
  }

  if (!record) {
    // INV-O3 REQUIRES this clear. The slot is the truth, and an api-key entry, an absent `openai`
    // entry and an entry we cannot attribute all say the same thing: NO ChatGPT account occupies the
    // slot, therefore none is active. openaiActiveId is what marks a ChatGPT row "使用中", so leaving
    // it pointing at a record while the slot holds somebody else's credential is the panel asserting
    // something false — the same class of bug as the "In Use" ambiguity this whole feature exists to
    // fix (#47: the panel claimed a Claude account was in use while the conversation was routed to
    // GPT). Trading that correctness property for a scheduling convenience is not a trade.
    //
    // It ALSO happens to end the re-quarantine loop the previous shape had (believedId stayed set, so
    // every tick re-stamped the whole pool and keepalive never ran). That relief is a CONSEQUENCE, not
    // the reason — do NOT "optimise" this clear away on the grounds that the loop is gone anyway.
    //
    // SPLIT BY CAUSE, which is what makes the clear safe. After a clear, believedId and record are
    // both undefined next time, so `evicted` is false and no further quarantine fires — the evicted
    // occupant gets exactly ONE window. That is only sound when we KNOW the slot holds no chain of
    // codex's: an api key, no `openai` key, or an entry carrying no refresh. It is NOT sound when we
    // merely failed to READ the slot, because the file may still hold a live occupant — clearing then
    // would end the quarantine after one window and hand that live chain to the keepalive.
    // So on `unreadable` we quarantine but do NOT clear: an unreadable slot is not evidence of an
    // empty one, and asserting "nobody is active" from ignorance is the same falsehood as asserting
    // the wrong account. That deliberately keeps re-quarantining on every capture for as long as the
    // read keeps failing — conservative on BOTH axes at once (nothing is refreshed, and the panel
    // keeps its last known truth instead of inventing an empty one), and it self-heals the moment one
    // read succeeds.
    if (read.state !== "unreadable") setActiveIdOf(file, "openai", undefined)
    if (evicted) await saveAccounts(file)
    return undefined
  }
  // INV-O3: the slot is the truth, so bookkeeping follows the occupant here — never the
  // reverse. An occupant we did not put there (out-of-band `opencode auth login`, another
  // machine) is ADOPTED, not overwritten.
  setActiveIdOf(file, "openai", record.id)
  await saveAccounts(file)
  log.info("openai-slot:captured", { id: record.id, label: record.label, evicted })
  return record
}

export function captureOpenaiSlot(): Promise<StoredAccount | undefined> {
  return withAuthLock(captureInLock)
}

// Joins the live email onto the record it BELONGS to, closing the one gap absorbOpenaiSlot cannot:
// that path runs from a background tick and makes no network call, so on insert it can only write
// a placeholder. This consumes a /wham/usage result the panel ALREADY has — it issues no request of
// its own, and in particular never one for a non-occupant (there is no live token for those while
// OPENAI_KEEPALIVE_ENABLED is false).
//
// ATTRIBUTED BY accountId, NEVER BY openaiActiveId. The response was authenticated with a specific
// ChatGPT-Account-Id header, so its email describes that account and no other; the pointer, by
// contrast, can move between the fetch starting and this write landing (a codex handover, another
// instance switching), and keying on it would stamp account A's email onto account B's record —
// a persisted lie about identity, strictly worse than the placeholder it replaced (#47).
//
// Takes the lock itself, so it must never be called from inside another withAuthLock hold (that
// queue is sequential and not reentrant) — same rule switchToOpenaiAccount follows by calling the
// unwrapped captureInLock rather than captureOpenaiSlot.
export async function backfillOpenaiLabel(input: { accountId?: string; email?: string }): Promise<boolean> {
  const { accountId, email } = input
  // Before the lock on purpose: nothing to write must not queue behind anybody's critical section.
  if (!accountId || !email) return false
  return withAuthLock(async () => {
    const file = await loadAccounts()
    const record = file.accounts.find((item) => providerOf(item) === "openai" && item.accountId === accountId)
    // Byte-identical to the placeholder FOR THIS accountId or we leave it alone. That is the
    // README's standing promise that auto-capture never overwrites a label the user renamed by
    // hand, and it also stops a later email change from "correcting" a deliberate rename.
    if (!record || record.label !== placeholderOpenaiLabel(accountId)) return false
    record.label = email
    await saveAccounts(file)
    // The email is the label, so it is deliberately NOT logged here.
    log.info("openai-slot:label-backfill", { id: record.id })
    return true
  })
}

export function switchToOpenaiAccount(id: string): Promise<StoredAccount> {
  return withAuthLock(async () => {
    // INV-O2 + INV-O3 BEFORE anything else, and before the target is read out of the store:
    // absorb the outgoing occupant so a rotation codex performed since our last tick is
    // superseded rather than dropped. Order matters — resolving the target first would let a
    // switch to the account ALREADY in the slot write its own pre-rotation token back, which
    // is a replay (`refresh_token_reused`) and revokes the whole family.
    const outgoing = await captureInLock()

    const file = await loadAccounts()
    const target = file.accounts.find((account) => account.id === id)
    if (!target) throw new Error("account not found")
    // Structural guard, not a warning: a caller handing an anthropic id to the OPENAI slot
    // writer would file an anthropic chain under codex's entry (and vice versa).
    if (providerOf(target) !== "openai") throw new Error("该账号不是 ChatGPT 账号")
    if (target.needsReauth) {
      log.warn("openai-slot:switch-refuse-reauth", { id })
      throw new Error("账号需重新登录")
    }
    // Without an accountId the entry we are about to write would be unattributable, so the
    // NEXT switch away from it would have to refuse (see commitSlot). Never create that state.
    const { accountId } = target
    if (!accountId) throw new Error("该账号缺少 accountId,请重新登录 ChatGPT")

    // DELIBERATELY NOT REFRESHING THE TARGET, even when its access token is already expired.
    // This is the OPPOSITE of switchToAccount (the anthropic path) and it is intentional:
    // codex is the slot's sole refresher and will lazily rotate a stale token on its very
    // next request, so a POST from here would add a SECOND writer to a one-shot rotating
    // chain for zero benefit — and losing that race replays a rotated token, which revokes
    // the whole family and bricks the account permanently. If you came here to "align" the
    // two paths by adding the refresh back: don't.
    await commitSlot({ refresh: target.refresh, access: target.access, expires: target.expires, accountId }, outgoing?.refresh)

    // Bookkeeping LAST, and on a FRESH read: commitSlot may have absorbed a mid-flight
    // rotation into the store, so re-saving our pre-commit snapshot would erase that tip
    // (INV-O2). A crash between the slot write and this save leaves the slot as the truth and
    // the next capture re-adopts it (INV-O3) — self-healing either way.
    const latest = await loadAccounts()
    setActiveIdOf(latest, "openai", id)
    await saveAccounts(latest)
    log.info("openai-slot:switch-commit", { id, label: target.label })
    return target
  })
}
