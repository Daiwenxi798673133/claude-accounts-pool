import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// WHY A SUBPROCESS (the reason usage.test.ts / openai-slot.test.ts document at length):
// autoswitch.test.ts sorts BEFORE this file in the same `bun test` process and registers
// process-global, un-evictable mock.module("./accounts.ts", ...) and
// mock.module("./usage.ts", ...) PARTIAL stubs (no applyToken, no writeAuthAnthropic, no
// withAuthLock, no getAuthJsonPath). Every case below needs the REAL accounts.ts, and case 4
// additionally needs its OWN usage.ts / openai-slot.ts stubs — registering those in-process
// would replace the leaked stubs that every LATER test file links against. So the scenarios
// run in a FRESH child process (real module graph, private mocks), driven through a temp-dir
// auth.json + claude-accounts.json seam, and the parent asserts on the results JSON.
// accounts.ts resolves ACCOUNTS_PATH from homedir() at MODULE LOAD, and os.homedir() snapshots
// HOME at process START, so only a spawn-env HOME override can sandbox the account library.
const runnerSource = `
import { test, mock } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"

const SRC = process.env.CAU_SRC
const OUT = process.env.CAU_OUT
const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile"

const dataHome = mkdtempSync(join(tmpdir(), "cau-lease-"))
process.env.XDG_DATA_HOME = dataHome
mkdirSync(join(dataHome, "opencode"), { recursive: true })
const authPath = join(dataHome, "opencode", "auth.json")

const accountsDir = join(homedir(), ".config", "opencode")
mkdirSync(accountsDir, { recursive: true })
const accountsPath = join(accountsDir, "claude-accounts.json")

const future = () => Date.now() + 3600000
const writeAuthRaw = (obj) => writeFileSync(authPath, JSON.stringify(obj))
const authText = () => readFileSync(authPath, "utf8")
const authEntry = () => JSON.parse(authText()).anthropic
const writeAccounts = (obj) => writeFileSync(accountsPath, JSON.stringify(obj))
const accountsText = () => readFileSync(accountsPath, "utf8")
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// The profile call is the ONE request the capture path legitimately makes; anything else
// THROWS so an accidental token POST blows up loudly at its call site instead of silently
// making these scenarios pass against a live endpoint.
let profileFetches = 0
globalThis.fetch = (async (input) => {
  const url = String(input)
  if (url === PROFILE_ENDPOINT) {
    profileFetches++
    return { ok: true, status: 200, json: async () => ({ account: { uuid: "u-lease", email: "lease@x.com" } }) }
  }
  throw new Error("unexpected network call: " + url)
})

const { initLogger } = await import(join(SRC, "logger.ts"))
const logTags = []
initLogger({ app: { log: (payload) => { logTags.push(String(payload.message)); return Promise.resolve() } } })
const logged = (tag) => logTags.some((entry) => entry.includes(tag))

const { SENTINEL_REFRESH } = await import(join(SRC, "constants.ts"))
const accounts = await import(join(SRC, "accounts.ts"))
// Snapshot BEFORE the mock below: mock.module patches the live namespace of an already-imported
// module, so reaching back through the module object after registering would land on the stub.
const realUsage = { ...(await import(join(SRC, "usage.ts"))) }
const realSlot = { ...(await import(join(SRC, "openai-slot.ts"))) }

const results = {}

// ---- 1: LEASE write -> sentinel refresh in both stores ----
const leaseExpires = future()
writeAuthRaw({ custom: { keep: 1 } })
await accounts.writeAuthAnthropic({ kind: "lease", access: "leased-access", expires: leaseExpires })
{
  const record = { id: "r1", label: "R1", refresh: "real-refresh", access: "old-a", expires: 1, needsReauth: true }
  accounts.applyToken(record, { kind: "lease", access: "leased-access", expires: leaseExpires })
  results.lease = {
    sentinel: SENTINEL_REFRESH,
    expires: leaseExpires,
    entry: authEntry(),
    foreignKey: JSON.parse(authText()).custom,
    recordRefresh: record.refresh,
    recordAccess: record.access,
    recordExpires: record.expires,
    recordFlagged: "needsReauth" in record,
  }
}

// ---- 2: FULL write -> byte-identical to the pre-change shape ----
const fullExpires = future()
writeAuthRaw({})
await accounts.writeAuthAnthropic({ kind: "full", token: { refresh: "full-refresh", access: "full-access", expires: fullExpires } })
const fullJson = authText()
// A token carrying neither access nor expires: the old writer defaulted them to "" and 0, and
// that default is part of the shape a worker's opencode still parses.
writeAuthRaw({})
await accounts.writeAuthAnthropic({ kind: "full", token: { refresh: "bare-refresh" } })
const bareJson = authText()
{
  const record = { id: "r2", label: "R2", refresh: "old", access: "old-a", expires: 1, needsReauth: true }
  accounts.applyToken(record, { kind: "full", token: { refresh: "new", access: "new-a", expires: fullExpires } })
  // The UNTAGGED AuthToken is the pre-change call shape and is still a live contract
  // (src/usage.test.ts drives applyToken with it); it must keep behaving as kind:"full".
  const legacy = { id: "r3", label: "R3", refresh: "old", access: "old-a", expires: 1, needsReauth: true }
  let legacyThrew = false
  try { accounts.applyToken(legacy, { refresh: "new", access: "new-a", expires: fullExpires }) } catch { legacyThrew = true }
  results.full = {
    expires: fullExpires,
    fullJson,
    bareJson,
    recordRefresh: record.refresh,
    recordAccess: record.access,
    recordExpires: record.expires,
    recordFlagged: "needsReauth" in record,
    legacyThrew,
    legacyRefresh: legacy.refresh,
    legacyAccess: legacy.access,
    legacyFlagged: "needsReauth" in legacy,
  }
}

// ---- 3: account-library capture REFUSES a sentinel refresh ----
writeAccounts({ version: 1, activeId: "keep-me", accounts: [{ id: "keep-me", label: "KEEP", refresh: "keep-r", access: "keep-a", expires: future() }] })
const storeBefore = accountsText()
writeAuthRaw({ anthropic: { type: "oauth", access: "leased-access", refresh: SENTINEL_REFRESH, expires: future() } })
logTags.length = 0
profileFetches = 0
let captureThrew = false
try { await realUsage.autoCapture() } catch { captureThrew = true }
const viaAutoCapture = {
  threw: captureThrew,
  storeUnchanged: accountsText() === storeBefore,
  sentinelSkipLogged: logged("accounts:sentinel-skip"),
  upsertLogged: logged("accounts:upsert"),
  profileFetches,
}
logTags.length = 0
const directBefore = accountsText()
await accounts.upsertAccount("u-direct", "direct@x.com", { refresh: SENTINEL_REFRESH, access: "leased-access", expires: future() })
results.capture = {
  ...viaAutoCapture,
  directStoreUnchanged: accountsText() === directBefore,
  directSentinelSkipLogged: logged("accounts:sentinel-skip"),
  directUpsertLogged: logged("accounts:upsert"),
}

// ---- 5: the leased account-id record (what /usage marks "In Use" on a worker) ----
const LEASED_ID = "eaaa1a79-4c1d-4f6e-9a52-6b7c8d9e0f11"
// A worker's library is EMPTY by design (scenario 3 above is why), which is exactly the state
// setActiveId refuses to write a pointer in. recordLeasedActiveId must write it anyway.
writeAccounts({ version: 1, openaiActiveId: "oa-keep", accounts: [] })
await accounts.recordLeasedActiveId(LEASED_ID)
const afterRecord = JSON.parse(accountsText())
const recordReadBack = await accounts.readActiveId()
// Re-leasing the SAME account must not rewrite the file. Seeded COMPACT while saveAccounts always
// writes 2-space JSON, so surviving bytes prove no write happened rather than merely no change.
writeAccounts({ version: 1, activeId: LEASED_ID, openaiActiveId: "oa-keep", accounts: [] })
const compactBefore = accountsText()
await accounts.recordLeasedActiveId(LEASED_ID)
const repeatSkipped = accountsText() === compactBefore
// AND setActiveId's membership check is UNTOUCHED: local mode still refuses a pointer at an
// account whose token this machine would never find.
logTags.length = 0
await accounts.setActiveId("not-in-this-library")
results.leasedActiveId = {
  activeId: afterRecord.activeId,
  openaiActiveId: afterRecord.openaiActiveId,
  accountCount: afterRecord.accounts.length,
  readBack: recordReadBack,
  repeatSkipped,
  afterSetActiveUnknown: (await accounts.loadAccounts()).activeId,
  setActiveUnknownLogged: logged("accounts:set-active-unknown"),
}

// ---- 4: keeper anthropic-maintenance gate ----
let openaiCaptures = 0
let keepActiveCalls = 0
let acquireCalls = 0
let autoCaptureCalls = 0
mock.module(join(SRC, "openai-slot.ts"), () => ({
  ...realSlot,
  captureOpenaiSlot: async () => { openaiCaptures++ },
}))
mock.module(join(SRC, "usage.ts"), () => ({
  ...realUsage,
  keepActiveFresh: async () => { keepActiveCalls++ },
  acquireInactiveAccess: async () => { acquireCalls++; return { refreshed: false } },
  autoCapture: async () => { autoCaptureCalls++ },
}))
const { installTokenKeeper } = await import(join(SRC, "keeper.ts"))

writeAccounts({ version: 1, activeId: "acc1", accounts: [{ id: "acc1", label: "A", refresh: "acc1-r", access: "acc1-a", expires: future() }] })
writeAuthRaw({ anthropic: { type: "oauth", access: "leased-access", refresh: SENTINEL_REFRESH, expires: future() } })

// installTokenKeeper fires its first tick at KEEPER_INITIAL_DELAY_MS (2s, a module-local const
// in keeper.ts with no injection seam), so the wait is deliberately just past it.
const TICK_WAIT_MS = 2600
const counts = () => ({ openaiCaptures, keepActiveCalls, acquireCalls, autoCaptureCalls })
const resetCounts = () => { openaiCaptures = 0; keepActiveCalls = 0; acquireCalls = 0; autoCaptureCalls = 0 }

const gated = installTokenKeeper(() => false, { anthropicMaintenance: false })
await sleep(TICK_WAIT_MS)
gated.dispose()
const gatedCounts = counts()

// CONTROL, same fixture: without the gate the very same tick MUST reach both anthropic passes,
// otherwise the gated assertions above would hold for a keeper that simply does nothing.
resetCounts()
const ungated = installTokenKeeper(() => false)
await sleep(TICK_WAIT_MS)
ungated.dispose()
results.keeper = { gated: gatedCounts, ungated: counts() }

writeFileSync(OUT, JSON.stringify(results))
test("lease write scenarios executed", () => {})
`

type AnthropicEntry = { type?: string; access?: string; refresh?: string; expires?: number }
type LeaseRow = {
  sentinel: string
  expires: number
  entry: AnthropicEntry
  foreignKey?: { keep: number }
  recordRefresh: string
  recordAccess?: string
  recordExpires?: number
  recordFlagged: boolean
}
type FullRow = {
  expires: number
  fullJson: string
  bareJson: string
  recordRefresh: string
  recordAccess?: string
  recordExpires?: number
  recordFlagged: boolean
  legacyThrew: boolean
  legacyRefresh: string
  legacyAccess?: string
  legacyFlagged: boolean
}
type CaptureRow = {
  threw: boolean
  storeUnchanged: boolean
  sentinelSkipLogged: boolean
  upsertLogged: boolean
  profileFetches: number
  directStoreUnchanged: boolean
  directSentinelSkipLogged: boolean
  directUpsertLogged: boolean
}
type TickCounts = { openaiCaptures: number; keepActiveCalls: number; acquireCalls: number; autoCaptureCalls: number }
type LeasedActiveIdRow = {
  activeId?: string
  openaiActiveId?: string
  accountCount: number
  readBack?: string
  repeatSkipped: boolean
  afterSetActiveUnknown?: string
  setActiveUnknownLogged: boolean
}
type Results = {
  lease: LeaseRow
  full: FullRow
  capture: CaptureRow
  keeper: { gated: TickCounts; ungated: TickCounts }
  leasedActiveId: LeasedActiveIdRow
}

const runnerDir = mkdtempSync(join(tmpdir(), "cau-lease-parent-"))
const runnerPath = join(runnerDir, "runner.test.ts")
const outPath = join(runnerDir, "results.json")
writeFileSync(runnerPath, runnerSource)

const childHome = mkdtempSync(join(tmpdir(), "cau-lease-home-"))
const proc = Bun.spawnSync(["bun", "test", runnerPath], {
  env: { ...process.env, CAU_SRC: join(import.meta.dir, ".."), CAU_OUT: outPath, HOME: childHome },
  stdout: "pipe",
  stderr: "pipe",
})
const parsed = existsSync(outPath) ? (JSON.parse(readFileSync(outPath, "utf8")) as Results) : undefined

// Accessor rather than a top-level throw: a child that dies before writing its results would
// otherwise collapse this whole file into one nameless error, hiding WHICH of the four
// behaviours regressed. Every test asks for the results and gets the child's own output on
// failure.
function results(): Results {
  if (!parsed) {
    throw new Error(`lease-write runner failed (exit ${proc.exitCode}):\n${proc.stderr.toString()}\n${proc.stdout.toString()}`)
  }
  return parsed
}

test("applyToken lease write serializes sentinel refresh", () => {
  const r = results()
  // auth.json's anthropic entry: the leased access/expires verbatim, and a refresh field that
  // is present (opencode 1.18.9 SILENTLY DISCARDS an entry without one) but is the sentinel.
  expect(r.lease.entry).toEqual({ type: "oauth", access: "leased-access", refresh: r.lease.sentinel, expires: r.lease.expires })
  expect(r.lease.entry.refresh).toBe("claude-accounts-usage/cloud-lease/not-a-refresh-token")
  expect(r.lease.foreignKey).toEqual({ keep: 1 })
  // Same rule through the record writer, so the two stores can never disagree about a lease.
  expect(r.lease.recordRefresh).toBe(r.lease.sentinel)
  expect(r.lease.recordAccess).toBe("leased-access")
  expect(r.lease.recordExpires).toBe(r.lease.expires)
  expect(r.lease.recordFlagged).toBe(false)
})

test("applyToken full write is byte-identical to previous shape", () => {
  const r = results()
  // The concrete bytes, not a subset: key set, key ORDER and indentation are all pinned, so any
  // future drift in the shape ex-machina and opencode parse fails here.
  expect(r.full.fullJson).toBe(
    JSON.stringify({ anthropic: { type: "oauth", access: "full-access", refresh: "full-refresh", expires: r.full.expires } }, null, 2),
  )
  expect(r.full.bareJson).toBe(
    JSON.stringify({ anthropic: { type: "oauth", access: "", refresh: "bare-refresh", expires: 0 } }, null, 2),
  )
  expect(r.full.recordRefresh).toBe("new")
  expect(r.full.recordAccess).toBe("new-a")
  expect(r.full.recordExpires).toBe(r.full.expires)
  expect(r.full.recordFlagged).toBe(false)
  expect(r.full.legacyThrew).toBe(false)
  expect(r.full.legacyRefresh).toBe("new")
  expect(r.full.legacyAccess).toBe("new-a")
  expect(r.full.legacyFlagged).toBe(false)
})

test("store capture refuses sentinel refresh", () => {
  const r = results()
  expect(r.capture.threw).toBe(false)
  expect(r.capture.storeUnchanged).toBe(true)
  expect(r.capture.upsertLogged).toBe(false)
  expect(r.capture.sentinelSkipLogged).toBe(true)
  // The profile call still happens on the autoCapture path — the refusal is at the library
  // write, not at the identity lookup — so this pins where the guard is, not merely that it is.
  expect(r.capture.profileFetches).toBe(1)
  expect(r.capture.directStoreUnchanged).toBe(true)
  expect(r.capture.directUpsertLogged).toBe(false)
  expect(r.capture.directSentinelSkipLogged).toBe(true)
})

test("recordLeasedActiveId names an account the library does not hold", () => {
  const r = results()
  // THE POINT OF THE WHOLE MECHANISM: a worker's library is empty, so the pointer necessarily names
  // an account only the master holds. Without this write nothing on the machine could answer "which
  // account is my lease for?" until this process performed a lease of its own — which is why the
  // first /usage of a freshly-started worker used to draw a blank "In Use" column.
  expect(r.leasedActiveId.accountCount).toBe(0)
  expect(r.leasedActiveId.activeId).toBe("eaaa1a79-4c1d-4f6e-9a52-6b7c8d9e0f11")
  expect(r.leasedActiveId.readBack).toBe("eaaa1a79-4c1d-4f6e-9a52-6b7c8d9e0f11")
  // The anthropic pointer is the ONLY field it may touch; the ChatGPT one belongs to another store.
  expect(r.leasedActiveId.openaiActiveId).toBe("oa-keep")
  // A renewal that lands on the same account costs no disk write.
  expect(r.leasedActiveId.repeatSkipped).toBe(true)
  // REGRESSION GUARD on local mode: setActiveId keeps refusing an unknown id, so the two writers
  // cannot be "simplified" into one without this failing.
  expect(r.leasedActiveId.setActiveUnknownLogged).toBe(true)
  expect(r.leasedActiveId.afterSetActiveUnknown).toBe("eaaa1a79-4c1d-4f6e-9a52-6b7c8d9e0f11")
})

test("keeper skips anthropic maintenance when gated", () => {
  const r = results()
  expect(r.keeper.gated.openaiCaptures).toBeGreaterThanOrEqual(1)
  expect(r.keeper.gated.keepActiveCalls).toBe(0)
  expect(r.keeper.gated.acquireCalls).toBe(0)
  expect(r.keeper.gated.autoCaptureCalls).toBe(0)
  // Control on the identical fixture: the ungated keeper does reach both anthropic passes.
  expect(r.keeper.ungated.keepActiveCalls).toBeGreaterThanOrEqual(1)
  expect(r.keeper.ungated.acquireCalls).toBeGreaterThanOrEqual(1)
})
