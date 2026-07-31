import { expect, test } from "bun:test"
import { latestTurn, type TurnMessage } from "./turn.ts"

test("正常:单步回合(user + 1 assistant) → 命中该轮", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
  ]
  const turn = latestTurn(msgs)
  expect(turn?.user.id).toBe("u1")
  expect(turn?.failed.id).toBe("a1")
})

test("多步回合:[u1, a1, a2] → failed 取最后一条 assistant a2", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "a2", role: "assistant", parentID: "u1" },
  ]
  const turn = latestTurn(msgs)
  expect(turn?.user.id).toBe("u1")
  expect(turn?.failed.id).toBe("a2")
})

test("多步回合(跑工具多轮 step):[u1, a1, a2, a3] → failed = a3", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "a2", role: "assistant", parentID: "u1" },
    { id: "a3", role: "assistant", parentID: "u1" },
  ]
  const turn = latestTurn(msgs)
  expect(turn?.user.id).toBe("u1")
  expect(turn?.failed.id).toBe("a3")
})

test("多轮:[u1, a1, u2, a2] → 命中最新一轮 u2 + a2", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant", parentID: "u2" },
  ]
  const turn = latestTurn(msgs)
  expect(turn?.user.id).toBe("u2")
  expect(turn?.failed.id).toBe("a2")
})

test("守卫:最新 user 尚无 assistant 响应 → undefined(不动 session)", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "u2", role: "user" },
  ]
  expect(latestTurn(msgs)).toBeUndefined()
})

test("边界:无 user → undefined", () => {
  const msgs: TurnMessage[] = [{ id: "a1", role: "assistant", parentID: "u0" }]
  expect(latestTurn(msgs)).toBeUndefined()
})

test("边界:空消息 → undefined", () => {
  expect(latestTurn([])).toBeUndefined()
})

test("assistants:[u1, a1, a2, a3] → 暴露整轮全部 assistant [a1,a2,a3],failed=a3,user=u1", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "a2", role: "assistant", parentID: "u1" },
    { id: "a3", role: "assistant", parentID: "u1" },
  ]
  const turn = latestTurn(msgs)
  expect(turn?.user.id).toBe("u1")
  expect(turn?.failed.id).toBe("a3")
  expect(turn?.assistants.map((m) => m.id)).toEqual(["a1", "a2", "a3"])
})

test("assistants 多轮不串味:[u1, a1, u2, a2] → 仅取 u2 之后 [a2](不含 a1),user=u2,failed=a2", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
    { id: "u2", role: "user" },
    { id: "a2", role: "assistant", parentID: "u2" },
  ]
  const turn = latestTurn(msgs)
  expect(turn?.user.id).toBe("u2")
  expect(turn?.failed.id).toBe("a2")
  expect(turn?.assistants.map((m) => m.id)).toEqual(["a2"])
})

test("assistants 单步:[u1, a1] → assistants=[a1],failed=a1", () => {
  const msgs: TurnMessage[] = [
    { id: "u1", role: "user" },
    { id: "a1", role: "assistant", parentID: "u1" },
  ]
  const turn = latestTurn(msgs)
  expect(turn?.failed.id).toBe("a1")
  expect(turn?.assistants.map((m) => m.id)).toEqual(["a1"])
})
