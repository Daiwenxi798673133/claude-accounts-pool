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

// senpi's own ceiling, not ours: its envSlots() walks suffixes 2..16 and stops, so a seventeenth
// variable is read by nobody. Asking for more slots than this would silently hold leases that can
// never be selected — accounts booked out of the pool for nothing.
export const SENPI_MAX_ENV_SLOTS = 16

// The slot name senpi synthesises alongside each variable (`env`, `env-2`, … `env-16`). Both halves
// come from one place because they must agree: the roster keys its claims by slot name while the
// writer publishes by variable name, and a mismatch would let one account be claimed under a slot
// whose token lives somewhere else.
// Clamped rather than refused. An operator who typed a bigger number than senpi can read gets the
// largest workable count instead of a worker that silently declines to start, and the ceiling matters
// because slots past it would hold leases nothing ever selects — accounts booked out of the pool for
// no one.
export function parseSlotCount(raw: string | undefined): number {
  if (raw === undefined) return 1
  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed < 1) return 1
  return Math.min(parsed, SENPI_MAX_ENV_SLOTS)
}

export function senpiEnvSlot(index: number): { slotName: string; varName: string } {
  if (!Number.isInteger(index) || index < 0 || index >= SENPI_MAX_ENV_SLOTS) {
    throw new Error(`senpi env slot index out of range: ${index}`)
  }
  return index === 0
    ? { slotName: "env", varName: SENPI_OAUTH_TOKEN_VAR }
    : { slotName: `env-${index + 1}`, varName: `${SENPI_OAUTH_TOKEN_VAR}_${index + 1}` }
}

export type EnvSlotDeps = {
  // Injected, never defaulted to the global: a slot built against the real process.env in a test
  // would leak a token into the runner's own environment and into every later test file.
  env: NodeJS.ProcessEnv
  varName?: string
}

export type EnvSlot = {
  readAuth: () => Promise<{ access?: string; expires?: number } | undefined>
  writeLease: (input: { access: string; expires: number; accountId: string }) => Promise<void>
  // The drift check below catches a token somebody REPLACED. It cannot catch one Anthropic REVOKED:
  // that leaves the string byte-identical and the remembered expiry in the future, so the slot reports
  // itself healthy and renewalDue() parks the keeper on a credential every request 401s on. senpi's
  // auth_error block is the only local evidence, and this is how the path that reads it forces a lease.
  //
  // LEAVES THE VARIABLE IN PLACE, DELIBERATELY: senpi only synthesises an env slot while the variable
  // is present, so clearing it drops the slot out of the candidate table — "No API key found" on a
  // worker with no login account. A revoked token costs one 401; an absent one costs the turn.
  //
  // HANDS BACK THE ACCESS IT FORGOT (undefined when there was nothing to forget) so the caller can
  // remember which string is dead. It has to: the shared lease cache holds that same byte-identical
  // token, and a caller that adopts from the cache would otherwise republish the credential it just
  // invalidated.
  invalidate: () => string | undefined
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
    invalidate: () => {
      if (written === undefined) return undefined
      const dropped = written.access
      log.info("senpi:env-slot-invalidated", { accountId: written.accountId, expires: written.expires })
      written = undefined
      return dropped
    },
  }
}
