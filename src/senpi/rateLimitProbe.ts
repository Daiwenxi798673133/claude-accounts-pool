// 把 senpi 丢掉的限流证据补回来。
//
// senpi 收到 429 只在 auth.json 留下 `blockReason: "rate_limit"`,报文全丢——没有状态码、没有
// retry-after、没有 `anthropic-ratelimit-unified-*` 头。而 errors.js 的分类器对配额耗尽另有
// blocking_limit / "hit your weekly limit" 专门分支,所以落到裸 `rate_limit` 的恰恰是原因不明的那一类:
// 分不清配额打满还是被短窗限流器挡下。补打一枪拿回 unified-status 与 5h/7d utilization,这条差别才有实证。
//
// 请求形状不能省。实测 2026-09-01(账号 5h 水位 0.33):同一枚 token 不带下面这句 system 前缀时,
// api.anthropic.com 回 429 `rate_limit_error` / message "Error" 且一个 ratelimit 头都不给;带上立刻 200
// 并附全套头。形状不对的探针只会伪造出"又被限流了"。
import { redactBody } from "../logger.ts"

export const RATE_LIMIT_PROBE_ENDPOINT = "https://api.anthropic.com/v1/messages"

const PROBE_BETA = "claude-code-20250219,oauth-2025-04-20"
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude."
const PROBE_MODEL = "claude-sonnet-4-5"

export type RateLimitProbe = {
  status: number
  /** 空对象不是"没查到",是上游一个头都没给——那本身就是结论。 */
  headers: Record<string, string>
  body?: string
}

export async function probeRateLimit(access: string, fetchImpl: typeof fetch = fetch): Promise<RateLimitProbe> {
  const res = await fetchImpl(RATE_LIMIT_PROBE_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: `Bearer ${access}`,
      "anthropic-version": "2023-06-01",
      "anthropic-beta": PROBE_BETA,
      "content-type": "application/json",
      "x-app": "cli",
    },
    body: JSON.stringify({
      model: PROBE_MODEL,
      max_tokens: 1,
      system: [{ type: "text", text: CLAUDE_CODE_SYSTEM }],
      messages: [{ role: "user", content: "quota" }],
    }),
  })
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => {
    if (key.startsWith("anthropic-ratelimit-") || key === "retry-after") headers[key] = value
  })
  const text = await res.text()
  return { status: res.status, headers, ...(res.ok ? {} : { body: redactBody(text, 200) }) }
}
