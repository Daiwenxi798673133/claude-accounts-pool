import { providerOf, type StoredAccount } from "../accounts.ts"
import { MASTER_USAGE_POLL_INTERVAL_MS } from "../constants.ts"
import { log } from "../logger.ts"
import type { UsageResponse } from "../usage.ts"
import type { UsageSnapshotEntry } from "./scheduler.ts"

// The master's ONLY route to steady-state utilization, and therefore the only reason the scheduler
// can rotate accounts by remaining quota at all.
//
// WHY POLL INSTEAD OF READING RESPONSE HEADERS. Anthropic reports quota in response headers, but a
// TUI plugin cannot observe them on a SUCCESSFUL request — verified: the session event payload
// carries only a message string, and the plugin package's type definitions expose no
// response-header surface. Rate-limit reports (scheduler.reportRateLimit) therefore only ever
// arrive on FAILURE, which tells the pool what is already exhausted and nothing about what is
// nearly full. Polling `/api/oauth/usage` is what closes that gap.

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Spacing between accounts — same value and same reason as the warm loop's MASTER_WARM_SPACING_MS
// (this host has ONE egress IP), but a SEPARATE knob: the usage endpoint and the token endpoint are
// different services, and tuning one must not silently retune the other.
export const USAGE_POLL_SPACING_MS = 500

// `/api/oauth/usage` has known PERSISTENT-429 behaviour: it stays angry well past the request that
// upset it, so a cooldown shorter than the poll interval would just re-provoke it on the very next
// tick. Two whole intervals guarantees at least one full tick is skipped, and it is DERIVED so that
// changing the poll cadence cannot silently turn this back into an immediate retry.
export const USAGE_POLL_429_COOLDOWN_MS = 2 * MASTER_USAGE_POLL_INTERVAL_MS

// src/usage.ts's fetchUsage throws `usage request failed (${res.status})` for every non-ok
// response — a message, not a typed status, and that module is owned by a parallel change set so
// this side cannot widen its error type. Matching the parenthesised status is therefore the only
// available signal; it is anchored on the parens so a bare "429" appearing anywhere in some other
// message cannot false-positive a five-minute exclusion.
const RATE_LIMITED_MESSAGE_RE = /\(429\)/

function isRateLimited(error: unknown): boolean {
  return error instanceof Error && RATE_LIMITED_MESSAGE_RE.test(error.message)
}

export type UsagePollerDeps = {
  loadAccounts: () => Promise<StoredAccount[]>
  // NO DEFAULT. A `= (account) => fetchUsage(account.access)` fallback would let a test that forgot
  // to inject fire real requests at an endpoint whose 429 lasts minutes for every account behind
  // this IP.
  fetchUsageFor: (account: StoredAccount) => Promise<UsageResponse>
  scheduler: { setUsageCache(entries: UsageSnapshotEntry[]): void }
  sleep: (ms: number) => Promise<void>
  now?: () => number
}

export function installUsagePoller(deps: UsagePollerDeps): { dispose: () => void; tickOnce: () => Promise<void> } {
  const now = deps.now ?? Date.now
  // PER-ACCOUNT, not global: one account's 429 says nothing about the others, and cooling the whole
  // roster would blind the scheduler completely.
  const cooldown = new Map<string, number>()
  let disposed = false
  let polling = false

  function isCooling(accountId: string): boolean {
    const until = cooldown.get(accountId)
    if (until === undefined) return false
    // Swept on read rather than by a timer: the map is only ever consulted here, and deleting the
    // lapsed entry keeps it from growing without bound over a long-lived master.
    if (now() >= until) {
      cooldown.delete(accountId)
      return false
    }
    return true
  }

  async function tickOnce(): Promise<void> {
    // Re-entrancy guard: a roster slow enough to outlast one interval would otherwise put two
    // sweeps on the wire at once, which is the burst this endpoint punishes hardest.
    if (disposed || polling) return
    polling = true
    try {
      let accounts: StoredAccount[]
      try {
        // ANTHROPIC-only (INV-M1/INV-P1): `/api/oauth/usage` is Anthropic's and the scheduler's pool
        // is anthropic-only, so a ChatGPT record here would leak its access token to the wrong
        // vendor and produce a snapshot entry nothing can ever pick. Read through providerOf — a
        // hand-rolled `provider === "anthropic"` drops every pre-multi-provider record.
        // Cooled accounts are filtered out HERE, before the loop, so they cost no spacing either.
        accounts = (await deps.loadAccounts()).filter(
          (account) => providerOf(account) === "anthropic" && !isCooling(account.id),
        )
      } catch (error) {
        log.warn("master-usage-poller:load-fail", { error: errorMessage(error) })
        return
      }
      const entries: UsageSnapshotEntry[] = []
      for (let index = 0; index < accounts.length; index++) {
        // Checked every iteration so dispose() takes effect mid-sweep, not at the end of it.
        if (disposed) return
        const account = accounts[index]
        try {
          entries.push({ id: account.id, usage: await deps.fetchUsageFor(account) })
        } catch (error) {
          // A failure contributes NOTHING to the snapshot — deliberately not a zero-utilization
          // entry. The scheduler ranks by LOWEST utilization, so a broken account reported as 0%
          // would look like the emptiest one in the pool and attract every single lease. Omitted,
          // it scores +Infinity instead: the honest unknown, which sorts last.
          if (isRateLimited(error)) {
            cooldown.set(account.id, now() + USAGE_POLL_429_COOLDOWN_MS)
            log.warn("master-usage-poller:cooldown", { accountId: account.id, label: account.label })
          } else {
            log.warn("master-usage-poller:fetch-fail", { accountId: account.id, error: errorMessage(error) })
          }
        }
        // Serial, spaced BETWEEN accounts (nothing trails the last one): one egress IP, and this
        // endpoint answers a burst with a 429 that outlives the burst by minutes.
        if (index < accounts.length - 1) await deps.sleep(USAGE_POLL_SPACING_MS)
      }
      if (disposed) return
      // ONE handover at the END of the sweep, never one per account: a half-swept cache would rank
      // the roster on a mix of fresh and missing entries. An EMPTY snapshot is handed over too and
      // is safe by the scheduler's own design — a cache covering none of the candidates is not
      // treated as data, so selection falls back to round-robin instead of freezing on whichever
      // account sorts first.
      deps.scheduler.setUsageCache(entries)
      log.debug("master-usage-poller:snapshot", { polled: accounts.length, reported: entries.length })
    } finally {
      polling = false
    }
  }

  const interval = setInterval(() => void tickOnce(), MASTER_USAGE_POLL_INTERVAL_MS)
  // Ranking data must never be the reason the process stays alive; the master's HTTP server owns
  // that decision.
  interval.unref?.()
  log.info("master-usage-poller:installed")

  return {
    dispose() {
      disposed = true
      clearInterval(interval)
    },
    tickOnce,
  }
}
