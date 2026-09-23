import { expect, test } from "bun:test"
import { classify, ERROR_TYPES } from "./hookEvent.ts"

const payload = (over: Record<string, unknown> = {}) => ({
  hook_event_name: "StopFailure",
  session_id: "s1",
  error_type: "rate_limit",
  error_message: "Rate limit exceeded",
  ...over,
})

test("rate_limit 上报给 master", () => {
  expect(classify(payload())).toEqual({ kind: "report-limit", errorType: "rate_limit" })
})

// 这一条是本模块存在的主要理由:把鉴权失败当成限流上报,会把一个额度健康的账号打进冷却,
// 而它其实只是这枚租约过期了。
test.each(["authentication_failed", "oauth_org_not_allowed", "account_on_hold"])(
  "%s 判为租约已死,绝不上报为限流",
  (errorType) => {
    const action = classify(payload({ error_type: errorType }))
    expect(action.kind).toBe("dead-lease")
  },
)

test.each(["overloaded", "server_error", "invalid_request", "model_not_found", "max_output_tokens", "billing_error", "cloud_credential_error", "unknown"])(
  "%s 与账号额度无关,不动作",
  (errorType) => {
    expect(classify(payload({ error_type: errorType })).kind).toBe("ignore")
  },
)

test("官方 schema 列出的每个 error_type 都被分类到,没有漏网的", () => {
  for (const errorType of ERROR_TYPES) {
    const action = classify(payload({ error_type: errorType }))
    expect(["report-limit", "dead-lease", "ignore"]).toContain(action.kind)
  }
})

test("不是 StopFailure 的事件不处理", () => {
  const action = classify(payload({ hook_event_name: "Stop" }))
  expect(action.kind).toBe("ignore")
  if (action.kind !== "ignore") return
  expect(action.reason).toContain("Stop")
})

test("垃圾报文不炸,只是不动作", () => {
  expect(classify(undefined).kind).toBe("ignore")
  expect(classify("nope").kind).toBe("ignore")
  expect(classify({}).kind).toBe("ignore")
  expect(classify(payload({ error_type: "brand_new_type" })).kind).toBe("ignore")
})

// 一份【真实报文】,原样抓自 claude 2.1.278 的交互式会话(2026-09-23,pty + 假端点回 401)。
// 它与官方文档的 schema 不一致:文档写 `error_type` + `error_message`,实际发的是 `error` +
// `last_assistant_message`。这条测试存在的唯一理由,就是钉住"按实际报文工作"——只按文档写,
// 每一个真实事件都会被判成 ignore,而钩子输出被客户端整个丢弃,失效是完全无声的。
const REAL_PAYLOAD_2_1_278 = {
  session_id: "e0df9949-1758-4017-ba13-68d2ce49e956",
  transcript_path: "/tmp/x/cc/projects/-tmp-x/e0df9949.jsonl",
  cwd: "/tmp/x",
  scratchpad_dir: "/tmp/scratch",
  prompt_id: "78ba6018-9b3f-47b1-be90-fd21d9d45de3",
  effort: { level: "high" },
  hook_event_name: "StopFailure",
  error: "authentication_failed",
  last_assistant_message: "Please run /login · API Error: 401 OAuth token is invalid",
}

test("真实报文(claude 2.1.278):用 `error` 字段,判为租约已死", () => {
  expect(classify(REAL_PAYLOAD_2_1_278)).toEqual({ kind: "dead-lease", errorType: "authentication_failed" })
})

test("文档写的 `error_type` 字段也照认 —— 哪天客户端改回去不用动这里", () => {
  expect(classify({ hook_event_name: "StopFailure", error_type: "rate_limit" })).toEqual({
    kind: "report-limit",
    errorType: "rate_limit",
  })
})

test("两个字段都在时以实测的 `error` 为准", () => {
  expect(classify({ hook_event_name: "StopFailure", error: "rate_limit", error_type: "server_error" })).toEqual({
    kind: "report-limit",
    errorType: "rate_limit",
  })
})
