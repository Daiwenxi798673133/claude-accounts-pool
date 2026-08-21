import { expect, test } from "bun:test"
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"
import { displayWidth } from "../panel-model.ts"
import {
  COLUMN_GAP,
  COLUMN_WIDTH,
  formatAccountRows,
  formatStatusText,
  formatSwitchActions,
  panelTitle,
  REFRESH_ROW,
  SENPI_BAR_WIDTH,
  type SlotHold,
} from "./usageRows.ts"

// This machine, as senpi's extension reports it. Named once because half the rules below turn on
// "is this us" — a literal repeated per test would let one copy drift and silently pass.
const WORKER = "vince-local.senpi"

// The cell offsets every row's columns must land on, DERIVED from the exported widths rather than
// written out: hardcoding 34 here would keep passing after someone widened the label column, which
// is exactly the regression the alignment test exists to catch.
const LABEL_CELL = COLUMN_WIDTH.id + COLUMN_GAP
const HELD_CELL = LABEL_CELL + COLUMN_WIDTH.label + COLUMN_GAP
const PIN_CELL = HELD_CELL + COLUMN_WIDTH.held + COLUMN_GAP
const WINDOWS_CELL = PIN_CELL + COLUMN_WIDTH.pin + COLUMN_GAP

// Walks the row by TERMINAL CELLS, the same unit the renderer pads in. Slicing by code units would
// make this helper agree with a `.length`-based implementation and the CJK case would pass wrongly.
function cells(row: string, start: number, end = Number.POSITIVE_INFINITY): string {
  let width = 0
  let out = ""
  for (const char of row) {
    if (width >= start && width < end) out += char
    width += displayWidth(char)
  }
  return out
}

// hasUsage defaults to FALSE and windows to empty, mirroring the real `954fd7d5` row: the pool's
// least-known account is the cheapest fixture, and every test that wants numbers has to say so.
function account(over: Partial<UsageAccountView> & { idPrefix: string }): UsageAccountView {
  return {
    label: "someone@potentia.ai",
    windows: [],
    hasUsage: false,
    coolingDown: false,
    excluded: false,
    needsReauth: false,
    ...over,
  }
}

function snapshot(accounts: UsageAccountView[], over: Partial<UsageSnapshotView> = {}): UsageSnapshotView {
  return { at: 1787280423805, stale: false, accounts, ...over }
}

function rowsOf(accounts: UsageAccountView[], held: readonly SlotHold[] = []) {
  return formatAccountRows({ view: snapshot(accounts), held, workerId: WORKER })
}

// REFRESH_ROW is the only option that is not an account, and `ui.select` hands back a STRING: if it
// were absent from `rows` the panel could never refresh, and if it appeared in `accountByRow` the
// refresh keypress would be read as "switch to some account".
test("every account renders one row and the refresh sentinel is appended last", () => {
  const { rows, accountByRow } = rowsOf([
    account({ idPrefix: "af008f89", label: "vince.dai2@potentia.ai" }),
    account({ idPrefix: "954fd7d5", label: "borong.gu@potentia.ai" }),
    account({ idPrefix: "eaaa1a79", label: "vince.dai3@potentia.ai" }),
  ])

  expect(rows).toHaveLength(4)
  expect(rows[3]).toBe(REFRESH_ROW)
  expect(accountByRow.size).toBe(3)
  expect(accountByRow.has(REFRESH_ROW)).toBe(false)
  expect(accountByRow.get(rows[0] ?? "")?.idPrefix).toBe("af008f89")
  expect(accountByRow.get(rows[2] ?? "")?.idPrefix).toBe("eaaa1a79")
})

// THE REASON displayWidth EXISTS. A CJK label occupies two cells per glyph, so a row padded with
// `.length` pushes every later column four cells right and the panel reads as a staircase. Both rows
// below must put `pin` and `5h` on the SAME cell — an implementation measuring code units cannot.
test("columns land on identical cell offsets even when a label is CJK", () => {
  const { rows } = rowsOf([
    account({
      idPrefix: "af008f89",
      label: "vince.dai2@potentia.ai",
      hasUsage: true,
      windows: [{ label: "five_hour", utilization: 2 }],
      pinnedBy: [WORKER],
    }),
    account({
      idPrefix: "bb11cc22",
      label: "测试账号@potentia.ai",
      hasUsage: true,
      windows: [{ label: "five_hour", utilization: 7 }],
      pinnedBy: [WORKER],
    }),
  ])
  const [ascii, cjk] = rows

  expect(cells(ascii ?? "", 0, COLUMN_WIDTH.id)).toBe("af008f89")
  expect(cells(cjk ?? "", 0, COLUMN_WIDTH.id)).toBe("bb11cc22")
  expect(cells(ascii ?? "", LABEL_CELL).startsWith("vince.dai2@")).toBe(true)
  expect(cells(cjk ?? "", LABEL_CELL).startsWith("测试账号@")).toBe(true)
  expect(cells(ascii ?? "", PIN_CELL).startsWith("pin")).toBe(true)
  expect(cells(cjk ?? "", PIN_CELL).startsWith("pin")).toBe(true)
  // The percentage is right-aligned into its own fixed width, so a 1-digit and a 3-digit utilization
  // put the next column on the same cell — see the window-alignment test below.
  expect(cells(ascii ?? "", WINDOWS_CELL)).toBe("5h ░░░░░░   2%")
  expect(cells(cjk ?? "", WINDOWS_CELL)).toBe("5h ░░░░░░   7%")
})

// THE WINDOWS HAVE TO BE A TABLE, not three strings joined per row. A percentage is 1–3 digits, so
// joining `5h 3%` and `5h 76%` with a fixed separator puts `7d` on a different cell in every row and
// the whole block reads as a staircase — which is what it did. Alignment is therefore a property of
// the SNAPSHOT (every row shares one column layout), never of the row being rendered.
test("window columns line up across rows regardless of digit count", () => {
  const at = (row: string, needle: string): number => displayWidth(row.slice(0, row.indexOf(needle)))
  const { rows } = rowsOf([
    account({
      idPrefix: "aaaaaaaa",
      hasUsage: true,
      windows: [
        { label: "five_hour", utilization: 76 },
        { label: "seven_day", utilization: 11 },
        { label: "Fable", utilization: 3 },
      ],
    }),
    account({
      idPrefix: "bbbbbbbb",
      hasUsage: true,
      windows: [
        { label: "five_hour", utilization: 3 },
        { label: "seven_day", utilization: 0 },
        { label: "Fable", utilization: 0 },
      ],
    }),
    // Three digits, the widest a utilization can be — the column has to have been sized for it all
    // along, or a single account at 100% shifts every other row's later columns.
    account({
      idPrefix: "cccccccc",
      hasUsage: true,
      windows: [
        { label: "five_hour", utilization: 100 },
        { label: "seven_day", utilization: 64 },
      ],
    }),
  ])
  const [wide, narrow, full] = rows as [string, string, string]

  expect(at(wide, "7d")).toBe(at(narrow, "7d"))
  expect(at(full, "7d")).toBe(at(narrow, "7d"))
  expect(at(wide, "Fable")).toBe(at(narrow, "Fable"))
  // The row missing the third window must not pad a phantom column onto its end.
  expect(full.endsWith(" ")).toBe(false)
})

// 未采集 ≠ 用量为零。An account the poller failed on (or never reached) has NO number we are entitled
// to print, and `0%` would rank the pool's least-known account as its emptiest — sending the
// operator straight at it.
test("an account with no snapshot shows a dash and never a zero percentage", () => {
  const { rows } = rowsOf([account({ idPrefix: "954fd7d5", label: "borong.gu@potentia.ai", hasUsage: false })])
  const row = rows[0] ?? ""

  expect(cells(row, WINDOWS_CELL)).toBe("--")
  expect(row).not.toContain("0%")
  expect(row).not.toContain("%")
})

// `pinnedBy: undefined` means the MASTER is too old to track pins — not that nobody pinned. Blank
// would claim the account is free to rotate away; `?` says we do not know, which is the truth.
test("the pin column separates our pin, someone else's pin and an unknowable one", () => {
  const { rows } = rowsOf([
    account({ idPrefix: "aaaaaaaa", pinnedBy: undefined }),
    account({ idPrefix: "bbbbbbbb", pinnedBy: ["someone-else"] }),
    account({ idPrefix: "cccccccc", pinnedBy: [WORKER] }),
  ])

  expect(cells(rows[0] ?? "", PIN_CELL, PIN_CELL + COLUMN_WIDTH.pin).trimEnd()).toBe("?")
  expect(cells(rows[1] ?? "", PIN_CELL, PIN_CELL + COLUMN_WIDTH.pin).trimEnd()).toBe("")
  expect(cells(rows[2] ?? "", PIN_CELL, PIN_CELL + COLUMN_WIDTH.pin).trimEnd()).toBe("pin")
})

// Our own workerId belongs in the SLOT-NAME branch (a slot we hold is named by its slot, `env`), so
// leaving it in the holder chips would print this machine twice under two different names. And
// `holders: undefined` is an old master, not an empty pool — it must render as nothing said.
test("holder chips name the other machines and drop us", () => {
  const { rows } = rowsOf([
    account({ idPrefix: "aaaaaaaa", holders: undefined }),
    account({ idPrefix: "bbbbbbbb", holders: ["other-a", "other-b"] }),
    account({ idPrefix: "cccccccc", holders: [WORKER, "other-a"] }),
  ])
  const heldCell = (row?: string) => cells(row ?? "", HELD_CELL, HELD_CELL + COLUMN_WIDTH.held).trimEnd()

  expect(heldCell(rows[0])).toBe("")
  expect(heldCell(rows[1])).toBe("other-a other-b")
  expect(heldCell(rows[2])).toBe("other-a")
  expect(rows[2]).not.toContain(WORKER)
})

// A lease names the FULL uuid while the row carries an 8-char prefix, so this is a prefix test and
// cannot be an equality one. Two slots on one account is legal (senpi runs numbered token slots), and
// the operator has to see both or a switch will look like it did nothing to the other slot.
test("the account this worker holds reads as a state, not as a slot name", () => {
  const full = "af008f89-1111-2222-3333-444455556666"
  const one = rowsOf([account({ idPrefix: "af008f89" })], [{ slotName: "env", accountId: full }])
  const heldCell = (row?: string) => cells(row ?? "", HELD_CELL, HELD_CELL + COLUMN_WIDTH.held).trimEnd()

  expect(heldCell(one.rows[0])).toBe("在用")
  // NEVER the raw slot name. Every other value in this column is a workerId, so `env` read as a
  // machine called "env" — reported from the live panel as "并没有 env 这个用户". A slot is senpi's
  // internal name for a token variable and has no business in a column of holders.
  expect(one.rows[0]).not.toContain("env")
})

// The slot is named ONLY when there is more than one, because only then does it tell the operator
// something: with a single slot `在用 env` adds a word that can never vary.
test("the slot is named only when this worker runs more than one", () => {
  const full = "af008f89-1111-2222-3333-444455556666"
  const heldCell = (row?: string) => cells(row ?? "", HELD_CELL, HELD_CELL + COLUMN_WIDTH.held).trimEnd()
  const both = rowsOf(
    [account({ idPrefix: "af008f89" })],
    [
      { slotName: "env", accountId: full },
      { slotName: "env-2", accountId: full },
    ],
  )
  // Two slots configured, only one of them on this account.
  const one = rowsOf(
    [account({ idPrefix: "af008f89" })],
    [{ slotName: "env", accountId: full }, { slotName: "env-2" }],
  )

  expect(heldCell(both.rows[0])).toBe("在用 env,env-2")
  expect(heldCell(one.rows[0])).toBe("在用 env")
})

// `ui.select` renders an option as ONE raw line with no truncation, so a label wider than its column
// would shove the windows off the right edge of the dialog instead of wrapping. The ellipsis has to
// be paid for out of the 22 cells, not added on top of them.
test("an over-wide label is truncated inside its own column budget", () => {
  const { rows } = rowsOf([account({ idPrefix: "aaaaaaaa", label: "averyveryverylongemailaddress@potentia.ai" })])
  const label = cells(rows[0] ?? "", LABEL_CELL, LABEL_CELL + COLUMN_WIDTH.label)

  expect(label.endsWith("…")).toBe(true)
  expect(displayWidth(label)).toBeLessThanOrEqual(COLUMN_WIDTH.label)
  expect(label.startsWith("averyvery")).toBe(true)
})

// THE ROW STRING IS THE ONLY HANDLE ui.select GIVES BACK. Two identical rows would collapse into one
// selectable entry and switch to whichever account the Map happened to keep. Labels are NOT unique —
// two pool entries can share an email — so uniqueness has to come from the id column, and this test
// fails loudly the day a column reorder drops it.
test("rows stay unique when two accounts share a label", () => {
  const { rows, accountByRow } = rowsOf([
    account({ idPrefix: "aaaaaaaa", label: "shared@potentia.ai" }),
    account({ idPrefix: "bbbbbbbb", label: "shared@potentia.ai" }),
  ])

  expect(new Set(rows).size).toBe(rows.length)
  expect(accountByRow.size).toBe(2)
})

// One slot needs no slot name in the copy (there is nothing to disambiguate), several slots need one
// on EVERY option — an unlabelled option under multiple slots gives the operator no way to say which
// token slot the account should land in.
test("switch actions name the slot only when there is a choice of slot", () => {
  const target = account({ idPrefix: "af008f89" })
  const single = formatSwitchActions({ account: target, slots: ["env"] })
  const multi = formatSwitchActions({ account: target, slots: ["env", "env-2"] })

  expect(single.options).toEqual(["切换到此账号", "切换并钉住此账号", "返回"])
  expect(single.actionByOption.get("切换到此账号")).toEqual({ slotName: "env", pin: "none" })
  expect(single.actionByOption.get("切换并钉住此账号")).toEqual({ slotName: "env", pin: "on" })
  expect(single.actionByOption.get("返回")).toBe("back")

  expect(multi.options).toHaveLength(5)
  expect(multi.options[4]).toBe("返回")
  expect(multi.actionByOption.get(multi.options[0] ?? "")).toEqual({ slotName: "env", pin: "none" })
  expect(multi.actionByOption.get(multi.options[3] ?? "")).toEqual({ slotName: "env-2", pin: "on" })
  // Every option must resolve: an unmapped one is a dead keypress.
  for (const option of multi.options) expect(multi.actionByOption.has(option)).toBe(true)
})

// THREE STATES, NOT A BOOLEAN, and the panel is where the third one becomes visible. manualSwitch
// reads `pin: false` as "UNPIN" and `undefined` as "just switch" — so a plain switch modelled as
// `false` gets reported to the operator as "已取消钉住", which is what it did before this test.
// Measured in the live TUI: 切换到此账号 announced an un-pin nobody asked for.
test("a plain switch is not an un-pin", () => {
  const { actionByOption } = formatSwitchActions({ account: account({ idPrefix: "af008f89" }), slots: ["env"] })

  expect(actionByOption.get("切换到此账号")).toEqual({ slotName: "env", pin: "none" })
})

// A slot already pinned here needs the OPPOSITE verb: offering "切换并钉住" to somebody who is
// already pinned is a no-op dressed as an action, and with the pin held in this process it would also
// be the only way out of a pin — i.e. none.
test("a slot already pinned to this account is offered the un-pin instead", () => {
  const target = account({ idPrefix: "af008f89" })
  const { options, actionByOption } = formatSwitchActions({ account: target, slots: ["env"], pinnedSlots: ["env"] })

  expect(options).toEqual(["切换到此账号", "取消钉住此账号", "返回"])
  expect(actionByOption.get("取消钉住此账号")).toEqual({ slotName: "env", pin: "off" })
  expect(actionByOption.has("切换并钉住此账号")).toBe(false)
})

// Per SLOT, not per account: with K slots one may be pinned here while another is free, and collapsing
// them would offer an un-pin for a slot that was never pinned.
test("only the pinned slot gets the un-pin verb", () => {
  const target = account({ idPrefix: "af008f89" })
  const { options } = formatSwitchActions({ account: target, slots: ["env", "env-2"], pinnedSlots: ["env-2"] })

  expect(options).toContain("切换并钉住此账号（槽位 env）")
  expect(options).toContain("取消钉住此账号（槽位 env-2）")
  expect(options).not.toContain("取消钉住此账号（槽位 env）")
})

// The prefix is the IDENTITY (it is what the master's log lines name) and the label's local part is
// only a human hint, so the prefix stays even when a label resolves — and an unresolvable label
// yields no trailing separator, which would read as a truncated name.
test("the status line keeps the prefix as the identity and the label as a hint", () => {
  const full = "af008f89-1111-2222-3333-444455556666"
  // Keyed by the 8-char idPrefix from the snapshot while `held` carries the full uuid: resolution is
  // a startsWith test, and an equality one would never match.
  const labels = new Map([["af008f89", "vince.dai2@potentia.ai"]])

  expect(formatStatusText({ held: [{ slotName: "env" }], labelByPrefix: labels })).toBe("账号 无")
  expect(formatStatusText({ held: [{ slotName: "env", accountId: full }], labelByPrefix: labels })).toBe(
    "账号 af008f89 vince.dai2",
  )
  expect(formatStatusText({ held: [{ slotName: "env", accountId: full }], labelByPrefix: new Map() })).toBe(
    "账号 af008f89",
  )

  const two = formatStatusText({
    held: [
      { slotName: "env", accountId: full },
      { slotName: "env-2", accountId: "eaaa1a79-9999-8888-7777-666655554444" },
    ],
    labelByPrefix: labels,
  })
  expect(two).toBe("账号 env:af008f89 env-2:eaaa1a79")
})

// `stale` is the SCHEDULER's own verdict — selection has already stopped ranking by these numbers, so
// the title must stop presenting them as current. `at: 0` is a master that has never swept: a
// formatted epoch-0 timestamp would read as a real 1970 sweep.
test("the title reports when the numbers were taken and when they cannot be trusted", () => {
  const at = 1787280423805
  const clock = new Date(at)
  const hhmmss = [clock.getHours(), clock.getMinutes(), clock.getSeconds()]
    .map((part) => String(part).padStart(2, "0"))
    .join(":")

  expect(panelTitle(snapshot([]))).toBe(`账号池用量 · ${hhmmss}`)
  expect(panelTitle(snapshot([], { stale: true }))).toBe(`账号池用量 · ${hhmmss} · 数据可能过期`)
  expect(panelTitle(snapshot([], { at: 0 }))).toBe("账号池用量 · 尚未采集")
  expect(panelTitle(snapshot([], { at: 0, stale: true }))).toBe("账号池用量 · 尚未采集 · 数据可能过期")
})

// Flags are the reasons a switch will disappoint: a cooling-down or excluded account is one the
// scheduler will refuse, and 重登 means the chain is dead. Only the ones that hold are printed —
// a fixed slate of three markers would make every healthy row carry three pieces of noise.
test("only the flags that hold are appended", () => {
  const { rows } = rowsOf([
    account({ idPrefix: "aaaaaaaa", coolingDown: true, needsReauth: true, excluded: true }),
    account({ idPrefix: "bbbbbbbb" }),
  ])

  expect((rows[0] ?? "").endsWith("冷却 重登 排除")).toBe(true)
  expect(rows[1] ?? "").not.toContain("冷却")
  expect((rows[1] ?? "").trimEnd().endsWith("--")).toBe(true)
})

// THE BAR IS THE POINT OF THE COLUMN: eleven accounts of three percentages each is 33 numbers, and
// nobody scans 33 numbers. A filled shape is read at a glance, which is the whole reason the opencode
// panel draws one — this shares that exact function so the two views cannot disagree about 50%.
test("each window carries a proportional bar of constant width", () => {
  const { rows } = rowsOf([
    account({
      idPrefix: "aaaaaaaa",
      hasUsage: true,
      windows: [
        { label: "five_hour", utilization: 100 },
        { label: "seven_day", utilization: 50 },
        { label: "Fable", utilization: 0 },
      ],
    }),
  ])
  const row = rows[0] ?? ""

  expect(row).toContain(`5h ${"█".repeat(SENPI_BAR_WIDTH)} 100%`)
  expect(row).toContain("7d ███░░░  50%")
  expect(row).toContain(`Fable ${"░".repeat(SENPI_BAR_WIDTH)}   0%`)
})

// An account with no snapshot must not draw an EMPTY bar: a full-width `░░░░░░` is exactly what 0%
// looks like, so the one row whose usage is unknown would read as the pool's idlest account.
test("an unknown account draws no bar at all", () => {
  const { rows } = rowsOf([account({ idPrefix: "954fd7d5", hasUsage: false })])

  expect(cells(rows[0] ?? "", WINDOWS_CELL)).toBe("--")
  expect(rows[0]).not.toContain("░")
  expect(rows[0]).not.toContain("█")
})

// senpi's selector prints an option RAW — no truncation, no ellipsis — so a row wider than the
// terminal wraps and takes the whole grid's alignment with it. Measured at 95 columns: the `Fable`
// column fell off and ten wrapped lines appeared under the list. Dropping the bars is the graceful
// degradation, because the numbers alone are the form this panel had before them and it fits.
test("bars are dropped rather than clipped when the terminal is too narrow", () => {
  const accounts = [
    account({
      idPrefix: "aaaaaaaa",
      label: "vince.dai2@potentia.ai",
      hasUsage: true,
      windows: [
        { label: "five_hour", utilization: 42 },
        { label: "seven_day", utilization: 63 },
        { label: "Fable", utilization: 3 },
      ],
    }),
  ]
  const wide = formatAccountRows({ view: snapshot(accounts), held: [], workerId: WORKER, terminalWidth: 200 })
  const narrow = formatAccountRows({ view: snapshot(accounts), held: [], workerId: WORKER, terminalWidth: 95 })

  expect(wide.rows[0]).toContain("█")
  expect(narrow.rows[0]).not.toContain("█")
  expect(narrow.rows[0]).not.toContain("░")
  // The numbers survive the loss of the bar — that is what makes dropping it acceptable.
  expect(narrow.rows[0]).toContain("42%")
  expect(narrow.rows[0]).toContain("63%")
  // And the fallback actually fits, which is the entire point.
  expect(displayWidth(narrow.rows[0] ?? "")).toBeLessThanOrEqual(95)
})

// An unknown width must not silently strip the bars: this panel runs in a real terminal far more
// often than not, and defaulting to the degraded form would cost every user the feature to serve a
// case that may never occur.
test("an unknown terminal width keeps the bars", () => {
  const { rows } = rowsOf([
    account({ idPrefix: "aaaaaaaa", hasUsage: true, windows: [{ label: "five_hour", utilization: 50 }] }),
  ])

  expect(rows[0]).toContain("█")
})
