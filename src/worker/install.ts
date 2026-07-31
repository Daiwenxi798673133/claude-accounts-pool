// COMPOSITION ROOT for cloud-worker mode. Every collaborator under src/worker/ is
// dependency-injected; this is the ONE file that resolves those dependencies against the real world
// — the real `fetch`, api.ui.toast, and auth.json's `anthropic` entry.
//
// THE INVARIANT THAT SHAPES EVERY LINE BELOW: a worker holds NO real refresh token. The master owns
// every chain and is the sole refresher, so this machine must never run a path that could POST
// Anthropic's token endpoint with an anthropic credential. That is why anthropic maintenance is
// switched off in the local keeper and why every credential write here is a `{kind:"lease"}`.
// OpenAI is untouched by all of this: those chains genuinely belong to this machine.

import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { writeAuthAnthropic, readAuthAnthropic } from "../accounts.ts"
import { installAutoSwitch } from "../autoswitch.ts"
import { installTokenKeeper } from "../keeper.ts"
import { log } from "../logger.ts"
import type { ModeConfig } from "../mode.ts"
import { createLeaseClient } from "./leaseClient.ts"
import { installLeaseKeeper } from "./leaseKeeper.ts"
import { createSwitchStrategy } from "./switchStrategy.ts"

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// The SOLE credential-write seam on a worker, shared by the renewal loop and the rate-limit switch
// so there is exactly one shape a worker can produce. `{kind:"lease"}` carries access + expiry and
// fills the refresh slot with the sentinel; `{kind:"full"}` is structurally unreachable from here
// because neither caller's dep type has a refresh field to pass.
function writeLease(input: { access: string; expires: number }): Promise<void> {
  return writeAuthAnthropic({ kind: "lease", access: input.access, expires: input.expires })
}

export function installCloudWorker(
  api: TuiPluginApi,
  cfg: Extract<ModeConfig, { mode: "cloud-worker" }>,
): { dispose: () => void } {
  const client = createLeaseClient({
    // The real global fetch: this is the composition root, and the master lives on the internal
    // network. Every test injects its own transport.
    fetchImpl: fetch,
    sleep,
    masterUrl: cfg.masterUrl,
    poolKey: cfg.poolKey,
    workerId: cfg.workerId,
  })

  // Rate-limit recovery: this worker DETECTS the limit and RESUMES the turn, the master DECIDES
  // which account comes next. Handing installAutoSwitch a strategy is what swaps its local
  // pick-and-switch for that split (INV-CLOUD-2) — the local selection code is never reached.
  const strategy = createSwitchStrategy({ client, writeLease, toast: api.ui.toast })

  const autoSwitch = installAutoSwitch(api, strategy)
  api.lifecycle.onDispose(autoSwitch.dispose)

  // anthropicMaintenance OFF: this keeper stays installed purely for its OpenAI half (codex slot
  // capture and keep-alive), which this machine really does own. With the flag false it performs no
  // anthropic refresh and no anthropic capture — the two things that would make this box a second
  // refresher of the master's one-time-use chains.
  const keeper = installTokenKeeper(autoSwitch.isSessionRunning, { anthropicMaintenance: false })
  api.lifecycle.onDispose(keeper.dispose)

  const leaseKeeper = installLeaseKeeper({
    client,
    readAuth: readAuthAnthropic,
    writeLease,
    toast: api.ui.toast,
    sleep,
  })
  api.lifecycle.onDispose(leaseKeeper.dispose)

  // THE STARTUP LEASE, which installLeaseKeeper deliberately leaves to its caller. Without it a
  // freshly-started worker holds whatever auth.json happened to contain until the first check
  // interval elapses — and if that entry is expired, the local auth provider refreshes it on the
  // very next request, which is the second-refresher failure this mode exists to prevent.
  // Fire-and-forget with a catch: writeLease touches a real file and can genuinely reject, and an
  // unhandled rejection here would surface as a crash in the plugin host.
  void leaseKeeper
    .tickOnce()
    .catch((error: unknown) => log.warn("worker:startup-lease-fail", { error: error instanceof Error ? error.message : String(error) }))

  // NO autoCapture() here, unlike the local bootstrap. Capture archives auth.json's tip into the
  // account library, and a worker's tip is a lease whose refresh slot holds the sentinel — absorbing
  // it would file a non-token as a chain and brand a healthy account needs-reauth forever.

  // FOLLOW-UP: request-level interception requires a server-plugin entry point — out of MVP scope (A3)

  let disposed = false
  // Mirrors the master's aggregate: the per-piece lifecycle registrations above are the FLOOR, this
  // is the caller's explicit lever, and the flag keeps firing both a no-op rather than a double free.
  const dispose = (): void => {
    if (disposed) return
    disposed = true
    leaseKeeper.dispose()
    keeper.dispose()
    autoSwitch.dispose()
  }

  log.info("worker:installed", { masterUrl: cfg.masterUrl, workerId: cfg.workerId })
  return { dispose }
}
