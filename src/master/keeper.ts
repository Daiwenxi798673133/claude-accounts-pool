import { providerOf, type AnthropicOauth, type StoredAccount } from "../accounts.ts"
import { KEEPALIVE_TICK_MS, MASTER_WARM_SPACING_MS, SENTINEL_REFRESH } from "../constants.ts"
import { log } from "../logger.ts"

// The master's background warm loop, plus the onboarding capture that gets accounts INTO the
// library in the first place.
//
// WHY THIS IS NOT src/keeper.ts. That keeper serves a machine that RUNS INFERENCE: exactly one
// account is "active" (the chain ex-machina holds in auth.json), INV-2 forbids touching it, and so
// its sweep deliberately covers only the INACTIVE roster. The master runs no inference and has no
// active account at all — the account library is the source of truth and every record in it is
// leasable — so the warm loop here covers EVERY anthropic account. Reusing the inactive-only sweep
// would leave whichever record happens to carry `activeId` permanently un-warmed.
//
// Nothing in this file refreshes anything itself: every refresh goes through `deps.refresher`,
// which is the ONE refresher in the system. A second refresh path would break the rotation
// guarantee the whole architecture rests on — Anthropic's refresh token is one-time-use, so two
// refreshers racing one account strand it with invalid_grant until a human re-logs in.

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export type OnboardingCaptureDeps = {
  // auth.json's `anthropic` entry as it stands right now. Injected (production passes
  // accounts.ts's readAuthAnthropic) so the refusal rules below are provable without a real file.
  readAuthTip: () => Promise<AnthropicOauth | undefined>
  // Hand the verified tip to the account library. Argument-less on purpose: the library identifies
  // an account by its PROFILE uuid, so the absorbing side has to re-read the tip and look the
  // profile up anyway (usage.ts's autoCapture is the production implementation). Passing a token
  // here would be a value nobody consumes — a lie in the signature.
  absorb: () => Promise<void>
  now?: () => number
}

// ONBOARDING. An admin runs `opencode auth login` on the master via the ex-machina PKCE flow,
// which writes a REAL credential into the master's local auth.json; this absorbs it into the
// account library so the pool grows without a manual /account-add.
export function makeOnboardingCapture(deps: OnboardingCaptureDeps): () => Promise<void> {
  const now = deps.now ?? Date.now
  // Per-instance, unlike src/keeper.ts's module-global `lastSeenAuthRefresh`: a module-global would
  // be shared with that keeper inside one process, so whichever ran first would suppress the
  // other's capture of the very same rotation.
  let lastAbsorbed: string | undefined

  return async function capture(): Promise<void> {
    const tip = await deps.readAuthTip()
    // An unchanged tip is not news. Cheapest check first, and it can never mask a sentinel: a
    // sentinel is never absorbed, so it never becomes `lastAbsorbed`.
    if (!tip?.refresh || tip.refresh === lastAbsorbed) return
    // INV-CLOUD-1, checked BEFORE the expiry test because a live lease's `expires` is deliberately
    // in the future and would otherwise sail straight through. A VALUE check, never a mode check.
    // Absorbing a worker's sentinel would put a non-token in the library, where it would be POSTed
    // to Anthropic as a refresh forever — branding a healthy account needs-reauth — and would make
    // this master look like it holds a credential it does not have. `upsertAccount` refuses the
    // same value at the store's choke point; this is the pre-flight refusal, so a sentinel never
    // even costs a profile lookup. Tag shared with accounts.ts on purpose: it names the INVARIANT,
    // not the module, so every place that refuses the sentinel greps as one.
    if (tip.refresh === SENTINEL_REFRESH) {
      log.info("accounts:sentinel-skip", { at: "master-keeper-capture" })
      return
    }
    // An expired tip cannot be verified against the profile endpoint, so it is skipped rather than
    // archived on faith. Not a loss: the account's next successful use re-freshens auth.json and
    // the following tick picks it up.
    if (!tip.expires || tip.expires < now()) {
      log.debug("master-keeper:capture-stale")
      return
    }
    await deps.absorb()
    // Stamped only AFTER a successful absorb, so a failed capture is retried on the next tick.
    lastAbsorbed = tip.refresh
    log.info("master-keeper:captured")
  }
}

export type MasterKeeperDeps = {
  refresher: { getFreshAccess(accountId: string): Promise<{ access: string; expiresAt: number }> }
  loadAccounts: () => Promise<StoredAccount[]>
  capture: () => Promise<void>
  // Injected so the spacing contract is observable without a real timer. NO DEFAULT: a test that
  // forgot to supply it would otherwise burn MASTER_WARM_SPACING_MS per account for real.
  sleep: (ms: number) => Promise<void>
}

export function installMasterKeeper(deps: MasterKeeperDeps): { dispose: () => void; tickOnce: () => Promise<void> } {
  let disposed = false
  let sweeping = false

  async function tickOnce(): Promise<void> {
    // Re-entrancy guard. A roster large enough to outlast one interval would otherwise have two
    // sweeps in the air, which is exactly the concurrency the spacing below exists to prevent.
    if (disposed || sweeping) return
    sweeping = true
    try {
      // Onboarding FIRST, in its own try/catch: an account captured now is warmed by the same
      // sweep, and a capture failure must never cost the whole roster its keep-alive.
      try {
        await deps.capture()
      } catch (error) {
        log.warn("master-keeper:capture-fail", { error: errorMessage(error) })
      }
      if (disposed) return
      let accounts: StoredAccount[]
      try {
        // ANTHROPIC-only. The refresher POSTs to Anthropic's TOKEN_URL, so a ChatGPT record here
        // would disclose its refresh token to platform.claude.com and the 400 that comes back
        // would brand that healthy account needs-reauth. Read through providerOf, never
        // `provider === "anthropic"`: every record written before multi-provider support lacks
        // the field and a hand-rolled comparison silently drops it.
        // A flagged account is skipped rather than warmed: its chain is known dead, and this sweep
        // visits every account every five minutes, so trying anyway would be a guaranteed-400 drip
        // at the token endpoint — from the single egress IP the entire pool depends on.
        accounts = (await deps.loadAccounts()).filter(
          (account) => providerOf(account) === "anthropic" && !account.needsReauth,
        )
      } catch (error) {
        log.warn("master-keeper:load-fail", { error: errorMessage(error) })
        return
      }
      for (let index = 0; index < accounts.length; index++) {
        // Checked every iteration so dispose() takes effect mid-sweep instead of at the end of it.
        if (disposed) return
        const account = accounts[index]
        try {
          const fresh = await deps.refresher.getFreshAccess(account.id)
          log.debug("master-keeper:warmed", { accountId: account.id, expiresAt: fresh.expiresAt })
        } catch (error) {
          // One dead chain must NEVER abort the sweep: the accounts after it are healthy and still
          // need their tokens kept fresh. Log and carry on.
          log.warn("master-keeper:warm-fail", { accountId: account.id, label: account.label, error: errorMessage(error) })
        }
        // STRICTLY SERIAL, with spacing BETWEEN accounts (none trailing the last — there is
        // nothing left to space from). Concurrent refreshes of DIFFERENT accounts are safe as far
        // as rotation goes, but they still leave this host on ONE egress IP and the token endpoint
        // rate-limits by IP: a back-to-back roster sweep earns a 429 that has nothing to do with
        // any single account's subscription, and the refresher never retries a 429 because doing
        // so deepens the block for every account behind that IP.
        if (index < accounts.length - 1) await deps.sleep(MASTER_WARM_SPACING_MS)
      }
    } finally {
      sweeping = false
    }
  }

  // One look per KEEPALIVE_TICK_MS (5 min) against the refresher's MASTER_REFRESH_THRESHOLD_MS
  // (4 h), so a chain that fails to rotate gets dozens of further attempts before its access token
  // is anywhere near spent — the margin that was missing when the trigger was a 10-minute window.
  const interval = setInterval(() => void tickOnce(), KEEPALIVE_TICK_MS)
  // The warm loop must never be the reason the process stays alive; the master's HTTP server owns
  // that decision.
  interval.unref?.()
  log.info("master-keeper:installed")

  return {
    dispose() {
      disposed = true
      clearInterval(interval)
    },
    tickOnce,
  }
}
