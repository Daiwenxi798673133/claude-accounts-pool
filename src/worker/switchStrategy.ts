// Cloud-worker rate-limit recovery. THE SPLIT this module implements: the worker DETECTS the limit
// (it is only observable as this session's own failed turn) and RESUMES the turn (only this session
// can re-issue it), while the MASTER decides which account comes next — it alone sees the whole
// roster and every worker's reports, so it alone can own selection and cooldown.
//
// Therefore NOTHING HERE PICKS AN ACCOUNT and nothing here refreshes a token. This module reports
// what the worker observed, asks for a replacement, and writes back whatever lease comes home.
import type { createLeaseClient, LeaseFailure, LeaseOutcome } from "./leaseClient.ts"
import type { PinStore } from "./pin.ts"
import { log } from "../logger.ts"

// Derived from the client rather than restated: a change to that wire surface must be a COMPILE
// error here, not a silent divergence between two hand-kept copies of the same shape.
type LeaseClient = ReturnType<typeof createLeaseClient>

export type SwitchContext = {
  accountId: string
  // Quota headers as OBSERVED on the limit event, already narrowed to the telemetry whitelist by
  // the caller. Raw values, because only the master can interpret a reset instant against the pool.
  headers: Record<string, string>
  resetsAt?: number
}

export type SwitchStrategy = {
  // true ⇒ a replacement lease was WRITTEN, so the caller may resume its failed turn.
  onLimit(ctx: SwitchContext): Promise<boolean>
  // Same boolean contract, a DIFFERENT event: the leased access token was revoked out from under
  // this worker (INV-CLOUD-5 below). No SwitchContext, because there is no quota telemetry to
  // carry — the account is healthy and the only fact that matters is which one we hold.
  onStaleLease(ctx: { accountId: string }): Promise<boolean>
}

export type SwitchStrategyDeps = {
  client: LeaseClient
  // The pin-aware lease verb (createPinnedLease), used by onStaleLease ONLY. Not by onLimit: that path
  // is leaving a SPENT account, which is the one account a pin must never keep naming.
  pinnedLease: (input: { reason: "prelease"; currentAccountId?: string }) => Promise<LeaseOutcome>
  pin: PinStore
  // Narrower than accounts.ts's TokenWrite on purpose: access + expires and NO refresh slot, so a
  // worker cannot express a {kind:"full"} write here even by accident — the master is the only
  // holder of real refresh chains. `accountId` is the master's answer to "who did you give me",
  // recorded by the seam so /usage can mark the right row after an automatic switch. MUST NOT
  // REJECT: onLimit's contract is a boolean, and a rejection would leave the caller's session
  // neither resumed nor marked stalled — that applies to the accountId record too, which is
  // bookkeeping and must never cost a session its recovery.
  writeLease: (input: { access: string; expires: number; accountId: string }) => Promise<void>
  toast: (input: { variant: "warning" | "error"; message: string }) => void
  now?: () => number
}

// A table, not an if/else chain (accounts.ts's TOKEN_WRITERS rule): adding a LeaseFailure kind is a
// COMPILE error until someone decides what the user is told, rather than silently degrading to a
// generic message for a fault whose remedy is different.
const FAILURE_MESSAGE: Record<LeaseFailure["kind"], string> = {
  "no-account": "云端账号池暂无可用账号，已停在当前账号，请稍后重试",
  unreachable: "连不上云端账号池，无法切号，请检查网络或 master 服务",
  "bad-response": "云端账号池返回了无法识别的响应，未切号",
  // NOT REACHABLE FROM EITHER VERB BELOW — a `refused` answer requires having NAMED an account, and
  // neither of them does (the master picks). The exhaustive table demands an entry anyway, and the
  // wording still has to hold if one ever appears; the operator-facing refusal messages, which name
  // the specific reason, live with the manual switch that can actually provoke one.
  refused: "云端账号池拒绝了本次租借请求，未切号",
}

export function createSwitchStrategy(deps: SwitchStrategyDeps): SwitchStrategy {
  const now = deps.now ?? Date.now

  return {
    async onLimit(ctx: SwitchContext): Promise<boolean> {
      // THE PIN'S END CONDITION, and the only automatic one: `p` promises to hold an account until its
      // quota is spent, and this event is USUALLY that quota being spent — usually, because only the
      // master can tell a real exhaustion from a sibling session's failure misattributed to us, and it
      // says so by handing the same account back. Cleared BEFORE the report and the lease below, so
      // neither can name the account we are leaving, and restored after the master has ruled.
      //
      // UNCONDITIONAL, not "only if the pin names ctx.accountId". A worker holds exactly one account,
      // so the two agree in every reachable state; and if they ever disagreed, keeping the pin would be
      // the dangerous direction — reportRateLimit is best-effort, so a lost report leaves the master
      // willing to hand the spent account straight back, and a pin naming it would ask for exactly
      // that, forever.
      // Guarded, not unconditional: `set` reaches a persisted store, and the overwhelmingly common
      // rate limit is one with no pin in play at all. The value is kept rather than a bare boolean
      // because the master may yet answer that we are not leaving at all — see below.
      const previousPin = deps.pin.get()
      if (previousPin !== undefined) deps.pin.set(undefined)
      // FIRST, and awaited: the master must know this account is spent BEFORE it answers the lease
      // below, or it may hand the very same account straight back. The report is best-effort BY
      // CONTRACT (leaseClient never retries and never throws across that boundary, it answers a
      // boolean), so this costs at most one bounded request — and its verdict is deliberately
      // ignored, because losing a data point must never cost the user a stalled session.
      await deps.client.reportRateLimit({ accountId: ctx.accountId, headers: ctx.headers, resetsAt: ctx.resetsAt })

      const outcome = await deps.client.lease({ reason: "ratelimit", currentAccountId: ctx.accountId })
      if (!outcome.ok) {
        log.warn("switch:lease-failed", { accountId: ctx.accountId, failure: outcome.failure.kind })
        deps.toast({ variant: "error", message: FAILURE_MESSAGE[outcome.failure.kind] })
        return false
      }

      const { lease } = outcome
      // An already-dead lease is WORSE than the spent one we hold: writing it swaps a recoverable
      // state (quota will reset) for an immediately broken login. Refuse and keep what we have.
      if (lease.expiresAt <= now()) {
        log.warn("switch:lease-stale", { accountId: lease.accountId, expiresAt: lease.expiresAt })
        deps.toast({ variant: "error", message: "云端账号池下发的凭据已过期，未写入，请稍后重试" })
        return false
      }

      await deps.writeLease({ access: lease.access, expires: lease.expiresAt, accountId: lease.accountId })
      // THE SAME ACCOUNT BACK IS THE MASTER'S VERDICT, not a coincidence: a `ratelimit` lease
      // excludes the account it names, so the only way to be handed it again is the master judging
      // this report misattributed — a failure that predates our move onto it, raised by a sibling
      // session or process sharing this machine's auth.json. Nothing was spent, so the pin was not
      // spent either, and the clear above is undone rather than left as a silent policy change.
      const stayed = lease.accountId === ctx.accountId
      if (stayed && previousPin !== undefined) deps.pin.set(previousPin)
      const unpinned = previousPin !== undefined && !stayed
      // Never the access token itself — it is a live credential.
      log.info("switch:leased", { from: ctx.accountId, to: lease.accountId, expiresAt: lease.expiresAt, unpinned, stayed })
      deps.toast({
        variant: "warning",
        message: stayed
          ? "本次额度报警被云端判定为误报（本机另一个会话刚切过号），已就地续用当前账号并自动重试"
          : unpinned
            ? `钉住的账号额度已用满，已解除钉住并切到云端账号「${lease.accountId}」并自动重试`
            : `当前账号额度已满，已切到云端账号「${lease.accountId}」并自动重试`,
      })
      return true
    },

    // INV-CLOUD-5. MEASURED against the real Anthropic API: an account's access token returned 200,
    // the master refreshed that account (grant_type=refresh_token, which rotated the refresh token
    // too) and the NEW access token returned 200 — after which the PREVIOUS access token returned
    // 401. Anthropic revokes the prior access token on refresh. The master is the only refresher and
    // workers hold leased copies of exactly that token, so a master refresh kills every outstanding
    // lease for that account at that instant. The normal timeline is being fixed master-side; this
    // handles the residual (clock skew, an early refresh, a laptop resuming from sleep).
    async onStaleLease(ctx: { accountId: string }): Promise<boolean> {
      // NO reportRateLimit, and reason:"prelease" rather than "ratelimit": the account is HEALTHY —
      // only its token was rotated away. leaseServer excludes currentAccountId for "ratelimit"
      // ONLY, so prelease is the one reason that says "keep me here, just re-issue the token"
      // instead of cooling a fine account and shrinking pool capacity for nothing.
      // THROUGH THE PIN, unlike onLimit: the account is healthy and only its token was rotated away, so
      // a pinned worker must come back to the same account. Plain `client.lease` would hand this to the
      // ranked pick and quietly rotate the operator off the row they pinned.
      const outcome = await deps.pinnedLease({ reason: "prelease", currentAccountId: ctx.accountId })
      if (!outcome.ok) {
        log.warn("switch:stale-lease-failed", { accountId: ctx.accountId, failure: outcome.failure.kind })
        deps.toast({ variant: "error", message: FAILURE_MESSAGE[outcome.failure.kind] })
        return false
      }

      const { lease } = outcome
      // The same refusal onLimit makes, for a sharper reason here: the token we hold is already
      // revoked, so writing an EXPIRED replacement would put `expires` in the past — the one state
      // in which the local auth provider refreshes the sentinel itself and becomes a second
      // refresher of the master's one-time-use chain.
      if (lease.expiresAt <= now()) {
        log.warn("switch:stale-lease-expired", { accountId: lease.accountId, expiresAt: lease.expiresAt })
        deps.toast({ variant: "error", message: "云端账号池下发的新凭据已过期，未写入，请检查 master 状态" })
        return false
      }

      await deps.writeLease({ access: lease.access, expires: lease.expiresAt, accountId: lease.accountId })
      // Never the access token itself — it is a live credential.
      log.info("switch:stale-lease-renewed", { accountId: lease.accountId, expiresAt: lease.expiresAt })
      deps.toast({ variant: "warning", message: `云端凭据已失效，已重新租用账号「${lease.accountId}」并自动重试` })
      return true
    },
  }
}
