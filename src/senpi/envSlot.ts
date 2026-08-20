// The credential seam that lets installLeaseKeeper drive SENPI: the `readAuth` / `writeLease`
// pair it needs, backed by process.env instead of opencode's auth.json.
//
// WHY THE ENVIRONMENT AND NOT A FILE — this is the entire reason this module exists:
//   * senpi's claude-sdk-oauth provider discovers accounts by reading CLAUDE_CODE_OAUTH_TOKEN*
//     out of its OWN environment and synthesises a slot tagged `source: "env"`.
//   * Its prepareSlot() refreshes a slot only `if (slot.source !== "env" && ...)`, so an
//     env-sourced slot is the one credential shape senpi promises never to refresh itself.
//   * A file-backed slot would instead land in that provider's `accounts[]` as `source: "import"`,
//     which senpi DOES refresh 5 minutes before expiry. That makes this box a SECOND refresher of
//     a chain the master owns — and Anthropic revokes the previously issued access token on every
//     successful refresh (INV-CLOUD-4), so one senpi process would knock every other holder of
//     that account offline. The same failure src/worker/leaseKeeper.ts exists to prevent, arriving
//     through a different door.
//
// A MUTATION HERE IS SEEN WITHOUT A RESTART. senpi reads the environment through a live reference
// (`() => process.env`) inside managedPool(), which runs at the top of every query. There is no
// file to invalidate and no cache to bust.
//
// THE EXPIRY CANNOT LIVE IN THE ENVIRONMENT. senpi synthesises env slots with `expires: 0` and
// never consults an expiry for them, so there is nowhere to put it and nothing that would read it.
// It is held in this closure instead — which is also why readAuth cross-checks the variable it
// last wrote before trusting the expiry it remembers.
//
// This module names no Anthropic endpoint and performs no I/O beyond the environment object it was
// handed: it CANNOT refresh, by construction rather than by discipline.
import { log } from "../logger.ts"

/** The variable senpi's `envSlots()` reads for its first (unnumbered) env account slot. */
export const SENPI_OAUTH_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN"

export type EnvSlotDeps = {
  // Injected, never defaulted to the global: a slot built against the real process.env in a test
  // would leak a token into the runner's own environment and into every later test file.
  env: NodeJS.ProcessEnv
  varName?: string
}

export type EnvSlot = {
  readAuth: () => Promise<{ access?: string; expires?: number } | undefined>
  writeLease: (input: { access: string; expires: number; accountId: string }) => Promise<void>
}

export function createEnvSlot(deps: EnvSlotDeps): EnvSlot {
  const varName = deps.varName ?? SENPI_OAUTH_TOKEN_VAR
  // The lease this slot last published, or undefined before the first one lands. Holds the access
  // token too — not to hand back out, but to detect the drift described below.
  let written: { access: string; expires: number; accountId: string } | undefined

  return {
    // FAIL CLOSED ON DRIFT. The expiry lives here while the token lives in the environment, so the
    // two can genuinely disagree: a `/login` inside senpi, another extension, or an exported shell
    // variable can replace or clear it under us. Reporting the remembered expiry for a token we no
    // longer own would let the keeper sit out a whole renewal window on behalf of a credential it
    // cannot see. A mismatch therefore reads as "no credential at all", which is the one answer
    // that makes renewalDue() lease again immediately.
    readAuth: () => {
      if (written === undefined) return Promise.resolve(undefined)
      if (deps.env[varName] !== written.access) {
        log.warn("senpi:env-slot-drift", { accountId: written.accountId, present: deps.env[varName] !== undefined })
        return Promise.resolve(undefined)
      }
      return Promise.resolve({ access: written.access, expires: written.expires })
    },
    writeLease: (input) => {
      deps.env[varName] = input.access
      written = { access: input.access, expires: input.expires, accountId: input.accountId }
      // accountId and expiry only. `input.access` is a live credential and is never logged.
      log.info("senpi:env-slot-written", { accountId: input.accountId, expires: input.expires })
      return Promise.resolve()
    },
  }
}
