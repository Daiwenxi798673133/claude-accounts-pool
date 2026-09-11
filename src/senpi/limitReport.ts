// 把"这个账号的额度打满了"告诉 master —— senpi 这条链此前只在本机记账。
//
// 为什么必须上报:worker 侧的节流账本(senpi-extension.ts 的 throttledUntil)只让**本机**绕开这个号,
// master 那边它照旧是可选账号,于是同一个空号会被继续发给别的机器,每台都得自己撞一次墙才知道。
// opencode 那条链从第一天就上报(src/worker/switchStrategy.ts 的 onLimit),senpi 这条链没有,这个文件
// 补齐的就是那一半。
//
// 为什么不带 resetsAt:senpi 只留下它自己的重试窗口 `blockedUntil`。2026-09-10 实测,封锁期限是
// 16:04:20 而同一时刻响应头里的真实 5 小时重置点是 17:10:00 —— 把前者当成配额重置点发过去,等于让
// master 一分钟后又把这个空号发给下一台机器。缺省反而是诚实的:master 收到没有期限的报告会记一个
// 待定冷却,由它自己的用量轮询把真实期限填上;INV-M2 还保证这条未知期限永远不会覆盖别人报上来的
// 已知期限(src/master/scheduler.ts 的 markCooldown)。
//
// 为什么 headers 是空的:senpi 把 429 的报文整个丢了(这正是 rateLimitProbe.ts 存在的理由),而 master
// 对这个字段只按 KEY 记一条日志、不解析内容,所以这里没有可以诚实填进去的东西。
import { log } from "../logger.ts"

export type LimitReportDeps = {
  // 只要 leaseClient 的这一个动词:它自己吞掉全部故障并返回 false,所以这里既不重试也不抛。
  reportRateLimit: (input: { accountId: string; headers: Record<string, string> }) => Promise<boolean>
}

export type LimitReporter = {
  // 调用方一律 `void` 掉:这是给**别的机器**看的遥测,本机的恢复不该为它等一个网络超时。
  report: (input: { accountId: string; blockedUntil?: number }) => Promise<void>
}

export function createLimitReporter(deps: LimitReportDeps): LimitReporter {
  // 同一次封锁只上报一次。封锁期间每一轮 turn_start 都会走到这里,不去重就是对着 master 连打。
  // 键是账号(限流是账号的事),值是那次封锁的期限 —— 换一次封锁才值得再报一枪。
  const reported = new Map<string, number>()

  return {
    async report({ accountId, blockedUntil }) {
      // 没有期限的封锁也要能去重,所以用 0 占位:senpi 偶尔只留 blockReason 而不留 blockedUntil。
      const stamp = blockedUntil ?? 0
      if (reported.get(accountId) === stamp) return
      // 先占位再发。K 个槽位可能在同一瞬间为同一个账号各报一枪(限流是账号的事,封锁却是按槽位盖的),
      // 占位就是"只报一次"的那一半。
      reported.set(accountId, stamp)
      if (await deps.reportRateLimit({ accountId, headers: {} })) {
        log.info("senpi:limit-reported", { accountId, blockedUntil })
        return
      }
      // 没报到就把占位撤掉:master 往往只是暂时不可达,而下一轮对话如果还站着同一个封锁,就值得再试
      // 一次 —— 报不到的代价是别的机器继续撞这个空号,重试的代价只是一次往返。
      reported.delete(accountId)
      log.warn("senpi:limit-report-failed", { accountId, blockedUntil })
    },
  }
}
