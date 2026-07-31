import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// WHY A SUBPROCESS (same reason usage.test.ts documents at length): autoswitch.test.ts runs
// earlier in this `bun test` process and registers a process-global, un-evictable
// mock.module("./accounts.ts", ...) that is only a PARTIAL stub (no withAuthLock, no
// applyToken). Importing the real accounts.ts — which openai-slot.ts links against — is
// therefore impossible in-process. The child below runs in a FRESH process where the real
// modules link cleanly, drives them through a temp-dir auth.json / claude-accounts.json seam,
// writes a results JSON, and the parent tests assert on it.
const runnerSource = `
import { test, mock } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const SRC = process.env.CAU_SRC
const OUT = process.env.CAU_OUT

const dataHome = mkdtempSync(join(tmpdir(), "cau-slot-"))
process.env.XDG_DATA_HOME = dataHome
mkdirSync(join(dataHome, "opencode"), { recursive: true })
const authPath = join(dataHome, "opencode", "auth.json")

// accounts.ts derives ACCOUNTS_PATH from homedir() at module load, and os.homedir() snapshots
// HOME at process START (later process.env mutation is ignored), so the PARENT passes
// HOME=<tmp> through the spawn env.
const accountsDir = join(homedir(), ".config", "opencode")
mkdirSync(accountsDir, { recursive: true })
const accountsPath = join(accountsDir, "claude-accounts.json")

const future = () => Date.now() + 3600000
const past = () => Date.now() - 1000
const writeAuthRaw = (obj) => writeFileSync(authPath, JSON.stringify(obj))
const authText = () => readFileSync(authPath, "utf8")
const readAuthRaw = () => JSON.parse(authText())
const dropAuth = () => { try { unlinkSync(authPath) } catch {} }
const writeAccounts = (obj) => writeFileSync(accountsPath, JSON.stringify(obj))
const accountsText = () => readFileSync(accountsPath, "utf8")
const readAccounts = () => JSON.parse(accountsText())
// The stored RECORDS only, stripped of lastActiveAt. An unusable slot is an eviction, so capture is
// entitled to exactly two mutations there and no others: it starts the openai pool's quarantine clock
// (INV-O1) and clears openaiActiveId (INV-O3 — no attributable occupant means no account is active).
// Both have their own assertion fields, so this comparison is what pins "and nothing else moved".
const storeSansStamps = () => JSON.stringify(readAccounts().accounts, (key, value) => (key === "lastActiveAt" ? undefined : value))
const stampFresh = (id) => Date.now() - (rec(id, readAccounts().accounts)?.lastActiveAt ?? 0) < 60000
const activeOpenai = () => readAccounts().openaiActiveId ?? "<cleared>"
const anth = (access, refresh, expires) => ({ type: "oauth", access, refresh, expires })
const oa = (access, refresh, expires, accountId) => ({ type: "oauth", access, refresh, expires, accountId })
const anthRec = (id) => ({ id, label: "Anth-" + id, refresh: id + "-r", access: id + "-a", expires: future() })
const oaRec = (accountId, refresh, access, expires, extra) => ({ id: "openai:" + accountId, label: "OA-" + accountId, refresh, access, expires, provider: "openai", accountId, ...extra })
const rec = (id, accs) => accs.find((item) => item.id === id)
const byAcct = (accountId) => readAccounts().accounts.find((item) => item.accountId === accountId)

// This wave's new code paths make ZERO network calls, so the stub both COUNTS and THROWS: an
// accidental POST shows up in the results AND blows up loudly at its call site.
let fetches = 0
globalThis.fetch = (async (input) => { fetches++; throw new Error("unexpected network call: " + String(input)) })

// Pass-through by default. \`rotateNext\` is armed only by the mid-flight scenario: firing it
// from inside saveAccounts places the rotation AFTER captureInLock read auth.json and BEFORE
// commitSlot re-reads it, which is exactly the window INV-O2's mid-flight branch guards.
// mock.module patches the live namespace of an ALREADY-imported module, so the real exports
// must be snapshotted into a plain object first — reaching back through \`realAccounts\` after
// registering would land on the mock and recurse forever.
let rotateNext
const realExports = { ...(await import(join(SRC, "accounts.ts"))) }
mock.module(join(SRC, "accounts.ts"), () => ({
  ...realExports,
  saveAccounts: async (file) => {
    const hook = rotateNext
    rotateNext = undefined
    if (hook) hook()
    return realExports.saveAccounts(file)
  },
}))

const { captureOpenaiSlot, switchToOpenaiAccount, backfillOpenaiLabel, placeholderOpenaiLabel } = await import(join(SRC, "openai-slot.ts"))
const { switchToAccount } = await import(join(SRC, "usage.ts"))

const results = {}
const attempt = async (fn) => {
  try { await fn(); return { threw: false, msg: "" } } catch (error) { return { threw: true, msg: String(error.message) } }
}

// ---- happy path: preserve foreign keys, capture the outgoing tip, write the target AS-IS ----
writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: oa("oa-A-a", "oa-A-r", future(), "acct-A"), custom: { keep: 1 } })
writeAccounts({ version: 1, activeId: "anthA", openaiActiveId: "openai:acct-A", accounts: [
  anthRec("anthA"),
  oaRec("acct-A", "oa-A-r-old", "oa-A-a-old", future()),
  oaRec("acct-B", "oa-B-r", "oa-B-a", past()),
] })
{
  const ret = await switchToOpenaiAccount("openai:acct-B")
  const auth = readAuthRaw()
  const accs = readAccounts()
  const a = rec("openai:acct-A", accs.accounts)
  results.sw_ok = {
    fetches, retId: ret.id,
    anthropicEntry: auth.anthropic, custom: auth.custom, slot: auth.openai,
    slotExpired: auth.openai.expires < Date.now(),
    aRefresh: a.refresh, aAccess: a.access, aLastActive: typeof a.lastActiveAt,
    activeId: accs.activeId, openaiActiveId: accs.openaiActiveId,
  }
}
{
  await switchToOpenaiAccount("openai:acct-A")
  const accs = readAccounts()
  results.sw_back = { slot: readAuthRaw().openai, bRefresh: rec("openai:acct-B", accs.accounts).refresh, openaiActiveId: accs.openaiActiveId }
}

// ---- refusals: the openai key is SHARED with plain API keys, and an unattributable tip ----
writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: { type: "api", key: "sk-user-pasted-key" } })
writeAccounts({ version: 1, activeId: "anthA", openaiActiveId: "openai:acct-A", accounts: [anthRec("anthA"), oaRec("acct-B", "oa-B-r", "oa-B-a", future())] })
{
  const authBefore = authText()
  const storeBefore = storeSansStamps()
  const out = await attempt(() => switchToOpenaiAccount("openai:acct-B"))
  results.refuse_api = { ...out, authUnchanged: authText() === authBefore, storeUnchanged: storeSansStamps() === storeBefore, quarantined: stampFresh("openai:acct-B"), openaiActiveId: activeOpenai() }
}

writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: { type: "oauth", access: "x-a", refresh: "unattributable-r", expires: future() } })
writeAccounts({ version: 1, activeId: "anthA", openaiActiveId: "openai:acct-A", accounts: [anthRec("anthA"), oaRec("acct-B", "oa-B-r", "oa-B-a", future())] })
{
  const authBefore = authText()
  const storeBefore = storeSansStamps()
  const out = await attempt(() => switchToOpenaiAccount("openai:acct-B"))
  results.refuse_noacct = { ...out, authUnchanged: authText() === authBefore, storeUnchanged: storeSansStamps() === storeBefore, quarantined: stampFresh("openai:acct-B"), openaiActiveId: activeOpenai() }
}

// ---- INV-O3: the slot holds an account that is NOT our openaiActiveId ----
writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: oa("oa-C-a", "oa-C-r", future(), "acct-C") })
writeAccounts({ version: 1, activeId: "anthA", openaiActiveId: "openai:acct-A", accounts: [anthRec("anthA"), oaRec("acct-A", "oa-A-r-keep", "oa-A-a-keep", future())] })
{
  const captured = await captureOpenaiSlot()
  const accs = readAccounts()
  // Located by accountId, never by the expected id: the id namespacing is itself under test.
  const c = accs.accounts.find((item) => item.accountId === "acct-C")
  results.adopt = {
    fetches, returnedId: captured.id,
    cId: c.id, cProvider: c.provider, cAccountId: c.accountId, cRefresh: c.refresh, cAccess: c.access,
    cLabel: c.label, cLastActive: typeof c.lastActiveAt,
    activeId: accs.activeId, openaiActiveId: accs.openaiActiveId,
    aRefresh: rec("openai:acct-A", accs.accounts).refresh,
    slotRefresh: readAuthRaw().openai.refresh,
  }
}

writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: oa("oa-D-a2", "oa-D-r2", future(), "acct-D") })
writeAccounts({ version: 1, openaiActiveId: "openai:acct-A", accounts: [oaRec("acct-D", "oa-D-r1", "oa-D-a1", past(), { needsReauth: true })] })
{
  await captureOpenaiSlot()
  const accs = readAccounts()
  const d = rec("openai:acct-D", accs.accounts)
  results.adopt_clear = { refresh: d.refresh, access: d.access, flagged: d.needsReauth === true, openaiActiveId: accs.openaiActiveId }
}

// ---- INV-O2 mid-flight: codex rotates between our capture and the final re-read ----
writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: oa("oa-A-a", "oa-A-r", future(), "acct-A") })
writeAccounts({ version: 1, activeId: "anthA", openaiActiveId: "openai:acct-A", accounts: [
  anthRec("anthA"),
  oaRec("acct-A", "oa-A-r-stale", "oa-A-a-stale", future()),
  oaRec("acct-B", "oa-B-r", "oa-B-a", future()),
] })
{
  rotateNext = () => writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: oa("oa-A-a2", "oa-A-r2", future(), "acct-A") })
  await switchToOpenaiAccount("openai:acct-B")
  const accs = readAccounts()
  const a = rec("openai:acct-A", accs.accounts)
  results.midflight = { fetches, aRefresh: a.refresh, aAccess: a.access, slotRefresh: readAuthRaw().openai.refresh, openaiActiveId: accs.openaiActiveId }
}

// ---- the two active-id fields never cross ----
writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: oa("oa-A-a", "oa-A-r", future(), "acct-A") })
writeAccounts({ version: 1, activeId: "anthA", openaiActiveId: "openai:acct-A", accounts: [anthRec("anthA"), anthRec("anthB"), oaRec("acct-A", "oa-A-r", "oa-A-a", future())] })
{
  await switchToAccount("anthB")
  const accs = readAccounts()
  const auth = readAuthRaw()
  results.anth_switch = { fetches, activeId: accs.activeId, openaiActiveId: accs.openaiActiveId, slot: auth.openai, anthropicRefresh: auth.anthropic.refresh }
}

// ---- provider / state guards on the target ----
writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: oa("oa-A-a", "oa-A-r", future(), "acct-A") })
// anthX is an anthropic record that hand-carries an accountId, so it clears every OTHER guard:
// only the provider check stands between it and an anthropic chain being filed under codex's
// entry. Without that fixture the refusal could be satisfied by the accountId guard instead.
writeAccounts({ version: 1, activeId: "anthA", openaiActiveId: "openai:acct-A", accounts: [
  anthRec("anthA"),
  { ...anthRec("anthX"), accountId: "acct-X" },
  oaRec("acct-A", "oa-A-r", "oa-A-a", future()),
] })
{
  const authBefore = authText()
  const wrong = await attempt(() => switchToOpenaiAccount("anthX"))
  const missing = await attempt(() => switchToOpenaiAccount("nope"))
  const accs = readAccounts()
  results.guards = { ...wrong, missingThrew: missing.threw, missingMsg: missing.msg, authUnchanged: authText() === authBefore, activeId: accs.activeId, openaiActiveId: accs.openaiActiveId }
}

writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: oa("oa-A-a", "oa-A-r", future(), "acct-A") })
writeAccounts({ version: 1, activeId: "anthA", openaiActiveId: "openai:acct-A", accounts: [
  anthRec("anthA"),
  oaRec("acct-A", "oa-A-r", "oa-A-a", future()),
  oaRec("acct-B", "oa-B-r", "oa-B-a", future(), { needsReauth: true }),
  { id: "openai:legacy", label: "L", refresh: "legacy-r", provider: "openai" },
] })
{
  const authBefore = authText()
  const flagged = await attempt(() => switchToOpenaiAccount("openai:acct-B"))
  const noAcct = await attempt(() => switchToOpenaiAccount("openai:legacy"))
  results.refuse_target = { ...flagged, noAcctThrew: noAcct.threw, noAcctMsg: noAcct.msg, authUnchanged: authText() === authBefore }
}

// ---- capture is a background-safe no-op on every unusable slot shape ----
const noopCase = async (setup) => {
  writeAccounts({ version: 1, activeId: "anthA", openaiActiveId: "openai:acct-A", accounts: [anthRec("anthA"), oaRec("acct-A", "keep-r", "keep-a", future())] })
  setup()
  const storeBefore = storeSansStamps()
  let threw = false
  let returned = "sentinel"
  try { returned = await captureOpenaiSlot() } catch { threw = true }
  return { threw, returnedUndefined: returned === undefined, storeUnchanged: storeSansStamps() === storeBefore, quarantined: stampFresh("openai:acct-A"), openaiActiveId: activeOpenai() }
}
results.noop_missing = await noopCase(() => dropAuth())
results.noop_no_entry = await noopCase(() => writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()) }))
results.noop_api = await noopCase(() => writeAuthRaw({ anthropic: anth("anthA-a", "anthA-r", future()), openai: { type: "api", key: "sk-user-pasted-key" } }))

// ---- label backfill: the email lives behind /wham/usage, which capture deliberately never calls ----
// Deliberately driven through a REAL capture-insert rather than a hand-written fixture: that is what
// makes this a round trip between the writer (absorbOpenaiSlot) and the recogniser
// (backfillOpenaiLabel). Re-spell the placeholder on either side and this stops matching.
writeAuthRaw({ openai: oa("oa-E-a", "oa-E-r", future(), "acct-EEEEEEEEEEEE") })
writeAccounts({ version: 1, accounts: [] })
{
  await captureOpenaiSlot()
  const before = byAcct("acct-EEEEEEEEEEEE").label
  const changed = await backfillOpenaiLabel({ accountId: "acct-EEEEEEEEEEEE", email: "guborong12345@gmail.com" })
  results.backfill_ok = { fetches, changed, before, after: byAcct("acct-EEEEEEEEEEEE").label }
}

writeAccounts({ version: 1, openaiActiveId: "openai:acct-F", accounts: [{ ...oaRec("acct-F", "oa-F-r", "oa-F-a", future()), label: "我的工作号" }] })
{
  const changed = await backfillOpenaiLabel({ accountId: "acct-F", email: "boss@example.com" })
  results.backfill_renamed = { changed, label: byAcct("acct-F").label }
}

// The pointer names acct-G while the response authenticated as acct-H. Attribution follows the
// accountId, so the email must land on H and G must not be touched at all.
writeAccounts({ version: 1, openaiActiveId: "openai:acct-G", accounts: [
  { ...oaRec("acct-G", "oa-G-r", "oa-G-a", future()), label: placeholderOpenaiLabel("acct-G") },
  { ...oaRec("acct-H", "oa-H-r", "oa-H-a", future()), label: placeholderOpenaiLabel("acct-H") },
] })
{
  const changed = await backfillOpenaiLabel({ accountId: "acct-H", email: "h@example.com" })
  results.backfill_target = {
    changed,
    gLabel: byAcct("acct-G").label,
    gExpected: placeholderOpenaiLabel("acct-G"),
    hLabel: byAcct("acct-H").label,
    openaiActiveId: activeOpenai(),
  }
}
{
  const before = accountsText()
  const noEmail = await backfillOpenaiLabel({ accountId: "acct-G", email: undefined })
  const emptyEmail = await backfillOpenaiLabel({ accountId: "acct-G", email: "" })
  const noAcct = await backfillOpenaiLabel({ accountId: undefined, email: "x@example.com" })
  const unknownAcct = await backfillOpenaiLabel({ accountId: "acct-NOPE", email: "x@example.com" })
  results.backfill_noop = { noEmail, emptyEmail, noAcct, unknownAcct, unchanged: accountsText() === before, fetches }
}

writeFileSync(OUT, JSON.stringify(results))
test("openai slot scenarios executed", () => {})
`

type OauthEntry = { type: string; access?: string; refresh?: string; expires?: number; accountId?: string }
type Attempt = { threw: boolean; msg: string }
type SwOk = {
  fetches: number
  retId: string
  anthropicEntry: OauthEntry
  custom: { keep: number }
  slot: OauthEntry
  slotExpired: boolean
  aRefresh: string
  aAccess: string
  aLastActive: string
  activeId?: string
  openaiActiveId?: string
}
type SwBack = { slot: OauthEntry; bRefresh: string; openaiActiveId?: string }
type Refusal = Attempt & { authUnchanged: boolean; storeUnchanged: boolean; quarantined: boolean; openaiActiveId?: string }
type Adopt = {
  fetches: number
  returnedId: string
  cId: string
  cProvider: string
  cAccountId: string
  cRefresh: string
  cAccess: string
  cLabel: string
  cLastActive: string
  activeId?: string
  openaiActiveId?: string
  aRefresh: string
  slotRefresh: string
}
type AdoptClear = { refresh: string; access: string; flagged: boolean; openaiActiveId?: string }
type Midflight = { fetches: number; aRefresh: string; aAccess: string; slotRefresh: string; openaiActiveId?: string }
type AnthSwitch = { fetches: number; activeId?: string; openaiActiveId?: string; slot: OauthEntry; anthropicRefresh: string }
type Guards = Attempt & { missingThrew: boolean; missingMsg: string; authUnchanged: boolean; activeId?: string; openaiActiveId?: string }
type RefuseTarget = Attempt & { noAcctThrew: boolean; noAcctMsg: string; authUnchanged: boolean }
type NoopCase = { threw: boolean; returnedUndefined: boolean; storeUnchanged: boolean; quarantined: boolean; openaiActiveId: string }
type BackfillOk = { fetches: number; changed: boolean; before: string; after: string }
type BackfillRenamed = { changed: boolean; label: string }
type BackfillTarget = { changed: boolean; gLabel: string; gExpected: string; hLabel: string; openaiActiveId: string }
type BackfillNoop = {
  noEmail: boolean
  emptyEmail: boolean
  noAcct: boolean
  unknownAcct: boolean
  unchanged: boolean
  fetches: number
}
type Results = {
  sw_ok: SwOk
  sw_back: SwBack
  refuse_api: Refusal
  refuse_noacct: Refusal
  adopt: Adopt
  adopt_clear: AdoptClear
  midflight: Midflight
  anth_switch: AnthSwitch
  guards: Guards
  refuse_target: RefuseTarget
  noop_missing: NoopCase
  noop_no_entry: NoopCase
  noop_api: NoopCase
  backfill_ok: BackfillOk
  backfill_renamed: BackfillRenamed
  backfill_target: BackfillTarget
  backfill_noop: BackfillNoop
}

const runnerDir = mkdtempSync(join(tmpdir(), "cau-slot-parent-"))
const runnerPath = join(runnerDir, "runner.test.ts")
const outPath = join(runnerDir, "results.json")
writeFileSync(runnerPath, runnerSource)

const childHome = mkdtempSync(join(tmpdir(), "cau-slot-home-"))
const proc = Bun.spawnSync(["bun", "test", runnerPath], {
  env: { ...process.env, CAU_SRC: import.meta.dir, CAU_OUT: outPath, HOME: childHome },
  stdout: "pipe",
  stderr: "pipe",
})
if (proc.exitCode !== 0) {
  throw new Error(`openai slot runner failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}\n${proc.stdout.toString()}`)
}
const r = JSON.parse(readFileSync(outPath, "utf8")) as Results

test("S1:切换 OpenAI 账号完整保留 anthropic 条目与 auth.json 里其它无关键", () => {
  expect(r.sw_ok.anthropicEntry).toEqual({ type: "oauth", access: "anthA-a", refresh: "anthA-r", expires: r.sw_ok.anthropicEntry.expires })
  expect(r.sw_ok.anthropicEntry.expires).toBeGreaterThan(Date.now())
  expect(r.sw_ok.custom).toEqual({ keep: 1 })
  expect(r.sw_ok.slot.accountId).toBe("acct-B")
  expect(r.sw_ok.retId).toBe("openai:acct-B")
})

// storeUnchanged now ignores lastActiveAt, and `quarantined` is the reason: an api-key entry means
// the previous occupant was EVICTED, so capture must start its quarantine clock (INV-O1) rather than
// leave it frozen and refreshable. Everything else about the store — and all of auth.json — is still
// asserted byte-exact, which is the part that actually protects the user's pasted key.
// The pointer assertion is INVERTED from "still names acct-A" to "cleared": an api key in the slot
// means no ChatGPT account occupies it, so INV-O3's truth is that none is active. The property the
// original assertion was really protecting — a refused switch must never point at its TARGET — is
// kept explicitly below. auth.json stays byte-exact, which is what guards the user's pasted key.
test("S2:openai 槽位是 {type:\"api\"} → 拒绝覆盖,auth.json 逐字节不变,账号记录除隔离计时外分毫不动,活跃指针被清空", () => {
  expect(r.refuse_api.threw).toBe(true)
  expect(r.refuse_api.msg).toContain("API key")
  expect(r.refuse_api.authUnchanged).toBe(true)
  expect(r.refuse_api.storeUnchanged).toBe(true)
  expect(r.refuse_api.quarantined).toBe(true)
  expect(r.refuse_api.openaiActiveId).toBe("<cleared>")
  expect(r.refuse_api.openaiActiveId).not.toBe("openai:acct-B")
})

test("S3:openai 槽位有 refresh 但缺 accountId → 拒绝覆盖(无法归档的链尾不可销毁),起隔离计时并清空活跃指针", () => {
  expect(r.refuse_noacct.threw).toBe(true)
  expect(r.refuse_noacct.msg).toContain("accountId")
  expect(r.refuse_noacct.authUnchanged).toBe(true)
  expect(r.refuse_noacct.storeUnchanged).toBe(true)
  expect(r.refuse_noacct.quarantined).toBe(true)
  expect(r.refuse_noacct.openaiActiveId).toBe("<cleared>")
})

// INV-O2: "already in the store" is not enough — the tip must be the one that was IN THE SLOT,
// superseding the older stored copy, and switching back must use it.
test("S4:INV-O2 覆盖前先归档 —— 离任占位者的槽位 token 落库并取代旧副本,之后切回仍可用", () => {
  expect(r.sw_ok.aRefresh).toBe("oa-A-r")
  expect(r.sw_ok.aAccess).toBe("oa-A-a")
  expect(r.sw_ok.aLastActive).toBe("number")
  expect(r.sw_back.slot.refresh).toBe("oa-A-r")
  expect(r.sw_back.slot.accountId).toBe("acct-A")
  expect(r.sw_back.bRefresh).toBe("oa-B-r")
  expect(r.sw_back.openaiActiveId).toBe("openai:acct-A")
})

test("S5:INV-O3 槽位占位者与 openaiActiveId 不一致 → 归档并采纳槽位,绝不回写旧记账", () => {
  expect(r.adopt.returnedId).toBe("openai:acct-C")
  expect(r.adopt.cId).toBe("openai:acct-C")
  expect(r.adopt.cProvider).toBe("openai")
  expect(r.adopt.cAccountId).toBe("acct-C")
  expect(r.adopt.cRefresh).toBe("oa-C-r")
  expect(r.adopt.cAccess).toBe("oa-C-a")
  expect(r.adopt.cLastActive).toBe("number")
  expect(r.adopt.openaiActiveId).toBe("openai:acct-C")
  expect(r.adopt.aRefresh).toBe("oa-A-r-keep")
  expect(r.adopt.slotRefresh).toBe("oa-C-r")
  expect(r.adopt.fetches).toBe(0)
})

// The label must be an honest placeholder: the email lives behind a /wham/usage call that this
// path deliberately does not make, and the id must not be able to collide with a profile uuid.
test("S5b:新建的 OpenAI 记录 id 带 openai: 前缀,label 是占位符且绝不编造邮箱", () => {
  expect(r.adopt.cId.startsWith("openai:")).toBe(true)
  expect(r.adopt.cLabel).not.toContain("@")
  expect(r.adopt.cLabel).toContain("ChatGPT")
})

test("S6:归档复用 applyToken,needsReauth 与 token 一起被原子清除", () => {
  expect(r.adopt_clear.refresh).toBe("oa-D-r2")
  expect(r.adopt_clear.access).toBe("oa-D-a2")
  expect(r.adopt_clear.flagged).toBe(false)
  expect(r.adopt_clear.openaiActiveId).toBe("openai:acct-D")
})

// codex rotated the tip after our capture read it. The final re-read must notice and archive
// the NEWER tip; "oa-A-r" would mean we dropped a rotation, "oa-A-r-stale" that we never
// captured at all.
test("S7:飞行中轮换 —— 最终重读发现 refresh 变了,先归档新链尾再覆盖槽位", () => {
  expect(r.midflight.aRefresh).toBe("oa-A-r2")
  expect(r.midflight.aAccess).toBe("oa-A-a2")
  expect(r.midflight.slotRefresh).toBe("oa-B-r")
  expect(r.midflight.openaiActiveId).toBe("openai:acct-B")
  expect(r.midflight.fetches).toBe(0)
})

test("S8:切 OpenAI 不动 activeId;切 Anthropic 不动 openaiActiveId 与 openai 槽位", () => {
  expect(r.sw_ok.activeId).toBe("anthA")
  expect(r.sw_ok.openaiActiveId).toBe("openai:acct-B")
  expect(r.anth_switch.activeId).toBe("anthB")
  expect(r.anth_switch.openaiActiveId).toBe("openai:acct-A")
  expect(r.anth_switch.anthropicRefresh).toBe("anthB-r")
  expect(r.anth_switch.slot.refresh).toBe("oa-A-r")
  expect(r.anth_switch.slot.accountId).toBe("acct-A")
})

test("S9:switchToOpenaiAccount 收到 Anthropic 账号 id → 抛错,且不写 auth.json", () => {
  expect(r.guards.threw).toBe(true)
  expect(r.guards.msg).toBe("该账号不是 ChatGPT 账号")
  expect(r.guards.missingThrew).toBe(true)
  expect(r.guards.missingMsg).toContain("account not found")
  expect(r.guards.authUnchanged).toBe(true)
  expect(r.guards.activeId).toBe("anthA")
  expect(r.guards.openaiActiveId).toBe("openai:acct-A")
})

// The deliberate asymmetry with the anthropic path: codex is the slot's sole refresher, so an
// expired token is handed over verbatim and zero token POSTs leave this process.
test("S10:目标 token 已过期也原样写入槽位 —— 绝不刷新它(零网络请求)", () => {
  expect(r.sw_ok.slot).toEqual({ type: "oauth", access: "oa-B-a", refresh: "oa-B-r", expires: r.sw_ok.slot.expires, accountId: "acct-B" })
  expect(r.sw_ok.slotExpired).toBe(true)
  expect(r.sw_ok.fetches).toBe(0)
  expect(r.anth_switch.fetches).toBe(0)
})

test("S11:目标被标记 needsReauth → 拒绝切换,auth.json 不变", () => {
  expect(r.refuse_target.threw).toBe(true)
  expect(r.refuse_target.msg).toBe("账号需重新登录")
  expect(r.refuse_target.authUnchanged).toBe(true)
})

test("S12:目标缺 accountId → 拒绝切换(否则会造出此后无法覆盖的槽位)", () => {
  expect(r.refuse_target.noAcctThrew).toBe(true)
  expect(r.refuse_target.noAcctMsg).toContain("accountId")
})

// Each of these three shapes means the slot no longer holds what openaiActiveId names, i.e. the
// occupant was evicted, so capture is deliberately no longer a PURE no-op: it stamps the quarantine
// clock and nothing else. It must still never throw and never adopt (this runs from a background
// tick), which is what the remaining assertions pin.
// All three quarantine and none throws. They part company on the pointer, and that split is the
// knowledge/ignorance line: a file that PARSED and holds no ChatGPT chain is evidence that nobody is
// active, so the pointer is cleared; a file we could not read at all is not, so it is preserved —
// asserting "nobody is in use" from a failed read is the same falsehood as naming the wrong account.
test("S13:归档在 auth.json 缺失 / 无 openai 条目 / API key 条目下都绝不抛错、绝不采纳,只起隔离计时;确知为空才清空活跃指针,读不到则保留", () => {
  for (const row of [r.noop_missing, r.noop_no_entry, r.noop_api]) {
    expect(row.threw).toBe(false)
    expect(row.returnedUndefined).toBe(true)
    expect(row.storeUnchanged).toBe(true)
    expect(row.quarantined).toBe(true)
  }
  expect(r.noop_no_entry.openaiActiveId).toBe("<cleared>")
  expect(r.noop_api.openaiActiveId).toBe("<cleared>")
  expect(r.noop_missing.openaiActiveId).toBe("openai:acct-A")
})

// The round trip that keeps the writer and the recogniser honest: capture INSERTS the placeholder
// (no network, so it cannot know the email), and the backfill must recognise that exact string and
// replace it. `fetches` stays 0 — the backfill consumes a result the panel already had.
test("S14:占位符标签被实时邮箱回填 —— 写入方与识别方共用同一个构造函数,全程零网络请求", () => {
  expect(r.backfill_ok.before).toBe("ChatGPT acct-EEE")
  expect(r.backfill_ok.before).not.toContain("@")
  expect(r.backfill_ok.changed).toBe(true)
  expect(r.backfill_ok.after).toBe("guborong12345@gmail.com")
  expect(r.backfill_ok.fetches).toBe(0)
})

// The README promises auto-capture never overwrites a hand-edited label.
test("S15:用户手改过的 label → 拒绝回填,一个字都不动", () => {
  expect(r.backfill_renamed.changed).toBe(false)
  expect(r.backfill_renamed.label).toBe("我的工作号")
})

// Attribution is by accountId and nothing else. Keyed on openaiActiveId instead, this fixture would
// stamp acct-H's email onto acct-G — a PERSISTED lie about which account is which, strictly worse
// than the placeholder it replaced.
test("S16:活跃指针指向另一个账号时,邮箱仍然落在请求所认证的那个账号上,绝不串行", () => {
  expect(r.backfill_target.changed).toBe(true)
  expect(r.backfill_target.hLabel).toBe("h@example.com")
  expect(r.backfill_target.gLabel).toBe(r.backfill_target.gExpected)
  expect(r.backfill_target.gLabel).not.toBe("h@example.com")
  expect(r.backfill_target.openaiActiveId).toBe("openai:acct-G")
})

test("S17:没有邮箱 / 没有 accountId / 账号不存在 → 一律不写盘,零网络请求", () => {
  expect(r.backfill_noop.noEmail).toBe(false)
  expect(r.backfill_noop.emptyEmail).toBe(false)
  expect(r.backfill_noop.noAcct).toBe(false)
  expect(r.backfill_noop.unknownAcct).toBe(false)
  expect(r.backfill_noop.unchanged).toBe(true)
  expect(r.backfill_noop.fetches).toBe(0)
})
