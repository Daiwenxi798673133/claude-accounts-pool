import { expect, test } from "bun:test"
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"
import { helpText, hookResponse, parsePanelCommand, renderPanel, resolveTarget } from "./panel.ts"

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
const ACCOUNTS = [account("b657773c"), account("ea15869e"), account("2277483b"), account("eaaa1a79")]
const SNAPSHOT: UsageSnapshotView = { at: 0, stale: false, accounts: ACCOUNTS }

test("不是 /pool 的输入一律不管", () => {
  for (const prompt of ["hello", "/poolside", "look at /pool", "/usage", ""]) expect(parsePanelCommand(prompt)).toBeUndefined()
})

test("/pool 各种写法", () => {
  expect(parsePanelCommand("/pool")).toEqual({ kind: "list" })
  expect(parsePanelCommand("  /pool  ")).toEqual({ kind: "list" })
  expect(parsePanelCommand("/pool 3")).toEqual({ kind: "switch", target: "3", pin: false })
  expect(parsePanelCommand("/pool af008f89")).toEqual({ kind: "switch", target: "af008f89", pin: false })
  expect(parsePanelCommand("/pool pin 3")).toEqual({ kind: "switch", target: "3", pin: true })
  expect(parsePanelCommand("/pool unpin")).toEqual({ kind: "unpin" })
  expect(parsePanelCommand("/pool help")).toEqual({ kind: "help" })
})

test("看不懂的 /pool 给用法,而不是去猜", () => {
  expect(parsePanelCommand("/pool pin")?.kind).toBe("help")
  expect(parsePanelCommand("/pool 3 4")?.kind).toBe("help")
  expect(parsePanelCommand("/pool unpin 3")?.kind).toBe("help")
})

test("全是数字的 id 前缀不会被当成编号", () => {
  const r = resolveTarget("22774", [account("22774831"), account("b657773c")])
  expect(r.ok && r.account.idPrefix).toBe("22774831")
})

test("编号按面板顺序对应账号", () => {
  const r = resolveTarget("3", ACCOUNTS)
  expect(r.ok && r.account.idPrefix).toBe("2277483b")
  expect(resolveTarget("0", ACCOUNTS).ok).toBe(false)
  expect(resolveTarget("9", ACCOUNTS).ok).toBe(false)
})

// 与 master 的 409 同一条规矩:0 个或多个匹配一律拒绝,绝不猜。
test("id 前缀必须唯一", () => {
  const unique = resolveTarget("2277", ACCOUNTS)
  expect(unique.ok && unique.account.idPrefix).toBe("2277483b")
  const ambiguous = resolveTarget("ea15", [...ACCOUNTS, account("ea15ffff")])
  expect(!ambiguous.ok && ambiguous.reason).toContain("2 个")
  expect(resolveTarget("ffff", ACCOUNTS).ok).toBe(false)
  expect(resolveTarget("zz", ACCOUNTS).ok).toBe(false)
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
  expect(text).toContain("/pool pin 3")
})

test("面板:拿不到用量数据、数据过期、没有窗口时都如实说", () => {
  expect(renderPanel({ snapshot: undefined, workerId: "w" })).toContain("拿不到 master 的用量数据")
  expect(renderPanel({ snapshot: { ...SNAPSHOT, stale: true }, workerId: "w" })).toContain("已过期")
  expect(renderPanel({ snapshot: { ...SNAPSHOT, accounts: [account("aaaa0000", { windows: [] })] }, workerId: "w" })).toMatch(/aaaa0000\s+–\s+–/)
  expect(renderPanel({ snapshot: SNAPSHOT, workerId: "w" })).toContain("共享 尚未领取")
})

test("钩子应答:拦下输入、面板不进上下文、不复述原输入", () => {
  expect(JSON.parse(hookResponse("x"))).toEqual({ decision: "block", reason: "x", suppressOriginalPrompt: true })
  expect(helpText("错了")).toStartWith("错了")
})
