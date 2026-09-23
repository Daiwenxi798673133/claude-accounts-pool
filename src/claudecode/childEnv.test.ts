import { expect, test } from "bun:test"
import { buildChildEnv, CLAUDE_CODE_TOKEN_VAR, envBlockers, settingsBlockers } from "./childEnv.ts"

// A plain object, never process.env: a token written into the runner's own environment would leak
// into every later test file in the same process.
const base = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({ PATH: "/usr/bin", HOME: "/home/x", ...extra })

test("干净环境:租约被注入,父环境其余部分原样带过去", () => {
  const outcome = buildChildEnv({ env: base({ EDITOR: "vim" }), access: "lease-token" })
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) return
  expect(outcome.env[CLAUDE_CODE_TOKEN_VAR]).toBe("lease-token")
  // 不是白名单:子进程丢了 PATH / EDITOR 就等于丢了操作者的 hook、MCP server 和编辑器。
  expect(outcome.env.PATH).toBe("/usr/bin")
  expect(outcome.env.EDITOR).toBe("vim")
})

test("注入不回写父环境", () => {
  const parent = base()
  buildChildEnv({ env: parent, access: "lease-token" })
  expect(parent[CLAUDE_CODE_TOKEN_VAR]).toBeUndefined()
})

// 这四个是 issue #83 实测出的优先级表里排在我们之上的那些。任何一个在场,注入都会被无声忽略,
// 会话照跑、钱记在池子没租过的号上 —— 所以是拒绝启动,不是警告后继续。
test.each([
  ["ANTHROPIC_API_KEY", "sk-ant-api03-xxx"],
  ["ANTHROPIC_AUTH_TOKEN", "whatever"],
  ["CLAUDE_CODE_USE_BEDROCK", "1"],
  ["CLAUDE_CODE_USE_VERTEX", "1"],
  ["CLAUDE_CODE_USE_FOUNDRY", "1"],
])("%s 在场时拒绝启动", (varName, value) => {
  const outcome = buildChildEnv({ env: base({ [varName]: value }), access: "lease-token" })
  expect(outcome.ok).toBe(false)
  if (outcome.ok) return
  expect(outcome.blockers.map((b) => b.varName)).toEqual([varName])
  // 文案必须说出「怎么修」,因为操作者正站在一个拒绝启动的提示符前面。
  expect(outcome.blockers[0].remedy).toContain(`unset ${varName}`)
})

test("ANTHROPIC_BASE_URL 也拒绝:它不是盖过我们,是把租来的订阅凭证发去别人的网关", () => {
  const outcome = buildChildEnv({ env: base({ ANTHROPIC_BASE_URL: "http://gw.internal" }), access: "lease-token" })
  expect(outcome.ok).toBe(false)
})

// `export ANTHROPIC_API_KEY=` 会留下一个空值的名字,Claude Code 不当它是凭证。为它拒绝启动
// 等于为一个什么都不改变的变量挡住一次启动 —— 而这种残留在 shell profile 里很常见。
test("空字符串算不在场", () => {
  expect(envBlockers(base({ ANTHROPIC_API_KEY: "", CLAUDE_CODE_USE_BEDROCK: "" }))).toEqual([])
})

test("多个同时在场时全部报出来,不是只报第一个", () => {
  const outcome = buildChildEnv({
    env: base({ ANTHROPIC_API_KEY: "k", ANTHROPIC_BASE_URL: "http://gw" }),
    access: "lease-token",
  })
  expect(outcome.ok).toBe(false)
  if (outcome.ok) return
  expect(outcome.blockers.map((b) => b.varName).sort()).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL"])
})

test("settings 里的 apiKeyHelper 同样拒绝:它优先级更高,而且那条车道服务端会 401", () => {
  const outcome = buildChildEnv({ env: base(), access: "lease-token", settings: { apiKeyHelper: "/usr/local/bin/tok" } })
  expect(outcome.ok).toBe(false)
  if (outcome.ok) return
  expect(outcome.blockers[0].varName).toBe("apiKeyHelper")
})

test("settings 读不到时不假装干净,但也不凭空拦人", () => {
  // undefined = 不知道。本模块只报它被出示过的东西,判断「不知道要不要拦」是调用方的事。
  expect(settingsBlockers(undefined)).toEqual([])
  expect(settingsBlockers({})).toEqual([])
  expect(settingsBlockers({ apiKeyHelper: "" })).toEqual([])
  expect(settingsBlockers("not an object")).toEqual([])
})
