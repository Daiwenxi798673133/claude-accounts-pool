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
// Start the worker with both of these:
//   SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION=oauth-slots
//   SENPI_NO_FALLBACK=1
//
// AN INVALID LEASE IS REPORTED AS A SUCCESSFUL TURN, AND THAT IS UPSTREAM OF THIS FILE.
// Traced on senpi 2026.8.19 by instrumenting its own prepareSlot(): the lane resolves to
// `oauth-slots`, the slot selected is ours (`{slot:"env",source:"env"}`), and the invalid token IS
// handed to the child. The Agent SDK then rejects it — isolated against
// @anthropic-ai/claude-agent-sdk directly, an invalid CLAUDE_CODE_OAUTH_TOKEN throws
// `401 OAuth access token is invalid`. But it delivers that failure as a `result` message carrying
// `subtype: "success"` with `is_error: true`, and senpi's classifier only treats a result as a
// failure when `subtype !== "success"` — so an auth failure is scored as a completed turn: no error,
// no failover, no account block.
//
// CONSEQUENCE FOR THE POOL: a dead lease does not take the account out of rotation, and the turn is
// reported against an account that never served it. Attribution on this lane is therefore only as
// trustworthy as the leases themselves until senpi's classifier learns about `is_error`.
// The race that this file DID own — a turn starting before the first lease landed — is fixed in the
// turn_start handler below.
import { createEnvSlot } from "./src/senpi/envSlot.ts"
import { createLeaseJoiner } from "./src/senpi/leaseJoiner.ts"
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
  // The handler's promise MATTERS: senpi's runner awaits it (`await handler(event, ctx)`), which is
  // the only thing that lets a turn wait for a lease instead of racing it.
  on: (event: "turn_start", handler: () => Promise<void>) => void
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// PROCESS-WIDE, NOT MODULE-WIDE. senpi loads extensions through jiti with `moduleCache: false` and
// calls the factory once per session, so module-level state is re-created on `/reload` and per cwd —
// a module-level guard would leak a keeper (and its interval) on every reload. A registry symbol
// survives both, because it hangs off the realm rather than the module.
const KEEPER_KEY = Symbol.for("claude-accounts-pool/senpi-lease-keeper")

type Installed = { ensureLeased: () => Promise<void> }

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

  const ensureLeased = createLeaseJoiner(keeper.tickOnce)

  // THE STARTUP LEASE, which installLeaseKeeper deliberately leaves to its caller. Nothing is
  // adopted first, unlike the opencode worker: that path inherits a previous process's auth.json
  // and must name the account it already holds, whereas an environment starts every process empty.
  // Registered through ensureLeased so the first turn JOINS this lease instead of skipping past it.
  void ensureLeased().catch((error: unknown) => log.warn("senpi:startup-lease-fail", { error: errorMessage(error) }))

  log.info("senpi:lease-keeper-installed", { workerId })
  return { ensureLeased }
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

  // AWAITED, NOT FIRE-AND-FORGET — this is the whole reason the lane works. managedPool() reads
  // CLAUDE_CODE_OAUTH_TOKEN at the top of every query and, finding none, returns undefined; the
  // provider then takes its `ambient` branch, which passes the parent environment straight through
  // and lets the spawned `claude` fall back to whatever credential the machine itself holds. The
  // turn succeeds, reports `provider: "claude-sdk-oauth"`, raises no error — and was charged to an
  // account the pool never leased. Returning this promise is what makes the turn wait for the token
  // instead of overtaking it. `SENPI_CLAUDE_SDK_OAUTH_TOKEN_INJECTION=oauth-slots` cannot cover for
  // it: the ambient fallback is gated on `accounts.length === 0`, not on the configured lane.
  //
  // `pi` IS NOT CAPTURED. senpi invalidates a captured extension ctx after a session replacement or
  // /reload and then throws from every method on it — so anything that outlives this call (the
  // keeper, its interval) must never hold one. Renewal needs only the environment and the master.
  //
  // The catch is deliberate and its consequence is the residual hazard: a turn is never failed on
  // this extension's behalf, because no supported hook can abort one. A worker that cannot lease
  // therefore still runs — on ambient credentials — and only the log says so.
  pi.on("turn_start", () =>
    installed
      .ensureLeased()
      .catch((error: unknown) => log.error("senpi:turn-lease-fail", { error: errorMessage(error) })),
  )
}
