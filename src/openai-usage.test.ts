import { expect, test, afterAll } from "bun:test"
import { normalizeOpenaiUsage, fetchOpenaiUsage } from "./openai-usage.ts"
import type { OpenaiOauth } from "./accounts.ts"

// No mock.module here on purpose: autoswitch.test.ts installs a process-global partial
// stub of accounts.ts that wins over any later registration, so the auth reader is
// injected instead.
const reader = (auth?: OpenaiOauth) => async () => auth

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})
const stubFetch = (fn: () => Promise<Response>) => {
  globalThis.fetch = fn as unknown as typeof fetch
}

// Captured verbatim from a live GET of the endpoint on a "go" plan.
const goPlanPayload = {
  user_id: "user-abc",
  account_id: "user-abc",
  email: "someone@example.com",
  plan_type: "go",
  rate_limit: {
    allowed: true,
    limit_reached: false,
    primary_window: { used_percent: 0, limit_window_seconds: 2592000, reset_after_seconds: 2591545, reset_at: 1787903707 },
    secondary_window: null,
  },
  credits: { has_credits: false },
}

const loggedIn: OpenaiOauth = { type: "oauth", access: "tok-123", accountId: "acct-456" }

test("O1:真实 go 计划响应 → 单个 30d 窗口,带 email 与 plan", () => {
  const out = normalizeOpenaiUsage(goPlanPayload)
  expect(out.email).toBe("someone@example.com")
  expect(out.planType).toBe("go")
  expect(out.windows).toHaveLength(1)
  expect(out.windows[0].label).toBe("30d")
  expect(out.windows[0].utilization).toBe(0)
  expect(out.windows[0].resets_at).toBe(new Date(1787903707 * 1000).toISOString())
})

test("O2:双窗口 → 按 primary,secondary 顺序产出,标签各自换算", () => {
  const out = normalizeOpenaiUsage({
    rate_limit: {
      primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_at: 1787903707 },
      secondary_window: { used_percent: 88, limit_window_seconds: 604800, reset_at: 1788003707 },
    },
  })
  expect(out.windows.map((w) => w.label)).toEqual(["5h", "7d"])
  expect(out.windows.map((w) => w.utilization)).toEqual([42, 88])
})

test("O3:rate_limit 缺失/为 null → 空窗口,不抛错", () => {
  expect(normalizeOpenaiUsage({}).windows).toEqual([])
  expect(normalizeOpenaiUsage({ rate_limit: null }).windows).toEqual([])
})

test("O4:used_percent 非数字 → 跳过该窗口,不产出占位", () => {
  const out = normalizeOpenaiUsage({
    rate_limit: {
      primary_window: { used_percent: null, limit_window_seconds: 18000 },
      secondary_window: { used_percent: 7, limit_window_seconds: 18000 },
    },
  })
  expect(out.windows).toHaveLength(1)
  expect(out.windows[0].utilization).toBe(7)
})

// The project refuses to render invented countdowns elsewhere (cooldown without a real
// reset); an absent reset_at must stay absent rather than become "now".
test("O5:reset_at 缺失 → resets_at 为 undefined,绝不编造倒计时", () => {
  const out = normalizeOpenaiUsage({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000 } } })
  expect(out.windows[0].resets_at).toBeUndefined()
})

test("O6:垃圾载荷 → 空结果,不抛错", () => {
  for (const junk of [null, undefined, "nope", 42, []]) {
    expect(normalizeOpenaiUsage(junk).windows).toEqual([])
  }
})

test("O7:未登录 ChatGPT → undefined(面板整块省略)", async () => {
  expect(await fetchOpenaiUsage(reader(undefined))).toBeUndefined()
  expect(await fetchOpenaiUsage(reader({ type: "oauth" }))).toBeUndefined()
})

test("O8:401/403 → needsReauth,不当成普通错误", async () => {
  for (const status of [401, 403]) {
    stubFetch(async () => new Response("", { status }))
    const out = await fetchOpenaiUsage(reader(loggedIn))
    expect(out?.needsReauth).toBe(true)
    expect(out?.error).toBeUndefined()
  }
})

test("O9:5xx → 诚实报错,不静默成 0%", async () => {
  stubFetch(async () => new Response("", { status: 503 }))
  const out = await fetchOpenaiUsage(reader(loggedIn))
  expect(out?.error).toContain("503")
  expect(out?.windows).toEqual([])
})

test("O10:网络异常 → 收敛成 error 字段,不向上抛", async () => {
  stubFetch(async () => {
    throw new Error("boom")
  })
  const out = await fetchOpenaiUsage(reader(loggedIn))
  expect(out?.error).toBe("boom")
})

test("O11:200 → 归一化结果,且请求带上 Bearer 与 ChatGPT-Account-Id", async () => {
  let seen: Record<string, string> | undefined
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    seen = init.headers as Record<string, string>
    return new Response(JSON.stringify(goPlanPayload), { status: 200 })
  }) as unknown as typeof fetch
  const out = await fetchOpenaiUsage(reader(loggedIn))
  expect(out?.windows[0].label).toBe("30d")
  expect(seen?.Authorization).toBe("Bearer tok-123")
  expect(seen?.["ChatGPT-Account-Id"]).toBe("acct-456")
})
