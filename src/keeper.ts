import { watch, type FSWatcher } from "node:fs"
import { dirname } from "node:path"
import { accountsOf, getAuthJsonPath, loadAccounts, readAuthAnthropic, type StoredAccount } from "./accounts.ts"
import { KEEPALIVE_TICK_MS, OPENAI_KEEPALIVE_ENABLED, SENTINEL_REFRESH, WATCH_DEBOUNCE_MS } from "./constants.ts"
import { log } from "./logger.ts"
import { keepOpenaiAccountFresh } from "./openai-keepalive.ts"
import { captureOpenaiSlot } from "./openai-slot.ts"
import { acquireInactiveAccess, autoCapture, keepActiveFresh } from "./usage.ts"

const KEEPER_REFRESH_DELAY_MS = 500
// Prompt heal sweep shortly after load (not truly 0ms — let OpenCode finish booting):
// refreshes every stale account up front so the first /usage is already fresh, and a
// user upgrading with stale on-disk tokens sees "需重新登录" only for genuinely dead chains.
const KEEPER_INITIAL_DELAY_MS = 2_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

let lastSeenAuthRefresh: string | undefined

// Whether this machine maintains anthropic chains at all. A CLOUD WORKER sets it false: the
// master holds every real refresh token and is the ONLY refresher, so the worker must do zero
// anthropic refresh and zero anthropic capture while keeping its OpenAI handling untouched (it
// does own those chains locally). Call-site option ONLY — deliberately not env-overridable,
// because a machine that flips this by accident either starts refreshing chains it does not own
// or silently stops maintaining the ones it does.
export type KeeperOptions = { anthropicMaintenance?: boolean }

// Defaults to true so every existing call site — and every local-mode install — keeps today's
// behaviour without saying anything.
function maintainsAnthropic(options: KeeperOptions): boolean {
  return options.anthropicMaintenance ?? true
}

// Capture the active chain tip currently in auth.json. EXPORTED so a later master-side keeper can
// reuse this exact capture, INV-CLOUD-1 refusal included: a second copy of the sentinel rule is
// precisely how the two sides drift apart. Throws on failure — the caller owns the logging policy.
export async function captureAnthropicTip(): Promise<void> {
  const auth = await readAuthAnthropic()
  if (!auth?.refresh || auth.refresh === lastSeenAuthRefresh) return
  // INV-CLOUD-1, checked BEFORE the expiry test because a live lease's `expires` is deliberately
  // in the future and would otherwise sail straight into autoCapture. A VALUE check, not a mode
  // check: in local mode the sentinel never appears in auth.json, so this branch is never taken.
  // Tag shared with accounts.ts on purpose — it names the INVARIANT, not the module, so every
  // place that refuses the sentinel greps as one.
  if (auth.refresh === SENTINEL_REFRESH) {
    log.info("accounts:sentinel-skip", { at: "keeper-auth-change" })
    return
  }
  if (!auth.expires || auth.expires < Date.now()) return
  await autoCapture()
  lastSeenAuthRefresh = auth.refresh
  log.debug("keeper:auth-change-captured")
}

// Re-capture the active chain tip whenever ex-machina rewrites auth.json (rotation or a
// brand-new login), so the tip is never lost across an out-of-band switch (`opencode
// auth login`, restart). autoCapture identifies the account by profile uuid, so
// rotation-vs-new-login needs no guessing and a foreign token can never be attributed
// to the wrong account.
export async function onAuthJsonChanged(options: KeeperOptions = {}): Promise<void> {
  // Openai slot first, in its OWN try/catch so neither provider's failure can skip the other.
  // codex rotates the slot's refresh token on its own schedule and does not take our lock, so
  // this watcher only SHORTENS the delay before that rotation is absorbed — a missed or
  // coalesced fs event defers capture to the next keeperTick and can never corrupt anything.
  try {
    await captureOpenaiSlot()
  } catch (error) {
    log.warn("keeper:openai-capture-fail", { error: errorMessage(error) })
  }
  // Gated AFTER the openai half so a worker still absorbs codex's slot rotations: only the
  // anthropic side belongs to the master.
  if (!maintainsAnthropic(options)) {
    log.debug("keeper:anthropic-maintenance-off", { at: "auth-change" })
    return
  }
  try {
    await captureAnthropicTip()
  } catch (error) {
    log.warn("keeper:capture-fail", { error: errorMessage(error) })
  }
}

// Background keep-alive pass: refresh every INACTIVE account that is nearing expiry so
// /usage opens with instantly-usable tokens and idle chains never lapse. All safety
// guards (active skip per INV-2, needsReauth skip, staleness threshold, 429 cooldown,
// locking, revoked flagging) live inside acquireInactiveAccess.
export async function keeperTick(isSessionRunning: () => boolean, options: KeeperOptions = {}): Promise<void> {
  // The CORRECTNESS FLOOR for absorbing codex's slot rotations (onAuthJsonChanged above is only a
  // latency optimisation) — and it MUST run before the keepalive pass below, never after. INV-O1
  // decides refreshability by comparing each record against the slot; a decision taken against a
  // store that has not yet absorbed the slot's current tip and its lastActiveAt stamp is a decision
  // taken on stale facts, which is how INV-O1 gets fooled. Do not reorder these two.
  try {
    await captureOpenaiSlot()
  } catch (error) {
    log.warn("keeper:openai-capture-fail", { error: errorMessage(error) })
  }
  // Keep-alive for INACTIVE ChatGPT accounts, DARK by default (see OPENAI_KEEPALIVE_ENABLED). While
  // false this loads nothing and POSTs nothing, so the tick is byte-for-byte the previous wave's.
  // Every INV-O1 guard lives inside keepOpenaiAccountFresh, which takes the lock itself — so this
  // must stay OUTSIDE any lock hold (withAuthLock is sequential, not reentrant).
  if (OPENAI_KEEPALIVE_ENABLED) {
    let openaiAccounts: StoredAccount[] = []
    try {
      openaiAccounts = accountsOf(await loadAccounts(), "openai")
    } catch (error) {
      log.warn("keeper:openai-tick-fail", { error: errorMessage(error) })
    }
    for (const account of openaiAccounts) {
      try {
        const { refreshed } = await keepOpenaiAccountFresh(account.id)
        if (refreshed) {
          log.info("keeper:openai-refreshed", { label: account.label })
          await new Promise((resolve) => setTimeout(resolve, KEEPER_REFRESH_DELAY_MS))
        }
      } catch (error) {
        log.warn("keeper:openai-refresh-fail", { label: account.label, error: errorMessage(error) })
      }
    }
  }
  // Everything below this line refreshes ANTHROPIC chains — the active one via keepActiveFresh,
  // the inactive roster via acquireInactiveAccess. Both are the master's job on a cloud worker, so
  // the gate returns HERE: past the two openai passes above (which a worker still owns and which
  // are therefore byte-for-byte unchanged) and before the first anthropic token POST.
  if (!maintainsAnthropic(options)) {
    log.debug("keeper:anthropic-maintenance-off", { at: "tick" })
    return
  }
  try {
    await keepActiveFresh(isSessionRunning)
  } catch (error) {
    log.warn("keeper:active-fail", { error: errorMessage(error) })
  }
  let accounts
  try {
    // ANTHROPIC-only: acquireInactiveAccess refreshes through Anthropic's TOKEN_URL and would
    // therefore POST a captured openai refresh token to the wrong vendor, whose 400 then
    // falsely brands that healthy account needs-reauth. Openai chains go through the separate,
    // INV-O1-guarded pass above — never through this one.
    accounts = accountsOf(await loadAccounts(), "anthropic")
  } catch (error) {
    log.warn("keeper:tick-fail", { error: errorMessage(error) })
    return
  }
  for (const account of accounts) {
    try {
      const { refreshed } = await acquireInactiveAccess(account.id)
      if (refreshed) {
        log.info("keeper:refreshed", { label: account.label })
        await new Promise((resolve) => setTimeout(resolve, KEEPER_REFRESH_DELAY_MS))
      }
    } catch (error) {
      log.warn("keeper:refresh-fail", { label: account.label, error: errorMessage(error) })
    }
  }
}

export function installTokenKeeper(isSessionRunning: () => boolean, options: KeeperOptions = {}): { dispose: () => void } {
  let watcher: FSWatcher | undefined
  let debounce: ReturnType<typeof setTimeout> | undefined
  let disposed = false
  const interval = setInterval(() => void keeperTick(isSessionRunning, options), KEEPALIVE_TICK_MS)
  const initial = setTimeout(() => void keeperTick(isSessionRunning, options), KEEPER_INITIAL_DELAY_MS)
  interval.unref?.()
  initial.unref?.()
  void (async () => {
    try {
      const authPath = await getAuthJsonPath()
      if (disposed) return
      watcher = watch(dirname(authPath), (_event, filename) => {
        if (disposed) return
        if (filename && !String(filename).startsWith("auth.json")) return
        clearTimeout(debounce)
        debounce = setTimeout(() => void onAuthJsonChanged(options), WATCH_DEBOUNCE_MS)
      })
      // An unhandled 'error' event on an EventEmitter crashes the host process — degrade
      // to interval-only keep-alive instead.
      watcher.on("error", (error) => log.warn("keeper:watch-error", { error: errorMessage(error) }))
      log.info("keeper:installed")
    } catch (error) {
      log.warn("keeper:watch-fail", { error: errorMessage(error) })
    }
  })()
  return {
    dispose() {
      disposed = true
      clearInterval(interval)
      clearTimeout(initial)
      clearTimeout(debounce)
      try {
        watcher?.close()
      } catch {}
    },
  }
}
