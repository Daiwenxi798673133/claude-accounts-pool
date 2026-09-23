// 本机声明簿:这台机器当前有哪些 claude-pool 会话、各自占着哪个账号。
//
// 所有会话共用【一个】 workerId,所以 master 无法区分它们 —— 它的租约账本按 workerId 键,一个标签
// 只记得住最后一条。于是"两个会话别拿同一个号"这件事必须在本机解决,靠 LeaseRequest 的
// excludeAccountIds(协议里本来就是为这个准备的字段)。
//
// 【惊群是这里唯一真正的敌人】,而且形态是确定的 —— src/senpi/slotRoster.ts 的注释已经把它写死了:
// N 个会话同时启动,各自读"本机已持有哪些号"、都读到空、都带着空排除集去租号,于是 master 把同一个
// 号发给所有人,一个 5 小时窗口被 N 倍烧。
//
//   所以:【读排除集 → 租号 → 写声明】必须是同一个临界区,不是调用方按顺序做的三件事。
//   这也是本模块只导出一个动词(leaseWithClaim)而不是导出三个的原因 —— 把它们拆开给调用方,
//   就等于把那个竞态重新做成可表达的。
//
// 【锁的策略与 senpi 的 slotLock 相反,这是有意的】。那边是续期循环,抢不到就跳过一个 tick,代价为零;
// 这边是启动器,抢不到就等于启动失败。所以这里【有界等待】。能这么做的前提是租号用 attempts:1 ——
// 一次带超时的 HTTP 请求,而不是 8 次、最长十分钟的退避。拿那种退避进临界区会让一次 master 故障
// 把这台机器上所有的启动都堵死。
import type { LeaseFailure, LeaseOutcome } from "../worker/leaseClient.ts"
import { log } from "../logger.ts"
import type { Preference } from "./pin.ts"

export type Claim = {
  accountId: string
  // 持有这个声明的启动器进程。进程没了,声明就该消失 —— 否则一台机器崩过几次之后,池子在它眼里
  // 会越来越小,直到再也租不到号。
  pid: number
  // 租约的到期时刻。pid 可能被系统回收给另一个无关进程,所以只靠 pid 存活判断是不够的。
  expiresAt: number
}

export type ClaimStore = {
  // 同步读:它在临界区里被调用,而临界区越短越好。
  read: () => Claim[]
  write: (claims: readonly Claim[]) => void
}

/** 剔掉死进程与过期的声明。两个条件都要,理由见 Claim.expiresAt。 */
export function liveClaims(
  claims: readonly Claim[],
  now: number,
  isAlive: (pid: number) => boolean,
): Claim[] {
  return claims.filter((claim) => claim.expiresAt > now && isAlive(claim.pid))
}

export type ClaimedLease =
  | {
      ok: true
      lease: { accountId: string; access: string; expiresAt: number }
      release: () => Promise<void>
      // "想点名但这次点不成"的那句话,由调用方转达给操作者。
      notice?: string
    }
  | { ok: false; reason: "lock-unavailable" }
  | { ok: false; reason: "at-capacity"; held: number }
  | { ok: false; reason: "lease-failed"; failure: LeaseFailure; notice?: string }

export type ClaimedLeaseDeps = {
  // 有界等待的机器级锁。undefined = 等不到 —— 调用方必须当成失败,绝不能绕过它去租号:
  // 不在锁里租号正是本模块存在要防的那件事。
  withLock: <T>(fn: () => Promise<T>) => Promise<T | undefined>
  store: ClaimStore
  // 已绑定 workerId 的租号动词。排除集与点名都由本模块在临界区内算出来。
  lease: (input: {
    excludeAccountIds: readonly string[]
    preferredAccountIdPrefix?: string
    pinned?: boolean
  }) => Promise<LeaseOutcome>
  // 点名哪个账号 —— 必须在临界区【里面】算,因为"要点的那个是不是已被本机另一个会话占着"
  // 只有拿到活声明才知道。放在外面算就会在并发下同时对 master 说"别给我这个"和"就要这个"。
  preferenceFor?: (heldAccountIds: readonly string[]) => Preference
  // master 明说不服务被点名的账号时调用。钉住必须在这里交还 —— 否则每次启动都点它、每次被拒、
  // 每次白跑一趟往返,而操作者早就被告知过它不可用。
  onPreferenceRefused?: () => void
  maxSessions: number
  pid: number
  isAlive: (pid: number) => boolean
  now: () => number
}

export async function leaseWithClaim(deps: ClaimedLeaseDeps): Promise<ClaimedLease> {
  const result = await deps.withLock(async (): Promise<ClaimedLease> => {
    // 1. 先回收。不回收就租号,会让崩过的会话永久占着排除位,池子在这台机器眼里越来越小。
    const live = liveClaims(deps.store.read(), deps.now(), deps.isAlive)

    // 2. 容量检查【在锁里】。放在锁外的话,N 个同时启动的会话会各自看到"还有位置"。
    if (live.length >= deps.maxSessions) {
      // 回收的结果仍然落盘:下一个会话就不用重算了,而且这是唯一能把死声明清出去的路径。
      deps.store.write(live)
      return { ok: false, reason: "at-capacity", held: live.length }
    }

    // 3. 带着排除集去租。master 的 fewestHolders 对我们这个标签只看得见一条,所以"别给我这些号"
    //    必须由我们自己说出口。
    const held = live.map((claim) => claim.accountId)
    const preference = deps.preferenceFor?.(held) ?? {}
    const outcome = await deps.lease({
      excludeAccountIds: held,
      ...(preference.prefix === undefined ? {} : { preferredAccountIdPrefix: preference.prefix, pinned: preference.pinned }),
    })
    if (!outcome.ok) {
      // 被点名的账号不可用(冷却中/需重登/已满员/前缀不唯一),master 明说了。绝不替换成别的:
      // 操作者的用量归属依赖"我要的就是我拿到的"(与 src/worker/manualSwitch.ts 同一条规矩)。
      if (outcome.failure.kind === "refused" && preference.prefix !== undefined) deps.onPreferenceRefused?.()
      deps.store.write(live) // 顺手把回收结果落盘;失败不写任何新声明,别毒化账本
      return { ok: false, reason: "lease-failed", failure: outcome.failure, notice: preference.notice }
    }

    // 4. 声明与租号在同一个临界区内完成 —— 这一整段就是防惊群的全部。
    const claim: Claim = { accountId: outcome.lease.accountId, pid: deps.pid, expiresAt: outcome.lease.expiresAt }
    deps.store.write([...live, claim])
    log.info("claudecode:claim-taken", { accountId: claim.accountId.slice(0, 8), held: live.length + 1 })

    return {
      ok: true,
      lease: outcome.lease,
      notice: preference.notice,
      // 撤销也必须在锁里做,否则它会与另一个会话的"读-改-写"互相覆盖。
      release: async () => {
        await deps.withLock(async () => {
          const remaining = liveClaims(deps.store.read(), deps.now(), deps.isAlive).filter(
            (held) => !(held.pid === deps.pid && held.accountId === claim.accountId),
          )
          deps.store.write(remaining)
          log.info("claudecode:claim-released", { accountId: claim.accountId.slice(0, 8) })
        })
      },
    }
  })
  // 等不到锁:明确失败,绝不"那就不带排除集直接租吧"。
  return result ?? { ok: false, reason: "lock-unavailable" }
}
