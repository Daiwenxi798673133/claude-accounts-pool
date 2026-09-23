import { expect, test } from "bun:test"
import { runHook, type HookRunDeps } from "./hookRun.ts"

type Reported = { accountId: string; headers: Record<string, string> }

function harness(over: Partial<HookRunDeps> = {}) {
  const reports: Reported[] = []
  const deps: HookRunDeps = {
    readStdin: async () => JSON.stringify({ hook_event_name: "StopFailure", error_type: "rate_limit" }),
    reportRateLimit: async (input) => (reports.push(input), true),
    accountId: "af008f89-1111-2222-3333-444455556666",
    ...over,
  }
  return { deps, reports }
}

test("撞限流:上报给 master,带账号、不带 headers、不带期限", async () => {
  const h = harness()
  await runHook(h.deps)
  expect(h.reports).toHaveLength(1)
  expect(h.reports[0].accountId).toBe("af008f89-1111-2222-3333-444455556666")
  expect(h.reports[0].headers).toEqual({})
})

// 这条是整个模块最重要的断言:把鉴权失败当限流上报,会把一个额度健康的号打进冷却。
test.each(["authentication_failed", "oauth_org_not_allowed", "account_on_hold"])(
  "%s:一个字都不上报",
  async (errorType) => {
    const h = harness({ readStdin: async () => JSON.stringify({ hook_event_name: "StopFailure", error_type: errorType }) })
    await runHook(h.deps)
    expect(h.reports).toEqual([])
  },
)

test.each(["overloaded", "server_error", "unknown"])("%s 与额度无关,不上报", async (errorType) => {
  const h = harness({ readStdin: async () => JSON.stringify({ hook_event_name: "StopFailure", error_type: errorType }) })
  await runHook(h.deps)
  expect(h.reports).toEqual([])
})

test("挂在非池子会话上(没有账号变量)时不上报,也不抛", async () => {
  const h = harness({ accountId: undefined })
  await expect(runHook(h.deps)).resolves.toBeUndefined()
  expect(h.reports).toEqual([])
})

test("报文不是 JSON 时不抛 —— 钩子崩溃会在操作者的终端里留下噪声", async () => {
  const h = harness({ readStdin: async () => "not json at all" })
  await expect(runHook(h.deps)).resolves.toBeUndefined()
  expect(h.reports).toEqual([])
})

test("master 不可达时安静收场:这一轮对话已经失败了,没有什么在等这条遥测", async () => {
  const h = harness({ reportRateLimit: async () => false })
  await expect(runHook(h.deps)).resolves.toBeUndefined()
})
