// 这台机器的【那一个】租约 —— 所有 claude 会话共用,由 relay 持有、续期、换号。
//
// 【为什么全机只有一个号】(issue #83 定稿)。一台机器 = 一个 relay = 一个 workerId = 一个账号。这是
// 天然的限流阀:到期续期、撞额度换号都只发生一次。反过来,每个会话各持一个号,5 个会话同时到期或
// 同时撞墙就是一瞬间切走 5 个号。
//
// 【进程内的惊群,是本模块唯一真正的敌人】。共用一个号,就会有 N 个请求同时在路上、同时吃到 429
// (或 401)。每个都去换号,惊群只是从进程之间挪进了进程里面 —— issue #59 的形状:一次真实限流被报成
// N 次,连带冷却 N 个健康账号。所以:
//
//   1. 所有状态变更走同一条串行队列(serialize),不存在两个换号同时在飞。
//   2. 每个失败请求带着「发出时用的是哪个账号 / 哪枚 access」进队。轮到它时先比对:当前已经不是
//      那个号了,说明排在前面的已经换过,它直接拿当前的去重发,不上报、不换号。
//
// 这是代次比对,不是去重窗口:没有时间常数,也就没有"窗口刚过又报一次"的边界。
//
// 【到期只续期,不换号】。`reason: "prelease"` + `currentAccountId`,master 保留同一个号
// (leaseServer.ts 的 incumbent 分支)。prompt cache 按 organization 隔离(docs/research/
// prompt-caching-账号隔离调研.md),换号 = 整段重写缓存,所以换号只留给额度用满。
//
// INV-CLOUD-1:本模块只跟 master 说话,从不碰 token 端点。
import type { LeaseFailure, LeaseOutcome } from "../worker/leaseClient.ts"
import type { LeaseReason } from "../cloud/protocol.ts"
import { LEASE_RENEW_BUFFER_MS } from "../constants.ts"
import { log } from "../logger.ts"
import { leaseLiveAccess } from "../senpi/deadLease.ts"
import { limitHeadersOf, resetsAtOf } from "./relayWire.ts"
import type { PinStore } from "./pin.ts"

export type HeldLease = { accountId: string; access: string; expiresAt: number }

export type SharedLeaseResult = { ok: true; lease: HeldLease } | { ok: false; failure: LeaseFailure }

export type SharedLeaseDeps = {
  lease: (input: {
    reason: LeaseReason
    currentAccountId?: string
    excludeAccountIds?: readonly string[]
    preferredAccountIdPrefix?: string
    pinned?: boolean
  }) => Promise<LeaseOutcome>
  // leaseClient 的同名动词:自己吞掉全部故障、返回 false,所以这里既不重试也不抛。
  reportRateLimit: (input: { accountId: string; headers: Record<string, string>; resetsAt?: number }) => Promise<boolean>
  pin: PinStore
  now: () => number
}

// 换号失败(池子没号、master 不可达)之后,同一个号上再来的 429 在这段时间内不再去问 master。
// 否则池子空了的那几分钟里,每个请求都是一次上报加一次租约 —— 对着 master 连发,而答案不会变。
export const SWITCH_RETRY_MS = 60_000

export type SharedLease = {
  /** 当前持有的租约,不发起任何请求。 */
  current: () => HeldLease | undefined
  /** 保证手里有一枚可用的租约:没有就领,快到期就续(同一个号)。 */
  ensure: () => Promise<SharedLeaseResult>
  /** 操作者点名:把全机共享的号切到这个前缀。被拒绝时绝不替换成别的号。 */
  name: (prefix: string, pinned: boolean) => Promise<SharedLeaseResult>
  /** 某个请求在 failedAccountId 上撞了额度。第一个到的换号,其余的拿到换好的那个。 */
  quotaExhausted: (failedAccountId: string, headers: Headers) => Promise<SharedLeaseResult>
  /** 某个请求拿 failedAccess 吃了 401。第一个到的续期,其余的拿到续好的那枚。 */
  unauthorized: (failedAccess: string) => Promise<SharedLeaseResult>
}

export function createSharedLease(deps: SharedLeaseDeps): SharedLease {
  let held: HeldLease | undefined
  // 本进程亲眼见过 401 的 access。master 在视界够宽时返回缓存的那枚,吊销了也原样返回
  // (src/senpi/deadLease.ts 的头注释),所以"续一次"可能拿回同一具尸体 —— 这个集合是唯一的证据。
  const deadAccess = new Set<string>()
  let switchFailed: { accountId: string; at: number; failure: LeaseFailure } | undefined

  let queue: Promise<unknown> = Promise.resolve()
  function serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = queue.then(fn, fn)
    queue = run.catch(() => {})
    return run
  }

  const due = (lease: HeldLease): boolean => lease.expiresAt - deps.now() < LEASE_RENEW_BUFFER_MS
  const usable = (lease: HeldLease): boolean => lease.expiresAt > deps.now() && !deadAccess.has(lease.access)

  function adopt(lease: HeldLease, why: string): SharedLeaseResult {
    const moved = held !== undefined && held.accountId !== lease.accountId
    held = lease
    // 永远只出前 8 位,access 一个字符都不进日志。
    log.info("claudecode:relay-lease", { why, accountId: lease.accountId.slice(0, 8), moved, expiresAt: lease.expiresAt })
    return { ok: true, lease }
  }

  // 自动路径的租约动词:钉住感知 + 死凭证感知。钉住的规矩照抄 src/worker/pin.ts 的 createPinnedLease:
  // 只有 master 明说 refused 才交还钉住,网络抖动、池子没号都不算 —— 那说明不了这个号能不能服务。
  async function autoLease(reason: LeaseReason): Promise<LeaseOutcome> {
    const base = { reason, ...(held === undefined ? {} : { currentAccountId: held.accountId }) }
    const leaseDeps = { lease: deps.lease, deadAccess }
    const pinned = deps.pin.read()
    if (pinned === undefined) return leaseLiveAccess(leaseDeps, base)
    const outcome = await leaseLiveAccess(leaseDeps, { ...base, preferredAccountIdPrefix: pinned, pinned: true })
    if (outcome.ok || outcome.failure.kind !== "refused") return outcome
    log.warn("claudecode:relay-pin-dropped", { idPrefix: pinned, refused: outcome.failure.refused })
    deps.pin.write(undefined)
    return leaseLiveAccess(leaseDeps, base)
  }

  async function renew(why: string): Promise<SharedLeaseResult> {
    const outcome = await autoLease("prelease")
    if (outcome.ok) return adopt(outcome.lease, why)
    // 续不上但手里那枚还能用:接着用,下一次再续。把一次 master 抖动变成所有会话的报错才是错的。
    if (held !== undefined && usable(held)) {
      log.warn("claudecode:relay-renew-failed", { kind: outcome.failure.kind, accountId: held.accountId.slice(0, 8) })
      return { ok: true, lease: held }
    }
    return outcome
  }

  return {
    current: () => held,

    ensure: () =>
      serialize(async () => {
        if (held !== undefined && usable(held) && !due(held)) return { ok: true, lease: held }
        return renew(held === undefined ? "initial" : "renew")
      }),

    name: (prefix, pinned) =>
      serialize(async (): Promise<SharedLeaseResult> => {
        if (held !== undefined && held.accountId.startsWith(prefix) && usable(held) && !due(held)) {
          return { ok: true, lease: held }
        }
        const outcome = await deps.lease({
          reason: "prelease",
          ...(held === undefined ? {} : { currentAccountId: held.accountId }),
          preferredAccountIdPrefix: prefix,
          pinned,
        })
        if (!outcome.ok) {
          // master 明说不服务这个号 —— 钉住必须在这里交还,否则每次续期都点它、每次被拒。
          if (outcome.failure.kind === "refused" && deps.pin.read() === prefix) deps.pin.write(undefined)
          return outcome
        }
        // 点名拿回了一枚本进程见过 401 的 access:不能静默换成别的号(用量归属依赖"我要的就是我拿到的"),
        // 只能如实失败。
        if (deadAccess.has(outcome.lease.access)) {
          return { ok: false, failure: { kind: "dead-access", accountId: outcome.lease.accountId } }
        }
        return adopt(outcome.lease, "named")
      }),

    quotaExhausted: (failedAccountId, headers) =>
      serialize(async (): Promise<SharedLeaseResult> => {
        // 代次比对:排在前面的已经换过号了。
        if (held !== undefined && held.accountId !== failedAccountId) return { ok: true, lease: held }
        if (
          switchFailed !== undefined &&
          switchFailed.accountId === failedAccountId &&
          deps.now() - switchFailed.at < SWITCH_RETRY_MS
        ) {
          return { ok: false, failure: switchFailed.failure }
        }
        // 先报后租:报告先落地,master 才会把这个号标成冷却 —— 钉住的正是它时,下面的点名会被
        // 明确拒绝(cooling)并交还钉住,而不是把用满的号原样发回来。
        const resetsAt = resetsAtOf(headers)
        await deps.reportRateLimit({
          accountId: failedAccountId,
          headers: limitHeadersOf(headers),
          ...(resetsAt === undefined ? {} : { resetsAt }),
        })
        log.warn("claudecode:relay-quota-exhausted", { accountId: failedAccountId.slice(0, 8), resetsAt })
        const outcome = await autoLease("ratelimit")
        if (!outcome.ok) {
          switchFailed = { accountId: failedAccountId, at: deps.now(), failure: outcome.failure }
          log.warn("claudecode:relay-switch-failed", { kind: outcome.failure.kind, accountId: failedAccountId.slice(0, 8) })
          return outcome
        }
        switchFailed = undefined
        return adopt(outcome.lease, "ratelimit")
      }),

    unauthorized: (failedAccess) =>
      serialize(async (): Promise<SharedLeaseResult> => {
        if (held !== undefined && held.access !== failedAccess) return { ok: true, lease: held }
        deadAccess.add(failedAccess)
        log.warn("claudecode:relay-unauthorized", { accountId: held?.accountId.slice(0, 8) })
        const outcome = await autoLease("prelease")
        return outcome.ok ? adopt(outcome.lease, "unauthorized") : outcome
      }),
  }
}
