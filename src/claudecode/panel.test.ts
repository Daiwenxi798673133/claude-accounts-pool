import { expect, test } from "bun:test"
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"
import { hookResponse, isPoolCommand, renderPanel } from "./panel.ts"

const account = (idPrefix: string, over: Partial<UsageAccountView> = {}): UsageAccountView => ({
  idPrefix,
  label: `${idPrefix}@example.com`,
  windows: [
    { label: "five_hour", utilization: 10 },
    { label: "seven_day", utilization: 55 },
  ],
  hasUsage: true,
  coolingDown: false,
  excluded: false,
  needsReauth: false,
  ...over,
})
const SNAPSHOT: UsageSnapshotView = { at: 0, stale: false, accounts: [account("b657773c"), account("ea15869e")] }

test("认得 /pool(带不带参数都算),别的输入一律不管", () => {
  expect(isPoolCommand("/pool")).toBe(true)
  expect(isPoolCommand("  /pool  ")).toBe(true)
  expect(isPoolCommand("/pool 3")).toBe(true)
  for (const prompt of ["hello", "/poolside", "look at /pool", "/usage", ""]) expect(isPoolCommand(prompt)).toBe(false)
})

test("面板:编号、用量、当前、钉住、冷却、需重登、在用机器数都标出来", () => {
  const text = renderPanel({
    snapshot: {
      ...SNAPSHOT,
      accounts: [
        account("b657773c", { holders: ["vince.cc"] }),
        account("ea15869e", { coolingDown: true }),
        account("2277483b", { needsReauth: true, coolingDown: true }),
        account("eaaa1a79"),
      ],
    },
    current: "b657773c",
    pin: "eaaa1a79",
    workerId: "vince.cc",
    sessions: 2,
  })
  expect(text).toContain("本机 vince.cc · 共享 b657773c · 2 个会话在用")
  const line = (prefix: string) => text.split("\n").find((l) => /^\s+\d+\s/.test(l) && l.includes(prefix)) ?? ""
  expect(line("b657773c")).toMatch(/^\s+1\s+b657773c\s+10%\s+55%\s+← 当前 · 1 台在用$/)
  expect(line("ea15869e")).toContain("冷却中")
  // 需重登比冷却更要紧,两个都成立时只说需重登。
  expect(line("2277483b")).toContain("需重登")
  expect(line("2277483b")).not.toContain("冷却中")
  expect(line("eaaa1a79")).toContain("📌 钉住")
  expect(text).toContain("b657773c@example.com")
})

// issue #101:只要 /pool 一条命令,面板上不再列衍生命令。
test("面板上不列任何 /pool 衍生命令", () => {
  const text = renderPanel({ snapshot: SNAPSHOT, workerId: "w" })
  expect(text).not.toMatch(/\/pool\s+\S/)
})

test("面板:拿不到用量数据、数据过期、没有窗口时都如实说", () => {
  expect(renderPanel({ snapshot: undefined, workerId: "w" })).toContain("拿不到 master 的用量数据")
  expect(renderPanel({ snapshot: { ...SNAPSHOT, stale: true }, workerId: "w" })).toContain("已过期")
  expect(renderPanel({ snapshot: { ...SNAPSHOT, accounts: [account("aaaa0000", { windows: [] })] }, workerId: "w" })).toMatch(/aaaa0000\s+–\s+–/)
  expect(renderPanel({ snapshot: SNAPSHOT, workerId: "w" })).toContain("共享 尚未领取")
})

test("钩子应答:拦下输入、面板不进上下文", () => {
  expect(JSON.parse(hookResponse("x"))).toEqual({ decision: "block", reason: "x", suppressOriginalPrompt: true })
})
