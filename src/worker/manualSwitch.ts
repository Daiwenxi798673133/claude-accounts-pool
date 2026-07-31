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
    lease(input: { reason: "prelease"; preferredAccountIdPrefix: string; attempts: number }): Promise<LeaseOutcome>
  }
  // The `{kind:"lease"}` write seam — access + expiry and NOTHING else, so this path cannot express a
  // real refresh token even by accident (INV-CLOUD-1). Same seam the renewal loop uses.
  writeLease: (input: { access: string; expires: number }) => Promise<void>
  toast: (input: { variant: "success" | "warning" | "error"; message: string }) => void
  now?: () => number
}

export type ManualSwitchOutcome = { ok: true; accountId: string } | { ok: false }

export type ManualSwitch = {
  // `label` is carried in purely so the messages can name the account: a worker has no account
  // library to look it up in, and the panel already has the label the operator is reading.
  switchTo(input: { prefix: string; label: string }): Promise<ManualSwitchOutcome>
}

// Worded for THIS path, deliberately not shared with switchStrategy's table: there the sentence ends
// "已停在当前账号" because a spent account is still in use, here it ends "未切号" because nothing moved.
const FAILURE_MESSAGE: Record<Exclude<LeaseFailure["kind"], "refused">, string> = {
  auth: "云端账号池拒绝了本机的 pool key，无法切号，请检查 tui.json 配置",
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

export function createManualSwitch(deps: ManualSwitchDeps): ManualSwitch {
  const now = deps.now ?? Date.now

  return {
    async switchTo(input: { prefix: string; label: string }): Promise<ManualSwitchOutcome> {
      // `prelease`, never `ratelimit`: the account being LEFT is healthy — the operator just wants a
      // different one — and `ratelimit` would have the master cool a perfectly good account, shrinking
      // pool capacity for everyone because one person changed their mind.
      const outcome = await deps.client.lease({
        reason: "prelease",
        preferredAccountIdPrefix: input.prefix,
        attempts: MANUAL_LEASE_ATTEMPTS,
      })
      if (!outcome.ok) {
        log.warn("manual-switch:lease-failed", { prefix: input.prefix, failure: outcome.failure.kind })
        deps.toast({ variant: "error", message: messageFor(outcome.failure, input.label) })
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

      await deps.writeLease({ access: lease.access, expires: lease.expiresAt })
      // Never `lease.access` — it is a live credential.
      log.info("manual-switch:leased", { accountId: lease.accountId, expiresAt: lease.expiresAt })
      // The second clause is not hedging, it is the truth about this pool: there is NO worker→account
      // affinity by design, so the next renewal ranks by utilization like any other and may well move
      // off this account. Saying so beats letting the operator discover it as a bug.
      deps.toast({ variant: "success", message: `已切到「${input.label}」，续租时可能被账号池按用量轮换走` })
      return { ok: true, accountId: lease.accountId }
    },
  }
}
