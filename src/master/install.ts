// COMPOSITION ROOT for cloud-master mode. Every collaborator under src/master/ is
// dependency-injected and knows nothing about opencode; this is the ONE file that resolves those
// dependencies against the real world — api.kv, the real `fetch`, the on-disk account library —
// and therefore the one file that decides what a master actually is.
//
// A master RUNS NO INFERENCE. It never installs installAutoSwitch and never installs the local
// token keeper: it holds every account's real OAuth refresh token and is the SOLE refresher, so a
// second local refresh path here would race its own lease server over a one-time-use chain — the
// exact invalid_grant strand the whole architecture exists to prevent.

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
// DEEP IMPORT, and knowingly so. ex-machina's package entry exports only its opencode Plugin object,
// while `authorize` / `exchange` — the PKCE half this repo has always delegated rather than owned —
// live in this submodule. There is no `exports` map in that package, so the path resolves and ships
// its own .d.ts; the version is pinned EXACTLY in package.json because a private path carries no
// compatibility promise. It is also bundled at build time (scripts/build.ts inlines everything not
// listed as external), so a published consumer never resolves this path at runtime.
import { authorize, exchange } from "@ex-machina/opencode-anthropic-auth/dist/auth.js"
import {
  applyToken,
  backupRemovedAccount,
  loadAccounts,
  readAuthAnthropic,
  removeAccount,
  saveAccounts,
  upsertAccount,
  withAuthLock,
  type AuthToken,
  type StoredAccount,
} from "../accounts.ts"
import { logBundleCommand } from "../logbundle.ts"
import { log } from "../logger.ts"
import type { ModeConfig } from "../mode.ts"
import { fetchProfile } from "../profile.ts"
import { autoCapture, fetchUsage } from "../usage.ts"
import { createAccountOnboard, type OnboardProfile } from "./accountOnboard.ts"
import { createAccountRemove } from "./accountRemove.ts"
import { installMasterKeeper, makeOnboardingCapture } from "./keeper.ts"
import { startLeaseServer } from "./leaseServer.ts"
import { createRefresher, type MasterToken, type RefreshRevokedOutcome } from "./refresher.ts"
import { createScheduler } from "./scheduler.ts"
import { installUsagePoller } from "./usagePoller.ts"
import { createWorkerRegistry } from "./workerRegistry.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// The ONE persist path behind the refresher, and it holds the cross-process auth lock for the whole
// read-modify-write: the rotated tip is the only usable one from the instant the POST succeeds, so a
// concurrent writer landing between the load and the save would drop it and strand the account.
// A record that vanished mid-flight (deleted through /usage) is skipped, never re-created — the
// operator's deletion wins over a refresh that was already in the air.
async function persistToken(accountId: string, token: MasterToken): Promise<void> {
  await withAuthLock(async () => {
    const file = await loadAccounts()
    const record = file.accounts.find((account) => account.id === accountId)
    if (!record) {
      log.warn("master:persist-unknown-account", { accountId })
      return
    }
    // Through applyToken, never a spread-merge: it is the single writer that clears needsReauth
    // atomically with the token, so a re-logged-in account is not left permanently skipped.
    applyToken(record, { kind: "full", token })
    await saveAccounts(file)
  })
}

// What happens to an account whose refresh POST came back `invalid_grant`, and the ONLY writer of
// `needsReauth` on this master. Under the same lock as persistToken, because both are
// read-modify-writes of the same record.
//
// THE ADOPT BRANCH IS NOT AN OPTIMISATION. This master is supposed to be the sole refresher, but the
// one failure it cannot rule out is that it is NOT — a stale login on another box, a second master.
// In that case our POST merely lost the rotation race and the account is perfectly healthy, so
// branding it needs-reauth would take a live account out of the pool on the strength of someone
// else's success. A record already flagged is never adopted: that would erase another writer's
// verdict on a chain that really is dead.
async function onRefreshRevoked(accountId: string, deadRefresh: string): Promise<RefreshRevokedOutcome> {
  return withAuthLock(async () => {
    const file = await loadAccounts()
    const record = file.accounts.find((account) => account.id === accountId)
    if (!record) {
      log.warn("master:revoked-unknown-account", { accountId })
      return {}
    }
    if (record.needsReauth) return {}
    if (record.refresh !== deadRefresh) {
      log.info("master:adopt-foreign-rotation", { accountId, label: record.label })
      return { adopted: { access: record.access, expires: record.expires } }
    }
    record.needsReauth = true
    await saveAccounts(file)
    log.warn("master:account-needs-reauth", { accountId, label: record.label })
    return {}
  })
}

async function roster(): Promise<StoredAccount[]> {
  return (await loadAccounts()).accounts
}

// The web onboarding flow's write step. Goes STRAIGHT into the account library rather than via
// auth.json, and that is the correct half of a real fork:
//
//   • Writing auth.json instead would mean waiting for the master keeper's next capture tick to
//     absorb it — up to KEEPALIVE_TICK_MS — so the dialog would have to either lie ("已加入池中")
//     or make the operator watch a spinner for five minutes. It would also put this process in the
//     business of writing the file ex-machina owns, for a chain ex-machina never asked for.
//   • The rotation hazard that makes auth.json untouchable elsewhere (INV-2) does not apply to this
//     chain: it was just minted by OUR authorization_code exchange, nobody else has ever held it, so
//     there is no other refresher to race. Contrast makeOnboardingCapture, which absorbs a chain
//     ex-machina minted and must therefore never refresh it.
//
// `existing` is read INSIDE the lock and before the write, because upsertAccount's own return value
// cannot answer it — it reports the file after the insert, by which point every id is present.
async function absorbOnboarded(input: { profile: OnboardProfile; token: AuthToken }): Promise<{ existing: boolean }> {
  return withAuthLock(async () => {
    const before = await loadAccounts()
    const existing = before.accounts.some((account) => account.id === input.profile.uuid)
    // Not nested in a second withAuthLock: upsertAccount deliberately takes no lock of its own (its
    // callers own the critical section), and the lock here is NOT reentrant.
    await upsertAccount(input.profile.uuid, input.profile.email, input.token, input.profile.subscription)
    return { existing }
  })
}

export function installCloudMaster(
  api: TuiPluginApi,
  cfg: Extract<ModeConfig, { mode: "cloud-master" }>,
): { dispose: () => void } {
  // Cooldown deadlines live in api.kv so they survive a restart: a master that forgot its cooldowns
  // would re-lease accounts that are still spent.
  const scheduler = createScheduler({ kv: api.kv })

  // Same store as the cooldown book, for the same reason: a master that forgot which workers had
  // been registered would report every machine in the pool as unknown after a restart — an alarm
  // nobody can act on, instead of the one this book exists to raise.
  const workerRegistry = createWorkerRegistry({ kv: api.kv })

  const refresher = createRefresher({
    // The real global fetch: this is the composition root, the one place a live POST to Anthropic's
    // token endpoint is the CORRECT thing to wire. Every test injects its own.
    fetchImpl: fetch,
    loadAccount: async (accountId) => (await roster()).find((account) => account.id === accountId),
    persist: persistToken,
    onRefreshRevoked,
  })

  const usagePoller = installUsagePoller({
    loadAccounts: roster,
    // Routed through the refresher rather than reading `account.access` directly: a stale access
    // token would answer 401 and cost that account its snapshot entry, which the scheduler reads as
    // "utilization unknown" — the poller would then be blind to exactly the accounts it just failed
    // on. Going through the refresher also keeps the single-flight guarantee intact.
    fetchUsageFor: async (account) => fetchUsage((await refresher.getFreshAccess(account.id)).access),
    scheduler,
    sleep,
  })

  const keeper = installMasterKeeper({
    refresher,
    loadAccounts: roster,
    // ONBOARDING: an admin runs the ex-machina login on this box, and the capture absorbs that real
    // credential into the pool. autoCapture is the account library's own identify-by-profile-uuid
    // path, so a rotation updates in place and a genuinely new login is added.
    capture: makeOnboardingCapture({ readAuthTip: readAuthAnthropic, absorb: autoCapture }),
    sleep,
  })

  const accountOnboard = createAccountOnboard({
    // 'max' — the Claude Pro/Max subscription flow. NEVER 'console': that mode's chain authorizes an
    // API-key workspace, not the subscription whose 5h/7d windows this pool schedules against.
    authorize: () => authorize("max"),
    exchange,
    fetchProfile,
    absorb: absorbOnboarded,
    newId: () => crypto.randomUUID(),
    now: Date.now,
  })

  // The dashboard's 删除账号 flow, wired against the account library's OWN removal path rather than a
  // second load/modify/save: removeAccount already holds the cross-process auth lock for the whole
  // read-modify-write and already clears every active pointer naming the id, and a copy of that
  // here would be a copy that drifts. It also means the backup runs OUTSIDE that lock — the record
  // was read a moment earlier and is passed by value, so the copy on disk is the record as it stood
  // when the operator confirmed it, which is exactly the one they are asking to be able to restore.
  const accountRemove = createAccountRemove({
    loadAccounts: roster,
    backup: async (account) => {
      await backupRemovedAccount(account)
    },
    remove: removeAccount,
  })

  // Started LAST of the four, so the port only opens once everything a lease answer depends on is
  // live: a worker that reached a half-composed master would be handed a 500 it retries forever.
  const server = startLeaseServer({
    scheduler,
    workerRegistry,
    refresher,
    loadAccounts: roster,
    accountOnboard,
    accountRemove,
    // The dashboard's refresh button reuses the poller's OWN sweep rather than fetching usage itself,
    // so a forced refresh inherits every protection the scheduled path already has: the re-entrancy
    // guard, the 500ms spacing between accounts, and the per-account 429 cooldown.
    refreshUsage: usagePoller.tickOnce,
    hostname: cfg.hostname,
    port: cfg.port,
    // The plugin's own abort signal, so the port dies with the plugin rather than outliving it as
    // an unsupervised credential dispenser.
    signal: api.lifecycle.signal,
  })

  // THE ONE COMMAND A MASTER REGISTERS, and the exception is narrow on purpose: /update-log mints
  // nothing and reads nothing but this machine's own log file, so it does not touch the reason a
  // master has no /usage and no /stats (it runs no inference and holds no single active account).
  // It has to be here because master-side lease and refresh failures are the ones a worker's log
  // cannot explain — see docs/internals.md's note that selection is only visible on the master.
  let unregisterCommand: (() => void) | undefined
  const command = api.command
  if (command) unregisterCommand = command.register(() => [logBundleCommand(api, "cloud-master")])
  // Not fatal, exactly as on a worker: a master with no command surface still serves every lease.
  else log.warn("master:no-command-api")

  let disposed = false

  // TWO PATHS TO THE SAME TEARDOWN, deliberately. The per-piece lifecycle registrations below are
  // the FLOOR — a plugin teardown must kill this port even if the caller drops the handle we
  // return — while this aggregate is the caller's explicit lever. Every piece is idempotent and the
  // flag makes the aggregate so, therefore firing both is a no-op, not a double free.
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    unregisterCommand?.()
    usagePoller.dispose()
    keeper.dispose()
    server.stop()
  }

  api.lifecycle.onDispose(server.stop)
  api.lifecycle.onDispose(keeper.dispose)
  api.lifecycle.onDispose(usagePoller.dispose)

  // A master registers no ACCOUNT commands: it runs no inference, so it has no /usage and no
  // /stats, and there is no longer a credential for a palette entry to mint. Everything an operator
  // needs is on the web dashboard this server already serves — the one palette entry above is
  // /update-log, which only reads this machine's log file.
  log.info("master:installed", { hostname: cfg.hostname, port: server.port })
  return { dispose }
}
