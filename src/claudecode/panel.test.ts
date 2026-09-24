import { expect, test } from "bun:test"
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"
import { displayWidth } from "../panel-model.ts"
import { hookResponse, isPoolCommand, parsePanelCommand, renderPanel, resolveTarget, type PanelView } from "./panel.ts"

const account = (idPrefix: string, over: Partial<UsageAccountView> = {}): UsageAccountView => ({
  idPrefix,
  label: `${idPrefix}@example.com`,
  windows: [
    { label: "five_hour", utilization: 10, resetsAt: "2026-09-24T02:00:00Z" },
    { label: "seven_day", utilization: 55 },
  ],
  hasUsage: true,
  coolingDown: false,
  excluded: false,
  needsReauth: false,
  ...over,
})
const SNAPSHOT: UsageSnapshotView = { at: 0, stale: false, accounts: [account("b657773c"), account("ea15869e")] }
const NOW = Date.parse("2026-09-24T00:00:00Z")
const view = (over: Partial<PanelView> = {}): PanelView => ({ snapshot: SNAPSHOT, relayUp: true, workerId: "vince.cc", now: NOW, ...over })

const ANSI = /\x1b\[[0-9;]*m/g
const plain = (text: string): string => text.replace(ANSI, "")
const lines = (text: string): string[] => plain(text).split("\n")

test("认得 /pool(带不带参数都算),别的输入一律不管", () => {
  for (const prompt of ["/pool", "  /pool  ", "/pool 3", "/pool r"]) expect(isPoolCommand(prompt)).toBe(true)
  for (const prompt of ["hello", "/poolside", "look at /pool", "/usage", ""]) expect(isPoolCommand(prompt)).toBe(false)
})

test("命令:面板、编号 / 前缀切号、pin 两种顺序、r 刷新,其余给用法", () => {
  expect(parsePanelCommand("/pool")).toEqual({ kind: "list" })
  expect(parsePanelCommand("/pool 3")).toEqual({ kind: "switch", target: "3", pin: false })
  expect(parsePanelCommand("/pool ea15869e")).toEqual({ kind: "switch", target: "ea15869e", pin: false })
  expect(parsePanelCommand("/pool 3 pin")).toEqual({ kind: "switch", target: "3", pin: true })
  expect(parsePanelCommand("/pool pin 3")).toEqual({ kind: "switch", target: "3", pin: true })
  expect(parsePanelCommand("/pool r")).toEqual({ kind: "refresh" })
  expect(parsePanelCommand("/pool 刷新")).toEqual({ kind: "refresh" })
  expect(parsePanelCommand("/pool help")).toEqual({ kind: "help" })
  expect(parsePanelCommand("/pool pin")?.kind).toBe("help")
  expect(parsePanelCommand("/pool pin pin")?.kind).toBe("help")
  expect(parsePanelCommand("/pool 1 2 3")?.kind).toBe("help")
})

test("定位:编号按面板顺序;4 位以上是前缀,必须唯一;全数字前缀不被当成编号", () => {
  const accounts = [account("b657773c"), account("22774830"), account("2277483b")]
  expect(resolveTarget("1", accounts)).toEqual({ ok: true, account: accounts[0] })
  expect(resolveTarget("4", accounts).ok).toBe(false)
  expect(resolveTarget("b657", accounts)).toEqual({ ok: true, account: accounts[0] })
  const ambiguous = resolveTarget("2277", accounts)
  expect(ambiguous.ok).toBe(false)
  expect(ambiguous.ok ? "" : ambiguous.reason).toContain("匹配到 2 个")
  expect(resolveTarget("zzzz", accounts).ok).toBe(false)
})

test("面板长得像 OMO:标题 + 汇总、本机、分隔线、每个号的标题行与每个窗口一行进度条、图例、命令提示", () => {
  const text = renderPanel(
    view({
      snapshot: {
        ...SNAPSHOT,
        at: NOW,
        accounts: [
          account("b657773c", { holders: ["vince.cc", "mephisto"], pinnedBy: ["mephisto"] }),
          account("ea15869e", { coolingDown: true, needsReauth: true, excluded: true }),
        ],
      },
      current: "b657773c",
      sessions: 2,
    }),
  )
  const all = lines(text)
  expect(all[0]).toMatch(/^账号池用量\s+2 个账号 · 1 可用 · 1 在用$/)
  expect(all[1]).toMatch(/^本机 vince\.cc · 2 个会话在用\s+快照于 \d\d:\d\d$/)
  expect(all[2]).toMatch(/^─+$/)
  expect(all[3]).toMatch(/^1 ● b657773c@example\.com In Use\s+vince\.cc mephisto$/)
  expect(all[4]).toBe("    5h     ██░░░░░░░░░░░░░░  10% 重置   2h 0m")
  expect(all[5]).toBe("    7d     █████████░░░░░░░  55%")
  expect(all[7]).toMatch(/^2 ○ ea15869e@example\.com 冷却中 需重新登录\s+不自动切$/)
  expect(all.at(-2)).toBe("● 本机在用 · ○ 本机未用")
  expect(all.at(-1)).toBe("/pool 编号 切号 · /pool 编号 pin 钉住/取消 · /pool r 刷新")
})

test("颜色:进度条按用量分档(0 灰、<60 绿、<85 黄、≥85 红),本机名字绿色,每行先回到默认色", () => {
  const text = renderPanel(
    view({
      snapshot: {
        ...SNAPSHOT,
        accounts: [
          account("b657773c", {
            holders: ["vince.cc"],
            windows: [
              { label: "five_hour", utilization: 0 },
              { label: "seven_day", utilization: 59 },
              { label: "seven_day_opus", utilization: 60 },
              { label: "Fable", utilization: 85 },
            ],
          }),
        ],
      },
      current: "b657773c",
    }),
  )
  for (const line of text.split("\n")) expect(line.startsWith("\x1b[0m")).toBe(true)
  const bar = (label: string) => text.split("\n").find((line) => plain(line).trim().startsWith(label)) ?? ""
  expect(bar("5h")).toContain("\x1b[2m░░░░")
  expect(bar("7d ")).toContain("\x1b[32m█")
  expect(bar("7d opus")).toContain("\x1b[33m█")
  expect(bar("Fable")).toContain("\x1b[31m█")
  expect(text).toContain("\x1b[32mvince.cc\x1b[0m")
  expect(text).toContain("\x1b[32m●\x1b[0m")
})

test("钉住顶替 In Use;relay 不在或还没领号时 ● / ○ 一列留空,不冒充「本机没在用」", () => {
  const pinned = lines(renderPanel(view({ current: "b657773c", pin: "b657773c" })))
  expect(pinned.find((l) => l.includes("b657773c@"))).toMatch(/^1 ● b657773c@example\.com 已钉住$/)
  const unknown = lines(renderPanel(view({ relayUp: false })))
  expect(unknown[1]).toMatch(/^本机 vince\.cc · relay 不在\s/)
  expect(unknown.find((l) => l.includes("b657773c@"))).toMatch(/^1   b657773c@example\.com$/)
  expect(lines(renderPanel(view()))[1]).toMatch(/^本机 vince\.cc · 还没领到号\s/)
})

test("布局:不超过 6 个号单列;更多且终端够宽就双列、按列填;拿不到宽度或太窄就单列", () => {
  const many = { ...SNAPSHOT, accounts: Array.from({ length: 9 }, (_, i) => account(`${i}0000000`.slice(0, 8))) }
  const wide = lines(renderPanel(view({ snapshot: many, terminalWidth: 166 })))
  // 1..5 在左列、6..9 在右列:第 1 个号与第 6 个号在同一行。
  expect(wide.find((l) => l.includes("00000000@"))).toMatch(/^1 ○? *00000000@example\.com\s+6\s+50000000@example\.com$/)
  for (const line of wide) expect(displayWidth(line)).toBeLessThanOrEqual(166 - 4)
  for (const width of [undefined, 90]) {
    const narrow = lines(renderPanel(view({ snapshot: many, ...(width === undefined ? {} : { terminalWidth: width }) })))
    expect(narrow.filter((l) => /@example\.com/.test(l))).toHaveLength(9)
    expect(narrow.some((l) => /@example\.com.*@example\.com/.test(l))).toBe(false)
  }
  const few = lines(renderPanel(view({ terminalWidth: 200 })))
  expect(few.some((l) => /@example\.com.*@example\.com/.test(l))).toBe(false)
})

test("持有者放不下时丢尾巴、留 +N;标签过长截断带 …,整行不超过列宽", () => {
  const holders = ["alpha-machine", "bravo-machine", "charlie-machine", "delta-machine"]
  const text = lines(renderPanel(view({ snapshot: { ...SNAPSHOT, accounts: [account("b657773c", { holders, label: `${"x".repeat(80)}@example.com` })] } })))
  const title = text.find((l) => l.startsWith("1 ")) ?? ""
  expect(title).toContain("…")
  expect(displayWidth(title)).toBeLessThanOrEqual(56)
  const short = lines(renderPanel(view({ snapshot: { ...SNAPSHOT, accounts: [account("b657773c", { holders })] } })))
  expect(short.find((l) => l.startsWith("1 "))).toMatch(/\+\d$/)
})

test("拿不到用量、快照陈旧、没有窗口时都如实说", () => {
  expect(plain(renderPanel(view({ snapshot: undefined })))).toContain("拿不到 master 的用量数据")
  expect(plain(renderPanel(view({ snapshot: { ...SNAPSHOT, stale: true } })))).toContain("⚠ 快照已陈旧")
  expect(plain(renderPanel(view({ snapshot: { ...SNAPSHOT, accounts: [account("b657773c", { hasUsage: false, windows: [] })] } })))).toContain(
    "额度未知(不在本次快照)",
  )
  expect(plain(renderPanel(view({ snapshot: { ...SNAPSHOT, accounts: [] } })))).toContain("账号池暂无用量数据")
  expect(plain(renderPanel(view({ snapshot: { ...SNAPSHOT, at: 0 } })))).toContain("尚未采集")
})

test("提示放在最上面,按结果上色", () => {
  const text = renderPanel(view({ notices: [{ tone: "ok", text: "✓ 已切到 x" }, { tone: "error", text: "✗ 不行" }] }))
  expect(lines(text).slice(0, 3)).toEqual(["✓ 已切到 x", "✗ 不行", ""])
  expect(text).toContain("\x1b[32m✓ 已切到 x")
  expect(text).toContain("\x1b[31m✗ 不行")
})

test("标签里的控制字符剥掉,不让一个 ESC 弄乱整段颜色", () => {
  const text = renderPanel(view({ snapshot: { ...SNAPSHOT, accounts: [account("b657773c", { label: "evil\x1b[31m@example.com" })] } }))
  expect(plain(text)).toContain("evil[31m@example.com")
  expect(text).not.toContain("evil\x1b")
})

test("钩子应答:block + reason,suppressOriginalPrompt 在 hookSpecificOutput 里", () => {
  expect(JSON.parse(hookResponse("hi"))).toEqual({
    decision: "block",
    reason: "hi",
    hookSpecificOutput: { hookEventName: "UserPromptSubmit", suppressOriginalPrompt: true },
  })
})
