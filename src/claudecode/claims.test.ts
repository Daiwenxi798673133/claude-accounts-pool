import { expect, test } from "bun:test"
import type { LeaseOutcome } from "../worker/leaseClient.ts"
import { leaseWithClaim, liveClaims, type Claim, type ClaimedLeaseDeps } from "./claims.ts"

const NOW = 1_700_000_000_000
const HOUR = 3600_000

// 串行化的假锁:真锁的原子性由 scripts/e2e-claude-pool-herd.ts 用真进程证明,这里证明的是
// 【在锁确实串行化的前提下,逻辑组合出来的结果对不对】。
function serialLock() {
  let tail: Promise<unknown> = Promise.resolve()
  let concurrent = 0
  let maxConcurrent = 0
  const withLock = async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    const run = tail.then(async () => {
      maxConcurrent = Math.max(maxConcurrent, ++concurrent)
      try {
        return await fn()
      } finally {
        concurrent--
      }
    })
    tail = run.catch(() => {})
    return run as Promise<T>
  }
  return { withLock, peakConcurrency: () => maxConcurrent }
}

function harness(over: Partial<ClaimedLeaseDeps> & { initial?: Claim[]; accounts?: string[] } = {}) {
  let book: Claim[] = over.initial ?? []
  const excludesSeen: string[][] = []
  const accounts = over.accounts ?? ["acc-a", "acc-b", "acc-c", "acc-d"]
  let served = 0
  const lock = serialLock()
  const deps: ClaimedLeaseDeps = {
    withLock: lock.withLock,
    store: { read: () => [...book], write: (next) => void (book = [...next]) },
    lease: async (excludeAccountIds): Promise<LeaseOutcome> => {
      excludesSeen.push([...excludeAccountIds])
      // 假 master:发第一个没被排除的号 —— 于是"排除集算错了"会立刻表现成"两个会话拿到同一个号"
      const pick = accounts.find((id) => !excludeAccountIds.includes(id))
      if (!pick) return { ok: false, failure: { kind: "no-account" } }
      served++
      return { ok: true, lease: { accountId: pick, access: `tok-${served}`, expiresAt: NOW + 3 * HOUR } }
    },
    maxSessions: 4,
    pid: 100,
    isAlive: () => true,
    now: () => NOW,
    ...over,
  }
  return { deps, book: () => book, excludesSeen, lock }
}

test("空机器:排除集为空,拿到号后写进声明簿", async () => {
  const h = harness()
  const result = await leaseWithClaim(h.deps)
  expect(result.ok).toBe(true)
  expect(h.excludesSeen).toEqual([[]])
  expect(h.book()).toEqual([{ accountId: "acc-a", pid: 100, expiresAt: NOW + 3 * HOUR }])
})

test("已有会话占着号:排除集带上它们", async () => {
  const h = harness({ initial: [{ accountId: "acc-a", pid: 7, expiresAt: NOW + HOUR }] })
  const result = await leaseWithClaim(h.deps)
  expect(h.excludesSeen).toEqual([["acc-a"]])
  expect(result.ok && result.lease.accountId).toBe("acc-b")
})

// 不回收就租号,会让崩过的会话永久占着排除位,池子在这台机器眼里越来越小,直到再也租不到。
test("死进程的声明被回收:不进排除集,而且回收结果落盘", async () => {
  const h = harness({
    initial: [
      { accountId: "acc-a", pid: 7, expiresAt: NOW + HOUR },
      { accountId: "acc-b", pid: 8, expiresAt: NOW + HOUR },
    ],
    isAlive: (pid) => pid !== 7,
  })
  await leaseWithClaim(h.deps)
  expect(h.excludesSeen).toEqual([["acc-b"]])
  expect(h.book().map((c) => c.accountId).sort()).toEqual(["acc-a", "acc-b"])
  expect(h.book().find((c) => c.pid === 7)).toBeUndefined()
})

// pid 会被系统回收给另一个无关进程,所以只靠存活判断不够。
test("过期的声明也被回收,即使进程还活着", async () => {
  const h = harness({ initial: [{ accountId: "acc-a", pid: 7, expiresAt: NOW - 1 }] })
  await leaseWithClaim(h.deps)
  expect(h.excludesSeen).toEqual([[]])
})

test("容量在锁里检查,而且算的是回收之后的数量", async () => {
  const h = harness({
    maxSessions: 2,
    initial: [
      { accountId: "acc-a", pid: 7, expiresAt: NOW + HOUR },
      { accountId: "acc-b", pid: 8, expiresAt: NOW + HOUR },
    ],
  })
  const result = await leaseWithClaim(h.deps)
  expect(result).toEqual({ ok: false, reason: "at-capacity", held: 2 })
  expect(h.excludesSeen).toEqual([]) // 满了就不该去打扰 master
})

test("死声明不占容量", async () => {
  const h = harness({
    maxSessions: 2,
    initial: [
      { accountId: "acc-a", pid: 7, expiresAt: NOW + HOUR },
      { accountId: "acc-b", pid: 8, expiresAt: NOW + HOUR },
    ],
    isAlive: (pid) => pid !== 8,
  })
  expect((await leaseWithClaim(h.deps)).ok).toBe(true)
})

test("租号失败:不写新声明,但回收结果保留", async () => {
  const h = harness({
    initial: [{ accountId: "acc-a", pid: 7, expiresAt: NOW - 1 }],
    lease: async () => ({ ok: false, failure: { kind: "unreachable", detail: "x" } }),
  })
  const result = await leaseWithClaim(h.deps)
  expect(result).toEqual({ ok: false, reason: "lease-failed", failure: { kind: "unreachable", detail: "x" } })
  expect(h.book()).toEqual([])
})

// 不在锁里租号正是本模块存在要防的那件事 —— 等不到锁就失败,绝不降级成"那就不带排除集直接租"。
test("等不到锁:明确失败,一次租约都不发", async () => {
  const h = harness({ withLock: async () => undefined })
  const result = await leaseWithClaim(h.deps)
  expect(result).toEqual({ ok: false, reason: "lock-unavailable" })
  expect(h.excludesSeen).toEqual([])
})

test("撤销只删自己那条,别人的原样留着", async () => {
  const h = harness({ initial: [{ accountId: "acc-z", pid: 9, expiresAt: NOW + HOUR }] })
  const result = await leaseWithClaim(h.deps)
  expect(result.ok).toBe(true)
  if (!result.ok) return
  await result.release()
  expect(h.book()).toEqual([{ accountId: "acc-z", pid: 9, expiresAt: NOW + HOUR }])
})

// 这是整个模块存在的理由:N 个会话同时启动,不能拿到同一个号。
test("惊群:四个会话同时启动,拿到四个不同的号", async () => {
  const h = harness({ maxSessions: 4 })
  const results = await Promise.all(
    [101, 102, 103, 104].map((pid) => leaseWithClaim({ ...h.deps, pid })),
  )
  const got = results.map((r) => (r.ok ? r.lease.accountId : `失败:${r.reason}`))
  expect(new Set(got).size).toBe(4)
  expect(got.every((id) => id.startsWith("acc-"))).toBe(true)
  // 排除集必须是递增的 —— 每个人都看得见前面那些人的声明,这正是"同一个临界区"的可观测形态
  expect(h.excludesSeen.map((e) => e.length)).toEqual([0, 1, 2, 3])
  expect(h.lock.peakConcurrency()).toBe(1)
})

test("惊群且池子不够:拿到号的各不相同,拿不到的干脆失败", async () => {
  const h = harness({ maxSessions: 8, accounts: ["acc-a", "acc-b"] })
  const results = await Promise.all([101, 102, 103].map((pid) => leaseWithClaim({ ...h.deps, pid })))
  const ok = results.filter((r) => r.ok)
  expect(ok).toHaveLength(2)
  expect(new Set(ok.map((r) => (r.ok ? r.lease.accountId : ""))).size).toBe(2)
  expect(results.filter((r) => !r.ok && r.reason === "lease-failed")).toHaveLength(1)
})

test("liveClaims 两个条件都生效", () => {
  const claims: Claim[] = [
    { accountId: "a", pid: 1, expiresAt: NOW + HOUR },
    { accountId: "b", pid: 2, expiresAt: NOW - 1 },
    { accountId: "c", pid: 3, expiresAt: NOW + HOUR },
  ]
  expect(liveClaims(claims, NOW, (pid) => pid !== 3).map((c) => c.accountId)).toEqual(["a"])
})
