import { expect, test } from "bun:test"
import { probeRateLimit, RATE_LIMIT_PROBE_ENDPOINT } from "./rateLimitProbe.ts"

type Captured = { url: string; init: RequestInit }

function stub(response: Response): { fetch: typeof fetch; calls: Captured[] } {
  const calls: Captured[] = []
  return {
    calls,
    fetch: ((url: string, init: RequestInit) => {
      calls.push({ url, init })
      return Promise.resolve(response)
    }) as unknown as typeof fetch,
  }
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers })
}

// 这枪打不对形状就白打:实测同一枚 token 少了 Claude Code 前缀就是 429 且零 ratelimit 头,
// 探针会把"请求被挡下"伪造成"账号被限流"。
test("探针带上 OAuth 准入所需的 Claude Code system 前缀", async () => {
  const { fetch: fetchImpl, calls } = stub(json(200, {}, {}))

  await probeRateLimit("sk-ant-oat01-token", fetchImpl)

  expect(calls).toHaveLength(1)
  expect(calls[0]?.url).toBe(RATE_LIMIT_PROBE_ENDPOINT)
  const headers = calls[0]?.init.headers as Record<string, string>
  expect(headers.authorization).toBe("Bearer sk-ant-oat01-token")
  expect(headers["anthropic-beta"]).toContain("oauth-2025-04-20")
  const sent = JSON.parse(String(calls[0]?.init.body)) as { system: { text: string }[]; max_tokens: number }
  expect(sent.system[0]?.text).toBe("You are Claude Code, Anthropic's official CLI for Claude.")
  expect(sent.max_tokens).toBe(1)
})

test("只收 ratelimit 与 retry-after 头,其余丢弃", async () => {
  const { fetch: fetchImpl } = stub(
    json(
      200,
      {},
      {
        "anthropic-ratelimit-unified-status": "allowed",
        "anthropic-ratelimit-unified-5h-utilization": "0.44",
        "retry-after": "60",
        "anthropic-organization-id": "org-1",
        "cf-ray": "abc",
      },
    ),
  )

  const probe = await probeRateLimit("token", fetchImpl)

  expect(probe.status).toBe(200)
  expect(probe.headers).toEqual({
    "anthropic-ratelimit-unified-status": "allowed",
    "anthropic-ratelimit-unified-5h-utilization": "0.44",
    "retry-after": "60",
  })
  expect(probe.body).toBeUndefined()
})

// 零头部的 429 与配额耗尽的 429 是两件事,只有 body 分得开——前者 message 是 "Error"。
test("非 2xx 保留脱敏 body,头部可以为空", async () => {
  const { fetch: fetchImpl } = stub(json(429, { type: "error", error: { type: "rate_limit_error", message: "Error" } }, {}))

  const probe = await probeRateLimit("token", fetchImpl)

  expect(probe.status).toBe(429)
  expect(probe.headers).toEqual({})
  expect(probe.body).toContain("rate_limit_error")
})
