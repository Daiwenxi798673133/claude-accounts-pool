import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// WHY A SUBPROCESS (the openai-slot.test.ts / usage.test.ts reason): autoswitch.test.ts runs earlier
// in this `bun test` process and registers a process-global, un-evictable partial
// mock.module("./accounts.ts", ...) with no withAuthLock and no applyToken, so the real accounts.ts
// that openai-keepalive.ts links against cannot be imported here at all.
//
// WHY TWO CHILDREN: OPENAI_KEEPALIVE_ENABLED is the whole safety story, so both of its values must
// be exercised against the SAME fixture. The child mocks constants.ts by SPREADING the real module
// and overriding only that one flag, so every other constant (above all OPENAI_QUARANTINE_MS and
// INACTIVE_REFRESH_THRESHOLD_MS) is the shipped value — a hand-listed mock could make these tests
// pass against thresholds the product does not have.
const runnerSource = `
import { test, mock } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const SRC = process.env.CAU_SRC
const OUT = process.env.CAU_OUT
const FLAG = process.env.CAU_FLAG === "on"
const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token"

const dataHome = mkdtempSync(join(tmpdir(), "cau-ka-"))
process.env.XDG_DATA_HOME = dataHome
mkdirSync(join(dataHome, "opencode"), { recursive: true })
const authPath = join(dataHome, "opencode", "auth.json")

// accounts.ts derives ACCOUNTS_PATH from homedir() at module load and os.homedir() snapshots HOME at
// process START, so the PARENT passes HOME=<tmp> through the spawn env.
const accountsDir = join(homedir(), ".config", "opencode")
mkdirSync(accountsDir, { recursive: true })
const accountsPath = join(accountsDir, "claude-accounts.json")

const realConstants = await import(join(SRC, "constants.ts"))
mock.module(join(SRC, "constants.ts"), () => ({ ...realConstants, OPENAI_KEEPALIVE_ENABLED: FLAG }))

const QUARANTINE_MS = realConstants.OPENAI_QUARANTINE_MS

const future = () => Date.now() + 3600000
// Inside INACTIVE_REFRESH_THRESHOLD_MS (30 min) ⇒ near-expiry ⇒ eligible on the staleness term.
const soon = () => Date.now() + 10 * 60000
const oa = (access, refresh, expires, accountId) => ({ type: "oauth", access, refresh, expires, accountId })
const writeAuthRaw = (obj) => writeFileSync(authPath, JSON.stringify(obj))
const dropAuth = () => { try { unlinkSync(authPath) } catch {} }
// "The slot is DEFINITIVELY empty", which is what almost every scenario below means and which a
// MISSING file no longer expresses: readOpenaiSlotState reports an unreadable file as ignorance, and
// INV-O1 refuses on ignorance. Scenarios that want an empty slot must therefore present a file that
// parses and simply has no \`openai\` entry. Only the two scenarios whose SUBJECT is a bad read use
// dropAuth()/garbage.
const emptySlot = () => writeAuthRaw({})
const unreadableSlot = () => writeFileSync(authPath, "{ this is not json")
const writeAccounts = (obj) => writeFileSync(accountsPath, JSON.stringify(obj))
const accountsText = () => readFileSync(accountsPath, "utf8")
const authText = () => { try { return readFileSync(authPath, "utf8") } catch { return "<absent>" } }
const readAccounts = () => JSON.parse(accountsText())
const rec = (id) => readAccounts().accounts.find((item) => item.id === id)
// A ChatGPT record that satisfies EVERY INV-O1 term, so each scenario below breaks exactly the one
// term it is about: near-expiry token, and a lastActiveAt well past the quarantine window.
const oaRec = (accountId, refresh, extra) => ({
  id: "openai:" + accountId, label: "OA-" + accountId, refresh, access: refresh + "-a", expires: soon(),
  provider: "openai", accountId, lastActiveAt: Date.now() - 3 * QUARANTINE_MS, ...extra,
})

let fetches = 0
let openaiPosts = 0
let postedRefresh = []
let mode = "ok"
let slowMs = 0
let steal
const rotated = { access_token: "ka-a2", refresh_token: "ka-r2", expires_in: 3600 }
globalThis.fetch = (async (input, init) => {
  fetches++
  const url = String(input)
  if (url !== OPENAI_TOKEN_URL) return new Response("{}", { status: 200 })
  openaiPosts++
  try { postedRefresh.push(new URLSearchParams(String(init?.body)).get("refresh_token")) } catch {}
  if (slowMs) await new Promise((resolve) => setTimeout(resolve, slowMs))
  if (mode === "reused") return new Response(JSON.stringify({ error: { code: "refresh_token_reused" } }), { status: 400 })
  if (mode === "500") return new Response("<html>502 Bad Gateway</html>", { status: 500 })
  if (mode === "429") return new Response("", { status: 429 })
  if (mode === "steal") {
    // Simulates another process winning the rotation while our POST is in flight (reachable when our
    // lock hold was stolen after LOCK_STALE_MS), then answering our replay with the family verdict.
    if (steal) {
      const accs = readAccounts()
      const target = accs.accounts.find((item) => item.id === steal.id)
      if (target) {
        target.refresh = steal.refresh; target.access = steal.access; target.expires = steal.expires
        if (steal.flagged) target.needsReauth = true
        else delete target.needsReauth
        writeAccounts(accs)
      }
    }
    return new Response(JSON.stringify({ error: { code: "refresh_token_reused" } }), { status: 400 })
  }
  return new Response(JSON.stringify(rotated), { status: 200 })
})

const { keepOpenaiAccountFresh } = await import(join(SRC, "openai-keepalive.ts"))
const { keeperTick } = await import(join(SRC, "keeper.ts"))
const { withAuthLock } = await import(join(SRC, "accounts.ts"))
const { captureOpenaiSlot, switchToOpenaiAccount } = await import(join(SRC, "openai-slot.ts"))

const reset = (nextMode) => { fetches = 0; openaiPosts = 0; postedRefresh = []; mode = nextMode ?? "ok"; slowMs = 0; steal = undefined }
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
// Always "a session is running", so keepActiveFresh never self-refreshes an anthropic chain and the
// openai counters below can never be polluted by the anthropic path.
const tick = () => keeperTick(() => true)

const results = {}

// ---- THE FLAG GATE. Identical fixture in both children: one stale ChatGPT account, no slot at all
// (so capture is a no-op and the anthropic pass has nothing to do). Flag off ⇒ literally nothing.
// openaiActiveId is deliberately UNSET here. captureOpenaiSlot is NOT flag-gated, and it now starts a
// quarantine clock whenever the slot does not hold the record openaiActiveId names — so a store that
// named an absent occupant would have capture itself mutate the file and quarantine acct-B, masking
// the very thing KA1/KA2 measure. With the field unset there is nothing to evict, capture is a true
// no-op, and the only variable left is the flag.
const seedGate = () => {
  emptySlot()
  writeAccounts({ version: 1, accounts: [oaRec("acct-B", "oa-B-r")] })
}
reset(); seedGate()
{
  const before = accountsText()
  const out = await keepOpenaiAccountFresh("openai:acct-B")
  results.gate_direct = { fetches, openaiPosts, skipped: out.skipped, refreshed: out.refreshed, storeUnchanged: accountsText() === before, bRefresh: rec("openai:acct-B").refresh }
}
reset(); seedGate()
{
  const before = accountsText()
  await tick()
  results.gate_tick = { fetches, openaiPosts, storeUnchanged: accountsText() === before, bRefresh: rec("openai:acct-B").refresh }
}

if (FLAG) {
  // ---- INV-O1 (a): the occupant matched by accountId. The record's refresh DELIBERATELY differs
  // from the slot's (codex already rotated it), so ONLY the accountId term can refuse this.
  reset()
  writeAuthRaw({ openai: oa("slot-a", "slot-r-rotated", future(), "acct-A") })
  writeAccounts({ version: 1, accounts: [oaRec("acct-A", "oa-A-r-stale")] })
  {
    const before = accountsText()
    const out = await keepOpenaiAccountFresh("openai:acct-A")
    results.occupant_by_accountid = { openaiPosts, skipped: out.skipped, storeUnchanged: accountsText() === before }
  }

  // ---- INV-O1 (b1): the slot carries NO accountId, so only refresh-string equality can refuse.
  reset()
  writeAuthRaw({ openai: { type: "oauth", access: "slot-a", refresh: "oa-A-r", expires: future() } })
  writeAccounts({ version: 1, accounts: [oaRec("acct-A", "oa-A-r")] })
  {
    const before = accountsText()
    const out = await keepOpenaiAccountFresh("openai:acct-A")
    results.occupant_by_refresh_noacct = { openaiPosts, skipped: out.skipped, storeUnchanged: accountsText() === before }
  }

  // ---- INV-O1 (b2): the slot's accountId has DRIFTED away from the record's; same refresh.
  reset()
  writeAuthRaw({ openai: oa("slot-a", "oa-A-r", future(), "acct-DRIFTED") })
  writeAccounts({ version: 1, accounts: [oaRec("acct-A", "oa-A-r")] })
  {
    const before = accountsText()
    const out = await keepOpenaiAccountFresh("openai:acct-A")
    results.occupant_by_refresh_drift = { openaiPosts, skipped: out.skipped, storeUnchanged: accountsText() === before }
  }

  // ---- the quarantine, isolated: same account, ONLY lastActiveAt differs across the two runs.
  const seedQuarantine = (lastActiveAt) => {
    emptySlot()
    writeAccounts({ version: 1, accounts: [oaRec("acct-Q", "oa-Q-r", { lastActiveAt })] })
  }
  reset(); seedQuarantine(Date.now() - QUARANTINE_MS / 10)
  {
    const before = accountsText()
    const out = await keepOpenaiAccountFresh("openai:acct-Q")
    results.quarantine_inside = { openaiPosts, skipped: out.skipped, storeUnchanged: accountsText() === before }
  }
  reset(); seedQuarantine(Date.now() - QUARANTINE_MS - 60000)
  {
    const out = await keepOpenaiAccountFresh("openai:acct-Q")
    results.quarantine_outside = { openaiPosts, refreshed: out.refreshed, qRefresh: rec("openai:acct-Q").refresh, posted: [...postedRefresh] }
  }

  // ---- the quarantine survives a reload: its ONLY carrier is the persisted lastActiveAt field.
  // The slot's expires is near-expiry too, because the switch below ABSORBS the slot entry into A's
  // record — a far-future expires there would leave A ineligible on the staleness term instead, and
  // the scenario would silently stop testing the quarantine.
  reset()
  writeAuthRaw({ openai: oa("oa-A-a", "oa-A-r", soon(), "acct-A") })
  writeAccounts({ version: 1, openaiActiveId: "openai:acct-A", accounts: [oaRec("acct-A", "oa-A-r"), oaRec("acct-B", "oa-B-r")] })
  {
    // A real switch evicts A from the slot and stamps it on disk. After this, A matches the slot on
    // NEITHER accountId nor refresh, so the quarantine is the only term left holding it back.
    await switchToOpenaiAccount("openai:acct-B")
    const stamped = rec("openai:acct-A").lastActiveAt
    const out = await keepOpenaiAccountFresh("openai:acct-A")
    const postsWhileQuarantined = openaiPosts
    // Backdate ONLY the persisted stamp and ask again: a refresh now proves the verdict was read
    // from the FILE, not from some in-memory "recently switched" flag.
    const accs = readAccounts()
    accs.accounts.find((item) => item.id === "openai:acct-A").lastActiveAt = Date.now() - QUARANTINE_MS - 60000
    writeAccounts(accs)
    const out2 = await keepOpenaiAccountFresh("openai:acct-A")
    results.quarantine_persisted = {
      stampedType: typeof stamped, stampFresh: Date.now() - stamped < QUARANTINE_MS,
      firstSkip: out.skipped, postsWhileQuarantined, secondRefreshed: out2.refreshed,
      aRefresh: rec("openai:acct-A").refresh, openaiPosts,
    }
  }

  // ---- the rotated tip is persisted INSIDE the lock hold, not after it.
  reset(); slowMs = 60
  emptySlot()
  writeAccounts({ version: 1, accounts: [oaRec("acct-L", "oa-L-r")] })
  {
    const inflight = keepOpenaiAccountFresh("openai:acct-L")
    // Queued strictly behind the keepalive's own hold, so what this reads is what the lock released.
    const observed = withAuthLock(async () => rec("openai:acct-L").refresh)
    const out = await inflight
    results.persist_in_lock = { refreshed: out.refreshed, observed: await observed, onDisk: rec("openai:acct-L").refresh, openaiPosts }
  }

  // ---- refresh_token_reused ⇒ needsReauth, and NEVER probed again on a later tick.
  reset("reused")
  emptySlot()
  writeAccounts({ version: 1, accounts: [oaRec("acct-R", "oa-R-r")] })
  {
    const out = await keepOpenaiAccountFresh("openai:acct-R")
    const afterFirst = rec("openai:acct-R")
    await tick()
    const out3 = await keepOpenaiAccountFresh("openai:acct-R")
    results.reused = { needsReauth: out.needsReauth, flagged: afterFirst.needsReauth === true, refreshKept: afterFirst.refresh, openaiPosts, secondSkip: out3.skipped }
  }

  // ---- adopt-foreign-rotation: another process rotated the record while we POSTed ⇒ adopt, do NOT
  // flag, and do NOT write our own pre-rotation snapshot back over the winner's tip.
  reset("steal")
  emptySlot()
  writeAccounts({ version: 1, accounts: [oaRec("acct-S", "oa-S-r")] })
  steal = { id: "openai:acct-S", refresh: "oa-S-r-WINNER", access: "oa-S-a-WINNER", expires: future() }
  {
    const out = await keepOpenaiAccountFresh("openai:acct-S")
    const after = rec("openai:acct-S")
    results.adopt = { needsReauth: out.needsReauth, refreshed: out.refreshed, flagged: after.needsReauth === true, refresh: after.refresh, access: after.access, openaiPosts }
  }

  // ---- ...but a record that is ALREADY flagged is never adopted: that would clear another
  // process's dead-chain verdict.
  reset("steal")
  emptySlot()
  writeAccounts({ version: 1, accounts: [oaRec("acct-F", "oa-F-r")] })
  steal = { id: "openai:acct-F", refresh: "oa-F-r-OTHER", access: "oa-F-a-OTHER", expires: future(), flagged: true }
  {
    const out = await keepOpenaiAccountFresh("openai:acct-F")
    const after = rec("openai:acct-F")
    results.no_adopt_flagged = { needsReauth: out.needsReauth, flagged: after.needsReauth === true, refresh: after.refresh }
  }

  // ---- a transient 500 must not brand the account and must not wedge it; the tick must survive.
  reset("500")
  emptySlot()
  writeAccounts({ version: 1, accounts: [oaRec("acct-T", "oa-T-r")] })
  {
    let tickThrew = false
    try { await tick() } catch { tickThrew = true }
    const after = rec("openai:acct-T")
    mode = "ok"
    const out2 = await keepOpenaiAccountFresh("openai:acct-T")
    results.transient = { tickThrew, flagged: after.needsReauth === true, refreshKept: after.refresh, recovered: out2.refreshed, refreshAfter: rec("openai:acct-T").refresh, openaiPosts }
  }

  // ---- a 429 arms a backoff instead of hammering the endpoint.
  reset("429")
  emptySlot()
  writeAccounts({ version: 1, accounts: [oaRec("acct-9", "oa-9-r")] })
  {
    try { await keepOpenaiAccountFresh("openai:acct-9") } catch {}
    mode = "ok"
    const out2 = await keepOpenaiAccountFresh("openai:acct-9")
    results.cooldown429 = { skipped: out2.skipped, openaiPosts, flagged: rec("openai:acct-9").needsReauth === true }
  }

  // ---- the predicate reads auth.json, NEVER openaiActiveId. (i) bookkeeping says A is active while
  // the slot really holds B ⇒ A is still refreshed.
  reset()
  writeAuthRaw({ openai: oa("oa-B-a", "oa-B-r", future(), "acct-B") })
  writeAccounts({ version: 1, openaiActiveId: "openai:acct-A", accounts: [oaRec("acct-A", "oa-A-r"), oaRec("acct-B", "oa-B-r")] })
  {
    const out = await keepOpenaiAccountFresh("openai:acct-A")
    results.ignores_bookkeeping_refresh = { refreshed: out.refreshed, aRefresh: rec("openai:acct-A").refresh, openaiPosts }
  }
  // (ii) bookkeeping says B is active while the slot really holds A ⇒ A is REFUSED.
  reset()
  writeAuthRaw({ openai: oa("oa-A-a", "oa-A-r", future(), "acct-A") })
  writeAccounts({ version: 1, openaiActiveId: "openai:acct-B", accounts: [oaRec("acct-A", "oa-A-r"), oaRec("acct-B", "oa-B-r")] })
  {
    const before = accountsText()
    const out = await keepOpenaiAccountFresh("openai:acct-A")
    results.ignores_bookkeeping_refuse = { skipped: out.skipped, openaiPosts, storeUnchanged: accountsText() === before }
  }

  // ---- a record with no accountId cannot be compared to the slot by identity ⇒ refused outright.
  reset()
  emptySlot()
  writeAccounts({ version: 1, accounts: [{ id: "openai:legacy", label: "L", refresh: "legacy-r", provider: "openai", lastActiveAt: Date.now() - 3 * QUARANTINE_MS }] })
  {
    const before = accountsText()
    const out = await keepOpenaiAccountFresh("openai:legacy")
    results.no_account_id = { skipped: out.skipped, openaiPosts, storeUnchanged: accountsText() === before }
  }

  // ---- an anthropic id handed to the ChatGPT keepalive is refused before any POST (INV-P1).
  reset()
  emptySlot()
  writeAccounts({ version: 1, activeId: "anthA", accounts: [{ id: "anthA", label: "A", refresh: "anth-r", access: "anth-a", expires: soon(), accountId: "acct-X", lastActiveAt: 0 }] })
  {
    const out = await keepOpenaiAccountFresh("anthA")
    results.wrong_provider = { skipped: out.skipped, openaiPosts, anthRefresh: rec("anthA").refresh }
  }

  // ---- a token far from expiry is left alone, and an unknown id is an honest no-op.
  reset()
  emptySlot()
  writeAccounts({ version: 1, accounts: [oaRec("acct-N", "oa-N-r", { expires: future() })] })
  {
    const out = await keepOpenaiAccountFresh("openai:acct-N")
    const missing = await keepOpenaiAccountFresh("openai:nope")
    results.not_stale = { skipped: out.skipped, missingSkip: missing.skipped, openaiPosts }
  }

  // ---- THE OUT-OF-BAND EVICTION. X is what openaiActiveId names and its quarantine expired long
  // ago; the slot is then taken over by Y WITHOUT any switchToOpenaiAccount call — exactly what
  // \`opencode auth login\` in another terminal, or another instance's swap, does. Nothing else in the
  // system would ever stamp X, so unless capture starts X's quarantine clock at the moment it
  // NOTICES the eviction, the very next tick refreshes a chain codex may still have a request in
  // flight on. These two scenarios live here rather than in openai-slot.test.ts because the property
  // that matters is not the stamp, it is the POST the stamp prevents.
  const OLD_STAMP = 1_000_000
  results.constants = {
    quarantine: realConstants.OPENAI_QUARANTINE_MS,
    tick: realConstants.KEEPALIVE_TICK_MS,
    threshold: realConstants.INACTIVE_REFRESH_THRESHOLD_MS,
  }
  reset()
  writeAuthRaw({ openai: oa("oa-Y-a", "oa-Y-r", soon(), "acct-Y") })
  writeAccounts({ version: 1, openaiActiveId: "openai:acct-X", accounts: [
    oaRec("acct-X", "oa-X-r"),
    oaRec("acct-Y", "oa-Y-r-stale"),
    // A bystander: NEITHER the occupant nor the record openaiActiveId names. Left near-expiry on
    // purpose, so the ONLY thing that can keep it out of the tick's POST list is the broad
    // quarantine — under the evictee-only policy it would be refreshed.
    oaRec("acct-Z", "oa-Z-r", { lastActiveAt: OLD_STAMP }),
  ] })
  {
    const captured = await captureOpenaiSlot()
    const stampedAt = rec("openai:acct-X").lastActiveAt
    await tick()
    results.oob_eviction = {
      capturedId: captured.id,
      openaiActiveId: readAccounts().openaiActiveId,
      xStampFresh: Date.now() - stampedAt < QUARANTINE_MS,
      xStampAgeMs: Date.now() - stampedAt,
      zStampFresh: Date.now() - rec("openai:acct-Z").lastActiveAt < QUARANTINE_MS,
      openaiPosts, posted: [...postedRefresh],
      xRefresh: rec("openai:acct-X").refresh,
      zRefresh: rec("openai:acct-Z").refresh,
    }
  }

  // ---- 甲, THE MIDDLE OCCUPANT. The slot really moves three times with only ONE observation after
  // them all: X (what we believe is active) → Y → Z. Y both took and lost the slot between two of our
  // looks, so no by-name rule can reach it — X is stamped as the record openaiActiveId names, Z as
  // the occupant, and only the BROAD quarantine covers Y. This is the structural class the
  // evictee-only policy cannot close, not a second instance of KA20.
  reset()
  writeAccounts({ version: 1, openaiActiveId: "openai:acct-X2", accounts: [
    oaRec("acct-X2", "oa-X2-r"),
    oaRec("acct-Y2", "oa-Y2-r"),
    oaRec("acct-Z2", "oa-Z2-r"),
  ] })
  writeAuthRaw({ openai: oa("oa-X2-a", "oa-X2-r", soon(), "acct-X2") })
  writeAuthRaw({ openai: oa("oa-Y2-a", "oa-Y2-r", soon(), "acct-Y2") })
  writeAuthRaw({ openai: oa("oa-Z2-a", "oa-Z2-r", soon(), "acct-Z2") })
  {
    await captureOpenaiSlot()
    const yStamp = rec("openai:acct-Y2").lastActiveAt
    await tick()
    results.middle_occupant = {
      yStampFresh: Date.now() - yStamp < QUARANTINE_MS,
      openaiPosts, posted: [...postedRefresh],
      yRefresh: rec("openai:acct-Y2").refresh,
      xRefresh: rec("openai:acct-X2").refresh,
      openaiActiveId: readAccounts().openaiActiveId,
    }
  }

  // ---- 乙, EVERY UNUSABLE SLOT SHAPE IS AN EVICTION. The api-key paste is the headline (commitSlot
  // refuses to overwrite such an entry, so it can sit in the slot indefinitely), but a missing file, a
  // missing openai entry and an oauth entry we cannot attribute are the same eviction in different
  // clothes — and all four used to return before anything could stamp anybody.
  const unusableCase = async (setup) => {
    reset()
    writeAccounts({ version: 1, openaiActiveId: "openai:acct-U", accounts: [oaRec("acct-U", "oa-U-r", { lastActiveAt: OLD_STAMP })] })
    setup()
    const authBefore = authText()
    let threw = false
    let returned = "sentinel"
    try { returned = await captureOpenaiSlot() } catch { threw = true }
    const stamp = rec("openai:acct-U").lastActiveAt
    await tick()
    return {
      threw, returnedUndefined: returned === undefined,
      stampFresh: Date.now() - stamp < QUARANTINE_MS,
      openaiPosts, posted: [...postedRefresh],
      uRefresh: rec("openai:acct-U").refresh,
      openaiActiveId: readAccounts().openaiActiveId ?? "<cleared>",
      authUnchanged: authText() === authBefore,
    }
  }
  // The first three are DEFINITIVELY empty (the file parsed and holds no ChatGPT chain), so the
  // pointer is cleared. The last two are IGNORANCE (missing file, unparseable file) — quarantined
  // just the same, but the pointer is preserved because we cannot assert nobody is using the slot.
  results.unusable_api = await unusableCase(() => writeAuthRaw({ openai: { type: "api", key: "sk-user-pasted-key" } }))
  results.unusable_no_entry = await unusableCase(() => writeAuthRaw({ anthropic: { type: "oauth", access: "a", refresh: "r", expires: future() } }))
  results.unusable_unattributable = await unusableCase(() => writeAuthRaw({ openai: { type: "oauth", access: "x", refresh: "no-acct-id-r", expires: future() } }))
  results.unusable_missing = await unusableCase(() => dropAuth())
  results.unusable_garbage = await unusableCase(() => unreadableSlot())

  // ---- THE FAIL-OPEN, CLOSED. An unreadable slot used to arrive at refuse() as the same undefined a
  // genuinely empty one does, and the \`slot &&\` guard then skipped the occupant check altogether —
  // "we cannot see the slot, therefore no chain is codex's". acct-W2 below is PERFECTLY refreshable on
  // every other conjunct, so it is the account that fail-open would have POSTed. The direct call runs
  // BEFORE any capture, so no quarantine has been applied yet and refuse() itself is what must refuse.
  reset()
  writeAccounts({ version: 1, openaiActiveId: "openai:acct-W", accounts: [
    oaRec("acct-W", "oa-W-r", { lastActiveAt: OLD_STAMP }),
    oaRec("acct-W2", "oa-W2-r", { lastActiveAt: OLD_STAMP }),
  ] })
  unreadableSlot()
  {
    const direct = await keepOpenaiAccountFresh("openai:acct-W2")
    const postsAfterDirect = openaiPosts
    await captureOpenaiSlot()
    const stamp1 = rec("openai:acct-W").lastActiveAt
    await sleep(12)
    await captureOpenaiSlot()
    const stamp2 = rec("openai:acct-W").lastActiveAt
    await tick()
    results.unreadable_fail_closed = {
      directSkip: direct.skipped,
      postsAfterDirect,
      pointer: readAccounts().openaiActiveId ?? "<cleared>",
      stampFresh: Date.now() - stamp1 < QUARANTINE_MS,
      // Ignorance persists ⇒ the quarantine is deliberately RE-applied every capture, the opposite of
      // the definitively-empty case. This is the "conservative on both axes" behaviour.
      requarantined: stamp2 > stamp1,
      openaiPosts, posted: [...postedRefresh],
      wRefresh: rec("openai:acct-W").refresh,
      w2Refresh: rec("openai:acct-W2").refresh,
    }
  }

  // ---- a record whose quarantine stamp is absent or not a finite number is unknown HISTORY, and the
  // old \`?? 0\` read that as "infinitely long ago" — the same unknown-⇒-allow shape. Both shapes are
  // presented against an otherwise perfectly refreshable record and a definitively empty slot, so the
  // stamp is the only thing that can refuse them.
  reset()
  emptySlot()
  writeAccounts({ version: 1, accounts: [
    { id: "openai:acct-H", label: "H", refresh: "oa-H-r", access: "a", expires: soon(), provider: "openai", accountId: "acct-H" },
    { id: "openai:acct-H2", label: "H2", refresh: "oa-H2-r", access: "a", expires: soon(), provider: "openai", accountId: "acct-H2", lastActiveAt: "yesterday" },
  ] })
  {
    const missing = await keepOpenaiAccountFresh("openai:acct-H")
    const malformed = await keepOpenaiAccountFresh("openai:acct-H2")
    results.unknown_history = { missingSkip: missing.skipped, malformedSkip: malformed.skipped, openaiPosts, posted: [...postedRefresh] }
  }

  // ---- the RE-QUARANTINE LOOP must be gone. With the pointer cleared, a parked unusable slot gives
  // the evicted pool exactly ONE window instead of re-stamping it on every capture forever. Captures
  // 2 and 3 must leave the stamp byte-identical (the elapsed figure is reported so that equality is
  // meaningful rather than two reads landing in the same millisecond), and once that single window has
  // elapsed the account must actually become refreshable again.
  reset()
  writeAccounts({ version: 1, openaiActiveId: "openai:acct-V", accounts: [oaRec("acct-V", "oa-V-r", { lastActiveAt: OLD_STAMP })] })
  writeAuthRaw({ openai: { type: "api", key: "sk-user-pasted-key" } })
  {
    const started = Date.now()
    await captureOpenaiSlot()
    const stamp1 = rec("openai:acct-V").lastActiveAt
    const pointerAfterFirst = readAccounts().openaiActiveId ?? "<cleared>"
    await sleep(12)
    await captureOpenaiSlot()
    const stamp2 = rec("openai:acct-V").lastActiveAt
    await sleep(12)
    await captureOpenaiSlot()
    const stamp3 = rec("openai:acct-V").lastActiveAt
    const elapsedMs = Date.now() - started
    // One window elapses: backdate the single stamp on disk, exactly as real time passing would.
    const accs = readAccounts()
    accs.accounts.find((item) => item.id === "openai:acct-V").lastActiveAt = Date.now() - QUARANTINE_MS - 60000
    writeAccounts(accs)
    await tick()
    results.no_requarantine_loop = {
      pointerAfterFirst,
      firstStampFresh: Date.now() - stamp1 < QUARANTINE_MS,
      stampStable: stamp2 === stamp1 && stamp3 === stamp1,
      elapsedMs,
      openaiPosts, posted: [...postedRefresh],
      vRefresh: rec("openai:acct-V").refresh,
    }
  }

  // ---- ...and the eviction stamp must NOT fire when there was no eviction: an occupant that IS
  // already what openaiActiveId names gets stamped as the OCCUPANT (absorbOpenaiSlot's existing
  // behaviour), and no OTHER record's stamp may move. Both bystander stamps are distinct literals so
  // a fix that blindly stamps every record — or copies one record's stamp onto another — is caught.
  reset()
  writeAuthRaw({ openai: oa("oa-A-a", "oa-A-r", soon(), "acct-A") })
  writeAccounts({ version: 1, openaiActiveId: "openai:acct-A", accounts: [
    oaRec("acct-A", "oa-A-r-stale", { lastActiveAt: OLD_STAMP }),
    oaRec("acct-B", "oa-B-r", { expires: future(), lastActiveAt: OLD_STAMP + 1 }),
  ] })
  {
    await captureOpenaiSlot()
    const a = rec("openai:acct-A")
    results.stamp_scope = {
      aStampFresh: Date.now() - a.lastActiveAt < QUARANTINE_MS,
      aStampAgeMs: Date.now() - a.lastActiveAt,
      bStamp: rec("openai:acct-B").lastActiveAt,
      openaiActiveId: readAccounts().openaiActiveId,
      openaiPosts,
    }
  }

  // ---- capture runs BEFORE the keepalive pass: by the time any decision is taken, the occupant's
  // record already holds the slot's CURRENT tip and a fresh stamp — and it is never POSTed.
  reset()
  writeAuthRaw({ openai: oa("oa-A-a2", "oa-A-r2", future(), "acct-A") })
  writeAccounts({ version: 1, accounts: [oaRec("acct-A", "oa-A-r-stale")] })
  {
    await tick()
    const a = rec("openai:acct-A")
    results.capture_first = { openaiPosts, aRefresh: a.refresh, aAccess: a.access, stampFresh: Date.now() - a.lastActiveAt < QUARANTINE_MS }
  }
}

writeFileSync(OUT, JSON.stringify(results))
test("openai keepalive scenarios executed", () => {})
`

type Gate = { fetches: number; openaiPosts: number; skipped?: string; refreshed?: boolean; storeUnchanged: boolean; bRefresh: string }
type Refusal = { openaiPosts: number; skipped?: string; storeUnchanged: boolean }
type OffResults = { gate_direct: Gate; gate_tick: Omit<Gate, "skipped" | "refreshed"> }
type OnResults = OffResults & {
  occupant_by_accountid: Refusal
  occupant_by_refresh_noacct: Refusal
  occupant_by_refresh_drift: Refusal
  quarantine_inside: Refusal
  quarantine_outside: { openaiPosts: number; refreshed: boolean; qRefresh: string; posted: string[] }
  quarantine_persisted: {
    stampedType: string
    stampFresh: boolean
    firstSkip?: string
    postsWhileQuarantined: number
    secondRefreshed: boolean
    aRefresh: string
    openaiPosts: number
  }
  persist_in_lock: { refreshed: boolean; observed: string; onDisk: string; openaiPosts: number }
  reused: { needsReauth?: boolean; flagged: boolean; refreshKept: string; openaiPosts: number; secondSkip?: string }
  adopt: { needsReauth?: boolean; refreshed: boolean; flagged: boolean; refresh: string; access: string; openaiPosts: number }
  no_adopt_flagged: { needsReauth?: boolean; flagged: boolean; refresh: string }
  transient: { tickThrew: boolean; flagged: boolean; refreshKept: string; recovered: boolean; refreshAfter: string; openaiPosts: number }
  cooldown429: { skipped?: string; openaiPosts: number; flagged: boolean }
  ignores_bookkeeping_refresh: { refreshed: boolean; aRefresh: string; openaiPosts: number }
  ignores_bookkeeping_refuse: Refusal
  no_account_id: Refusal
  wrong_provider: { skipped?: string; openaiPosts: number; anthRefresh: string }
  not_stale: { skipped?: string; missingSkip?: string; openaiPosts: number }
  capture_first: { openaiPosts: number; aRefresh: string; aAccess: string; stampFresh: boolean }
  oob_eviction: {
    capturedId: string
    openaiActiveId?: string
    xStampFresh: boolean
    xStampAgeMs: number
    zStampFresh: boolean
    openaiPosts: number
    posted: string[]
    xRefresh: string
    zRefresh: string
  }
  stamp_scope: { aStampFresh: boolean; aStampAgeMs: number; bStamp: number; openaiActiveId?: string; openaiPosts: number }
  middle_occupant: {
    yStampFresh: boolean
    openaiPosts: number
    posted: string[]
    yRefresh: string
    xRefresh: string
    openaiActiveId?: string
  }
  unusable_api: Unusable
  unusable_missing: Unusable
  unusable_no_entry: Unusable
  unusable_unattributable: Unusable
  unusable_garbage: Unusable
  constants: { quarantine: number; tick: number; threshold: number }
  unreadable_fail_closed: {
    directSkip?: string
    postsAfterDirect: number
    pointer: string
    stampFresh: boolean
    requarantined: boolean
    openaiPosts: number
    posted: string[]
    wRefresh: string
    w2Refresh: string
  }
  unknown_history: { missingSkip?: string; malformedSkip?: string; openaiPosts: number; posted: string[] }
  no_requarantine_loop: {
    pointerAfterFirst: string
    firstStampFresh: boolean
    stampStable: boolean
    elapsedMs: number
    openaiPosts: number
    posted: string[]
    vRefresh: string
  }
}

type Unusable = {
  threw: boolean
  returnedUndefined: boolean
  stampFresh: boolean
  openaiPosts: number
  posted: string[]
  uRefresh: string
  openaiActiveId?: string
  authUnchanged: boolean
}

const runnerDir = mkdtempSync(join(tmpdir(), "cau-ka-parent-"))
const runnerPath = join(runnerDir, "runner.test.ts")
writeFileSync(runnerPath, runnerSource)

function runChild(flag: "on" | "off"): string {
  const outPath = join(runnerDir, `results-${flag}.json`)
  const childHome = mkdtempSync(join(tmpdir(), `cau-ka-home-${flag}-`))
  const proc = Bun.spawnSync(["bun", "test", runnerPath], {
    env: { ...process.env, CAU_SRC: import.meta.dir, CAU_OUT: outPath, CAU_FLAG: flag, HOME: childHome },
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    throw new Error(`openai keepalive runner (flag=${flag}) failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}\n${proc.stdout.toString()}`)
  }
  return readFileSync(outPath, "utf8")
}

const off = JSON.parse(runChild("off")) as OffResults
const r = JSON.parse(runChild("on")) as OnResults

// The dark-launch contract: with the flag false the feature must be indistinguishable from never
// having been written. Asserted on the request COUNT and on the store's exact bytes, with a stale
// non-occupant ChatGPT account present — i.e. against the one fixture that WOULD be refreshed.
test("KA1:开关关闭 → 即便存在一个快过期、非占位者的 ChatGPT 账号,也零网络请求、账号库逐字节不变", () => {
  expect(off.gate_direct.fetches).toBe(0)
  expect(off.gate_direct.openaiPosts).toBe(0)
  expect(off.gate_direct.skipped).toBe("flag-off")
  expect(off.gate_direct.refreshed).toBe(false)
  expect(off.gate_direct.storeUnchanged).toBe(true)
  expect(off.gate_direct.bRefresh).toBe("oa-B-r")
  expect(off.gate_tick.fetches).toBe(0)
  expect(off.gate_tick.openaiPosts).toBe(0)
  expect(off.gate_tick.storeUnchanged).toBe(true)
  expect(off.gate_tick.bRefresh).toBe("oa-B-r")
})

// The A/B half of KA1: the same fixture, same code path, flag flipped — so KA1 is proof the FLAG
// suppressed the refresh and not that the fixture was ineligible all along.
test("KA2:开关打开 → 同一份 fixture 经 keeperTick 真的被刷新(证明 KA1 是开关拦下的,不是 fixture 不合格)", () => {
  expect(r.gate_direct.openaiPosts).toBe(1)
  expect(r.gate_direct.refreshed).toBe(true)
  expect(r.gate_direct.bRefresh).toBe("ka-r2")
  expect(r.gate_tick.openaiPosts).toBe(1)
  expect(r.gate_tick.bRefresh).toBe("ka-r2")
})

// INV-O1's accountId term, isolated: the record's stored refresh differs from the slot's (codex has
// already rotated it), so nothing but accountId can refuse this POST.
test("KA3:槽位占位者按 accountId 命中 → 绝不 POST(记录里的 refresh 已与槽位不同,只有 accountId 能拦)", () => {
  expect(r.occupant_by_accountid.skipped).toBe("slot-occupant")
  expect(r.occupant_by_accountid.openaiPosts).toBe(0)
  expect(r.occupant_by_accountid.storeUnchanged).toBe(true)
})

// INV-O1's refresh-string term, isolated twice: a slot that carries no accountId, and one whose
// accountId has drifted. Either way the chain is provably the occupant's and must not be touched.
test("KA4:槽位缺 accountId / accountId 已漂移,但 refresh 字符串相同 → 一律拒绝 POST", () => {
  expect(r.occupant_by_refresh_noacct.skipped).toBe("slot-occupant")
  expect(r.occupant_by_refresh_noacct.openaiPosts).toBe(0)
  expect(r.occupant_by_refresh_noacct.storeUnchanged).toBe(true)
  expect(r.occupant_by_refresh_drift.skipped).toBe("slot-occupant")
  expect(r.occupant_by_refresh_drift.openaiPosts).toBe(0)
  expect(r.occupant_by_refresh_drift.storeUnchanged).toBe(true)
})

// A switch evicts an account while a codex request for it may still be in flight; refreshing inside
// that window is the replay that revokes the family.
test("KA5:处于隔离期内的账号被跳过,同一账号越过隔离期后才刷新", () => {
  expect(r.quarantine_inside.skipped).toBe("quarantine")
  expect(r.quarantine_inside.openaiPosts).toBe(0)
  expect(r.quarantine_inside.storeUnchanged).toBe(true)
  expect(r.quarantine_outside.refreshed).toBe(true)
  expect(r.quarantine_outside.openaiPosts).toBe(1)
  expect(r.quarantine_outside.qRefresh).toBe("ka-r2")
  expect(r.quarantine_outside.posted).toEqual(["oa-Q-r"])
})

// "switch, quit immediately, relaunch" must not bypass the quarantine: its only carrier is the
// PERSISTED lastActiveAt, and backdating that one field on disk is what flips the verdict.
test("KA6:隔离期靠落盘的 lastActiveAt 生效 —— 切号后重新读盘仍被拦,只改盘上这一个字段才放行", () => {
  expect(r.quarantine_persisted.stampedType).toBe("number")
  expect(r.quarantine_persisted.stampFresh).toBe(true)
  expect(r.quarantine_persisted.firstSkip).toBe("quarantine")
  expect(r.quarantine_persisted.postsWhileQuarantined).toBe(0)
  expect(r.quarantine_persisted.secondRefreshed).toBe(true)
  expect(r.quarantine_persisted.aRefresh).toBe("ka-r2")
  expect(r.quarantine_persisted.openaiPosts).toBe(1)
})

// A rotated token obtained but not persisted is a LOST CHAIN TIP, so the write must land before the
// lock is released. The observer below is queued behind our hold and must already see the new tip.
test("KA7:轮换后的 token 在锁内落盘 —— 排在同一把锁后面的读者已经看到新 refresh", () => {
  expect(r.persist_in_lock.refreshed).toBe(true)
  expect(r.persist_in_lock.observed).toBe("ka-r2")
  expect(r.persist_in_lock.onDisk).toBe("ka-r2")
  expect(r.persist_in_lock.openaiPosts).toBe(1)
})

test("KA8:refresh_token_reused → 标记 needsReauth,且后续 tick 绝不再探一次(总共只 POST 一次)", () => {
  expect(r.reused.needsReauth).toBe(true)
  expect(r.reused.flagged).toBe(true)
  expect(r.reused.refreshKept).toBe("oa-R-r")
  expect(r.reused.secondSkip).toBe("needs-reauth")
  expect(r.reused.openaiPosts).toBe(1)
})

// Our POST lost the race, so the account is healthy and the loser is us: adopt the winner's tip and
// leave the flag off. Overwriting it with our pre-rotation snapshot would destroy the live tip.
test("KA9:POST 期间被别的进程抢先轮换 → 采纳对方链尾,绝不标记 needsReauth、绝不回写旧 token", () => {
  expect(r.adopt.needsReauth).toBeUndefined()
  expect(r.adopt.refreshed).toBe(false)
  expect(r.adopt.flagged).toBe(false)
  expect(r.adopt.refresh).toBe("oa-S-r-WINNER")
  expect(r.adopt.access).toBe("oa-S-a-WINNER")
})

test("KA10:已被别的进程标记 needsReauth 的记录绝不采纳 —— 不清除对方的死链判定", () => {
  expect(r.no_adopt_flagged.needsReauth).toBe(true)
  expect(r.no_adopt_flagged.flagged).toBe(true)
  expect(r.no_adopt_flagged.refresh).toBe("oa-F-r-OTHER")
})

// A passing outage must never brand a healthy account "需重新登录" — and must not wedge it either.
test("KA11:瞬时 500 不标记 needsReauth、不吞掉 tick,恢复后下一轮正常刷新", () => {
  expect(r.transient.tickThrew).toBe(false)
  expect(r.transient.flagged).toBe(false)
  expect(r.transient.refreshKept).toBe("oa-T-r")
  expect(r.transient.recovered).toBe(true)
  expect(r.transient.refreshAfter).toBe("ka-r2")
  expect(r.transient.openaiPosts).toBe(2)
})

test("KA12:429 进入退避 —— 下一次调用直接跳过,不重复 POST,也不标记 needsReauth", () => {
  expect(r.cooldown429.skipped).toBe("cooldown-429")
  expect(r.cooldown429.openaiPosts).toBe(1)
  expect(r.cooldown429.flagged).toBe(false)
})

// The stale-bookkeeping trap, in both directions: openaiActiveId can disagree with the file for
// reasons from an out-of-band `opencode auth login` to another instance switching. auth.json decides.
test("KA13:占位判定只认 auth.json —— openaiActiveId 说它活跃也照刷,说它不活跃但槽位是它则照拒", () => {
  expect(r.ignores_bookkeeping_refresh.refreshed).toBe(true)
  expect(r.ignores_bookkeeping_refresh.aRefresh).toBe("ka-r2")
  expect(r.ignores_bookkeeping_refresh.openaiPosts).toBe(1)
  expect(r.ignores_bookkeeping_refuse.skipped).toBe("slot-occupant")
  expect(r.ignores_bookkeeping_refuse.openaiPosts).toBe(0)
  expect(r.ignores_bookkeeping_refuse.storeUnchanged).toBe(true)
})

// Stricter than the INV-O1 formula on purpose: without an accountId, a STALE copy of the occupant's
// family would pass the refresh-string test and still revoke that family when POSTed.
test("KA14:缺 accountId 的记录一律拒刷(无法证明它不属于占位者的 token family)", () => {
  expect(r.no_account_id.skipped).toBe("no-account-id")
  expect(r.no_account_id.openaiPosts).toBe(0)
  expect(r.no_account_id.storeUnchanged).toBe(true)
})

test("KA15:把 Anthropic 账号 id 交给 ChatGPT keepalive → 拒绝,绝不把它的 refresh 发给 auth.openai.com", () => {
  expect(r.wrong_provider.skipped).toBe("not-openai")
  expect(r.wrong_provider.openaiPosts).toBe(0)
  expect(r.wrong_provider.anthRefresh).toBe("anth-r")
})

test("KA16:离过期还远的 token 不刷;未知 id 诚实报 not-found 而非静默成功", () => {
  expect(r.not_stale.skipped).toBe("not-stale")
  expect(r.not_stale.missingSkip).toBe("not-found")
  expect(r.not_stale.openaiPosts).toBe(0)
})

// Capture must precede every refresh decision: it is what puts the slot's CURRENT tip and a fresh
// lastActiveAt into the store that INV-O1 then reads.
test("KA17:tick 里归档先跑 —— 占位者记录已带上槽位最新链尾与新鲜时间戳,且全程零 POST", () => {
  expect(r.capture_first.openaiPosts).toBe(0)
  expect(r.capture_first.aRefresh).toBe("oa-A-r2")
  expect(r.capture_first.aAccess).toBe("oa-A-a2")
  expect(r.capture_first.stampFresh).toBe(true)
})

// The interleaving that used to defeat INV-O1, end to end. The stamp is only the mechanism; the
// property is the POST that does not happen. Without the eviction stamp, X — a chain codex may still
// have a request in flight on — is refreshed on the very next tick, and the replay revokes X's whole
// token family. Note X is NOT evicted through switchToOpenaiAccount, which is the entire point: that
// path already stamps its outgoing occupant, and an out-of-band swap is the case nothing else covers.
test("KA20:带外换槽 —— 槽位被 Y 顶掉但 X 从未走过 switchToOpenaiAccount,capture 必须就地给 X 起隔离计时,使下一次 tick 绝不为 X 发 POST", () => {
  expect(r.oob_eviction.capturedId).toBe("openai:acct-Y")
  expect(r.oob_eviction.openaiActiveId).toBe("openai:acct-Y")
  expect(r.oob_eviction.xStampFresh).toBe(true)
  // The property that actually matters: X's chain was never touched.
  expect(r.oob_eviction.posted).toEqual([])
  expect(r.oob_eviction.openaiPosts).toBe(0)
  expect(r.oob_eviction.xRefresh).toBe("oa-X-r")
  // THE BROAD-QUARANTINE POLICY, and the inversion of this test's original assertion: a bystander is
  // no longer left frozen at its old stamp, it is quarantined too. Z is near-expiry and is neither
  // the occupant nor the record openaiActiveId names, so under the evictee-only policy it would have
  // been POSTed here — that is the whole reason the assertion flipped.
  expect(r.oob_eviction.zStampFresh).toBe(true)
  expect(r.oob_eviction.zRefresh).toBe("oa-Z-r")
})

// 甲's structural case: an occupant that took AND lost the slot between two of our observations
// cannot be reached by any by-name rule, so only quarantining the whole pool covers it.
test("KA22:槽位在一次观测之间连换两手(X→Y→Z)—— 中间占位者 Y 无名可循,仍必须被隔离且下一次 tick 不为它发 POST", () => {
  expect(r.middle_occupant.openaiActiveId).toBe("openai:acct-Z2")
  expect(r.middle_occupant.yStampFresh).toBe(true)
  expect(r.middle_occupant.posted).toEqual([])
  expect(r.middle_occupant.openaiPosts).toBe(0)
  expect(r.middle_occupant.yRefresh).toBe("oa-Y2-r")
  expect(r.middle_occupant.xRefresh).toBe("oa-X2-r")
})

// 乙: capture is no longer a pure no-op on an unusable slot — each shape means the occupant was
// evicted, and stamping nobody is what left it frozen and refreshable. auth.json itself must still be
// untouched in every shape (an api key the user pasted is theirs, and a missing file stays missing).
// All five shapes are evictions and all five quarantine. They differ in ONE respect, and it is the
// whole point of this round: the first three are knowledge (the file parsed and holds no ChatGPT
// chain) so the pointer is cleared per INV-O3, while the last two are ignorance so the pointer is
// PRESERVED — we cannot assert "nobody is using the slot" from a read we could not perform.
test("KA23:五种不可用槽位形态都算驱逐并进入隔离,auth.json 分毫不动;能确知为空的清空活跃指针,读不到的则保留", () => {
  for (const row of [r.unusable_api, r.unusable_no_entry, r.unusable_unattributable, r.unusable_missing, r.unusable_garbage]) {
    expect(row.threw).toBe(false)
    expect(row.returnedUndefined).toBe(true)
    expect(row.stampFresh).toBe(true)
    expect(row.posted).toEqual([])
    expect(row.openaiPosts).toBe(0)
    expect(row.uRefresh).toBe("oa-U-r")
    expect(row.authUnchanged).toBe(true)
  }
  for (const row of [r.unusable_api, r.unusable_no_entry, r.unusable_unattributable]) {
    expect(row.openaiActiveId).toBe("<cleared>")
  }
  for (const row of [r.unusable_missing, r.unusable_garbage]) {
    expect(row.openaiActiveId).toBe("openai:acct-U")
  }
})

// The fail-open this round exists to close: "slot unreadable ⇒ every chain is refreshable" inverted
// INV-O1's premise, and acct-W2 satisfies every other conjunct, so nothing else would have stopped it.
test("KA26:槽位读不出来 → INV-O1 失败即拒绝 —— 任何账号都不 POST(含一个其它条件全部合格的),活跃指针保留,隔离每次归档都重新施加", () => {
  expect(r.unreadable_fail_closed.directSkip).toBe("slot-unreadable")
  expect(r.unreadable_fail_closed.postsAfterDirect).toBe(0)
  expect(r.unreadable_fail_closed.posted).toEqual([])
  expect(r.unreadable_fail_closed.openaiPosts).toBe(0)
  expect(r.unreadable_fail_closed.wRefresh).toBe("oa-W-r")
  expect(r.unreadable_fail_closed.w2Refresh).toBe("oa-W2-r")
  expect(r.unreadable_fail_closed.pointer).toBe("openai:acct-W")
  expect(r.unreadable_fail_closed.stampFresh).toBe(true)
  expect(r.unreadable_fail_closed.requarantined).toBe(true)
})

// The second fail-open of the same shape, found by auditing every conjunct for its behaviour on a
// missing input: `?? 0` read an absent stamp as "infinitely long ago", i.e. never quarantined.
test("KA27:隔离时间戳缺失或非有限数 → 视为历史未知并拒绝,绝不当成\"无限久以前\"", () => {
  expect(r.unknown_history.missingSkip).toBe("unknown-history")
  expect(r.unknown_history.malformedSkip).toBe("unknown-history")
  expect(r.unknown_history.posted).toEqual([])
  expect(r.unknown_history.openaiPosts).toBe(0)
})

// The loop the pointer-clear removes. Its absence is a real behavioural claim, not a tidy-up: while
// the slot stayed unusable the old shape re-stamped the whole pool on every single capture, so no
// ChatGPT chain was ever kept warm again.
test("KA25:活跃指针被清空后,重复归档不再反复盖章 —— 不可用槽位只给一轮隔离,窗口过去后账号重新可刷", () => {
  expect(r.no_requarantine_loop.pointerAfterFirst).toBe("<cleared>")
  expect(r.no_requarantine_loop.firstStampFresh).toBe(true)
  expect(r.no_requarantine_loop.stampStable).toBe(true)
  // Equality above is only meaningful if measurable time passed between the three captures.
  expect(r.no_requarantine_loop.elapsedMs).toBeGreaterThan(15)
  expect(r.no_requarantine_loop.posted).toEqual(["oa-V-r"])
  expect(r.no_requarantine_loop.openaiPosts).toBe(1)
  expect(r.no_requarantine_loop.vRefresh).toBe("ka-r2")
})

// The coupling that used to be written down nowhere, now enforced. The lower bound is what stops a
// raised tick from silently opening the eviction hole; the upper bound is what stops the quarantine
// from starving a token instead of merely delaying it — worst case is one quarantine plus one tick,
// because that is how long an evicted account waits before a tick can even look at it again.
test("KA24:隔离窗口由 keeper tick 推导 —— 下界 ≥ 2 个 tick、上界 quarantine+tick < 刷新阈值,今日有效值仍是 10 分钟", () => {
  expect(r.constants.quarantine).toBe(10 * 60_000)
  expect(r.constants.quarantine).toBeGreaterThanOrEqual(2 * r.constants.tick)
  expect(r.constants.quarantine + r.constants.tick).toBeLessThan(r.constants.threshold)
})

// The other side of the same fix: no eviction happened, so nothing beyond the occupant may be
// stamped. A fix that stamped every record would pass KA20 and fail here.
test("KA21:占位者本就是 openaiActiveId 指向的记录 → 它作为占位者被刷新时间戳,任何其它记录的时间戳一律不动", () => {
  expect(r.stamp_scope.aStampFresh).toBe(true)
  expect(r.stamp_scope.bStamp).toBe(1_000_001)
  expect(r.stamp_scope.openaiActiveId).toBe("openai:acct-A")
  expect(r.stamp_scope.openaiPosts).toBe(0)
})

// KA17 can only show that capture ran and the occupant survived, never the ORDER: with the accountId
// term in place, every fixture where capture would change the verdict is already refused by
// accountId alone, so the ordering is defence-in-depth and has no observable consequence. Asserted
// structurally instead (the usage.test.ts precedent for un-observable properties).
test("KA18:结构断言 —— keeperTick 源码里 captureOpenaiSlot 严格早于 keepalive,且 keepalive 只被开关门控", () => {
  const src = readFileSync(join(import.meta.dir, "keeper.ts"), "utf8")
  const tick = src.slice(src.indexOf("export async function keeperTick"), src.indexOf("export function installTokenKeeper"))
  const capture = tick.indexOf("await captureOpenaiSlot()")
  const gate = tick.indexOf("OPENAI_KEEPALIVE_ENABLED")
  const keepalive = tick.indexOf("keepOpenaiAccountFresh(")
  expect(capture).toBeGreaterThan(-1)
  expect(gate).toBeGreaterThan(capture)
  expect(keepalive).toBeGreaterThan(gate)
  // The anthropic pass must not have been reordered behind the openai one either.
  expect(tick.indexOf("acquireInactiveAccess(")).toBeGreaterThan(-1)
})

// The fresh in-lock read and the single non-reentrant hold are the two properties a future reader is
// most likely to "simplify" away, and neither is observable from outside.
test("KA19:结构断言 —— keepalive 只持一把锁,槽位重读 / POST / 落盘全在锁内,且从不读 openaiActiveId", () => {
  const src = readFileSync(join(import.meta.dir, "openai-keepalive.ts"), "utf8")
  const body = src.slice(src.indexOf("export async function keepOpenaiAccountFresh"))
  const code = body
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
  expect((code.match(/withAuthLock/g) ?? []).length).toBe(1)
  const lock = code.indexOf("withAuthLock")
  expect(code.indexOf("readOpenaiSlotState()")).toBeGreaterThan(lock)
  expect(code.indexOf("refreshOpenaiToken(")).toBeGreaterThan(lock)
  expect(code.indexOf("await saveAccounts(")).toBeGreaterThan(code.indexOf("refreshOpenaiToken("))
  expect(code).not.toContain("openaiActiveId")
})
