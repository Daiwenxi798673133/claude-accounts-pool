import { expect, test } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import { currentConversation } from "./current-conversation.ts"

type Msg = { id: string; role: string; providerID?: string; modelID?: string }

function fakeApi(opts: { route?: unknown; messages?: Msg[] | (() => never) }): TuiPluginApi {
  return {
    route: opts.route === undefined ? undefined : { current: opts.route },
    state: {
      session: {
        messages: () => {
          if (typeof opts.messages === "function") return opts.messages()
          return opts.messages ?? []
        },
      },
    },
  } as unknown as TuiPluginApi
}

const sessionRoute = { name: "session", params: { sessionID: "s1" } }
const user = { id: "u1", role: "user" }

test("C1:api.route 缺失 → undefined(旧版 OpenCode 不应崩)", () => {
  expect(currentConversation(fakeApi({}))).toBeUndefined()
})

test("C2:不在会话路由上(home) → undefined", () => {
  expect(currentConversation(fakeApi({ route: { name: "home" } }))).toBeUndefined()
})

test("C3:会话路由但无 sessionID → undefined", () => {
  expect(currentConversation(fakeApi({ route: { name: "session", params: {} } }))).toBeUndefined()
})

test("C4:最后一条 assistant 是 openai → 显示 openai/模型", () => {
  const api = fakeApi({
    route: sessionRoute,
    messages: [user, { id: "a1", role: "assistant", providerID: "openai", modelID: "gpt-5.4-mini" }],
  })
  expect(currentConversation(api)).toBe("openai / gpt-5.4-mini")
})

test("C5:最后一条 assistant 是 anthropic → 显示 anthropic/模型", () => {
  const api = fakeApi({
    route: sessionRoute,
    messages: [user, { id: "a1", role: "assistant", providerID: "anthropic", modelID: "claude-x" }],
  })
  expect(currentConversation(api)).toBe("anthropic / claude-x")
})

// The whole point of the line: after a mid-session model switch it must report what the
// latest turn ran on, not the provider the session started with.
test("C6:会话中途换过模型 → 取最后一条,不是第一条", () => {
  const api = fakeApi({
    route: sessionRoute,
    messages: [
      user,
      { id: "a1", role: "assistant", providerID: "anthropic", modelID: "claude-x" },
      { id: "u2", role: "user" },
      { id: "a2", role: "assistant", providerID: "openai", modelID: "gpt-5.4-mini" },
    ],
  })
  expect(currentConversation(api)).toBe("openai / gpt-5.4-mini")
})

test("C7:本轮尚无 assistant 消息 → undefined,不猜", () => {
  expect(currentConversation(fakeApi({ route: sessionRoute, messages: [user] }))).toBeUndefined()
})

test("C8:assistant 缺 providerID/modelID → undefined,不渲染 'undefined / undefined'", () => {
  const noProvider = fakeApi({ route: sessionRoute, messages: [user, { id: "a1", role: "assistant", modelID: "x" }] })
  const noModel = fakeApi({ route: sessionRoute, messages: [user, { id: "a1", role: "assistant", providerID: "openai" }] })
  expect(currentConversation(noProvider)).toBeUndefined()
  expect(currentConversation(noModel)).toBeUndefined()
})

// Called inline during dialog render; /usage has crashed on open before (README 0.2.5),
// so a throwing state lookup must degrade to a missing line, never a dead dialog.
test("C9:messages() 抛异常 → 吞掉并返回 undefined,不搞挂弹窗", () => {
  const api = fakeApi({
    route: sessionRoute,
    messages: () => {
      throw new Error("state unavailable")
    },
  })
  expect(() => currentConversation(api)).not.toThrow()
  expect(currentConversation(api)).toBeUndefined()
})
