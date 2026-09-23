import { expect, test } from "bun:test"
import type { LeaseOutcome } from "../worker/leaseClient.ts"
import { LEASE_RENEW_BUFFER_MS } from "../constants.ts"
import { createSharedLease, SWITCH_RETRY_MS, type SharedLeaseDeps } from "./sharedLease.ts"

const A = "aaaaaaaa-0000-0000-0000-000000000000"
const B = "bbbbbbbb-0000-0000-0000-000000000000"
const C = "cccccccc-0000-0000-0000-000000000000"
const QUOTA = new Headers({
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": "1790000000",
})

type LeaseCall = Parameters<SharedLeaseDeps["lease"]>[0]
type ReportCall = Parameters<SharedLeaseDeps["reportRateLimit"]>[0]

// 假 master:按脚本发号,记录每一次请求。`delay` 让租约请求真的"在飞",并发用例靠它让多个调用者
// 同时排进队列 —— 没有它,串行化是否生效根本测不出来。
function harness(opts: { answers?: ((call: LeaseCall) => LeaseOutcome)[]; pin?: string; delay?: number } = {}) {
  let now = 1_700_000_000_000
  let pin = opts.pin
  const leases: LeaseCall[] = []
  const reports: ReportCall[] = []
  const answers = [...(opts.answers ?? [])]
  let served = 0
  const deps: SharedLeaseDeps = {
    lease: async (call) => {
      leases.push(call)
      if (opts.delay) await new Promise((r) => setTimeout(r, opts.delay))
      const next = answers.shift()
      if (next) return next(call)
      served++
      return grant(call.currentAccountId ?? A, `access-${served}`)
    },
    reportRateLimit: async (call) => {
      reports.push(call)
      return true
    },
    pin: { read: () => pin, write: (next) => void (pin = next) },
    now: () => now,
  }
  const grant = (accountId: string, access: string, ttl = 3 * 3600_000): LeaseOutcome => ({
    ok: true,
    lease: { accountId, access, expiresAt: now + ttl },
  })
  return {
    shared: createSharedLease(deps),
    leases,
    reports,
    grant,
    advance: (ms: number) => void (now += ms),
    pin: () => pin,
    setPin: (next: string | undefined) => void (pin = next),
  }
}

test("首次 ensure 领一个号,之后在视界内不再问 master", async () => {
  const h = harness()
  const first = await h.shared.ensure()
  expect(first.ok && first.lease.accountId).toBe(A)
  await h.shared.ensure()
  await h.shared.ensure()
  expect(h.leases).toHaveLength(1)
  expect(h.leases[0].reason).toBe("prelease")
})

// 到期只续期,不换号:prompt cache 按 organization 隔离,换号 = 整段重写缓存。
test("快到期时续期,带着 currentAccountId —— master 据此保留同一个号", async () => {
  const h = harness()
  await h.shared.ensure()
  h.advance(3 * 3600_000 - LEASE_RENEW_BUFFER_MS + 1)
  const renewed = await h.shared.ensure()
  expect(h.leases).toHaveLength(2)
  expect(h.leases[1]).toEqual({ reason: "prelease", currentAccountId: A })
  expect(renewed.ok && renewed.lease.access).toBe("access-2")
})

test("续期失败但手里那枚还能用:接着用,不把一次 master 抖动变成所有会话的报错", async () => {
  const h = harness({
    answers: [() => h.grant(A, "x"), () => ({ ok: false, failure: { kind: "unreachable", detail: "ECONNREFUSED" } })],
  })
  await h.shared.ensure()
  h.advance(3 * 3600_000 - 60_000) // 进入续期窗口,但还没过期
  const kept = await h.shared.ensure()
  expect(h.leases).toHaveLength(2)
  expect(kept.ok && kept.lease.access).toBe("x")
})

test("续期失败且手里那枚已过期:如实失败", async () => {
  const h = harness({ answers: [() => h.grant(A, "x"), () => ({ ok: false, failure: { kind: "no-account" } })] })
  await h.shared.ensure()
  h.advance(3 * 3600_000 + 1)
  const result = await h.shared.ensure()
  expect(result.ok).toBe(false)
})

// 这就是整套设计要防的那件事:5 个会话共用一个号,5 个请求同时吃到 429。
test("N 个请求同时在 A 上撞额度:只上报一次、只换一次号,所有人都拿到 B", async () => {
  const h = harness({
    delay: 20,
    answers: [() => h.grant(A, "access-A"), () => h.grant(B, "access-B")],
  })
  await h.shared.ensure()
  const results = await Promise.all(Array.from({ length: 5 }, () => h.shared.quotaExhausted(A, QUOTA)))
  expect(h.reports).toHaveLength(1)
  expect(h.reports[0].accountId).toBe(A)
  expect(h.leases.filter((c) => c.reason === "ratelimit")).toHaveLength(1)
  for (const r of results) expect(r.ok && r.lease.accountId).toBe(B)
})

test("换号请求带着被用满的号作 currentAccountId,master 据此排除它", async () => {
  const h = harness({ answers: [() => h.grant(A, "a"), () => h.grant(B, "b")] })
  await h.shared.ensure()
  await h.shared.quotaExhausted(A, QUOTA)
  expect(h.leases[1]).toEqual({ reason: "ratelimit", currentAccountId: A })
})

test("上报带上 unified-reset 作 resetsAt,且只带限流相关的头", async () => {
  const h = harness({ answers: [() => h.grant(A, "a"), () => h.grant(B, "b")] })
  await h.shared.ensure()
  await h.shared.quotaExhausted(A, QUOTA)
  expect(h.reports[0].resetsAt).toBe(1_790_000_000_000)
  expect(Object.keys(h.reports[0].headers).every((k) => k.startsWith("anthropic-ratelimit-"))).toBe(true)
})

// 代次比对:一个在 A 上发出、却在换号之后才回来的 429,不该再把 B 也换掉。
test("迟到的 429(号已经换过了):不上报、不换号,直接拿当前的", async () => {
  const h = harness({ answers: [() => h.grant(A, "a"), () => h.grant(B, "b")] })
  await h.shared.ensure()
  await h.shared.quotaExhausted(A, QUOTA)
  const late = await h.shared.quotaExhausted(A, QUOTA)
  expect(late.ok && late.lease.accountId).toBe(B)
  expect(h.reports).toHaveLength(1)
  expect(h.leases).toHaveLength(2)
})

test("B 也用满了:再换一次,上报的是 B", async () => {
  const h = harness({ answers: [() => h.grant(A, "a"), () => h.grant(B, "b"), () => h.grant(C, "c")] })
  await h.shared.ensure()
  await h.shared.quotaExhausted(A, QUOTA)
  const again = await h.shared.quotaExhausted(B, QUOTA)
  expect(again.ok && again.lease.accountId).toBe(C)
  expect(h.reports.map((r) => r.accountId)).toEqual([A, B])
})

// 池子空了的那几分钟里,不能每个请求都对 master 一次上报加一次租约。
test("换号失败后,同一个号上的 429 在冷静期内不再打扰 master", async () => {
  const h = harness({ answers: [() => h.grant(A, "a"), () => ({ ok: false, failure: { kind: "no-account" } })] })
  await h.shared.ensure()
  expect((await h.shared.quotaExhausted(A, QUOTA)).ok).toBe(false)
  expect((await h.shared.quotaExhausted(A, QUOTA)).ok).toBe(false)
  expect(h.reports).toHaveLength(1)
  expect(h.leases).toHaveLength(2)
  h.advance(SWITCH_RETRY_MS)
  await h.shared.quotaExhausted(A, QUOTA)
  expect(h.reports).toHaveLength(2)
})

test("401:续一次,拿回新 access 就用新的", async () => {
  const h = harness({ answers: [() => h.grant(A, "dead"), () => h.grant(A, "fresh")] })
  await h.shared.ensure()
  const next = await h.shared.unauthorized("dead")
  expect(next.ok && next.lease.access).toBe("fresh")
  expect(h.leases[1]).toEqual({ reason: "prelease", currentAccountId: A })
})

// master 在视界够宽时返回缓存的那枚 —— 吊销了也原样返回(src/senpi/deadLease.ts)。
test("401 后 master 发回同一具尸体:排除这个号再租一次", async () => {
  const h = harness({ answers: [() => h.grant(A, "dead"), () => h.grant(A, "dead"), () => h.grant(B, "b")] })
  await h.shared.ensure()
  const next = await h.shared.unauthorized("dead")
  expect(next.ok && next.lease.accountId).toBe(B)
  expect(h.leases[2].excludeAccountIds).toEqual([A])
})

test("N 个请求同时吃 401:只续一次", async () => {
  const h = harness({ delay: 20, answers: [() => h.grant(A, "dead"), () => h.grant(A, "fresh")] })
  await h.shared.ensure()
  const results = await Promise.all(Array.from({ length: 4 }, () => h.shared.unauthorized("dead")))
  expect(h.leases).toHaveLength(2)
  for (const r of results) expect(r.ok && r.lease.access).toBe("fresh")
})

test("钉住:自动续期点名钉住的号", async () => {
  const h = harness({ pin: "bbbbbbbb", answers: [() => h.grant(B, "b")] })
  await h.shared.ensure()
  expect(h.leases[0]).toEqual({ reason: "prelease", preferredAccountIdPrefix: "bbbbbbbb", pinned: true })
})

// 额度用满前不被轮换走 —— 用满了,master 以 cooling 拒绝点名,钉住随之交还,再按排名换号。
test("钉住的号撞额度:先报后租,点名被拒后交还钉住并按排名换号", async () => {
  const h = harness({
    pin: "aaaaaaaa",
    answers: [
      () => h.grant(A, "a"),
      () => ({ ok: false, failure: { kind: "refused", refused: "cooling" } }),
      () => h.grant(B, "b"),
    ],
  })
  await h.shared.ensure()
  const next = await h.shared.quotaExhausted(A, QUOTA)
  expect(next.ok && next.lease.accountId).toBe(B)
  expect(h.pin()).toBeUndefined()
  expect(h.leases[1]).toMatchObject({ reason: "ratelimit", currentAccountId: A, preferredAccountIdPrefix: "aaaaaaaa" })
  expect(h.leases[2]).toEqual({ reason: "ratelimit", currentAccountId: A })
})

test("网络故障不交还钉住:那说明不了这个号能不能服务", async () => {
  const h = harness({ pin: "bbbbbbbb", answers: [() => ({ ok: false, failure: { kind: "unreachable", detail: "x" } })] })
  await h.shared.ensure()
  expect(h.pin()).toBe("bbbbbbbb")
})

test("操作者点名:切到那个号,且点名请求带着当前号", async () => {
  const h = harness({ answers: [() => h.grant(A, "a"), () => h.grant(B, "b")] })
  await h.shared.ensure()
  const named = await h.shared.name("bbbbbbbb", false)
  expect(named.ok && named.lease.accountId).toBe(B)
  expect(h.leases[1]).toEqual({ reason: "prelease", currentAccountId: A, preferredAccountIdPrefix: "bbbbbbbb", pinned: false })
})

test("点名的就是当前号:不问 master", async () => {
  const h = harness({ answers: [() => h.grant(A, "a")] })
  await h.shared.ensure()
  await h.shared.name("aaaaaaaa", false)
  expect(h.leases).toHaveLength(1)
})

// 用量归属依赖"我要的就是我拿到的"。
test("点名被拒:如实失败,绝不替换成别的号;被拒的正是钉住的那个就交还钉住", async () => {
  const h = harness({ answers: [() => h.grant(A, "a"), () => ({ ok: false, failure: { kind: "refused", refused: "cooling" } })] })
  await h.shared.ensure()
  h.setPin("bbbbbbbb")
  const refused = await h.shared.name("bbbbbbbb", true)
  expect(refused.ok).toBe(false)
  expect(h.leases).toHaveLength(2) // 没有第三次"那就随便给一个"的租约
  expect(h.shared.current()?.accountId).toBe(A) // 其余会话继续用 A
  expect(h.pin()).toBeUndefined()
})

test("点名拿回一枚本进程见过 401 的 access:如实失败,不静默换号", async () => {
  const h = harness({ answers: [() => h.grant(A, "dead"), () => h.grant(B, "b"), () => h.grant(A, "dead")] })
  await h.shared.ensure()
  await h.shared.unauthorized("dead")
  const named = await h.shared.name("aaaaaaaa", false)
  expect(named.ok).toBe(false)
  expect(!named.ok && named.failure.kind).toBe("dead-access")
})
