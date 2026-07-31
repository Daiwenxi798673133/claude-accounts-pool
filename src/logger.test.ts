import { expect, test } from "bun:test"
import { diagnosticHeaders, redactBody, redactHeaders } from "./logger.ts"

test("R1:Anthropic sk-ant- key 被打码", () => {
  const out = redactBody(`{"key":"sk-ant-api03-AbC_dEf-123"}`)
  expect(out).not.toContain("sk-ant-")
  expect(out).toContain("***")
})

test("R2:OpenAI sk-proj- key 被打码", () => {
  const out = redactBody(`{"api_key":"sk-proj-AbC123_dEf-456"}`)
  expect(out).not.toContain("sk-proj-")
  expect(out).toContain("***")
})

test("R3:OpenAI 裸 sk- key 被打码", () => {
  const out = redactBody(`{"api_key":"sk-AbC123dEf456"}`)
  expect(out).not.toContain("sk-AbC123dEf456")
  expect(out).toContain("***")
})

// A too-narrow `sk-` rule running before the anthropic one would leave "ant-…" behind;
// assert no usable key remainder survives, not merely that "sk-" disappeared.
test("R4:sk-ant- 不会被截成半明文残留", () => {
  const out = redactBody(`{"key":"sk-ant-api03-SECRETTAIL"}`)
  expect(out).not.toContain("SECRETTAIL")
  expect(out).not.toContain("ant-api03")
})

test("R5:JWT(eyJ…) 被打码", () => {
  const out = redactBody(`{"id_token":"eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.SflKxwRJ"}`)
  expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9")
  expect(out).toContain("***")
})

test("R6:回归 — Bearer token 被打码", () => {
  const out = redactBody("Authorization: Bearer abc.def-123")
  expect(out).toBe("Authorization: Bearer ***")
})

test("R7:回归 — refresh_token / access_token 字段值被打码", () => {
  const out = redactBody(`{"refresh_token":"rt_secret","access_token":"at_secret"}`)
  expect(out).not.toContain("rt_secret")
  expect(out).not.toContain("at_secret")
})

test("R8:回归 — 先打码后截断,截断不会放出未打码的尾部", () => {
  const out = redactBody(`{"pad":"${"x".repeat(290)}","key":"sk-ant-TAIL"}`, 300)
  expect(out.length).toBeLessThanOrEqual(300)
  expect(out).not.toContain("sk-ant-TAIL")
})

test("R9:回归 — redactHeaders 只吐小写键名,绝不吐值", () => {
  const out = redactHeaders({ "X-Api-Key": "sk-secret", "Retry-After": "42" })
  expect(out).toEqual(["x-api-key", "retry-after"])
  expect(JSON.stringify(out)).not.toContain("sk-secret")
})

test("R10:diagnosticHeaders 保留额度遥测头的值", () => {
  const out = diagnosticHeaders({
    "X-Codex-Primary-Used-Percent": "100.0",
    "x-codex-rate-limit-reached-type": "workspace_member_usage_limit_reached",
    "Retry-After": "42",
    "anthropic-ratelimit-unified-status": "rejected",
  })
  expect(out).toEqual({
    "x-codex-primary-used-percent": "100.0",
    "x-codex-rate-limit-reached-type": "workspace_member_usage_limit_reached",
    "retry-after": "42",
    "anthropic-ratelimit-unified-status": "rejected",
  })
})

test("R11:diagnosticHeaders 丢弃白名单外的头,凭据不可能泄漏", () => {
  const out = diagnosticHeaders({
    Authorization: "Bearer sk-secret",
    Cookie: "session=secret",
    "x-api-key": "sk-secret",
    "set-cookie": "a=b",
  })
  expect(out).toEqual({})
  expect(JSON.stringify(out)).not.toContain("secret")
})

// `retry-after` is anchored end-to-end while the families are prefix-anchored: a header
// merely CONTAINING a whitelisted name must not slip through on either rule.
test("R12:diagnosticHeaders 的锚定不会被相似头名绕过", () => {
  const out = diagnosticHeaders({
    "x-retry-after": "9",
    "retry-after-ms": "9",
    "proxy-x-codex-token": "secret",
  })
  expect(out).toEqual({})
})

test("R13:diagnosticHeaders 无头部时返回空对象", () => {
  expect(diagnosticHeaders(undefined)).toEqual({})
})
