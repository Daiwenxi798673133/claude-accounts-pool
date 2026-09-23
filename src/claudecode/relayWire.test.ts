import { expect, test } from "bun:test"
import { downstreamHeaders, isQuotaExhausted, limitHeadersOf, relayErrorResponse, resetsAtOf, upstreamHeaders } from "./relayWire.ts"

const reqId = () => "req-1"

test("上游请求头:凭证换成当前租约,其余原样照抄", () => {
  const out = upstreamHeaders(
    new Headers({
      authorization: "Bearer frozen-startup-token",
      "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
      "user-agent": "claude-cli/2.1.280 (external, cli)",
      "x-app": "cli",
      "accept-encoding": "gzip, br",
    }),
    "current-lease",
    reqId,
  )
  expect(out.get("authorization")).toBe("Bearer current-lease")
  // anthropic-beta 原样过,不做白名单:官方警告把头当封闭列表的网关会在下个版本坏掉。
  expect(out.get("anthropic-beta")).toBe("claude-code-20250219,oauth-2025-04-20")
  expect(out.get("user-agent")).toBe("claude-cli/2.1.280 (external, cli)")
  expect(out.get("x-app")).toBe("cli")
  // 压缩协商原样交给上游:回来的字节不解压直接回传,两边对得上。
  expect(out.get("accept-encoding")).toBe("gzip, br")
})

test("x-api-key 不到达上游:它出现说明客户端被配进了别的车道", () => {
  const out = upstreamHeaders(new Headers({ "x-api-key": "sk-ant-api03-x" }), "lease", reqId)
  expect(out.has("x-api-key")).toBe(false)
  expect(out.get("authorization")).toBe("Bearer lease")
})

test("逐跳头、host、content-length 不转发", () => {
  const out = upstreamHeaders(
    new Headers({ host: "127.0.0.1:18787", connection: "keep-alive", "content-length": "123", "transfer-encoding": "chunked" }),
    "lease",
    reqId,
  )
  for (const name of ["host", "connection", "content-length", "transfer-encoding"]) expect(out.has(name)).toBe(false)
})

// 原生客户端直连 api.anthropic.com 时每个请求都带它,只因 base URL 指向 127.0.0.1 才省掉。
test("x-client-request-id 缺了就补,客户端自己带了就不动", () => {
  expect(upstreamHeaders(new Headers(), "l", reqId).get("x-client-request-id")).toBe("req-1")
  expect(upstreamHeaders(new Headers({ "x-client-request-id": "mine" }), "l", reqId).get("x-client-request-id")).toBe("mine")
})

test("下游响应头:content-encoding 保留(字节没解压),逐跳头去掉", () => {
  const out = downstreamHeaders(
    new Headers({ "content-encoding": "gzip", "content-length": "30", connection: "close", "anthropic-ratelimit-unified-status": "allowed" }),
  )
  expect(out.get("content-encoding")).toBe("gzip")
  expect(out.get("anthropic-ratelimit-unified-status")).toBe("allowed")
  expect(out.has("content-length")).toBe(false)
  expect(out.has("connection")).toBe(false)
})

test.each([
  ["representative-claim", { "anthropic-ratelimit-unified-representative-claim": "five_hour" }],
  ["overage-status", { "anthropic-ratelimit-unified-overage-status": "rejected" }],
  ["unified-status rejected", { "anthropic-ratelimit-unified-status": "rejected" }],
])("429 + %s = 额度用满", (_name, headers) => {
  expect(isQuotaExhausted(429, new Headers(headers))).toBe(true)
})

// 客户端自己的注释:"No quota headers — this is NOT a quota limit"。权限类 429(1M 上下文要 Extra
// Usage)换到哪个号都一样,见 429 就换会把整个池子切一遍。
test("不带配额头的 429 不算额度用满", () => {
  expect(isQuotaExhausted(429, new Headers({ "retry-after": "10" }))).toBe(false)
  expect(isQuotaExhausted(429, new Headers({ "anthropic-ratelimit-unified-status": "allowed" }))).toBe(false)
})

test("429 之外一律不算:529 overloaded 是服务端的事", () => {
  expect(isQuotaExhausted(529, new Headers({ "anthropic-ratelimit-unified-representative-claim": "five_hour" }))).toBe(false)
  expect(isQuotaExhausted(200, new Headers({ "anthropic-ratelimit-unified-status": "rejected" }))).toBe(false)
})

// retry-after 是客户端的重试窗口,不是配额重置点:拿它冒充会让 master 一分钟后把空号发给下一台机器。
test("重置点只认 unified-reset,不拿 retry-after 兜底", () => {
  expect(resetsAtOf(new Headers({ "anthropic-ratelimit-unified-reset": "1790000000" }))).toBe(1_790_000_000_000)
  expect(resetsAtOf(new Headers({ "retry-after": "60" }))).toBeUndefined()
  expect(resetsAtOf(new Headers({ "anthropic-ratelimit-unified-reset": "garbage" }))).toBeUndefined()
})

test("上报给 master 的只有限流相关的头", () => {
  const out = limitHeadersOf(
    new Headers({
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": "1790000000",
      "retry-after": "60",
      "request-id": "req_x",
      "set-cookie": "a=b",
    }),
  )
  expect(Object.keys(out).sort()).toEqual(["anthropic-ratelimit-unified-reset", "anthropic-ratelimit-unified-status", "retry-after"])
})

test("relay 自己的错误是 Anthropic 形状的报文:5xx 让客户端重试,429 让它直接显示", async () => {
  const unavailable = relayErrorResponse(503, "连不上 master")
  expect(unavailable.status).toBe(503)
  expect(await unavailable.json()).toEqual({ type: "error", error: { type: "api_error", message: "连不上 master" } })
  const empty = relayErrorResponse(429, "没号了")
  expect(((await empty.json()) as { error: { type: string } }).error.type).toBe("rate_limit_error")
  // 不带配额头:客户端会显示 message 原文,而不是把它当成某个账号的额度用满。
  expect(isQuotaExhausted(empty.status, empty.headers)).toBe(false)
})
