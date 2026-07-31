import { readFile, writeFile, mkdir, rename } from "node:fs/promises"
import { homedir } from "node:os"
import { join, dirname } from "node:path"
import { SENTINEL_REFRESH } from "./constants.ts"
import { log } from "./logger.ts"
import { withFileLock } from "./lockfile.ts"
// Type-only: profile.ts must never become a runtime dependency of the account store (it owns a
// network call, this file owns the on-disk records), and it does not import this file back.
import type { Subscription } from "./profile.ts"

export type ProviderId = "anthropic" | "openai"

export type StoredAccount = {
  id: string
  label: string
  refresh: string
  access?: string
  expires?: number
  excluded?: boolean
  needsReauth?: boolean
  // Absent ⇒ anthropic (read it through providerOf, never directly). Every record written
  // by a pre-multi-provider release lacks this field, and back-filling it on load would
  // rewrite a store that an older installed version still reads — hence a read-time
  // default instead of a migration.
  provider?: ProviderId
  // ChatGPT account id, needed alongside the token when switching an openai account;
  // anthropic records identify themselves by `id` alone and leave this unset.
  accountId?: string
  lastActiveAt?: number
  // Cached on purpose, unlike the usage numbers: a plan is an account ATTRIBUTE that changes
  // on the order of months, and oauth/usage carries no plan at all so each read costs a second
  // request. THREE STATES: absent = never looked up (backfill tries once); `{}` = looked up and
  // the profile had no organization; populated = real values. Collapsing `{}` into absent would
  // re-fetch every plan-less account on every /usage, forever.
  subscription?: Subscription
}

export type AccountsFile = {
  version: number
  // `activeId` stays ANTHROPIC-ONLY and openai gets its own field on purpose: one shared
  // field would let an openai switch overwrite the anthropic bookkeeping (and vice versa),
  // silently detaching auth.json's `anthropic` entry from the record we believe is active.
  // Callers must go through activeIdOf / setActiveIdOf rather than pick a field by hand.
  activeId?: string
  openaiActiveId?: string
  accounts: StoredAccount[]
}

// A table rather than a ternary so adding a ProviderId is a COMPILE error until its own
// active-id field is declared here — the alternative silently aliases it onto `activeId`.
const ACTIVE_ID_FIELD: Record<ProviderId, "activeId" | "openaiActiveId"> = {
  anthropic: "activeId",
  openai: "openaiActiveId",
}

// Derived, not re-listed: a new ProviderId added to the table above is picked up here for free.
const PROVIDER_IDS = Object.keys(ACTIVE_ID_FIELD) as ProviderId[]

export function providerOf(account: StoredAccount): ProviderId {
  return account.provider ?? "anthropic"
}

// The ONLY sanctioned way to obtain a per-provider candidate list. Filtering `accounts` by
// hand invites `account.provider === "anthropic"`, which drops every legacy record.
export function accountsOf(file: AccountsFile, provider: ProviderId): StoredAccount[] {
  return file.accounts.filter((account) => providerOf(account) === provider)
}

export function activeIdOf(file: AccountsFile, provider: ProviderId): string | undefined {
  return file[ACTIVE_ID_FIELD[provider]]
}

export function setActiveIdOf(file: AccountsFile, provider: ProviderId, id: string | undefined): void {
  file[ACTIVE_ID_FIELD[provider]] = id
}

export type AnthropicOauth = {
  type: "oauth"
  access?: string
  refresh?: string
  expires?: number
}

export type OpenaiOauth = {
  type: "oauth"
  access?: string
  refresh?: string
  expires?: number
  accountId?: string
}

export type AuthToken = {
  refresh: string
  access?: string
  expires?: number
}

// The two ways an anthropic token can be written. `full` is a REAL chain (access + expires + a
// real refresh) and is today's behaviour verbatim. `lease` is a cloud worker's write: the master
// holds the only real refresh token, so the worker receives an access token plus an expiry and
// nothing else — and INV-CLOUD-1 fills the refresh slot with the sentinel rather than omitting
// the field, because opencode 1.18.9 SILENTLY DISCARDS an `anthropic` entry that carries no
// `refresh` at all (verified: the same entry WITH a fake refresh makes `opencode auth list`
// report 1 credential, WITHOUT it 0 credentials, exit 0, no error printed).
export type TokenWrite =
  | { kind: "full"; token: AuthToken }
  | { kind: "lease"; access: string; expires: number }

// A table rather than an if/else chain, same reason as ACTIVE_ID_FIELD above: adding a
// TokenWrite kind is a COMPILE error until its writer is declared here. An `if (kind ===
// "lease") … else …` would instead serialize an unheard-of kind AS IF it were a full token,
// i.e. would fabricate a refresh field from a shape nobody wrote a rule for.
const TOKEN_WRITERS: { [K in TokenWrite["kind"]]: (write: Extract<TokenWrite, { kind: K }>) => AuthToken } = {
  full: (write) => write.token,
  // INV-CLOUD-1: a lease NEVER carries a real refresh token. The sentinel is deliberately not
  // token-shaped, so every capture path can refuse it on sight (see upsertAccount below) — which
  // is what keeps the MASTER the only holder of real chains: a worker machine cannot leak,
  // replay or revoke a chain it never received.
  lease: (write) => ({ refresh: SENTINEL_REFRESH, access: write.access, expires: write.expires }),
}

// Normalizes either write shape into the token fields to stamp. A BARE AuthToken is still
// accepted deliberately: it is the pre-cloud-mode call shape, is still exercised as such
// (src/usage.test.ts drives applyToken with it), and means exactly `{ kind: "full", token }` —
// mis-dispatching it through TOKEN_WRITERS[undefined] would throw on a token-write path.
// Normalizing here keeps ONE writer per store rather than a second path per shape.
function resolveTokenWrite(write: TokenWrite | AuthToken): AuthToken {
  if (!("kind" in write)) return write
  // Pure hand-off to the table, NOT a second decision point: each variant reaches its own entry.
  // Because the return type is declared, a newly-added kind that nobody routed here is also a
  // compile error (TS2366, missing return) on top of the missing-key error in the table above.
  switch (write.kind) {
    case "full":
      return TOKEN_WRITERS.full(write)
    case "lease":
      return TOKEN_WRITERS.lease(write)
  }
}

// SINGLE token-write path for a StoredAccount. Every site that stamps a fresh token
// onto a record MUST go through here so the dead-token flag is cleared atomically with
// the write — a spread-merge would silently keep needsReauth and strand a re-logged-in
// account as permanently skipped.
export function applyToken(record: StoredAccount, write: TokenWrite | AuthToken): StoredAccount {
  const token = resolveTokenWrite(write)
  record.refresh = token.refresh
  record.access = token.access
  record.expires = token.expires
  delete record.needsReauth
  return record
}

const ACCOUNTS_PATH = join(homedir(), ".config", "opencode", "claude-accounts.json")

function authJsonCandidates(): string[] {
  const list: string[] = []
  if (process.env.XDG_DATA_HOME) list.push(join(process.env.XDG_DATA_HOME, "opencode", "auth.json"))
  list.push(join(homedir(), ".local", "share", "opencode", "auth.json"))
  list.push(join(homedir(), "Library", "Application Support", "opencode", "auth.json"))
  return list
}

// Read twin of atomicWriteJson: swallows missing / malformed files so every caller can treat
// "no usable JSON" as undefined rather than branching on errno.
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return undefined
  }
}

export async function atomicWriteJson(path: string, data: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`
  await writeFile(tmp, JSON.stringify(data, null, 2), { mode: 0o600 })
  await rename(tmp, path)
}

async function resolveAuthJsonPath(): Promise<string> {
  const candidates = authJsonCandidates()
  for (const candidate of candidates) {
    if (await readJson(candidate)) return candidate
  }
  return candidates[0]
}

export function getAuthJsonPath(): Promise<string> {
  return resolveAuthJsonPath()
}

// Lazily resolve (and cache) the cross-process lock path. MUST be invoked only from
// inside withAuthLock (first call), NEVER at import time: resolving before auth.json
// exists can cache candidates[0] while a later process — seeing the file already
// materialized at a different candidate — resolves there instead ⇒ the two processes
// lock DIFFERENT paths ⇒ split lock domains ⇒ silent loss of mutual exclusion.
// The lock lives in the DATA dir beside auth.json (not the config dir): usage.test.ts's
// crash-persist scenario chmods the config dir 0o500 mid-section, which would break lock
// release if the lock lived there. The filename deliberately does NOT start with
// "auth.json" so keeper.ts's watcher filter (keeper.ts:82, ignores names not starting
// with "auth.json") never fires on lock churn.
let lockPathPromise: Promise<string> | undefined
function authLockPath(): Promise<string> {
  lockPathPromise ??= resolveAuthJsonPath().then((path) => join(dirname(path), "claude-accounts-usage.lock"))
  return lockPathPromise
}

// Serializes auth.json / claude-accounts.json read-modify-writes, now behind a
// cross-process file lock so concurrent OpenCode instances are mutually exclusive too.
// Still NOT reentrant in-process: never nest withAuthLock inside another withAuthLock or
// it deadlocks the in-process queue (as before) — and would now also self-contend on the
// file lock.
let authLock: Promise<unknown> = Promise.resolve()

export function withAuthLock<T>(fn: () => Promise<T>): Promise<T> {
  const job = async () => withFileLock(await authLockPath(), fn)
  const run = authLock.then(job, job)
  authLock = run.then(() => undefined, () => undefined)
  return run
}

export async function readActiveId(): Promise<string | undefined> {
  return (await loadAccounts()).activeId
}

export async function loadAccounts(): Promise<AccountsFile> {
  const data = await readJson<Partial<AccountsFile>>(ACCOUNTS_PATH)
  return {
    version: data?.version ?? 1,
    activeId: data?.activeId,
    // Must be carried through even though nothing in this wave writes it: loadAccounts is
    // the sole input of every saveAccounts, so omitting a field here silently ERASES it
    // from the file on the next unrelated write.
    openaiActiveId: data?.openaiActiveId,
    accounts: Array.isArray(data?.accounts)
      ? (data!.accounts as StoredAccount[]).filter((account) => typeof account.id === "string" && account.id.length > 0)
      : [],
  }
}

export async function saveAccounts(file: AccountsFile): Promise<void> {
  await atomicWriteJson(ACCOUNTS_PATH, file)
}

export async function readAuthAnthropic(): Promise<AnthropicOauth | undefined> {
  const auth = await readJson<Record<string, unknown>>(await resolveAuthJsonPath())
  const entry = auth?.["anthropic"]
  if (entry && typeof entry === "object" && (entry as AnthropicOauth).type === "oauth") {
    return entry as AnthropicOauth
  }
  return undefined
}

// THREE-WAY read of the openai slot, for the two SAFETY-CRITICAL callers only (the keepalive
// predicate and the capture protocol). readAuthOpenai below collapses "the file says there is no
// ChatGPT oauth entry" and "we could not read the file at all" into the same undefined. That is
// harmless for the panel — both mean "nothing to show" — and it is NOT harmless for INV-O1, where
// the first is EVIDENCE and the second is IGNORANCE: "we cannot see the slot, therefore no chain is
// codex's" inverts the entire premise. Anything deciding whether a refresh token may be POSTed must
// branch on the difference and refuse on ignorance.
export type OpenaiSlotRead =
  | { state: "oauth"; slot: OpenaiOauth & { refresh: string } }
  | { state: "absent" }
  | { state: "unreadable" }

export async function readOpenaiSlotState(): Promise<OpenaiSlotRead> {
  const auth = await readJson<Record<string, unknown>>(await resolveAuthJsonPath())
  // readJson swallows a missing file, a permissions error, unparseable JSON and fd exhaustion alike,
  // so a non-object here means "we learned nothing", NEVER "there is nothing".
  if (typeof auth !== "object" || auth === null || Array.isArray(auth)) return { state: "unreadable" }
  const entry = auth["openai"]
  const oauth = entry && typeof entry === "object" && (entry as OpenaiOauth).type === "oauth" ? (entry as OpenaiOauth) : undefined
  // An oauth entry WITHOUT a refresh token is reported as absent, not as an occupied slot, and the
  // distinction is load-bearing for the caller: codex cannot rotate a chain it does not hold, so
  // there is positively nothing of codex's in the slot. It also guarantees every "oauth" result
  // carries an exact chain identity, so the occupant comparison can never be left with nothing to
  // compare (which would silently degrade into a non-match, i.e. permission).
  if (oauth?.refresh) return { state: "oauth", slot: { ...oauth, refresh: oauth.refresh } }
  // Parsed fine: no `openai` key, an api key, or a shape carrying no chain. All are positive
  // evidence that no ChatGPT OAuth chain occupies the slot.
  return { state: "absent" }
}

// Narrowed to oauth, so a `{type:"api"}` key entry reads as undefined here — anything that
// must REFUSE such an entry has to read the raw value instead (src/openai-slot.ts).
// OpenCode's built-in codex plugin remains the `openai` entry's sole REFRESHER; the only
// sanctioned writer on our side is the slot protocol in src/openai-slot.ts, which never
// POSTs that one-shot chain.
// Kept EXACTLY as it was rather than reimplemented over readOpenaiSlotState: openai-usage.ts needs
// only `access` and legitimately fetches usage for an entry that carries no refresh, which that
// stricter reader deliberately reports as absent.
export async function readAuthOpenai(): Promise<OpenaiOauth | undefined> {
  const auth = await readJson<Record<string, unknown>>(await resolveAuthJsonPath())
  const entry = auth?.["openai"]
  if (entry && typeof entry === "object" && (entry as OpenaiOauth).type === "oauth") {
    return entry as OpenaiOauth
  }
  return undefined
}

// SOLE writer of auth.json's `anthropic` entry, for BOTH write kinds. A second writer is exactly
// what INV-CLOUD-1 forbids: the sentinel refresh must be produced in one place, by the one
// resolver applyToken also uses, or a lease could be serialized one way here and another way
// into a StoredAccount.
export async function writeAuthAnthropic(write: TokenWrite): Promise<void> {
  const path = await resolveAuthJsonPath()
  const auth = (await readJson<Record<string, unknown>>(path)) ?? {}
  const token = resolveTokenWrite(write)
  auth["anthropic"] = {
    type: "oauth",
    access: token.access ?? "",
    refresh: token.refresh,
    expires: token.expires ?? 0,
  }
  await atomicWriteJson(path, auth)
  log.info("accounts:write-auth", { kind: write.kind, hasAccess: Boolean(token.access), expires: token.expires ?? 0 })
}

export async function upsertAccount(
  id: string,
  label: string,
  token: AuthToken,
  subscription?: Subscription,
): Promise<AccountsFile> {
  // INV-CLOUD-1 guard at the account-library choke point, and a VALUE check rather than a mode
  // check on purpose. A worker's leased auth.json entry carries SENTINEL_REFRESH; archiving it
  // here would put a non-token in the library, where it would be POSTed to Anthropic as a refresh
  // forever (branding a healthy account needs-reauth) and would make this machine look like it
  // holds a credential it does not have. Checking the VALUE — never "am I a worker?" — is what
  // keeps this inert in local mode: the sentinel never appears there, so the branch is never
  // taken and the existing capture path is unchanged.
  if (token.refresh === SENTINEL_REFRESH) {
    log.info("accounts:sentinel-skip", { id, at: "upsert" })
    // Nothing was written, so hand back the store AS IT STANDS: the caller's contract is a
    // snapshot of the file, never "the file I just saved".
    return loadAccounts()
  }
  const file = await loadAccounts()
  const index = file.accounts.findIndex((account) => account.id === id)
  const inserted = index < 0
  if (index >= 0) {
    applyToken(file.accounts[index], { kind: "full", token })
    // Overwritten every capture rather than written once: this is the only path that ever sees a
    // live profile for the active account, so it is also the only place an upgrade / downgrade /
    // seat change can be noticed. An omitted argument leaves the stored value untouched.
    if (subscription) file.accounts[index].subscription = subscription
  } else {
    file.accounts.push({ id, label, refresh: token.refresh, access: token.access, expires: token.expires, subscription })
  }
  file.activeId = id
  await saveAccounts(file)
  log.info("accounts:upsert", { id, label, inserted })
  return file
}

// WHICH ACCOUNT A CLOUD-WORKER'S CURRENT LEASE BELONGS TO. A worker's auth.json entry carries
// access + expiry and the sentinel refresh — nothing that names an account — so without this record
// the only place that knows is leaseKeeper's in-memory field, which is empty for the whole first
// stretch of a process that booted onto a still-fresh on-disk lease. That gap is what left /usage's
// "In Use" marker blank on the first call and left autoswitch reporting `""` as the spent account.
//
// DELIBERATELY NOT setActiveId: that one refuses an id absent from `accounts[]`, which is correct
// for local mode (the pointer must name a record whose token this machine will actually load) and
// wrong here — a worker's library is empty BY DESIGN (upsertAccount's sentinel-skip), so on a worker
// this pointer legitimately names an account only the master holds.
//
// An id string only. There is no credential in this write, so it costs INV-CLOUD-1 nothing.
export async function recordLeasedActiveId(id: string): Promise<void> {
  await withAuthLock(async () => {
    const file = await loadAccounts()
    // Renewals re-lease the SAME account far more often than they move, and the read-modify-write
    // below is a real disk write under a cross-process lock; skipping the no-op keeps a long-lived
    // worker from rewriting this file every renewal for nothing.
    if (file.activeId === id) return
    const from = file.activeId
    file.activeId = id
    await saveAccounts(file)
    log.info("accounts:record-leased-active", { from, to: id })
  })
}

export async function setActiveId(id: string): Promise<void> {
  const file = await loadAccounts()
  const account = file.accounts.find((item) => item.id === id)
  if (!account) {
    log.warn("accounts:set-active-unknown", { id })
    return
  }
  // This writes the ANTHROPIC pointer specifically, so a non-anthropic id would aim it at a
  // record whose token never goes near auth.json's `anthropic` entry. Use setActiveIdOf for
  // any other provider.
  if (providerOf(account) !== "anthropic") {
    log.warn("accounts:set-active-wrong-provider", { id, provider: providerOf(account) })
    return
  }
  const from = file.activeId
  file.activeId = id
  await saveAccounts(file)
  log.info("accounts:set-active", { from, to: id })
}

// Removes an account from claude-accounts.json only. Deliberately does NOT touch
// auth.json: ex-machina owns that file, and the active account would just be
// re-captured by autoCapture anyway — callers must block deleting the active one.
export async function removeAccount(id: string): Promise<StoredAccount | undefined> {
  return withAuthLock(async () => {
    const file = await loadAccounts()
    const index = file.accounts.findIndex((account) => account.id === id)
    if (index < 0) return undefined
    const [removed] = file.accounts.splice(index, 1)
    // Clear EVERY pointer naming this id rather than only the one matching providerOf(removed):
    // a mis-tagged record would otherwise leave the other pointer dangling at a deleted account.
    for (const provider of PROVIDER_IDS) {
      if (activeIdOf(file, provider) === id) setActiveIdOf(file, provider, undefined)
    }
    await saveAccounts(file)
    log.info("accounts:remove", { id, label: removed.label })
    return removed
  })
}

export async function setAccountExcluded(id: string, excluded: boolean): Promise<StoredAccount | undefined> {
  return withAuthLock(async () => {
    const file = await loadAccounts()
    const account = file.accounts.find((item) => item.id === id)
    if (!account) {
      log.warn("accounts:set-excluded-unknown", { id })
      return undefined
    }
    if (excluded) account.excluded = true
    else delete account.excluded
    await saveAccounts(file)
    log.info("accounts:set-excluded", { id, excluded })
    return account
  })
}
