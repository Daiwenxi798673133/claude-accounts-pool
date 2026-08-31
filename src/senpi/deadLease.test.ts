import { describe, expect, test } from "bun:test"
import { leaseLiveAccess, type DeadLeaseRequest } from "./deadLease.ts"
import type { LeaseOutcome } from "../worker/leaseClient.ts"

// A lease answer shaped like the master's, with a horizon far enough out that nothing else
// would refuse it — the only thing under test here is whether the ACCESS is a known corpse.
const granted = (accountId: string, access: string): LeaseOutcome => ({
  ok: true,
  lease: { accountId, access, expiresAt: 9_000_000_000_000 },
})

describe("leaseLiveAccess", () => {
  test("master 原样发回已知死 token 时，剥掉指名与钉住并排除该账号重试一次", async () => {
    const calls: DeadLeaseRequest[] = []
    const outcome = await leaseLiveAccess(
      {
        deadAccess: new Set(["dead-token"]),
        lease: (input) => {
          calls.push(input)
          return Promise.resolve(calls.length === 1 ? granted("acct-dead", "dead-token") : granted("acct-live", "live-token"))
        },
      },
      { reason: "prelease", currentAccountId: "acct-dead", preferredAccountIdPrefix: "acct-dea", pinned: true },
    )

    expect(outcome).toEqual(granted("acct-live", "live-token"))
    expect(calls).toHaveLength(2)
    // 重试必须把尸体排除掉，并且不再指名它——一枚被吊销的令牌按名字要也只会原样再来一次。
    // currentAccountId 保留：它说的是"正在离开哪个账号"，正是 master 的轮换锚点。
    expect(calls[1]).toEqual({
      reason: "prelease",
      currentAccountId: "acct-dead",
      excludeAccountIds: ["acct-dead"],
    })
  })

  test("重试仍是死 token 时返回 dead-access 失败，绝不把死令牌交出去", async () => {
    const outcome = await leaseLiveAccess(
      {
        deadAccess: new Set(["dead-token"]),
        lease: () => Promise.resolve(granted("acct-dead", "dead-token")),
      },
      { reason: "prelease" },
    )

    expect(outcome).toEqual({ ok: false, failure: { kind: "dead-access", accountId: "acct-dead" } })
  })

  test("首次就拿到健康令牌时不重试，请求原样透传", async () => {
    const calls: DeadLeaseRequest[] = []
    const input: DeadLeaseRequest = { reason: "ratelimit", currentAccountId: "acct-a", excludeAccountIds: ["acct-b"] }
    const outcome = await leaseLiveAccess(
      {
        deadAccess: new Set(["dead-token"]),
        lease: (received) => {
          calls.push(received)
          return Promise.resolve(granted("acct-live", "live-token"))
        },
      },
      input,
    )

    expect(outcome).toEqual(granted("acct-live", "live-token"))
    // 稳态一轮不许多花一次往返，也不许改写调用方的请求。
    expect(calls).toEqual([input])
  })

  test("领租失败时原样上报，不额外重试", async () => {
    const calls: DeadLeaseRequest[] = []
    const outcome = await leaseLiveAccess(
      {
        deadAccess: new Set(["dead-token"]),
        lease: (received) => {
          calls.push(received)
          return Promise.resolve({ ok: false, failure: { kind: "no-account" } } satisfies LeaseOutcome)
        },
      },
      { reason: "prelease" },
    )

    expect(outcome).toEqual({ ok: false, failure: { kind: "no-account" } })
    expect(calls).toHaveLength(1)
  })
})
