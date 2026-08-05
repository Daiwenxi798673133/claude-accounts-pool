// The `enter` key of a cloud-worker's /usage panel: switch to the account the OPERATOR pointed at.
//
// THE SAME SPLIT switchStrategy.ts implements, one step further out. There, the worker detects a limit
// and the master chooses the replacement; here a human chooses and the master still mints. What this
// module must never become is a second selector: it NAMES an account and accepts a refusal, it never
// falls back to picking one itself — a "switch" that quietly landed on a different account would make
// the operator attribute the next turn's usage to the wrong subscription.
//
// It therefore holds no roster, no token and no policy. Ask, validate, write, say what happened.
import type { LeaseRefusal } from "../cloud/protocol.ts"
import { log } from "../logger.ts"
import type { LeaseFailure, LeaseOutcome } from "./leaseClient.ts"

// ONE attempt, against the client's default of eight. The operator is watching a dialog they just
// pressed enter in, and the retry ladder can spend minutes before it answers; a decisive "连不上" now
// is worth far more than a lease that lands after they have given up and moved on.
const MANUAL_LEASE_ATTEMPTS = 1

export type ManualSwitchDeps = {
  // Structural, not the concrete client: this needs exactly one verb, which is what lets every test
  // drive it without a transport. `attempts` is part of the shape because passing it is the point.
  client: {
    lease(input: {
      reason: "prelease"
      preferredAccountIdPrefix: string
      attempts: number
      pinned?: boolean
    }): Promise<LeaseOutcome>
  }
  // The `{kind:"lease"}` write seam — access + expiry and NOTHING else of the credential, so this
  // path cannot express a real refresh token even by accident (INV-CLOUD-1). Same seam the renewal
  // loop uses, `accountId` included: it is the id the seam records so /usage knows what it holds.
  writeLease: (input: { access: string; expires: number; accountId: string }) => Promise<void>
  toast: (input: { variant: "success" | "warning" | "error"; message: string }) => void
  now?: () => number
}

export type ManualSwitchOutcome = { ok: true; accountId: string } | { ok: false }

export type ManualSwitch = {
  // `label` is carried in purely so the messages can name the account: a worker has no account
  // library to look it up in, and the panel already has the label the operator is reading.
  //
  // `pin` says which of the panel's two keys pressed this. `undefined` is `enter` — a one-off switch
  // the pool may rotate away from. `true`/`false` are `p`: the SAME lease request, plus the flag that
  // tells the master whether to record this holder as staying put. All three share one code path
  // because they are one operation; only the sentence at the end differs.
  switchTo(input: { prefix: string; label: string; pin?: boolean }): Promise<ManualSwitchOutcome>
}

// Worded for THIS path, deliberately not shared with switchStrategy's table: there the sentence ends
// "已停在当前账号" because a spent account is still in use, here it ends "未切号" because nothing moved.
const FAILURE_MESSAGE: Record<Exclude<LeaseFailure["kind"], "refused">, string> = {
  "no-account": "云端账号池没有可租借的账号，未切号",
  unreachable: "连不上云端账号池，未切号，请检查网络或 master 服务",
  "bad-response": "云端账号池返回了无法识别的响应，未切号",
}

// THIS TABLE IS THE "NEVER FAIL SILENTLY" GUARANTEE: every refusal the master can answer has a
// sentence here naming what the operator can actually do about it. Keyed by refusal so a reason added
// to the protocol is a COMPILE error rather than a switch that just does nothing.
const REFUSAL_MESSAGE: Record<LeaseRefusal, (label: string) => string> = {
  unknown: () => "账号池里已经没有这个账号了，按 r 刷新后再试",
  ambiguous: () => "有多个账号的 id 前缀相同，无法确定要切到哪一个，请在 master 上核对账号库",
  cooling: (label) => `「${label}」额度已满正在冷却，未切号`,
  "needs-reauth": (label) => `「${label}」需要在 master 上重新登录，未切号`,
}

function messageFor(failure: LeaseFailure, label: string): string {
  return failure.kind === "refused" ? REFUSAL_MESSAGE[failure.refused](label) : FAILURE_MESSAGE[failure.kind]
}

function successMessage(label: string, pin?: boolean): string {
  if (pin === true) return `已钉住「${label}」，在额度用满前不再被账号池轮换走`
  if (pin === false) return `已取消钉住「${label}」，续租恢复按用量轮换`
  // Not hedging, but the truth about this pool: with no pin there is NO worker→account affinity, so
  // the next renewal ranks by utilization like any other and may well move off this account. Saying so
  // beats letting the operator discover it as a bug — and now names the key that prevents it.
  return `已切到「${label}」，续租时可能被账号池按用量轮换走(按 p 可钉住)`
}

// A FAILED un-pin is not a failed switch, and must not be reported as one: the local pin is already
// gone by the time this runs (worker/install.ts clears it before asking), so the operator's intent DID
// take effect here — only the master has not heard yet, and its own next renewal will tell it.
function failureMessage(failure: LeaseFailure, label: string, pin?: boolean): string {
  const base = messageFor(failure, label)
  return pin === false ? `${base}；本机已取消钉住，master 会在下次续租时同步` : base
}

export function createManualSwitch(deps: ManualSwitchDeps): ManualSwitch {
  const now = deps.now ?? Date.now

  return {
    async switchTo(input: { prefix: string; label: string; pin?: boolean }): Promise<ManualSwitchOutcome> {
      // `prelease`, never `ratelimit`: the account being LEFT is healthy — the operator just wants a
      // different one — and `ratelimit` would have the master cool a perfectly good account, shrinking
      // pool capacity for everyone because one person changed their mind.
      const outcome = await deps.client.lease({
        reason: "prelease",
        preferredAccountIdPrefix: input.prefix,
        attempts: MANUAL_LEASE_ATTEMPTS,
        ...(input.pin === undefined ? {} : { pinned: input.pin }),
      })
      if (!outcome.ok) {
        log.warn("manual-switch:lease-failed", { prefix: input.prefix, pin: input.pin, failure: outcome.failure.kind })
        deps.toast({ variant: "error", message: failureMessage(outcome.failure, input.label, input.pin) })
        return { ok: false }
      }

      const { lease } = outcome
      // VERSION SKEW, CAUGHT CLIENT-SIDE. A master that predates `preferredAccountIdPrefix` ignores
      // unknown request fields (its parser destructures the three it knows), so it answers 200 with a
      // RANKED pick — a different account than the operator chose. Without this check the worker would
      // write that lease and report a switch that never happened, which is the exact failure the 409
      // path exists to prevent. Refuse instead: the invariant is enforced on BOTH ends, so it holds
      // even when only one of them has been upgraded.
      if (!lease.accountId.startsWith(input.prefix)) {
        log.warn("manual-switch:account-mismatch", { requested: input.prefix, served: lease.accountId })
        deps.toast({ variant: "error", message: "master 没有按指定账号下发凭据(可能版本过旧)，未切号" })
        return { ok: false }
      }
      // The same refusal both automatic paths make: an already-dead lease is WORSE than the working
      // one we hold, because `expires` in the past is exactly the state in which the local auth
      // provider starts refreshing the sentinel itself and becomes a second refresher of the master's
      // one-time-use chain. Refusing leaves the current lease untouched.
      if (lease.expiresAt <= now()) {
        log.warn("manual-switch:lease-stale", { accountId: lease.accountId, expiresAt: lease.expiresAt })
        deps.toast({ variant: "error", message: "云端账号池下发的凭据已过期，未写入，请检查 master 状态" })
        return { ok: false }
      }

      await deps.writeLease({ access: lease.access, expires: lease.expiresAt, accountId: lease.accountId })
      // Never `lease.access` — it is a live credential.
      log.info("manual-switch:leased", { accountId: lease.accountId, expiresAt: lease.expiresAt, pin: input.pin })
      deps.toast({ variant: "success", message: successMessage(input.label, input.pin) })
      return { ok: true, accountId: lease.accountId }
    },
  }
}
