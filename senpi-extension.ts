// SENPI extension entry — the cloud-worker lease loop for the senpi harness.
//
// Companion to tui.tsx (the opencode plugin entry). Same master, same lease protocol, same
// installLeaseKeeper: the ONLY thing that differs is where a leased access token lands. opencode
// reads it from auth.json; senpi reads it from CLAUDE_CODE_OAUTH_TOKEN in its own environment. See
// src/senpi/envSlot.ts for why that difference is load-bearing rather than cosmetic.
//
// SCOPE: cloud-worker, anthropic only. Local mode has no lease to keep and a master runs no senpi.
//
// Install (per senpi's extension discovery):
//   senpi -e /path/to/claude-accounts-pool/senpi-extension.ts
//   # or drop a built copy into <agentDir>/extensions/
//
// The worker MUST also be started with these, or the pool's bookkeeping is fiction:
//   SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION=oauth-slots   # pin the lane; never fall to ambient
//   SENPI_NO_FALLBACK=1                                  # see the note on silent reroute below
//
// WHY SENPI_NO_FALLBACK IS NOT OPTIONAL. senpi expands a bare model selector across providers in
// PROVIDER_PRECEDENCE = ["claude-sdk-oauth", "anthropic", "kimi-coding"]. With fallback on, a
// rejected lease does not surface as an error — the turn silently completes on a DIFFERENT provider
// and a different credential. Measured: injecting two invalid tokens still produced a normal answer.
// For an accounting system that is worse than an outage, because the numbers keep looking fine.
import { createEnvSlot } from "./src/senpi/envSlot.ts"
import { log } from "./src/logger.ts"
import { createLeaseClient } from "./src/worker/leaseClient.ts"
import { installLeaseKeeper } from "./src/worker/leaseKeeper.ts"

/** Master endpoint, e.g. `http://10.0.0.5:8787`. Absent = this box is not a cloud worker. */
const MASTER_URL_VAR = "CAP_MASTER_URL"
/** This machine's stable identity in the master's lease book. Absent = not a cloud worker. */
const WORKER_ID_VAR = "CAP_WORKER_ID"

// Only the two verbs this entry uses, declared structurally rather than imported: senpi is not a
// dependency of this package, and taking one on to name a single event would tie the plugin's
// install to a senpi version for no gain.
type SenpiExtensionApi = {
  on: (event: "turn_start", handler: () => void) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// PROCESS-WIDE, NOT MODULE-WIDE. senpi loads extensions through jiti with `moduleCache: false` and
// calls the factory once per session, so module-level state is re-created on `/reload` and per cwd —
// a module-level guard would leak a keeper (and its interval) on every reload. A registry symbol
// survives both, because it hangs off the realm rather than the module.
const KEEPER_KEY = Symbol.for("claude-accounts-pool/senpi-lease-keeper")

type Installed = { tickOnce: () => Promise<void> }

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function install(masterUrl: string, workerId: string): Installed {
  const client = createLeaseClient({
    // The real global fetch: this is the composition root for the senpi lane, and the master lives
    // on the internal network. Tests inject their own transport.
    fetchImpl: fetch,
    sleep,
    masterUrl,
    workerId,
  })

  const slot = createEnvSlot({ env: process.env })

  const keeper = installLeaseKeeper({
    // The RAW client, unlike src/worker/install.ts which wraps it in createPinnedLease. Pins are
    // stored in opencode's TuiKV and surfaced through its /usage panel, neither of which exists
    // here; senpi carries its own `pinnedAccount` setting instead.
    // ponytail: unpinned leases only. Wire pins in when the senpi panel can express one.
    client,
    readAuth: slot.readAuth,
    writeLease: slot.writeLease,
    // ponytail: log-only. The keeper's fail-safe message is user-facing in opencode
    // (api.ui.toast); senpi's equivalent surface is not wired yet, so a stranded worker is
    // visible in the log bundle but not on screen. Upgrade path: pass pi.ui.notify once the
    // structural type above is widened to include it.
    toast: ({ variant, message }) => {
      if (variant === "error") log.error("senpi:lease-toast", { message })
      else log.warn("senpi:lease-toast", { message })
    },
    sleep,
  })

  // THE STARTUP LEASE, which installLeaseKeeper deliberately leaves to its caller. Nothing is
  // adopted first, unlike the opencode worker: that path inherits a previous process's auth.json
  // and must name the account it already holds, whereas an environment starts every process empty.
  void keeper.tickOnce().catch((error: unknown) => log.warn("senpi:startup-lease-fail", { error: errorMessage(error) }))

  log.info("senpi:lease-keeper-installed", { workerId })
  return { tickOnce: keeper.tickOnce }
}

export default function claudeAccountsPoolSenpiExtension(pi: SenpiExtensionApi): void {
  const masterUrl = process.env[MASTER_URL_VAR]
  const workerId = process.env[WORKER_ID_VAR]
  // Silent, not a warning: this same file is a no-op on a developer's laptop and on the master
  // itself, and an extension that complained on every unrelated senpi start would be uninstalled.
  if (!masterUrl || !workerId) return

  const registry = globalThis as Record<PropertyKey, unknown>
  const existing = registry[KEEPER_KEY] as Installed | undefined
  const installed = existing ?? install(masterUrl, workerId)
  registry[KEEPER_KEY] = installed

  // PULL, on top of the keeper's own interval. The interval is the correctness floor; this is the
  // latency cut that matters, because a turn is the exact moment senpi is about to spawn a
  // subprocess and read the variable. tickOnce() is a no-op when the lease is not yet due, and it
  // re-entrancy-guards itself, so firing it per turn costs nothing when nothing is needed.
  //
  // `pi` IS NOT CAPTURED. senpi invalidates a captured extension ctx after a session replacement or
  // /reload and then throws from every method on it — so anything that outlives this call (the
  // keeper, its interval) must never hold one. Renewal needs only the environment and the master.
  pi.on("turn_start", () => {
    void installed.tickOnce().catch((error: unknown) => log.warn("senpi:turn-lease-fail", { error: errorMessage(error) }))
  })
}
