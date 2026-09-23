import { expect, test } from "bun:test"
import { buildChildEnv, CLAUDE_CODE_TOKEN_VAR, envBlockers, RELAY_URL_VAR, settingsBlockers, TOOL_SEARCH_VAR } from "./childEnv.ts"

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

// 子进程的 ANTHROPIC_BASE_URL 是我们的(指向本机 relay)。操作者自己设的那个若被静默盖掉,他们以为
// 流量去了自己的网关,实际去了池子 —— 这是要说出来的决定,不是要丢掉的配置。
test("操作者环境里的 ANTHROPIC_BASE_URL 仍然拒绝,不会被静默盖掉", () => {
  const outcome = buildChildEnv({ env: base({ ANTHROPIC_BASE_URL: "http://gw.internal" }), access: "lease-token", relayUrl: "http://127.0.0.1:18787" })
  expect(outcome.ok).toBe(false)
})

test("子进程的 base URL 指向本机 relay", () => {
  const outcome = buildChildEnv({ env: base(), access: "lease-token", relayUrl: "http://127.0.0.1:18787" })
  expect(outcome.ok).toBe(true)
  if (!outcome.ok) return
  expect(outcome.env[RELAY_URL_VAR]).toBe("http://127.0.0.1:18787")
})

test("空跑(不给 relay 地址)时不写 base URL", () => {
  const outcome = buildChildEnv({ env: base(), access: "" })
  expect(outcome.ok && outcome.env[RELAY_URL_VAR]).toBeUndefined()
})

// 自定义 base URL 会让 Claude Code 关掉乐观 tool search(它假设网关不认 tool_reference),每一轮都把
// 全部 MCP 工具塞进上下文。relay 原样转给 api.anthropic.com,这个假设不成立,所以把默认值还回去。
test("ENABLE_TOOL_SEARCH 没设时补成 true,设了就不动", () => {
  const unset = buildChildEnv({ env: base(), access: "t", relayUrl: "http://127.0.0.1:1" })
  expect(unset.ok && unset.env[TOOL_SEARCH_VAR]).toBe("true")
  const chosen = buildChildEnv({ env: base({ [TOOL_SEARCH_VAR]: "false" }), access: "t", relayUrl: "http://127.0.0.1:1" })
  expect(chosen.ok && chosen.env[TOOL_SEARCH_VAR]).toBe("false")
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
