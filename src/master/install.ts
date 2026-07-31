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
import { applyToken, loadAccounts, readAuthAnthropic, saveAccounts, withAuthLock, type StoredAccount } from "../accounts.ts"
import { log } from "../logger.ts"
import type { ModeConfig } from "../mode.ts"
import { autoCapture, fetchUsage } from "../usage.ts"
import { installMasterKeeper, makeOnboardingCapture } from "./keeper.ts"
import { startLeaseServer } from "./leaseServer.ts"
import { createRefresher, type MasterToken } from "./refresher.ts"
import { createRegistry } from "./registry.ts"
import { createScheduler } from "./scheduler.ts"
import { installUsagePoller } from "./usagePoller.ts"

// Command-value namespace, matching tui.tsx's local `ID`. Restated rather than imported: tui.tsx
// is the plugin ENTRY and importing it from here would make the composition root depend on its own
// caller — and on the whole Solid dialog graph that entry pulls in.
const ID = "claude-accounts-usage"

// A pool key is displayed exactly ONCE and is unrecoverable afterwards (the registry stores only a
// SHA-256 digest), so the toast carrying it must outlive a glance. Every other toast in this plugin
// takes the default duration; this one cannot.
const POOL_KEY_TOAST_MS = 120_000

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

async function roster(): Promise<StoredAccount[]> {
  return (await loadAccounts()).accounts
}

export function installCloudMaster(
  api: TuiPluginApi,
  cfg: Extract<ModeConfig, { mode: "cloud-master" }>,
): { dispose: () => void } {
  // Both keyed stores live in api.kv (tui.json), so pool-key digests and cooldown deadlines both
  // survive a restart — a master that forgot its cooldowns would re-lease accounts that are still
  // spent, and one that forgot its digests would lock out every worker.
  const registry = createRegistry({ kv: api.kv })
  const scheduler = createScheduler({ kv: api.kv })

  const refresher = createRefresher({
    // The real global fetch: this is the composition root, the one place a live POST to Anthropic's
    // token endpoint is the CORRECT thing to wire. Every test injects its own.
    fetchImpl: fetch,
    loadAccount: async (accountId) => (await roster()).find((account) => account.id === accountId),
    persist: persistToken,
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

  // Started LAST of the four, so the port only opens once everything a lease answer depends on is
  // live: a worker that reached a half-composed master would be handed a 500 it retries forever.
  const server = startLeaseServer({
    scheduler,
    refresher,
    registry,
    loadAccounts: roster,
    hostname: cfg.hostname,
    port: cfg.port,
    // The plugin's own abort signal, so the port dies with the plugin rather than outliving it as
    // an unsupervised credential dispenser.
    signal: api.lifecycle.signal,
  })

  let unregisterCommand: (() => void) | undefined
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

  const command = api.command
  if (!command) {
    // Same refusal tui.tsx makes, and it stops HERE rather than aborting the install: a master
    // whose palette cannot mint new keys still serves every worker already holding one, so tearing
    // the pool down over a missing UI surface would be the worse outcome.
    log.error("master:no-command-api")
    api.ui.toast({ variant: "error", message: "当前 OpenCode 不支持命令注册 API,请更新 OpenCode" })
    return { dispose }
  }

  unregisterCommand = command.register(() => [
    {
      title: "Claude: 注册云端 worker(生成 pool key)",
      value: `${ID}.reg`,
      category: "Claude",
      slash: { name: "reg" },
      onSelect: () => {
        const worker = registry.register()
        // PRIVACY: `worker.poolKey` is a live bearer credential for this pool and reaches ONLY this
        // toast — never a log line, never a file we write. registry.register already logged the
        // workerId, which is the entire diagnostic value; the key is deliberately unrecoverable
        // from anywhere on disk, so a log here would be the only copy an attacker needs.
        api.ui.toast({
          variant: "success",
          message: `已注册 worker「${worker.workerId}」。pool key 仅显示这一次,请立即复制到该机器的 tui.json:${worker.poolKey}`,
          duration: POOL_KEY_TOAST_MS,
        })
      },
    },
  ])

  log.info("master:installed", { hostname: cfg.hostname, port: server.port, workers: registry.list().length })
  return { dispose }
}
