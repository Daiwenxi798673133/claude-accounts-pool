import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// WHY A SUBPROCESS: autoswitch.test.ts runs earlier in the same `bun test` process and
// registers process-global mock.module("./usage.ts", ...) (a stub lacking
// acquireActiveAccess) AND mock.module("./accounts.ts", ...) (a PARTIAL stub lacking
// withAuthLock). Bun's mock.module is process-global, is cached the moment autoswitch
// imports its graph, and cannot be evicted/undone for a later file — so importing the
// real usage.ts here is impossible in-process (verified: plain import yields the stub;
// ./usage.ts?real link-fails on the leaked partial accounts). We therefore run the real
// acquireActiveAccess scenarios in a FRESH child `bun test` process (no leak), where
// mock.module works cleanly and usage.ts links the REAL accounts.ts. The child drives
// real accounts.ts via a temp-dir auth.json seam and stubs fetch (counting TOKEN_URL
// POSTs), writes a results JSON, and the parent tests below assert on it.
const runnerSource = `
import { test, mock } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, chmodSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const SRC = process.env.CAU_SRC
const OUT = process.env.CAU_OUT
const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

const dataHome = mkdtempSync(join(tmpdir(), "cau-run-"))
process.env.XDG_DATA_HOME = dataHome
mkdirSync(join(dataHome, "opencode"), { recursive: true })
const authPath = join(dataHome, "opencode", "auth.json")

// accounts.ts derives ACCOUNTS_PATH from homedir() at module load. os.homedir()
// snapshots HOME at process START and ignores later process.env mutation, so the
// PARENT must pass HOME=<tmp> via the spawn env (done below); here we just use it.
const accountsDir = join(homedir(), ".config", "opencode")
mkdirSync(accountsDir, { recursive: true })
const accountsPath = join(accountsDir, "claude-accounts.json")
const writeAccounts = (obj) => writeFileSync(accountsPath, JSON.stringify(obj))
const readAccounts = () => JSON.parse(readFileSync(accountsPath, "utf8"))

const future = () => Date.now() + 3600000
const soon = () => Date.now() + 10 * 60000
const past = () => Date.now() - 1000
const bodyPast = () => new Date(Date.now() - 1000).toISOString()
const bodyFuture = () => new Date(Date.now() + 3600000).toISOString()
const oauth = (access, refresh, expires) => ({ type: "oauth", access, refresh, expires })
const writeAuth = (entry) => writeFileSync(authPath, JSON.stringify(entry ? { anthropic: entry } : {}))
const writeAuthRaw = (obj) => writeFileSync(authPath, JSON.stringify(obj))
const readAuth = () => JSON.parse(readFileSync(authPath, "utf8")).anthropic

// Spread the real module rather than re-listing it (the lockfile.test.ts pattern): a hand-written
// list silently DROPS every constant it has not heard of, so the moment keeper.ts's import graph
// reached openai-token.ts (OPENAI_CLIENT_ID / OPENAI_TOKEN_URL) the \`import keeper.ts\` below
// link-failed and fell through to the no-op stub — the keeper tests kept passing while asserting
// on nothing. Only the four values these scenarios actually need to differ are overridden.
const realConstants = await import(join(SRC, "constants.ts"))
mock.module(join(SRC, "constants.ts"), () => ({
  ...realConstants,
  CLIENT_ID: "test-client-id",
  TOKEN_URL,
  ACTIVE_WAIT_TIMEOUT_MS: 80,
  ACTIVE_WAIT_POLL_MS: 5,
  WATCH_DEBOUNCE_MS: 50,
}))

const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"
const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile"
let refreshMode = "ok"
let rotated = { access_token: "", refresh_token: "", expires_in: 3600 }
let usageBody = {}
let posts = 0
let usageFetches = 0
let profileFetches = 0
let lastRefreshInput
const refreshInputs = []
let slowMs = 50
let stealTarget
let profileUuid = "u1"
const crashNextSave = () => { try { chmodSync(accountsDir, 0o500) } catch {} }
const healSave = () => { try { chmodSync(accountsDir, 0o700) } catch {} }
globalThis.fetch = (async (input, init) => {
  const url = String(input)
  if (url === TOKEN_URL) {
    posts++
    try { lastRefreshInput = JSON.parse(init?.body ?? "{}").refresh_token; refreshInputs.push(lastRefreshInput) } catch {}
    if (refreshMode === "throw-then-fresh") writeAuth(oauth("reread-access", "r-e2", future()))
    if (refreshMode === "429") return { ok: false, status: 429, text: async () => "", headers: { forEach: () => {} } }
    if (refreshMode === "invalid-grant") return { ok: false, status: 400, text: async () => JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }), headers: { forEach: () => {} } }
    if (refreshMode === "steal") {
      if (stealTarget) {
        const accs = readAccounts()
        const rec = accs.accounts.find((a) => a.id === stealTarget.id)
        if (rec) {
          rec.refresh = stealTarget.refresh; rec.access = stealTarget.access; rec.expires = stealTarget.expires
          if (stealTarget.flagged) rec.needsReauth = true
          else delete rec.needsReauth
          writeAccounts(accs)
        }
      }
      return { ok: false, status: 400, text: async () => JSON.stringify({ error: "invalid_grant" }), headers: { forEach: () => {} } }
    }
    if (refreshMode === "400-other") return { ok: false, status: 400, text: async () => JSON.stringify({ error: "rate_limit_error" }), headers: { forEach: () => {} } }
    if (refreshMode === "network") throw new Error("network down")
    if (refreshMode === "slow") { await new Promise((res) => setTimeout(res, slowMs)); return { ok: true, status: 200, json: async () => rotated } }
    if (refreshMode === "crash-persist") { crashNextSave(); return { ok: true, status: 200, json: async () => rotated } }
    if (refreshMode !== "ok") return { ok: false, status: 500, text: async () => "", headers: { forEach: () => {} } }
    return { ok: true, status: 200, json: async () => rotated }
  }
  if (url === USAGE_ENDPOINT) {
    usageFetches++
    return { ok: true, status: 200, json: async () => usageBody }
  }
  if (url === PROFILE_ENDPOINT) {
    profileFetches++
    return { ok: true, status: 200, json: async () => ({ account: { uuid: profileUuid, email: profileUuid === "u1" ? "a@x.com" : profileUuid + "@x.com" } }) }
  }
  return { ok: true, status: 200, json: async () => ({}) }
})

const { acquireActiveAccess, collectAllUsage, autoCapture, switchToAccount, refreshToken, retryFlaggedRefresh } = await import(join(SRC, "usage.ts"))
const { applyToken, loadAccounts, saveAccounts, upsertAccount, providerOf, accountsOf, activeIdOf, setActiveIdOf, setActiveId, removeAccount } = await import(join(SRC, "accounts.ts"))
let keeper
try { keeper = await import(join(SRC, "keeper.ts")) } catch { keeper = { keeperTick: async () => {}, onAuthJsonChanged: async () => {} } }
const reset = (mode) => { posts = 0; usageFetches = 0; profileFetches = 0; refreshMode = mode; rotated = { access_token: "", refresh_token: "", expires_in: 3600 }; usageBody = {}; lastRefreshInput = undefined; refreshInputs.length = 0; slowMs = 50; stealTarget = undefined; profileUuid = "u1" }
const activeRow = (res) => res.results.find((r) => r.active)
const cap = (row) => ({ error: row?.error, pending: row?.pending, hasUsage: Boolean(row?.usage), usageAsOf: row?.usageAsOf, fiveHour: row?.usage?.five_hour ?? null, sevenDay: row?.usage?.seven_day ?? null })
const results = {}

reset("ok"); writeAuth(oauth("fresh-access", "r-a", future()))
{ const o = await acquireActiveAccess(() => true); results.a = { state: o.state, access: o.access, refresh: o.authToken?.refresh, tokenAccess: o.authToken?.access, posts } }

reset("ok"); writeAuth(oauth("stale-access", "r-b", past()))
setTimeout(() => writeAuth(oauth("waited-access", "r-b", future())), 12)
{ const o = await acquireActiveAccess(() => true); results.b = { state: o.state, access: o.access, posts } }

reset("ok"); writeAuth(oauth("stale-access", "r-c", past()))
{ const o = await acquireActiveAccess(() => true); results.c = { state: o.state, refresh: o.authToken?.refresh, posts } }

reset("ok"); rotated = { access_token: "rotated-access", refresh_token: "rotated-refresh", expires_in: 3600 }; writeAuth(oauth("stale-access", "r-d", past()))
{ const o = await acquireActiveAccess(() => false); const w = readAuth(); results.d = { state: o.state, access: o.access, posts, wRefresh: w?.refresh, wAccess: w?.access } }

reset("throw-then-fresh"); writeAuth(oauth("stale-access", "r-e", past()))
{ const o = await acquireActiveAccess(() => false); results.e = { state: o.state, access: o.access, refresh: o.authToken?.refresh } }

reset("throw"); writeAuth(oauth("stale-access", "r-f", past()))
{ const o = await acquireActiveAccess(() => false); results.f = { state: o.state, access: o.access, refresh: o.authToken?.refresh } }

reset("ok"); writeAuth(undefined)
{ const o = await acquireActiveAccess(() => false); results.g = { state: o.state, posts } }

// ---- collectAllUsage scenarios (lastActiveUsage starts empty here) ----
const acctsActive = (rec) => ({ version: 1, activeId: "acc1", accounts: [rec] })

reset("ok"); writeAuth(undefined); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "acc-r", access: "acc-a", expires: future() }))
{ const res = await collectAllUsage({ isSessionRunning: () => false }); results.ch_missing = { ...cap(activeRow(res)), posts } }

reset("ok"); writeAuthRaw({ openai: { type: "oauth", access: "x", refresh: "y", expires: future() } }); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "acc-r", access: "acc-a", expires: future() }))
{ const res = await collectAllUsage({ isSessionRunning: () => false }); results.ch_openai = { ...cap(activeRow(res)), posts } }

reset("ok"); usageBody = { five_hour: { utilization: 42, resets_at: bodyFuture() } }; writeAuth(oauth("auth-access-a", "auth-refresh-a", future())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-refresh", access: "drift-access", expires: past() }))
{ const res = await collectAllUsage({ isSessionRunning: () => true }); const acc = readAccounts().accounts[0]; results.ca = { ...cap(activeRow(res)), posts, accRefresh: acc.refresh, accAccess: acc.access } }

reset("ok"); usageBody = { five_hour: { utilization: 11, resets_at: bodyFuture() } }; writeAuth(oauth("auth-access-e", "auth-refresh-e", future())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "stale-drift-e", access: "stale-drift-e-a", expires: past() }))
{ const res = await collectAllUsage({ isSessionRunning: () => true }); const acc = readAccounts().accounts[0]; results.ce = { posts, accRefresh: acc.refresh, accAccess: acc.access } }

reset("ok"); rotated = { access_token: "inact-new-access", refresh_token: "inact-new-refresh", expires_in: 3600 }; usageBody = { five_hour: { utilization: 10, resets_at: bodyFuture() } }; writeAuth(oauth("auth-access-d", "auth-refresh-d", future())); writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "drift-d", access: "drift-d-a", expires: past() }, { id: "acc2", label: "B", refresh: "inact-old-refresh", access: "inact-old-access", expires: past() }] })
{ const res = await collectAllUsage({ isSessionRunning: () => true }); const accs = readAccounts().accounts; const authNow = readAuth(); results.cd = { posts, activeHasUsage: Boolean(activeRow(res).usage), acc2Refresh: accs.find((a) => a.id === "acc2").refresh, authRefresh: authNow.refresh } }

reset("ok"); rotated = { access_token: "rot-b-access", refresh_token: "rot-b-refresh", expires_in: 3600 }; usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }; writeAuth(oauth("stale-b", "auth-refresh-b", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-b", access: "drift-b-a", expires: past() }))
{ const res = await collectAllUsage({ isSessionRunning: () => false }); const acc = readAccounts().accounts[0]; const authNow = readAuth(); results.cb = { posts, hasUsage: Boolean(activeRow(res).usage), accRefresh: acc.refresh, authRefresh: authNow.refresh, authAccess: authNow.access } }

reset("ok"); usageBody = { five_hour: { utilization: 7, resets_at: bodyFuture() } }; writeAuth(oauth("stale-f", "auth-refresh-f", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-f", access: "drift-f-a", expires: past() }))
setTimeout(() => writeAuth(oauth("exmachina-f-access", "exmachina-f-refresh", future())), 12)
{ const res = await collectAllUsage({ isSessionRunning: () => true }); const acc = readAccounts().accounts[0]; results.cf = { posts, hasUsage: Boolean(activeRow(res).usage), accRefresh: acc.refresh } }

reset("ok"); writeAuth(oauth("stale-g", "auth-refresh-g", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-g", access: "drift-g-a", expires: past() }))
{ const res = await collectAllUsage({ isSessionRunning: () => true }); results.cg = { ...cap(activeRow(res)), posts } }

reset("ok"); writeAuth(oauth("stale-c", "auth-refresh-c", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-c", access: "drift-c-a", expires: past() }))
{ let partialPending; const res = await collectAllUsage({ isSessionRunning: () => true, onPartial: (rows) => { partialPending = rows.find((r) => r.active)?.pending } }); const a = activeRow(res); results.cc = { partialPending, posts, finalResolved: Boolean(a.usage) || Boolean(a.error) } }

reset("ok"); usageBody = { five_hour: { utilization: 3, resets_at: bodyFuture() } }; writeAuth(oauth("noactive-access", "noactive-refresh", future())); writeAccounts({ version: 1, accounts: [{ id: "acc1", label: "A", refresh: "acc1-r", access: "acc1-a", expires: future() }] })
{ const res = await collectAllUsage({ isSessionRunning: () => false }); const a = res.results.find((r) => r.active); results.h_noactive = { activeId: res.activeId ?? null, activeLabel: a?.label, activeHasUsage: Boolean(a?.usage), posts } }

reset("429"); writeAuth(oauth("stale-j", "cooldown-refresh-j", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-j", access: "drift-j-a", expires: past() }))
await collectAllUsage({ isSessionRunning: () => false })
reset("ok"); writeAuth(oauth("stale-j2", "cooldown-refresh-j", past()))
{ const res = await collectAllUsage({ isSessionRunning: () => false }); results.cj = { ...cap(activeRow(res)), posts } }

reset("ok"); rotated = { access_token: "conc-access", refresh_token: "conc-refresh", expires_in: 3600 }; usageBody = { five_hour: { utilization: 1, resets_at: bodyFuture() } }; writeAuth(oauth("stale-i", "conc-refresh-old", past())); writeAccounts(acctsActive({ id: "acc1", label: "A", refresh: "drift-i", access: "drift-i-a", expires: past() }))
{ await Promise.all([collectAllUsage({ isSessionRunning: () => false }), collectAllUsage({ isSessionRunning: () => false })]); results.ci = { posts } }

// ---- autoCapture scenarios (T3): capture only with a valid token, NEVER refresh ----
reset("ok"); writeAuth(oauth("cap-access", "cap-refresh", future())); writeAccounts({ version: 1, accounts: [] })
{ await autoCapture(); const accts = readAccounts(); const acc = accts.accounts.find((a) => a.id === "u1"); results.cap_fresh = { posts, profileFetches, activeId: accts.activeId, accId: acc?.id, accLabel: acc?.label, accRefresh: acc?.refresh, accAccess: acc?.access } }

reset("ok"); writeAuth(oauth("expired-cap-access", "expired-cap-refresh", past())); writeAccounts({ version: 1, activeId: "pre", accounts: [{ id: "pre", label: "PRE", refresh: "pre-r", access: "pre-a", expires: future() }] })
{ const before = JSON.stringify(readAccounts()); const authBefore = JSON.stringify(readAuth()); await autoCapture(); results.cap_expired = { posts, profileFetches, accountsUnchanged: before === JSON.stringify(readAccounts()), authUnchanged: authBefore === JSON.stringify(readAuth()) } }

reset("ok"); writeAuth(undefined); writeAccounts({ version: 1, accounts: [] })
{ let threw = false; try { await autoCapture() } catch { threw = true } results.cap_noauth = { threw, posts, profileFetches, accountCount: readAccounts().accounts.length } }

// ---- switchToAccount scenarios (T4): reverse-sync OUTGOING active token before switching ----
const acctsAB = (a, b, activeId) => ({ version: 1, activeId, accounts: [a, b] })

// (a)/(b)/(c): auth.json holds a ROTATED token for OUTGOING active A; switch A→B (B fresh).
reset("ok")
writeAuth(oauth("A-rotated-access", "A-rotated-refresh", future()))
writeAccounts(acctsAB(
  { id: "acc1", label: "A", refresh: "A-stored-old", access: "A-stored-old-a", expires: future() },
  { id: "acc2", label: "B", refresh: "B-refresh", access: "B-access", expires: future() },
  "acc1",
))
{ const ret = await switchToAccount("acc2"); const accs = readAccounts(); const a = accs.accounts.find((x) => x.id === "acc1"); const authNow = readAuth(); results.sw_reverse = { posts, activeId: accs.activeId, retId: ret.id, aRefresh: a.refresh, aAccess: a.access, authRefresh: authNow.refresh, authAccess: authNow.access } }

// (a) malformed: auth.json missing → no crash, skip reverse-sync; outgoing record kept, target still written.
reset("ok"); writeAuth(undefined)
writeAccounts(acctsAB(
  { id: "acc1", label: "A", refresh: "A-keep", access: "A-keep-a", expires: future() },
  { id: "acc2", label: "B", refresh: "B-keep", access: "B-keep-a", expires: future() },
  "acc1",
))
{ let threw = false; try { await switchToAccount("acc2") } catch { threw = true } const accs = readAccounts(); const a = accs.accounts.find((x) => x.id === "acc1"); const authNow = readAuth(); results.sw_noauth = { threw, posts, aRefresh: a.refresh, activeId: accs.activeId, authRefresh: authNow.refresh } }

// (d) REGRESSION round-trip: A active + auth.json rotated A live; A→B then B→A → back path uses LIVE token, not dead.
reset("ok")
rotated = { access_token: "should-not-be-used", refresh_token: "should-not-be-used", expires_in: 3600 }
writeAuth(oauth("A-live-access", "A-live-refresh", future()))
writeAccounts(acctsAB(
  { id: "acc1", label: "A", refresh: "A-dead-refresh", access: "A-dead-access", expires: past() },
  { id: "acc2", label: "B", refresh: "B-refresh2", access: "B-access2", expires: future() },
  "acc1",
))
await switchToAccount("acc2")
await switchToAccount("acc1")
{ const accs = readAccounts(); const a = accs.accounts.find((x) => x.id === "acc1"); const authNow = readAuth(); results.sw_roundtrip = { posts, lastRefreshInput: lastRefreshInput ?? null, aRefresh: a.refresh, authRefresh: authNow.refresh, authAccess: authNow.access } }

// ---- Component B (T1): refresh error classification ----
reset("invalid-grant")
{ let e; try { await refreshToken("dead-ig") } catch (err) { e = err } results.cls_ig = { name: e?.name, revoked: e?.revoked === true, message: e?.message } }
reset("400-other")
{ let e; try { await refreshToken("dead-400") } catch (err) { e = err } results.cls_400 = { name: e?.name, revoked: e?.revoked === true, message: e?.message } }
reset("throw")
{ let e; try { await refreshToken("dead-500") } catch (err) { e = err } results.cls_500 = { name: e?.name, revoked: e?.revoked === true, message: e?.message } }
reset("network")
{ let e; try { await refreshToken("dead-net") } catch (err) { e = err } results.cls_net = { name: e?.name, revoked: e?.revoked === true, message: e?.message } }

// ---- Component C (T3): applyToken clears needsReauth; re-login self-clear ----
{
  const rec = { id: "x", label: "X", refresh: "old", access: "old-a", expires: past(), needsReauth: true }
  let threw = false
  try { applyToken(rec, { refresh: "new", access: "new-a", expires: future() }) } catch { threw = true }
  results.apply_unit = { threw, isFn: typeof applyToken === "function", refresh: rec.refresh, access: rec.access, hasFlag: "needsReauth" in rec }
}

reset("ok"); writeAuth(oauth("cap2-access", "cap2-refresh", future())); writeAccounts({ version: 1, activeId: "u1", accounts: [{ id: "u1", label: "old@x.com", refresh: "dead-cap", access: "dead-a", expires: past(), needsReauth: true }] })
{ await autoCapture(); const acc = readAccounts().accounts.find((a) => a.id === "u1"); results.cap_relogin = { hasFlag: acc ? ("needsReauth" in acc) : true, refresh: acc?.refresh, access: acc?.access } }

// ---- Component C collect (T5): skip flagged + flag on revoked (tests 2, 9) ----
reset("invalid-grant"); usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }
writeAuth(oauth("cB-auth-a", "cB-auth-r", future()))
writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "acc1-r", access: "acc1-a", expires: future() }, { id: "accB", label: "B", refresh: "dead-r", access: "dead-a", expires: past() }] })
{
  const res1 = await collectAllUsage({ isSessionRunning: () => false }); const bRow1 = res1.results.find((x) => x.id === "accB"); const accB1 = readAccounts().accounts.find((a) => a.id === "accB"); const posts1 = posts
  reset("invalid-grant"); usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }
  const res2 = await collectAllUsage({ isSessionRunning: () => false }); const bRow2 = res2.results.find((x) => x.id === "accB")
  results.creauth = { row1Error: bRow1?.error, flagged: accB1?.needsReauth === true, posts1, row2Error: bRow2?.error, posts2: posts }
}

reset("ok"); usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }
writeAuth(oauth("c9-auth-a", "c9-auth-r", future()))
writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "acc1-r", access: "acc1-a", expires: future() }, { id: "accN", label: "N", refresh: "n-r", needsReauth: true }] })
{ let threw = false; let res; try { res = await collectAllUsage({ isSessionRunning: () => false }) } catch { threw = true } const nRow = res?.results.find((x) => x.id === "accN"); results.creauth_noaccess = { threw, posts, rowError: nRow?.error } }

// ---- Component C switch (T7): refuse flagged target / flag-on-revoked / reverse-sync clear (tests 3, 8b) ----
reset("ok")
writeAuth(oauth("sw3-auth-a", "sw3-auth-r", future()))
writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "A-r", access: "A-a", expires: future() }, { id: "accB", label: "B", refresh: "B-dead", access: "B-fresh-a", expires: future(), needsReauth: true }] })
{ const authBefore = readFileSync(authPath, "utf8"); let threw = false; let msg; try { await switchToAccount("accB") } catch (e) { threw = true; msg = e?.message } const authAfter = readFileSync(authPath, "utf8"); results.sw_flagged = { threw, msg, authUnchanged: authBefore === authAfter, activeId: readAccounts().activeId, posts } }

reset("invalid-grant")
writeAuth(oauth("sw4-auth-a", "sw4-auth-r", future()))
writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "A-r2", access: "A-a2", expires: future() }, { id: "accB", label: "B", refresh: "B-dead2", access: "B-old-a", expires: past() }] })
{ const authBefore = readFileSync(authPath, "utf8"); let threw = false; try { await switchToAccount("accB") } catch { threw = true } const accB = readAccounts().accounts.find((a) => a.id === "accB"); const authAfter = readFileSync(authPath, "utf8"); results.sw_revoked = { threw, flagged: accB?.needsReauth === true, authUnchanged: authBefore === authAfter, activeId: readAccounts().activeId } }

reset("ok")
writeAuth(oauth("A-live-a-8b", "A-live-r-8b", future()))
writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "A-stale-dead", access: "A-stale-a", expires: past(), needsReauth: true }, { id: "accB", label: "B", refresh: "B-fresh-r", access: "B-fresh-a", expires: future() }] })
{ await switchToAccount("accB"); const accA = readAccounts().accounts.find((a) => a.id === "acc1"); results.sw_outgoing_clear = { aRefresh: accA?.refresh, aHasFlag: accA ? ("needsReauth" in accA) : true, activeId: readAccounts().activeId } }

// ---- Component C retry hatch (T10): retryFlaggedRefresh success clears / failure keeps flag (test 8c) ----
reset("ok"); rotated = { access_token: "retry-new-a", refresh_token: "retry-new-r", expires_in: 3600 }
writeAuth(oauth("rt-auth-a", "rt-auth-r", future()))
writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "acc1-r", access: "acc1-a", expires: future() }, { id: "accB", label: "B", refresh: "B-was-dead", access: "B-a", expires: past(), needsReauth: true }] })
{ let threw = false; try { await retryFlaggedRefresh("accB") } catch { threw = true } const accB = readAccounts().accounts.find((a) => a.id === "accB"); results.retry_ok = { threw, isFn: typeof retryFlaggedRefresh === "function", refresh: accB?.refresh, hasFlag: accB ? ("needsReauth" in accB) : true, posts } }

reset("invalid-grant")
writeAuth(oauth("rt2-auth-a", "rt2-auth-r", future()))
writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "acc1-r", access: "acc1-a", expires: future() }, { id: "accB", label: "B", refresh: "B-still-dead", access: "B-a", expires: past(), needsReauth: true }] })
{ let threw = false; try { await retryFlaggedRefresh("accB") } catch { threw = true } const accB = readAccounts().accounts.find((a) => a.id === "accB"); results.retry_fail = { threw, stillFlagged: accB?.needsReauth === true, refresh: accB?.refresh } }

// ---- Component A (T11): PATH-5 concurrency / switch-before-turn / crash-window (tests 4, 5, 7) ----
reset("slow"); slowMs = 60; rotated = { access_token: "R2-a", refresh_token: "R2", expires_in: 3600 }; usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }
writeAuth(oauth("A-auth-a", "A-auth-r", future()))
writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "acc1-r", access: "acc1-a", expires: future() }, { id: "accB", label: "B", refresh: "R1", access: "B-a", expires: soon() }] })
{
  const collectP = collectAllUsage({ isSessionRunning: () => false })
  await new Promise((res) => setTimeout(res, 15))
  const switchP = switchToAccount("accB")
  await Promise.allSettled([collectP, switchP])
  const accs = readAccounts(); const authNow = readAuth(); const accB = accs.accounts.find((a) => a.id === "accB")
  results.race_path5 = { posts, lastRefreshInput, authRefresh: authNow?.refresh, accBRefresh: accB?.refresh, activeId: accs.activeId }
}

reset("slow"); slowMs = 60; rotated = { access_token: "slowA-new-a", refresh_token: "slowA-new-r", expires_in: 3600 }; usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }
writeAuth(oauth("act-auth-a", "act-auth-r", future()))
writeAccounts({ version: 1, activeId: "act", accounts: [{ id: "act", label: "ACT", refresh: "act-r", access: "act-a", expires: future() }, { id: "slowA", label: "SA", refresh: "slowA-r", access: "slowA-a", expires: past() }, { id: "accB", label: "B", refresh: "B-R", access: "B-a", expires: soon() }] })
{
  const collectP = collectAllUsage({ isSessionRunning: () => false })
  await new Promise((res) => setTimeout(res, 15))
  const switchP = switchToAccount("accB")
  await Promise.allSettled([collectP, switchP])
  const authNow = readAuth(); const accs = readAccounts()
  results.race_before_turn = { bPosts: refreshInputs.filter((x) => x === "B-R").length, authRefresh: authNow?.refresh, activeId: accs.activeId }
}

reset("crash-persist"); rotated = { access_token: "c7-r2-a", refresh_token: "c7-R2", expires_in: 3600 }; usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }
writeAuth(oauth("c7-auth-a", "c7-auth-r", future()))
writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "acc1-r", access: "acc1-a", expires: future() }, { id: "accB", label: "B", refresh: "c7-R1", access: "B-a", expires: past() }] })
{
  let threw = false
  try { await collectAllUsage({ isSessionRunning: () => false }) } catch { threw = true }
  healSave()
  const crashRefresh = readAccounts().accounts.find((a) => a.id === "accB")?.refresh
  reset("invalid-grant"); usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }; writeAuth(oauth("c7-auth-a", "c7-auth-r", future()))
  await collectAllUsage({ isSessionRunning: () => false })
  const flaggedCycle2 = readAccounts().accounts.find((a) => a.id === "accB")?.needsReauth === true
  reset("invalid-grant"); usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }; writeAuth(oauth("c7-auth-a", "c7-auth-r", future()))
  await collectAllUsage({ isSessionRunning: () => false })
  results.crash7 = { threw, crashRefresh, flaggedCycle2, posts3: posts }
}

// ---- Component D (T13): doActiveSync guard against activeId drift / mid-collect rotation (test 6) ----
reset("slow"); slowMs = 80; rotated = { access_token: "slowX-new-a", refresh_token: "slowX-new-r", expires_in: 3600 }; usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }
writeAuth(oauth("A-v1-a", "A-v1-r", future()))
writeAccounts({ version: 1, activeId: "accA", accounts: [{ id: "accA", label: "A", refresh: "A-stored", access: "A-stored-a", expires: future() }, { id: "slowX", label: "SX", refresh: "slowX-r", access: "slowX-a", expires: past() }, { id: "accB", label: "B", refresh: "B-r", access: "B-a", expires: future() }] })
{
  const collectP = collectAllUsage({ isSessionRunning: () => false })
  await new Promise((res) => setTimeout(res, 20))
  writeAuth(oauth("A-v2-a", "A-v2-r", future()))
  await switchToAccount("accB")
  await collectP
  const accA = readAccounts().accounts.find((a) => a.id === "accA")
  results.dsync_drift = { aRefresh: accA?.refresh, activeId: readAccounts().activeId }
}

reset("slow"); slowMs = 80; rotated = { access_token: "slowY-new-a", refresh_token: "slowY-new-r", expires_in: 3600 }; usageBody = { five_hour: { utilization: 5, resets_at: bodyFuture() } }
writeAuth(oauth("AA-v1-a", "AA-v1-r", future()))
writeAccounts({ version: 1, activeId: "accA", accounts: [{ id: "accA", label: "A", refresh: "AA-stored", access: "AA-stored-a", expires: future() }, { id: "slowY", label: "SY", refresh: "slowY-r", access: "slowY-a", expires: past() }] })
{
  const collectP = collectAllUsage({ isSessionRunning: () => false })
  await new Promise((res) => setTimeout(res, 20))
  writeAuth(oauth("AA-v2-a", "AA-v2-r", future()))
  await collectP
  const accA = readAccounts().accounts.find((a) => a.id === "accA")
  results.dsync_rotate = { aRefresh: accA?.refresh, activeId: readAccounts().activeId }
}

// ---- Round 2: cross-process adopt-guard (another process rotated the token mid-POST) ----
reset("steal"); stealTarget = { id: "gB", refresh: "G2", access: "g2a", expires: future() }; usageBody = { five_hour: { utilization: 8, resets_at: bodyFuture() } }
writeAuth(oauth("gA-auth-a", "gA-auth-r", future()))
writeAccounts({ version: 1, activeId: "gA", accounts: [{ id: "gA", label: "GA", refresh: "gA-r", access: "gA-a", expires: future() }, { id: "gB", label: "GB", refresh: "G1", access: "g1a", expires: past() }] })
{
  const res = await collectAllUsage({ isSessionRunning: () => false })
  const bRow = res.results.find((x) => x.id === "gB")
  const accB = readAccounts().accounts.find((a) => a.id === "gB")
  results.guard_adopt = { posts, bRefresh: accB?.refresh, flagged: accB?.needsReauth === true, rowHasUsage: Boolean(bRow?.usage), rowError: bRow?.error }
}

reset("steal"); stealTarget = { id: "sB", refresh: "S2", access: "s2a", expires: future() }
writeAuth(oauth("sA-auth-a", "sA-auth-r", future()))
writeAccounts({ version: 1, activeId: "sA", accounts: [{ id: "sA", label: "SA", refresh: "sA-r", access: "sA-a", expires: future() }, { id: "sB", label: "SB", refresh: "S1", access: "s1a", expires: past() }] })
{
  let threw = false
  try { await switchToAccount("sB") } catch { threw = true }
  const accB = readAccounts().accounts.find((a) => a.id === "sB")
  results.switch_adopt = { threw, authRefresh: readAuth()?.refresh, bRefresh: accB?.refresh, flagged: accB?.needsReauth === true, activeId: readAccounts().activeId }
}

reset("steal"); stealTarget = { id: "rB", refresh: "R2x", access: "r2xa", expires: future() }
writeAuth(oauth("rA-auth-a", "rA-auth-r", future()))
writeAccounts({ version: 1, activeId: "rA", accounts: [{ id: "rA", label: "RA", refresh: "rA-r", access: "rA-a", expires: future() }, { id: "rB", label: "RB", refresh: "R1x", access: "r1xa", expires: past(), needsReauth: true }] })
{
  let threw = false
  try { await retryFlaggedRefresh("rB") } catch { threw = true }
  const accB = readAccounts().accounts.find((a) => a.id === "rB")
  results.retry_adopt = { threw, bRefresh: accB?.refresh, flagged: accB?.needsReauth === true }
}

// ---- Round 2b: adopt-guard must NOT adopt a record that is itself flagged (reviewer must-fix) ----
reset("steal"); stealTarget = { id: "fB", refresh: "F2", access: "f2a", expires: future(), flagged: true }
writeAuth(oauth("fA-auth-a", "fA-auth-r", future()))
writeAccounts({ version: 1, activeId: "fA", accounts: [{ id: "fA", label: "FA", refresh: "fA-r", access: "fA-a", expires: future() }, { id: "fB", label: "FB", refresh: "F1", access: "f1a", expires: past() }] })
{
  const authBefore = readFileSync(authPath, "utf8")
  let threw = false
  try { await switchToAccount("fB") } catch { threw = true }
  const accB = readAccounts().accounts.find((a) => a.id === "fB")
  results.switch_no_adopt_flagged = { threw, authUnchanged: readFileSync(authPath, "utf8") === authBefore, bRefresh: accB?.refresh, flagged: accB?.needsReauth === true, activeId: readAccounts().activeId }
}

reset("steal"); stealTarget = { id: "fC", refresh: "FC2", access: "fc2a", expires: future(), flagged: true }; usageBody = { five_hour: { utilization: 9, resets_at: bodyFuture() } }
writeAuth(oauth("fA2-auth-a", "fA2-auth-r", future()))
writeAccounts({ version: 1, activeId: "fA2", accounts: [{ id: "fA2", label: "FA2", refresh: "fA2-r", access: "fA2-a", expires: future() }, { id: "fC", label: "FC", refresh: "FC1", access: "fc1a", expires: past() }] })
{
  const res = await collectAllUsage({ isSessionRunning: () => false })
  const cRow = res.results.find((x) => x.id === "fC")
  const accC = readAccounts().accounts.find((a) => a.id === "fC")
  results.acquire_no_adopt_flagged = { cRefresh: accC?.refresh, cFlagged: accC?.needsReauth === true, rowNeedsReauth: cRow?.needsReauth === true, rowHasUsage: Boolean(cRow?.usage) }
}

reset("steal"); stealTarget = { id: "fD", refresh: "FD2", access: "fd2a", expires: future(), flagged: true }
writeAuth(oauth("fA3-auth-a", "fA3-auth-r", future()))
writeAccounts({ version: 1, activeId: "fA3", accounts: [{ id: "fA3", label: "FA3", refresh: "fA3-r", access: "fA3-a", expires: future() }, { id: "fD", label: "FD", refresh: "FD1", access: "fd1a", expires: past(), needsReauth: true }] })
{
  let threw = false
  try { await retryFlaggedRefresh("fD") } catch { threw = true }
  const accD = readAccounts().accounts.find((a) => a.id === "fD")
  results.retry_no_adopt_flagged = { threw, dRefresh: accD?.refresh, flagged: accD?.needsReauth === true }
}

// ---- Round 2: access-first display + persisted per-account usage cache ----
reset("ok"); usageBody = { five_hour: { utilization: 33, resets_at: bodyFuture() } }
writeAuth(oauth("afA-auth-a", "afA-auth-r", future()))
writeAccounts({ version: 1, activeId: "afA", accounts: [{ id: "afA", label: "AFA", refresh: "afA-r", access: "afA-a", expires: future() }, { id: "afB", label: "AFB", refresh: "afB-dead", access: "afB-live-a", expires: future(), needsReauth: true }] })
{
  const res = await collectAllUsage({ isSessionRunning: () => false })
  const bRow = res.results.find((x) => x.id === "afB")
  results.access_first = { posts, rowHasUsage: Boolean(bRow?.usage), rowNeedsReauth: bRow?.needsReauth === true, rowError: bRow?.error }
}

reset("ok"); usageBody = { five_hour: { utilization: 77, resets_at: bodyFuture() } }
writeAuth(oauth("cfA-auth-a", "cfA-auth-r", future()))
writeAccounts({ version: 1, activeId: "cfA", accounts: [{ id: "cfA", label: "CFA", refresh: "cfA-r", access: "cfA-a", expires: future() }, { id: "cfB", label: "CFB", refresh: "cfB-r", access: "cfB-a", expires: future() }] })
{
  await collectAllUsage({ isSessionRunning: () => false })
  writeAccounts({ version: 1, activeId: "cfA", accounts: [{ id: "cfA", label: "CFA", refresh: "cfA-r", access: "cfA-a", expires: future() }, { id: "cfB", label: "CFB", refresh: "cfB-dead", needsReauth: true }] })
  reset("invalid-grant"); usageBody = { five_hour: { utilization: 77, resets_at: bodyFuture() } }
  const res2 = await collectAllUsage({ isSessionRunning: () => false })
  const bRow2 = res2.results.find((x) => x.id === "cfB")
  let cacheExists = true
  try { readFileSync(join(homedir(), ".config", "opencode", "claude-usage-cache.json"), "utf8") } catch { cacheExists = false }
  results.nocache = { rowError: bRow2?.error, rowHasUsage: Boolean(bRow2?.usage), rowNeedsReauth: bRow2?.needsReauth === true, cacheExists }
}

// ---- Round 2: token keeper (background keep-alive tick + auth.json change capture) ----
reset("ok"); rotated = { access_token: "kB-new-a", refresh_token: "kB-new-r", expires_in: 3600 }
writeAuth(oauth("kA-auth-a", "kA-auth-r", future()))
writeAccounts({ version: 1, activeId: "kA", accounts: [
  { id: "kA", label: "KA", refresh: "kA-r", access: "kA-a", expires: past() },
  { id: "kB", label: "KB", refresh: "kB-r", access: "kB-a", expires: past() },
  { id: "kC", label: "KC", refresh: "kC-r", needsReauth: true },
  { id: "kD", label: "KD", refresh: "kD-r", access: "kD-a", expires: future() },
] })
{
  await keeper.keeperTick(() => false)
  const accs = readAccounts().accounts
  results.keeper_tick = { posts, inputs: [...refreshInputs], bRefresh: accs.find((a) => a.id === "kB")?.refresh, cFlagged: accs.find((a) => a.id === "kC")?.needsReauth === true, aRefresh: accs.find((a) => a.id === "kA")?.refresh }
}

// ---- Round 3: keeper keeps the ACTIVE chain fresh while idle (staggered from ex-machina) ----
reset("ok"); rotated = { access_token: "kact-new-a", refresh_token: "kact-new-r", expires_in: 3600 }
writeAuth(oauth("kact-a", "kact-r", Date.now() + 10 * 60000))
writeAccounts({ version: 1, activeId: "kX", accounts: [{ id: "kX", label: "KX", refresh: "kX-r", access: "kX-a", expires: future() }] })
{
  await keeper.keeperTick(() => false)
  const authNow = readAuth()
  results.keeper_active = { posts, inputs: [...refreshInputs], authRefresh: authNow?.refresh, authAccess: authNow?.access }
}

reset("ok"); writeAuth(oauth("krun-a", "krun-r", Date.now() + 10 * 60000))
writeAccounts({ version: 1, activeId: "kX", accounts: [{ id: "kX", label: "KX", refresh: "kX-r", access: "kX-a", expires: future() }] })
{
  await keeper.keeperTick(() => true)
  results.keeper_active_running = { posts, authRefresh: readAuth()?.refresh }
}

reset("invalid-grant"); writeAuth(oauth("kdead-a", "kdead-r", past()))
writeAccounts({ version: 1, activeId: "kX", accounts: [{ id: "kX", label: "KX", refresh: "kX-r", access: "kX-a", expires: future() }] })
{
  await keeper.keeperTick(() => false)
  const postsAfterFirst = posts
  await keeper.keeperTick(() => false)
  results.keeper_active_dead = { postsAfterFirst, postsAfterSecond: posts, authRefresh: readAuth()?.refresh }
}

reset("ok"); profileUuid = "u7"
writeAuth(oauth("u7-access", "u7-refresh", future()))
writeAccounts({ version: 1, activeId: "kA", accounts: [{ id: "kA", label: "KA", refresh: "kA-r2", access: "kA-a2", expires: future() }] })
{
  await keeper.onAuthJsonChanged()
  const accs = readAccounts()
  const u7 = accs.accounts.find((a) => a.id === "u7")
  results.keeper_capture = { captured: Boolean(u7), u7Refresh: u7?.refresh, activeId: accs.activeId }
}
writeAuth(oauth("u7-access-2", "u7-refresh-2", future()))
{
  await keeper.onAuthJsonChanged()
  const u7 = readAccounts().accounts.find((a) => a.id === "u7")
  results.keeper_rotate = { u7Refresh: u7?.refresh, u7Access: u7?.access }
}
{
  const before = profileFetches
  await keeper.onAuthJsonChanged()
  results.keeper_skip = { extraProfile: profileFetches - before }
}

// ---- Fable: /usage limits[] weekly_scoped normalized into usage.scoped (per-model weekly window) ----
reset("ok"); usageBody = { five_hour: { utilization: 53, resets_at: bodyFuture() }, seven_day: { utilization: 48, resets_at: bodyFuture() }, seven_day_opus: null, seven_day_sonnet: null, limits: [ { kind: "session", percent: 53 }, { kind: "weekly_all", percent: 48 }, { kind: "weekly_scoped", percent: 7, resets_at: bodyFuture(), scope: { model: { display_name: "Fable" } } }, { kind: "weekly_scoped", percent: 3, resets_at: bodyFuture(), scope: { model: { display_name: null } } }, { kind: "weekly_scoped", percent: NaN, resets_at: bodyFuture(), scope: { model: { display_name: "Ghost" } } }, { kind: "weekly_scoped", percent: 9, resets_at: 999, scope: { model: { display_name: "Cove" } } } ] }
writeAuth(oauth("fable-a", "fable-r", future()))
writeAccounts({ version: 1, activeId: "fbl", accounts: [{ id: "fbl", label: "FBL", refresh: "fbl-r", access: "fbl-a", expires: future() }] })
{
  const res = await collectAllUsage({ isSessionRunning: () => false })
  const row = activeRow(res)
  results.scoped_fable = { scoped: row?.usage?.scoped ?? null, sevenDayOpus: row?.usage?.seven_day_opus ?? null, hasFiveHour: Boolean(row?.usage?.five_hour) }
}

// ---- provider-aware pool (accounts.ts): legacy store loads unchanged, pools independent ----
// Runs in the child because the REAL accounts.ts is only linkable here (see header) and its
// ACCOUNTS_PATH is homedir-derived, which only a fresh process with HOME=<tmp> can redirect.
writeAccounts({ version: 1, activeId: "lg1", accounts: [
  { id: "lg1", label: "L1", refresh: "lg1-r", access: "lg1-a", expires: future() },
  { id: "lg2", label: "L2", refresh: "lg2-r", access: "lg2-a", expires: future() },
] })
{
  const legacy = await loadAccounts()
  await saveAccounts(legacy)
  const after = readAccounts()
  results.prov_legacy = {
    providers: legacy.accounts.map((a) => providerOf(a)),
    anthropicIds: accountsOf(legacy, "anthropic").map((a) => a.id),
    openaiCount: accountsOf(legacy, "openai").length,
    anthropicActive: activeIdOf(legacy, "anthropic"),
    openaiActive: activeIdOf(legacy, "openai") ?? null,
    providerKeyWritten: after.accounts.some((a) => "provider" in a),
    openaiActiveKeyWritten: "openaiActiveId" in after,
    activeIdAfter: after.activeId,
    idsAfter: after.accounts.map((a) => a.id),
  }
}

writeAccounts({ version: 1, activeId: "aA", openaiActiveId: "oB", accounts: [
  { id: "aA", label: "A", refresh: "aA-r" },
  { id: "oB", label: "B", refresh: "oB-r", provider: "openai", accountId: "acct-oB", lastActiveAt: 111 },
  { id: "aC", label: "C", refresh: "aC-r", provider: "anthropic" },
] })
{
  const mixed = await loadAccounts()
  const openai = accountsOf(mixed, "openai")
  results.prov_mixed = {
    anthropicIds: accountsOf(mixed, "anthropic").map((a) => a.id),
    openaiIds: openai.map((a) => a.id),
    openaiAccountId: openai[0]?.accountId,
    openaiLastActiveAt: openai[0]?.lastActiveAt,
    anthropicActive: activeIdOf(mixed, "anthropic"),
    openaiActive: activeIdOf(mixed, "openai"),
  }
}

writeAccounts({ version: 1, accounts: [{ id: "oOnly", label: "O", refresh: "o-r", provider: "openai" }] })
{
  const openaiOnly = await loadAccounts()
  results.prov_empty = {
    anthropic: accountsOf(openaiOnly, "anthropic"),
    openaiIds: accountsOf(openaiOnly, "openai").map((a) => a.id),
  }
}

{
  const file = { version: 1, activeId: "aKeep", openaiActiveId: "oKeep", accounts: [] }
  setActiveIdOf(file, "openai", "oNew")
  const afterOpenaiSet = { activeId: file.activeId, openaiActiveId: file.openaiActiveId }
  setActiveIdOf(file, "anthropic", "aNew")
  const afterAnthropicSet = { activeId: file.activeId, openaiActiveId: file.openaiActiveId }
  setActiveIdOf(file, "openai", undefined)
  results.prov_active = {
    afterOpenaiSet,
    afterAnthropicSet,
    afterOpenaiClear: { activeId: activeIdOf(file, "anthropic"), openaiActiveId: activeIdOf(file, "openai") ?? null },
  }
}

writeAccounts({ version: 1, activeId: "up0", openaiActiveId: "oKeep", accounts: [{ id: "up0", label: "U0", refresh: "up0-r" }] })
{
  await upsertAccount("up1", "U1", { refresh: "up1-r", access: "up1-a", expires: future() })
  const after = readAccounts()
  results.prov_upsert = {
    activeId: after.activeId,
    openaiActiveId: after.openaiActiveId,
    newProvider: after.accounts.find((a) => a.id === "up1")?.provider ?? null,
  }
}

// ---- INV-P1: the anthropic slot refuses a cross-provider target, and the anthropic usage
// collect never lets one reach a request builder. Both fixtures give the ChatGPT record an
// EXPIRED token, so a provider-blind path POSTs its refresh to Anthropic's TOKEN_URL and the
// leak shows up as a nonzero \`posts\` count.
const oaRec = (accountId, refresh, expires) => ({ id: "openai:" + accountId, label: "OA-" + accountId, refresh, access: accountId + "-a", expires, provider: "openai", accountId })

reset("ok"); writeAuth(oauth("gA-auth-a", "gA-auth-r", future()))
writeAccounts({ version: 1, activeId: "gA", openaiActiveId: "openai:acct-G", accounts: [
  { id: "gA", label: "GA", refresh: "gA-r", access: "gA-a", expires: future() },
  { id: "gB", label: "GB", refresh: "gB-r", access: "gB-a", expires: future() },
  oaRec("acct-G", "oG-r", past()),
] })
{
  const authBefore = readFileSync(authPath, "utf8")
  let threw = false
  let msg
  try { await switchToAccount("openai:acct-G") } catch (e) { threw = true; msg = e?.message }
  const authAfterWrong = readFileSync(authPath, "utf8")
  const stillOpenai = readAccounts().accounts.find((a) => a.id === "openai:acct-G")
  // The explicit-argument path a post-wave caller must use, proving the guard passes an
  // in-provider target through unchanged.
  let explicitThrew = false
  try { await switchToAccount("gB", "anthropic") } catch { explicitThrew = true }
  results.sw_provider = {
    threw, msg, posts,
    authUnchanged: authAfterWrong === authBefore,
    openaiRefresh: stillOpenai?.refresh,
    openaiActiveId: readAccounts().openaiActiveId,
    explicitThrew,
    activeId: readAccounts().activeId,
    authRefresh: readAuth()?.refresh,
  }
}

reset("ok"); usageBody = { five_hour: { utilization: 12, resets_at: bodyFuture() } }
writeAuth(oauth("cxA-auth-a", "cxA-auth-r", future()))
writeAccounts({ version: 1, activeId: "cxA", openaiActiveId: "openai:acct-X", accounts: [
  { id: "cxA", label: "CXA", refresh: "cxA-r", access: "cxA-a", expires: future() },
  oaRec("acct-X", "oX-r", past()),
  { id: "cxB", label: "CXB", refresh: "cxB-r", access: "cxB-a", expires: future() },
] })
{
  const res = await collectAllUsage({ isSessionRunning: () => false })
  const ox = readAccounts().accounts.find((a) => a.id === "openai:acct-X")
  results.collect_openai = {
    posts, usageFetches, refreshInputs: [...refreshInputs],
    ids: res.results.map((row) => row.id),
    openaiRefresh: ox?.refresh,
    openaiFlagged: ox?.needsReauth === true,
  }
}

// ---- INV-P1 backfill: the three guards that landed without tests. Each fixture also runs an
// IN-PROVIDER control call, so a "zero network requests" assertion cannot pass merely because
// nothing in the fixture could ever have issued one.
reset("ok"); writeAuth(oauth("rfA-auth-a", "rfA-auth-r", future()))
writeAccounts({ version: 1, activeId: "rfA", openaiActiveId: "openai:acct-R", accounts: [
  { id: "rfA", label: "RFA", refresh: "rfA-r", access: "rfA-a", expires: future() },
  oaRec("acct-R", "oR-r", past()),
] })
{
  // Flag the ChatGPT record needsReauth: that is EXACTLY the row whose "press enter to retry"
  // escape hatch retryFlaggedRefresh is, so a provider-blind version would POST oR-r to
  // Anthropic's TOKEN_URL and let the resulting 400 brand a healthy account dead.
  const seeded = readAccounts()
  seeded.accounts.find((a) => a.id === "openai:acct-R").needsReauth = true
  writeAccounts(seeded)
  let threw = false
  let msg
  try { await retryFlaggedRefresh("openai:acct-R") } catch (e) { threw = true; msg = e?.message }
  const postsAfterRefusal = posts
  const inputsAfterRefusal = [...refreshInputs]
  const after = readAccounts().accounts.find((a) => a.id === "openai:acct-R")
  let explicitThrew = false
  try { await retryFlaggedRefresh("rfA") } catch { explicitThrew = true }
  results.retry_provider = {
    threw, msg,
    posts: postsAfterRefusal,
    refreshInputs: inputsAfterRefusal,
    postsAfterControl: posts,
    controlInput: refreshInputs[refreshInputs.length - 1],
    openaiRefresh: after?.refresh,
    stillFlagged: after?.needsReauth === true,
    explicitThrew,
  }
}

reset("ok")
writeAccounts({ version: 1, activeId: "saA", openaiActiveId: "openai:acct-S", accounts: [
  { id: "saA", label: "SAA", refresh: "saA-r" },
  { id: "saB", label: "SAB", refresh: "saB-r" },
  oaRec("acct-S", "oS-r", future()),
] })
{
  const ptr = () => ({ activeId: readAccounts().activeId, openaiActiveId: readAccounts().openaiActiveId })
  await setActiveId("openai:acct-S")
  const afterWrong = ptr()
  await setActiveId("nope-missing")
  const afterMissing = ptr()
  await setActiveId("saB")
  const afterOk = ptr()
  results.set_active_provider = { afterWrong, afterMissing, afterOk, posts }
}

reset("ok")
writeAccounts({ version: 1, activeId: "rmA", openaiActiveId: "openai:acct-M", accounts: [
  { id: "rmA", label: "RMA", refresh: "rmA-r" },
  oaRec("acct-M", "oM-r", future()),
] })
{
  const snap = () => { const f = readAccounts(); return { activeId: f.activeId ?? null, openaiActiveId: f.openaiActiveId ?? null, ids: f.accounts.map((a) => a.id) } }
  const removedOpenai = await removeAccount("openai:acct-M")
  const afterOpenai = snap()
  const removedAnthropic = await removeAccount("rmA")
  const afterAnthropic = snap()
  // A pointer naming a DIFFERENT record must SURVIVE the delete, or the guard is just
  // "always blank both pointers".
  writeAccounts({ version: 1, activeId: "keepA", openaiActiveId: "openai:acct-K", accounts: [
    { id: "keepA", label: "KA", refresh: "keepA-r" },
    { id: "dropA", label: "DA", refresh: "dropA-r" },
    oaRec("acct-K", "oK-r", future()),
  ] })
  await removeAccount("dropA")
  const afterOther = snap()
  results.remove_pointers = {
    removedOpenaiId: removedOpenai?.id ?? null,
    removedAnthropicId: removedAnthropic?.id ?? null,
    afterOpenai, afterAnthropic, afterOther,
  }
}

writeFileSync(OUT, JSON.stringify(results))
test("acquireActiveAccess scenarios executed", () => {})
`

type Outcome = { state: string; access?: string; refresh?: string; tokenAccess?: string; posts?: number; wRefresh?: string; wAccess?: string }
type Window = { utilization: number; resets_at?: string } | null
type CollectRow = {
  error?: string
  pending?: string
  hasUsage?: boolean
  usageAsOf?: number | null
  fiveHour?: Window
  sevenDay?: Window
  posts?: number
  accRefresh?: string
  accAccess?: string
  authRefresh?: string
  authAccess?: string
  acc2Refresh?: string
  activeHasUsage?: boolean
  activeId?: string | null
  activeLabel?: string
  partialPending?: string
  finalResolved?: boolean
}
type CaptureRow = {
  posts?: number
  profileFetches?: number
  activeId?: string
  accId?: string
  accLabel?: string
  accRefresh?: string
  accAccess?: string
  accountsUnchanged?: boolean
  authUnchanged?: boolean
  threw?: boolean
  accountCount?: number
}
type SwitchRow = {
  posts?: number
  activeId?: string
  retId?: string
  aRefresh?: string
  aAccess?: string
  authRefresh?: string
  authAccess?: string
  threw?: boolean
  lastRefreshInput?: string | null
}
type ClsRow = { name?: string; revoked?: boolean; message?: string }
type ApplyRow = { threw?: boolean; isFn?: boolean; refresh?: string; access?: string; hasFlag?: boolean }
type ReloginRow = { hasFlag?: boolean; refresh?: string; access?: string }
type ReauthCollectRow = { row1Error?: string; flagged?: boolean; posts1?: number; row2Error?: string; posts2?: number }
type ReauthNoAccessRow = { threw?: boolean; posts?: number; rowError?: string }
type SwFlaggedRow = { threw?: boolean; msg?: string; authUnchanged?: boolean; activeId?: string; posts?: number }
type SwRevokedRow = { threw?: boolean; flagged?: boolean; authUnchanged?: boolean; activeId?: string }
type SwOutgoingClearRow = { aRefresh?: string; aHasFlag?: boolean; activeId?: string }
type RetryOkRow = { threw?: boolean; isFn?: boolean; refresh?: string; hasFlag?: boolean; posts?: number }
type RetryFailRow = { threw?: boolean; stillFlagged?: boolean; refresh?: string }
type RacePath5Row = { posts?: number; lastRefreshInput?: string; authRefresh?: string; accBRefresh?: string; activeId?: string }
type RaceBeforeTurnRow = { bPosts?: number; authRefresh?: string; activeId?: string }
type Crash7Row = { threw?: boolean; crashRefresh?: string; flaggedCycle2?: boolean; posts3?: number }
type DsyncRow = { aRefresh?: string; activeId?: string }
type GuardAdoptRow = { posts?: number; bRefresh?: string; flagged?: boolean; rowHasUsage?: boolean; rowError?: string }
type SwitchAdoptRow = { threw?: boolean; authRefresh?: string; bRefresh?: string; flagged?: boolean; activeId?: string }
type RetryAdoptRow = { threw?: boolean; bRefresh?: string; flagged?: boolean }
type AccessFirstRow = { posts?: number; rowHasUsage?: boolean; rowNeedsReauth?: boolean; rowError?: string }
type NocacheRow = { rowError?: string; rowHasUsage?: boolean; rowNeedsReauth?: boolean; cacheExists?: boolean }
type KeeperActiveRow = { posts?: number; inputs?: string[]; authRefresh?: string; authAccess?: string }
type KeeperActiveDeadRow = { postsAfterFirst?: number; postsAfterSecond?: number; authRefresh?: string }
type KeeperTickRow = { posts?: number; inputs?: string[]; bRefresh?: string; cFlagged?: boolean; aRefresh?: string }
type KeeperCaptureRow = { captured?: boolean; u7Refresh?: string; activeId?: string }
type KeeperRotateRow = { u7Refresh?: string; u7Access?: string }
type KeeperSkipRow = { extraProfile?: number }
type SwitchNoAdoptRow = { threw?: boolean; authUnchanged?: boolean; bRefresh?: string; flagged?: boolean; activeId?: string }
type AcquireNoAdoptRow = { cRefresh?: string; cFlagged?: boolean; rowNeedsReauth?: boolean; rowHasUsage?: boolean }
type RetryNoAdoptRow = { threw?: boolean; dRefresh?: string; flagged?: boolean }
type Results = {
  a: Outcome; b: Outcome; c: Outcome; d: Outcome; e: Outcome; f: Outcome; g: Outcome
  ch_missing: CollectRow; ch_openai: CollectRow; ca: CollectRow; ce: CollectRow; cd: CollectRow
  cb: CollectRow; cf: CollectRow; cg: CollectRow; cc: CollectRow; h_noactive: CollectRow
  cj: CollectRow; ci: CollectRow
  cap_fresh: CaptureRow; cap_expired: CaptureRow; cap_noauth: CaptureRow
  sw_reverse: SwitchRow; sw_noauth: SwitchRow; sw_roundtrip: SwitchRow
  cls_ig: ClsRow; cls_400: ClsRow; cls_500: ClsRow; cls_net: ClsRow
  apply_unit: ApplyRow; cap_relogin: ReloginRow
  creauth: ReauthCollectRow; creauth_noaccess: ReauthNoAccessRow
  sw_flagged: SwFlaggedRow; sw_revoked: SwRevokedRow; sw_outgoing_clear: SwOutgoingClearRow
  retry_ok: RetryOkRow; retry_fail: RetryFailRow
  race_path5: RacePath5Row; race_before_turn: RaceBeforeTurnRow; crash7: Crash7Row
  dsync_drift: DsyncRow; dsync_rotate: DsyncRow
  guard_adopt: GuardAdoptRow; switch_adopt: SwitchAdoptRow; retry_adopt: RetryAdoptRow
  access_first: AccessFirstRow; nocache: NocacheRow
  keeper_tick: KeeperTickRow; keeper_capture: KeeperCaptureRow; keeper_rotate: KeeperRotateRow; keeper_skip: KeeperSkipRow
  keeper_active: KeeperActiveRow; keeper_active_running: KeeperActiveRow; keeper_active_dead: KeeperActiveDeadRow
  switch_no_adopt_flagged: SwitchNoAdoptRow; acquire_no_adopt_flagged: AcquireNoAdoptRow; retry_no_adopt_flagged: RetryNoAdoptRow
  scoped_fable: { scoped: Array<{ label: string; utilization: number; resets_at?: string }> | null; sevenDayOpus: unknown; hasFiveHour: boolean }
  prov_legacy: ProvLegacyRow; prov_mixed: ProvMixedRow; prov_empty: ProvEmptyRow
  prov_active: ProvActiveRow; prov_upsert: ProvUpsertRow
  sw_provider: SwProviderRow; collect_openai: CollectOpenaiRow
  retry_provider: RetryProviderRow; set_active_provider: SetActiveProviderRow; remove_pointers: RemovePointersRow
}
type RetryProviderRow = {
  threw: boolean
  msg?: string
  posts: number
  refreshInputs: string[]
  postsAfterControl: number
  controlInput?: string
  openaiRefresh?: string
  stillFlagged: boolean
  explicitThrew: boolean
}
type SetActiveProviderRow = { afterWrong: ProvActiveIds; afterMissing: ProvActiveIds; afterOk: ProvActiveIds; posts: number }
type PointerSnap = { activeId: string | null; openaiActiveId: string | null; ids: string[] }
type RemovePointersRow = {
  removedOpenaiId: string | null
  removedAnthropicId: string | null
  afterOpenai: PointerSnap
  afterAnthropic: PointerSnap
  afterOther: PointerSnap
}
type ProvLegacyRow = {
  providers: string[]
  anthropicIds: string[]
  openaiCount: number
  anthropicActive?: string
  openaiActive: string | null
  providerKeyWritten: boolean
  openaiActiveKeyWritten: boolean
  activeIdAfter?: string
  idsAfter: string[]
}
type ProvMixedRow = {
  anthropicIds: string[]
  openaiIds: string[]
  openaiAccountId?: string
  openaiLastActiveAt?: number
  anthropicActive?: string
  openaiActive?: string
}
type ProvEmptyRow = { anthropic: unknown[]; openaiIds: string[] }
type ProvActiveIds = { activeId?: string; openaiActiveId?: string }
type ProvActiveRow = {
  afterOpenaiSet: ProvActiveIds
  afterAnthropicSet: ProvActiveIds
  afterOpenaiClear: { activeId?: string; openaiActiveId: string | null }
}
type ProvUpsertRow = { activeId?: string; openaiActiveId?: string; newProvider: string | null }
type SwProviderRow = {
  threw: boolean
  msg?: string
  posts: number
  authUnchanged: boolean
  openaiRefresh?: string
  openaiActiveId?: string
  explicitThrew: boolean
  activeId?: string
  authRefresh?: string
}
type CollectOpenaiRow = {
  posts: number
  usageFetches: number
  refreshInputs: string[]
  ids: string[]
  openaiRefresh?: string
  openaiFlagged: boolean
}

const runnerDir = mkdtempSync(join(tmpdir(), "cau-parent-"))
const runnerPath = join(runnerDir, "runner.test.ts")
const outPath = join(runnerDir, "results.json")
writeFileSync(runnerPath, runnerSource)

const childHome = mkdtempSync(join(tmpdir(), "cau-home-"))
const proc = Bun.spawnSync(["bun", "test", runnerPath], {
  env: { ...process.env, CAU_SRC: import.meta.dir, CAU_OUT: outPath, HOME: childHome },
  stdout: "pipe",
  stderr: "pipe",
})
if (proc.exitCode !== 0) {
  throw new Error(`acquireActiveAccess runner failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}\n${proc.stdout.toString()}`)
}
const r = JSON.parse(readFileSync(outPath, "utf8")) as Results

test("acquireActiveAccess (a) fresh auth → state fresh, 0 POSTs to TOKEN_URL", () => {
  expect(r.a.state).toBe("fresh")
  expect(r.a.access).toBe("fresh-access")
  expect(r.a.refresh).toBe("r-a")
  expect(r.a.tokenAccess).toBe("fresh-access")
  expect(r.a.posts).toBe(0)
})

test("acquireActiveAccess (b) expired + running, freshens during poll → waited, 0 POSTs", () => {
  expect(r.b.state).toBe("waited")
  expect(r.b.access).toBe("waited-access")
  expect(r.b.posts).toBe(0)
})

test("acquireActiveAccess (c) expired + running never freshens → waiting-timeout (bounded), 0 POSTs", () => {
  expect(r.c.state).toBe("waiting-timeout")
  expect(r.c.refresh).toBe("r-c")
  expect(r.c.posts).toBe(0)
})

test("acquireActiveAccess (d) expired + idle → exactly 1 POST + writes rotated token, self-refreshed", () => {
  expect(r.d.state).toBe("self-refreshed")
  expect(r.d.access).toBe("rotated-access")
  expect(r.d.posts).toBe(1)
  expect(r.d.wRefresh).toBe("rotated-refresh")
  expect(r.d.wAccess).toBe("rotated-access")
})

test("acquireActiveAccess (e) expired + idle, refresh throws + re-read fresh → self-refreshed uses re-read token (H2)", () => {
  expect(r.e.state).toBe("self-refreshed")
  expect(r.e.access).toBe("reread-access")
  expect(r.e.refresh).toBe("r-e2")
})

test("acquireActiveAccess (f) expired + idle, refresh throws + re-read still stale → unavailable", () => {
  expect(r.f.state).toBe("unavailable")
  expect(r.f.access).toBeUndefined()
  expect(r.f.refresh).toBe("r-f")
})

test("acquireActiveAccess (g) auth.json missing + idle → unavailable, no crash, 0 POSTs", () => {
  expect(r.g.state).toBe("unavailable")
  expect(r.g.posts).toBe(0)
})

test("collectAllUsage (a) active FRESH → 0 POSTs, real-time usage + accounts.json reverse-synced to auth token", () => {
  expect(r.ca.posts).toBe(0)
  expect(r.ca.hasUsage).toBe(true)
  expect(r.ca.accRefresh).toBe("auth-refresh-a")
  expect(r.ca.accAccess).toBe("auth-access-a")
})

test("collectAllUsage (b) active EXPIRED + idle → exactly 1 POST + auth.json written + accounts.json reverse-synced to rotated", () => {
  expect(r.cb.posts).toBe(1)
  expect(r.cb.hasUsage).toBe(true)
  expect(r.cb.authRefresh).toBe("rot-b-refresh")
  expect(r.cb.authAccess).toBe("rot-b-access")
  expect(r.cb.accRefresh).toBe("rot-b-refresh")
})

test("collectAllUsage (c) active EXPIRED + running → onPartial fires pending=waiting-refresh, 0 POSTs, then resolves", () => {
  expect(r.cc.partialPending).toBe("waiting-refresh")
  expect(r.cc.posts).toBe(0)
  expect(r.cc.finalResolved).toBe(true)
})

test("collectAllUsage (d) inactive stale account refreshes as before — 1 POST, its record updated, auth.json untouched", () => {
  expect(r.cd.posts).toBe(1)
  expect(r.cd.activeHasUsage).toBe(true)
  expect(r.cd.acc2Refresh).toBe("inact-new-refresh")
  expect(r.cd.authRefresh).toBe("auth-refresh-d")
})

test("collectAllUsage (e) drift proof — FRESH branch, accounts.json active record after run equals auth.json token, 0 POSTs", () => {
  expect(r.ce.posts).toBe(0)
  expect(r.ce.accRefresh).toBe("auth-refresh-e")
  expect(r.ce.accAccess).toBe("auth-access-e")
})

test("collectAllUsage (f) RUNNING poll success — token flips fresh mid-poll → fetch uses ex-machina token, 0 POSTs", () => {
  expect(r.cf.posts).toBe(0)
  expect(r.cf.hasUsage).toBe(true)
  expect(r.cf.accRefresh).toBe("exmachina-f-refresh")
})

test("collectAllUsage (g) RUNNING timeout → honest unavailable error, NO cached bars, 0 POSTs", () => {
  expect(r.cg.posts).toBe(0)
  expect(r.cg.hasUsage).toBe(false)
  expect(r.cg.error).toBe("额度暂不可用(等待 token 刷新)")
})

test("collectAllUsage (h) activeId undefined + auth FRESH → synthesized active row, 0 POSTs for auth-held account", () => {
  expect(r.h_noactive.activeId).toBe(null)
  expect(r.h_noactive.activeLabel).toBe("当前账号")
  expect(r.h_noactive.activeHasUsage).toBe(true)
  expect(r.h_noactive.posts).toBe(0)
})

test("collectAllUsage (h) auth.json missing → active row '未登录', 0 POSTs", () => {
  expect(r.ch_missing.error).toBe("未登录")
  expect(r.ch_missing.posts).toBe(0)
})

test("collectAllUsage (h) openai-only auth.json → no anthropic token → '未登录', 0 POSTs", () => {
  expect(r.ch_openai.error).toBe("未登录")
  expect(r.ch_openai.posts).toBe(0)
})

test("collectAllUsage (i) concurrent modal + background overlap → exactly ONE TOKEN_URL POST", () => {
  expect(r.ci.posts).toBe(1)
})

test("collectAllUsage (j) IDLE + refresh429Cooldown active → skip refresh, honest unavailable error, 0 POSTs", () => {
  expect(r.cj.posts).toBe(0)
  expect(r.cj.hasUsage).toBe(false)
  expect(r.cj.error).toBe("额度暂不可用(等待 token 刷新)")
})



test("autoCapture (a) auth FRESH → fetchProfile + upsertAccount store token AS-IS, 0 POSTs to TOKEN_URL", () => {
  expect(r.cap_fresh.posts).toBe(0)
  expect(r.cap_fresh.profileFetches).toBe(1)
  expect(r.cap_fresh.accId).toBe("u1")
  expect(r.cap_fresh.accLabel).toBe("a@x.com")
  expect(r.cap_fresh.accRefresh).toBe("cap-refresh")
  expect(r.cap_fresh.accAccess).toBe("cap-access")
  expect(r.cap_fresh.activeId).toBe("u1")
})

test("autoCapture (b) auth EXPIRED → 0 POSTs, no profile fetch, no upsert, auth.json untouched (no writeAuthAnthropic)", () => {
  expect(r.cap_expired.posts).toBe(0)
  expect(r.cap_expired.profileFetches).toBe(0)
  expect(r.cap_expired.accountsUnchanged).toBe(true)
  expect(r.cap_expired.authUnchanged).toBe(true)
})

test("autoCapture (malformed) auth.json missing → early return, no crash, nothing written", () => {
  expect(r.cap_noauth.threw).toBe(false)
  expect(r.cap_noauth.posts).toBe(0)
  expect(r.cap_noauth.profileFetches).toBe(0)
  expect(r.cap_noauth.accountCount).toBe(0)
})

test("autoCapture (c) body calls only lock-free fns — no refreshToken, no writeAuthAnthropic, single withAuthLock (no nesting)", () => {
  const src = readFileSync(join(import.meta.dir, "usage.ts"), "utf8")
  const start = src.indexOf("export async function autoCapture")
  const raw = src.slice(start, src.indexOf("\ntype InactiveOutcome", start))
  const code = raw
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
  expect(code).not.toContain("refreshToken")
  expect(code).not.toContain("writeAuthAnthropic")
  expect((code.match(/withAuthLock/g) ?? []).length).toBe(1)
})

test("switchToAccount (a) A→B reverse-syncs OUTGOING A's accounts.json record to auth.json's CURRENT (rotated) A token BEFORE switching", () => {
  expect(r.sw_reverse.aRefresh).toBe("A-rotated-refresh")
  expect(r.sw_reverse.aAccess).toBe("A-rotated-access")
  expect(r.sw_reverse.activeId).toBe("acc2")
  expect(r.sw_reverse.retId).toBe("acc2")
})

test("switchToAccount (b) target B is written to auth.json", () => {
  expect(r.sw_reverse.authRefresh).toBe("B-refresh")
  expect(r.sw_reverse.authAccess).toBe("B-access")
})

test("switchToAccount (c) target B fresh → NOT re-refreshed (0 POSTs for the B path)", () => {
  expect(r.sw_reverse.posts).toBe(0)
})

test("switchToAccount (malformed) auth.json missing → no crash, skip reverse-sync, outgoing record kept, target still switched", () => {
  expect(r.sw_noauth.threw).toBe(false)
  expect(r.sw_noauth.posts).toBe(0)
  expect(r.sw_noauth.aRefresh).toBe("A-keep")
  expect(r.sw_noauth.activeId).toBe("acc2")
  expect(r.sw_noauth.authRefresh).toBe("B-keep")
})

test("switchToAccount (d) REGRESSION round-trip A→B→A uses the LIVE (rotated) A token, never the pre-rotation dead one — no stale switch-back", () => {
  expect(r.sw_roundtrip.posts).toBe(0)
  expect(r.sw_roundtrip.lastRefreshInput).toBe(null)
  expect(r.sw_roundtrip.aRefresh).toBe("A-live-refresh")
  expect(r.sw_roundtrip.authRefresh).toBe("A-live-refresh")
  expect(r.sw_roundtrip.authAccess).toBe("A-live-access")
})

test("Component B: 400 invalid_grant → RefreshRevokedError (revoked=true)", () => {
  expect(r.cls_ig.name).toBe("RefreshRevokedError")
  expect(r.cls_ig.revoked).toBe(true)
})

test("Component B: 400 non-invalid_grant → generic Error (not revoked)", () => {
  expect(r.cls_400.name).toBe("Error")
  expect(r.cls_400.revoked).toBe(false)
  expect(r.cls_400.message).toContain("token refresh failed (400)")
})

test("Component B: 5xx → generic Error (not revoked)", () => {
  expect(r.cls_500.name).toBe("Error")
  expect(r.cls_500.revoked).toBe(false)
  expect(r.cls_500.message).toContain("token refresh failed (500)")
})

test("Component B: network error → generic Error (not revoked)", () => {
  expect(r.cls_net.name).toBe("Error")
  expect(r.cls_net.revoked).toBe(false)
})

test("Component C: applyToken sets token fields AND deletes needsReauth", () => {
  expect(r.apply_unit.isFn).toBe(true)
  expect(r.apply_unit.threw).toBe(false)
  expect(r.apply_unit.refresh).toBe("new")
  expect(r.apply_unit.access).toBe("new-a")
  expect(r.apply_unit.hasFlag).toBe(false)
})

test("Component C: autoCapture re-login clears needsReauth (test 8a)", () => {
  expect(r.cap_relogin.hasFlag).toBe(false)
  expect(r.cap_relogin.refresh).toBe("cap2-refresh")
})

test("Component C collect: revoked inactive refresh → flagged + sentinel row + no re-hammer (test 2)", () => {
  expect(r.creauth.row1Error).toBe("needs-reauth")
  expect(r.creauth.flagged).toBe(true)
  expect(r.creauth.posts1).toBe(1)
  expect(r.creauth.row2Error).toBe("needs-reauth")
  expect(r.creauth.posts2).toBe(0)
})

test("Component C collect: flagged account with no access/expires → skipped, no POST, no throw (test 9)", () => {
  expect(r.creauth_noaccess.threw).toBe(false)
  expect(r.creauth_noaccess.posts).toBe(0)
  expect(r.creauth_noaccess.rowError).toBe("needs-reauth")
})

test("Component C switch: refuse flagged target → throws 需重新登录, auth.json unchanged, activeId unchanged (test 3)", () => {
  expect(r.sw_flagged.threw).toBe(true)
  expect(r.sw_flagged.msg).toContain("需重新登录")
  expect(r.sw_flagged.authUnchanged).toBe(true)
  expect(r.sw_flagged.activeId).toBe("acc1")
  expect(r.sw_flagged.posts).toBe(0)
})

test("Component C switch: target refresh revoked → account flagged, auth.json unchanged (flag-on-revoked)", () => {
  expect(r.sw_revoked.threw).toBe(true)
  expect(r.sw_revoked.flagged).toBe(true)
  expect(r.sw_revoked.authUnchanged).toBe(true)
  expect(r.sw_revoked.activeId).toBe("acc1")
})

test("Component C switch: reverse-sync of OUTGOING active clears its needsReauth via applyToken (test 8b)", () => {
  expect(r.sw_outgoing_clear.aRefresh).toBe("A-live-r-8b")
  expect(r.sw_outgoing_clear.aHasFlag).toBe(false)
  expect(r.sw_outgoing_clear.activeId).toBe("accB")
})

test("Component C retry: retryFlaggedRefresh success clears flag + rotates token (test 8c)", () => {
  expect(r.retry_ok.isFn).toBe(true)
  expect(r.retry_ok.threw).toBe(false)
  expect(r.retry_ok.refresh).toBe("retry-new-r")
  expect(r.retry_ok.hasFlag).toBe(false)
  expect(r.retry_ok.posts).toBe(1)
})

test("Component C retry: retryFlaggedRefresh on still-dead token rejects + keeps flag", () => {
  expect(r.retry_fail.threw).toBe(true)
  expect(r.retry_fail.stillFlagged).toBe(true)
  expect(r.retry_fail.refresh).toBe("B-still-dead")
})

test("Component A: PATH-5 concurrent collect+switch → single R1 POST, auth.json ends rotated R2 (not dead R1) (test 4)", () => {
  expect(r.race_path5.posts).toBe(1)
  expect(r.race_path5.lastRefreshInput).toBe("R1")
  expect(r.race_path5.accBRefresh).toBe("R2")
  expect(r.race_path5.authRefresh).toBe("R2")
})

test("Component A: switch makes B active mid-collect → collect skips B refresh (INV-2), B token not consumed (test 5)", () => {
  expect(r.race_before_turn.bPosts).toBe(0)
  expect(r.race_before_turn.authRefresh).toBe("B-R")
  expect(r.race_before_turn.activeId).toBe("accB")
})

test("Component A/crash: save fails after refresh → dead token stays, next cycle flags, then no re-hammer (test 7)", () => {
  expect(r.crash7.crashRefresh).toBe("c7-R1")
  expect(r.crash7.flaggedCycle2).toBe(true)
  expect(r.crash7.posts3).toBe(0)
})

test("Component D: activeId drifted mid-collect → doActiveSync SKIPS, keeps switch's live reverse-synced token (test 6a)", () => {
  expect(r.dsync_drift.aRefresh).toBe("A-v2-r")
  expect(r.dsync_drift.activeId).toBe("accB")
})

test("Component D: auth.json rotated mid-collect (activeId unchanged) → active record synced to LIVE token, not t0 snapshot (test 6b)", () => {
  expect(r.dsync_rotate.aRefresh).toBe("AA-v2-r")
  expect(r.dsync_rotate.activeId).toBe("accA")
})

test("R2 guard: collect refresh revoked BUT another process already rotated → adopt new token, NO false flag, usage shown", () => {
  expect(r.guard_adopt.posts).toBe(1)
  expect(r.guard_adopt.bRefresh).toBe("G2")
  expect(r.guard_adopt.flagged).toBe(false)
  expect(r.guard_adopt.rowHasUsage).toBe(true)
  expect(r.guard_adopt.rowError).toBeUndefined()
})

test("R2 guard: switch target revoked BUT another process already rotated → adopt + switch succeeds, NO flag", () => {
  expect(r.switch_adopt.threw).toBe(false)
  expect(r.switch_adopt.authRefresh).toBe("S2")
  expect(r.switch_adopt.bRefresh).toBe("S2")
  expect(r.switch_adopt.flagged).toBe(false)
  expect(r.switch_adopt.activeId).toBe("sB")
})

test("R2 guard: retry revoked BUT another process already rotated → adopt + flag cleared", () => {
  expect(r.retry_adopt.threw).toBe(false)
  expect(r.retry_adopt.bRefresh).toBe("R2x")
  expect(r.retry_adopt.flagged).toBe(false)
})

test("R2 access-first: flagged account with STILL-VALID access → fresh usage shown, no error, 0 POSTs", () => {
  expect(r.access_first.posts).toBe(0)
  expect(r.access_first.rowHasUsage).toBe(true)
  expect(r.access_first.rowNeedsReauth).toBe(true)
  expect(r.access_first.rowError).toBeUndefined()
})

test("R3 no-cache: dead+no-access account shows the honest needs-reauth error row; NO cache file is ever written", () => {
  expect(r.nocache.rowHasUsage).toBe(false)
  expect(r.nocache.rowError).toBe("needs-reauth")
  expect(r.nocache.rowNeedsReauth).toBe(true)
  expect(r.nocache.cacheExists).toBe(false)
})

test("R3 keeper: ACTIVE chain expiring soon + IDLE → keeper pre-refreshes auth.json (staggered from ex-machina)", () => {
  expect(r.keeper_active.posts).toBe(1)
  expect(r.keeper_active.inputs).toEqual(["kact-r"])
  expect(r.keeper_active.authRefresh).toBe("kact-new-r")
  expect(r.keeper_active.authAccess).toBe("kact-new-a")
})

test("R3 keeper: ACTIVE chain expiring soon + session RUNNING → keeper never touches it (0 POSTs)", () => {
  expect(r.keeper_active_running.posts).toBe(0)
  expect(r.keeper_active_running.authRefresh).toBe("krun-r")
})

test("R3 keeper: REVOKED active chain is POSTed once then never hammered on later ticks", () => {
  expect(r.keeper_active_dead.postsAfterFirst).toBe(1)
  expect(r.keeper_active_dead.postsAfterSecond).toBe(1)
  expect(r.keeper_active_dead.authRefresh).toBe("kdead-r")
})

test("R2 keeper: tick refreshes ONLY the stale inactive account — active(INV-2)/flagged/fresh all skipped", () => {
  expect(r.keeper_tick.posts).toBe(1)
  expect(r.keeper_tick.inputs).toEqual(["kB-r"])
  expect(r.keeper_tick.bRefresh).toBe("kB-new-r")
  expect(r.keeper_tick.cFlagged).toBe(true)
  expect(r.keeper_tick.aRefresh).toBe("kA-r")
})

test("R2 keeper: auth.json change → new login captured by uuid (chain tip preserved)", () => {
  expect(r.keeper_capture.captured).toBe(true)
  expect(r.keeper_capture.u7Refresh).toBe("u7-refresh")
  expect(r.keeper_capture.activeId).toBe("u7")
})

test("R2 keeper: subsequent rotation of the same chain re-captured (tip follows ex-machina)", () => {
  expect(r.keeper_rotate.u7Refresh).toBe("u7-refresh-2")
  expect(r.keeper_rotate.u7Access).toBe("u7-access-2")
})

test("R2 keeper: unchanged auth.json → no redundant profile fetch", () => {
  expect(r.keeper_skip.extraProfile).toBe(0)
})

test("R2b must-fix: switch NEVER adopts a record that is itself flagged — refuses, auth.json untouched, flag+winner-token preserved", () => {
  expect(r.switch_no_adopt_flagged.threw).toBe(true)
  expect(r.switch_no_adopt_flagged.authUnchanged).toBe(true)
  expect(r.switch_no_adopt_flagged.bRefresh).toBe("F2")
  expect(r.switch_no_adopt_flagged.flagged).toBe(true)
  expect(r.switch_no_adopt_flagged.activeId).toBe("fA")
})

test("R2b must-fix: collect does not un-flag an other-process-flagged record; row degrades to needsReauth (access-first ok)", () => {
  expect(r.acquire_no_adopt_flagged.cRefresh).toBe("FC2")
  expect(r.acquire_no_adopt_flagged.cFlagged).toBe(true)
  expect(r.acquire_no_adopt_flagged.rowNeedsReauth).toBe(true)
  expect(r.acquire_no_adopt_flagged.rowHasUsage).toBe(true)
})

test("R2b must-fix: retry NEVER clears the flag by adopting a flagged record — rejects, flag kept", () => {
  expect(r.retry_no_adopt_flagged.threw).toBe(true)
  expect(r.retry_no_adopt_flagged.dRefresh).toBe("FD2")
  expect(r.retry_no_adopt_flagged.flagged).toBe(true)
})

// SECOND, INDEPENDENT child runner (not a modification of runnerSource above): exercises
// the REAL accounts.ts withAuthLock through the now-live cross-process file lock. Runs in
// a fresh child for the same reason as runnerSource (autoswitch.test.ts's process-global
// mock.module of accounts.ts leaks in-process). Its constants mock speeds ONLY
// LOCK_ACQUIRE_TIMEOUT_MS to 500ms so the poisoning-regression times out in <1s instead of
// 30 real seconds, while LOCK_STALE_MS stays at the prod 45s — so the deliberately-FRESH
// foreign lock is genuinely CONTENDED (acquire times out) rather than STOLEN as stale;
// 45s ≫ 500ms guarantees the timeout path, not the steal path, is what gets exercised.
const lockRunnerSource = `
import { test, mock } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, unlinkSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const SRC = process.env.CAU_SRC
const OUT = process.env.CAU_OUT

const dataHome = mkdtempSync(join(tmpdir(), "cau-lock-run-"))
process.env.XDG_DATA_HOME = dataHome
mkdirSync(join(dataHome, "opencode"), { recursive: true })
const lockPath = join(process.env.XDG_DATA_HOME, "opencode", "claude-accounts-usage.lock")

const realConstants = await import(join(SRC, "constants.ts"))
mock.module(join(SRC, "constants.ts"), () => ({
  ...realConstants,
  LOCK_ACQUIRE_TIMEOUT_MS: 500,
  LOCK_STALE_MS: 45000,
  LOCK_POLL_MS: 100,
}))

const { withAuthLock } = await import(join(SRC, "accounts.ts"))

const results = {}

const existedDuring = await withAuthLock(async () => existsSync(lockPath))
results.lockLocation = { existedDuring, goneAfter: !existsSync(lockPath) }

writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "foreign", at: Date.now() }))
let fn1Ran = false
try {
  await withAuthLock(async () => { fn1Ran = true })
  results.poison = { threw: false, name: "", fn1Ran }
} catch (err) {
  results.poison = { threw: true, name: err.name, fn1Ran }
}
unlinkSync(lockPath)
try {
  const fn2Value = await withAuthLock(async () => "fn2-result")
  results.recovered = { fn2Resolved: true, fn2Value }
} catch (err) {
  results.recovered = { fn2Resolved: false, fn2Value: "REJECTED:" + err.name }
}

// ---- Todo-3: collectAllUsage degrades honestly on LockTimeoutError (never rejects) ----
const { collectAllUsage } = await import(join(SRC, "usage.ts"))

const authPath = join(process.env.XDG_DATA_HOME, "opencode", "auth.json")
writeFileSync(authPath, JSON.stringify({ anthropic: { type: "oauth", access: "old-access", refresh: "old-refresh", expires: Date.now() - 1000 } }))

const accountsDir3 = join(homedir(), ".config", "opencode")
mkdirSync(accountsDir3, { recursive: true })
writeFileSync(join(accountsDir3, "claude-accounts.json"), JSON.stringify({ version: 1, accounts: [{ id: "inact1", label: "Inactive1", refresh: "inact-r", access: "inact-a", expires: Date.now() + 3_600_000 }] }))

const TOKEN_URL3 = realConstants.TOKEN_URL
const USAGE_ENDPOINT3 = realConstants.USAGE_ENDPOINT
globalThis.fetch = (async (input) => {
  const url = String(input)
  if (url === TOKEN_URL3) return { ok: true, status: 200, json: async () => ({ access_token: "new-access", refresh_token: "new-refresh", expires_in: 3600 }) }
  if (url === USAGE_ENDPOINT3) return { ok: true, status: 200, json: async () => ({}) }
  return { ok: true, status: 200, json: async () => ({}) }
})

// Plant the foreign lock via onPartial — collectAllUsage invokes onPartial synchronously
// right after the inactive-account loop finishes and right BEFORE the deferred active
// resolve. This means the inactive row (fresh token, no refresh needed) resolves healthy
// BEFORE any contention exists; only the SUBSEQUENT active-deferred-resolve phase hits the
// now-planted lock. This precisely isolates "inactive stays healthy, active degrades".
let degradedThrew = false
let degradedResult
try {
  degradedResult = await collectAllUsage({
    isSessionRunning: () => false,
    onPartial: () => { writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "foreign2", at: Date.now() })) },
  })
} catch {
  degradedThrew = true
}
const degradedActive = degradedResult?.results.find((row) => row.active)
const degradedInactive = degradedResult?.results.find((row) => !row.active)
results.degrade = {
  threw: degradedThrew,
  activeError: degradedActive?.error ?? null,
  inactivePresent: Boolean(degradedInactive),
  inactiveHealthy: degradedInactive ? !degradedInactive.error : false,
}

unlinkSync(lockPath)
let healedThrew = false
let healedResult
try {
  healedResult = await collectAllUsage({ isSessionRunning: () => false })
} catch {
  healedThrew = true
}
const healedActive = healedResult?.results.find((row) => row.active)
results.healed = {
  threw: healedThrew,
  activeError: healedActive?.error ?? null,
  activeHasUsage: Boolean(healedActive?.usage),
}

writeFileSync(OUT, JSON.stringify(results))
test("lock integration scenarios executed", () => {})
`

type LockResults = {
  lockLocation: { existedDuring: boolean; goneAfter: boolean }
  poison: { threw: boolean; name: string; fn1Ran: boolean }
  recovered: { fn2Resolved: boolean; fn2Value: string }
  degrade: { threw: boolean; activeError: string | null; inactivePresent: boolean; inactiveHealthy: boolean }
  healed: { threw: boolean; activeError: string | null; activeHasUsage: boolean }
}

const lockRunnerDir = mkdtempSync(join(tmpdir(), "cau-lock-parent-"))
const lockRunnerPath = join(lockRunnerDir, "lock-runner.test.ts")
const lockOutPath = join(lockRunnerDir, "lock-results.json")
writeFileSync(lockRunnerPath, lockRunnerSource)

const lockChildHome = mkdtempSync(join(tmpdir(), "cau-lock-home-"))
const lockProc = Bun.spawnSync(["bun", "test", lockRunnerPath], {
  env: { ...process.env, CAU_SRC: import.meta.dir, CAU_OUT: lockOutPath, HOME: lockChildHome },
  stdout: "pipe",
  stderr: "pipe",
})
if (lockProc.exitCode !== 0) {
  throw new Error(`withAuthLock lock runner failed (exit ${lockProc.exitCode}):\n${lockProc.stderr.toString()}\n${lockProc.stdout.toString()}`)
}
const lr = JSON.parse(readFileSync(lockOutPath, "utf8")) as LockResults

test("withAuthLock holds the lock at XDG_DATA_HOME/opencode/claude-accounts-usage.lock during the critical section and removes it after resolution", () => {
  expect(lr.lockLocation.existedDuring).toBe(true)
  expect(lr.lockLocation.goneAfter).toBe(true)
})

test("withAuthLock: a LockTimeoutError does NOT poison the in-process queue — fn never ran, and the next call still runs and resolves", () => {
  expect(lr.poison.threw).toBe(true)
  expect(lr.poison.name).toBe("LockTimeoutError")
  expect(lr.poison.fn1Ran).toBe(false)
  expect(lr.recovered.fn2Resolved).toBe(true)
  expect(lr.recovered.fn2Value).toBe("fn2-result")
})

test("collectAllUsage degrades the active row honestly on LockTimeoutError instead of rejecting the whole panel", () => {
  expect(lr.degrade.threw).toBe(false)
  expect(lr.degrade.activeError).toBe("额度暂不可用(等待 token 刷新)")
  expect(lr.degrade.inactivePresent).toBe(true)
  expect(lr.degrade.inactiveHealthy).toBe(true)
})

test("collectAllUsage: active row heals once the lock is free again", () => {
  expect(lr.healed.threw).toBe(false)
  expect(lr.healed.activeError).toBeNull()
  expect(lr.healed.activeHasUsage).toBe(true)
})

test("collectAllUsage normalizes limits[] weekly_scoped into usage.scoped (Fable), skipping unnamed/non-scoped entries", () => {
  expect(r.scoped_fable.scoped).not.toBeNull()
  const byLabel = Object.fromEntries(r.scoped_fable.scoped!.map((w) => [w.label, w]))
  // kept: named + finite percent (Fable, Cove). skipped: unnamed(null) + non-finite percent(Ghost/NaN).
  expect(r.scoped_fable.scoped!.length).toBe(2)
  expect(byLabel.Fable.utilization).toBe(7)
  expect(typeof byLabel.Fable.resets_at).toBe("string")
  expect(byLabel.Ghost).toBeUndefined()
  // non-string resets_at (Cove sent a number) normalized to undefined, entry still kept
  expect(byLabel.Cove.utilization).toBe(9)
  expect(byLabel.Cove.resets_at).toBeUndefined()
  expect(r.scoped_fable.hasFiveHour).toBe(true)
  expect(r.scoped_fable.sevenDayOpus).toBeNull()
})

test("P1:旧版 claude-accounts.json(无 provider 字段)照旧加载,每条都读作 anthropic", () => {
  expect(r.prov_legacy.providers).toEqual(["anthropic", "anthropic"])
  expect(r.prov_legacy.anthropicIds).toEqual(["lg1", "lg2"])
  expect(r.prov_legacy.anthropicActive).toBe("lg1")
  expect(r.prov_legacy.openaiActive).toBeNull()
})

// Zero-migration guard: a load→save round trip must neither stamp provider onto records nor
// introduce openaiActiveId, or an older installed version would read a store it never wrote.
test("P2:load→save 往返不写回 provider、不新增 openaiActiveId,activeId 与账号顺序原样保留", () => {
  expect(r.prov_legacy.providerKeyWritten).toBe(false)
  expect(r.prov_legacy.openaiActiveKeyWritten).toBe(false)
  expect(r.prov_legacy.activeIdAfter).toBe("lg1")
  expect(r.prov_legacy.idsAfter).toEqual(["lg1", "lg2"])
})

test("P3:accountsOf 正确切分混合池 —— 无 provider 的旧记录归 anthropic,新字段随记录带出", () => {
  expect(r.prov_mixed.anthropicIds).toEqual(["aA", "aC"])
  expect(r.prov_mixed.openaiIds).toEqual(["oB"])
  expect(r.prov_mixed.openaiAccountId).toBe("acct-oB")
  expect(r.prov_mixed.openaiLastActiveAt).toBe(111)
})

test("P4:accountsOf 对没有账号的 provider 返回空数组,不返回 undefined", () => {
  expect(r.prov_empty.anthropic).toEqual([])
  expect(r.prov_empty.openaiIds).toEqual(["oOnly"])
  expect(r.prov_legacy.openaiCount).toBe(0)
})

test("P5:activeIdOf / setActiveIdOf 两个池完全独立 —— 设置一个绝不扰动另一个", () => {
  expect(r.prov_mixed.anthropicActive).toBe("aA")
  expect(r.prov_mixed.openaiActive).toBe("oB")
  expect(r.prov_active.afterOpenaiSet).toEqual({ activeId: "aKeep", openaiActiveId: "oNew" })
  expect(r.prov_active.afterAnthropicSet).toEqual({ activeId: "aNew", openaiActiveId: "oNew" })
  expect(r.prov_active.afterOpenaiClear).toEqual({ activeId: "aNew", openaiActiveId: null })
})

// upsertAccount stays anthropic-only this wave: it must keep claiming activeId and must never
// touch openaiActiveId, or an anthropic auto-capture would hijack the ChatGPT pool's pointer.
test("P6:upsertAccount 行为不变 —— 仍写 activeId、保留 openaiActiveId、不写 provider 字段", () => {
  expect(r.prov_upsert.activeId).toBe("up1")
  expect(r.prov_upsert.openaiActiveId).toBe("oKeep")
  expect(r.prov_upsert.newProvider).toBeNull()
})

// INV-P1 structural guard: without it the ChatGPT record's EXPIRED token would be refreshed at
// Anthropic's TOKEN_URL (posts=1) and then written into auth.json's anthropic entry.
test("X5:switchToAccount 收到 ChatGPT 账号 id → 抛错,零 TOKEN_URL 请求,auth.json 与该记录都不变", () => {
  expect(r.sw_provider.threw).toBe(true)
  expect(r.sw_provider.msg).toBe("该账号与目标 provider 不一致,拒绝写入 Claude 登录态")
  expect(r.sw_provider.posts).toBe(0)
  expect(r.sw_provider.authUnchanged).toBe(true)
  expect(r.sw_provider.openaiRefresh).toBe("oG-r")
  expect(r.sw_provider.openaiActiveId).toBe("openai:acct-G")
})

test("X5b:显式传 \"anthropic\" 的调用照旧切号 —— 守卫只拦跨 provider,不拦同 provider", () => {
  expect(r.sw_provider.explicitThrew).toBe(false)
  expect(r.sw_provider.activeId).toBe("gB")
  expect(r.sw_provider.authRefresh).toBe("gB-r")
})

// The cross-vendor disclosure this wave closes: a ChatGPT refresh token POSTed to
// platform.claude.com. Asserted as a request COUNT — the only shape that proves nothing left the
// process — plus the 400's side effect (needsReauth on a perfectly healthy account).
test("X6:collectAllUsage 对 ChatGPT 记录零网络请求 —— 不刷 token、不查用量、不标 needsReauth、不进结果行", () => {
  expect(r.collect_openai.posts).toBe(0)
  expect(r.collect_openai.refreshInputs).toEqual([])
  expect(r.collect_openai.ids).toEqual(["cxA", "cxB"])
  expect(r.collect_openai.usageFetches).toBe(2)
  expect(r.collect_openai.openaiRefresh).toBe("oX-r")
  expect(r.collect_openai.openaiFlagged).toBe(false)
})

// X5's twin on the OTHER path that POSTs to Anthropic's TOKEN_URL. The request count is the
// load-bearing assertion; `postsAfterControl` proves the counter was live, so posts===0 above
// means "refused", not "the stub could never have fired".
test("X7:retryFlaggedRefresh 收到 ChatGPT 账号 id → 抛错,零 TOKEN_URL 请求,该记录的 token 与 needsReauth 都不变", () => {
  expect(r.retry_provider.threw).toBe(true)
  expect(r.retry_provider.msg).toBe("该账号与目标 provider 不一致,拒绝用 Claude 端点刷新")
  expect(r.retry_provider.posts).toBe(0)
  expect(r.retry_provider.refreshInputs).toEqual([])
  expect(r.retry_provider.openaiRefresh).toBe("oR-r")
  expect(r.retry_provider.stillFlagged).toBe(true)
  // 同 provider 的对照调用照旧发出请求(守卫只拦跨 provider),同时证明计数器本来就是活的。
  expect(r.retry_provider.explicitThrew).toBe(false)
  expect(r.retry_provider.postsAfterControl).toBe(1)
  expect(r.retry_provider.controlInput).toBe("rfA-r")
})

test("X8:setActiveId 拒绝非 anthropic 的 id —— activeId 与 openaiActiveId 双指针都不动", () => {
  expect(r.set_active_provider.afterWrong).toEqual({ activeId: "saA", openaiActiveId: "openai:acct-S" })
  // 未知 id 走的是另一条早退分支,同样不得改动任何指针。
  expect(r.set_active_provider.afterMissing).toEqual({ activeId: "saA", openaiActiveId: "openai:acct-S" })
  // 合法的 anthropic id 照旧生效,且不碰 openai 指针 —— 否则这条守卫就退化成"什么都不做"。
  expect(r.set_active_provider.afterOk).toEqual({ activeId: "saB", openaiActiveId: "openai:acct-S" })
  expect(r.set_active_provider.posts).toBe(0)
})

test("X9:removeAccount 删掉指针指向的记录时清空该指针 —— openai 与 anthropic 两侧对称,且不误清指向别人的指针", () => {
  expect(r.remove_pointers.removedOpenaiId).toBe("openai:acct-M")
  expect(r.remove_pointers.afterOpenai).toEqual({ activeId: "rmA", openaiActiveId: null, ids: ["rmA"] })
  expect(r.remove_pointers.removedAnthropicId).toBe("rmA")
  expect(r.remove_pointers.afterAnthropic).toEqual({ activeId: null, openaiActiveId: null, ids: [] })
  // 删的是没有任何指针指向的记录 → 两个指针都必须原样保留。
  expect(r.remove_pointers.afterOther).toEqual({ activeId: "keepA", openaiActiveId: "openai:acct-K", ids: ["keepA", "openai:acct-K"] })
})
