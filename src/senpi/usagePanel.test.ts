import { expect, test } from "bun:test"
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"
import type { UsageFetchOutcome } from "../worker/usageClient.ts"
import { createUsagePanel, type PanelUi } from "./usagePanel.ts"

const WORKER_ID = "vince-local.senpi"

function account(idPrefix: string, label: string, extra: Partial<UsageAccountView> = {}): UsageAccountView {
  return {
    idPrefix,
    label,
    windows: [
      { label: "five_hour", utilization: 12 },
      { label: "seven_day", utilization: 30 },
    ],
    hasUsage: true,
    coolingDown: false,
    excluded: false,
    needsReauth: false,
    holders: [],
    pinnedBy: [],
    ...extra,
  }
}

function view(accounts: UsageAccountView[]): UsageSnapshotView {
  return { at: 1_787_280_423_805, stale: false, accounts }
}

const TWO_ACCOUNTS = view([account("af008f89", "vince.dai2@potentia.ai"), account("eaaa1a79", "vince.dai3@potentia.ai")])

// A scripted UI: `select` answers from a queue and records what it was shown, which is the only way
// to assert a two-level dialog from a test — senpi's real select blocks on a terminal.
function scriptedUi(answers: (string | undefined)[]): {
  ui: PanelUi
  shown: { title: string; options: string[] }[]
  notified: { message: string; type?: string }[]
} {
  const shown: { title: string; options: string[] }[] = []
  const notified: { message: string; type?: string }[] = []
  let at = 0
  return {
    shown,
    notified,
    ui: {
      hasUI: true,
      select: (title, options) => {
        shown.push({ title, options })
        const answer = answers[at]
        at += 1
        return Promise.resolve(answer)
      },
      notify: (message, type) => {
        notified.push({ message, ...(type === undefined ? {} : { type }) })
      },
    },
  }
}

function usageStub(outcomes: { fetch: UsageFetchOutcome; refresh?: UsageFetchOutcome }): {
  usage: { fetchSnapshot: () => Promise<UsageFetchOutcome>; refreshSnapshot: () => Promise<UsageFetchOutcome> }
  refreshes: () => number
} {
  let refreshes = 0
  return {
    refreshes: () => refreshes,
    usage: {
      fetchSnapshot: () => Promise.resolve(outcomes.fetch),
      refreshSnapshot: () => {
        refreshes += 1
        return Promise.resolve(outcomes.refresh ?? outcomes.fetch)
      },
    },
  }
}

type Switched = { slotName: string; prefix: string; label: string; pin: "none" | "on" | "off" }

function panelWith(input: {
  usage: { fetchSnapshot: () => Promise<UsageFetchOutcome>; refreshSnapshot: () => Promise<UsageFetchOutcome> }
  slots?: string[]
  held?: { slotName: string; accountId?: string }[]
  pinnedSlots?: (idPrefix: string) => readonly string[]
}): { open: (ui: PanelUi) => Promise<void>; switched: Switched[] } {
  const switched: Switched[] = []
  const slots = input.slots ?? ["env"]
  const panel = createUsagePanel({
    usage: input.usage,
    switchTo: (target) => {
      switched.push(target)
      return Promise.resolve()
    },
    slots,
    held: () => input.held ?? slots.map((slotName) => ({ slotName })),
    pinnedSlots: input.pinnedSlots ?? (() => []),
    workerId: WORKER_ID,
  })
  return { open: panel.open, switched }
}

// The rows are BUILT by the panel, so a test that wants to choose one has to be shown them first —
// open once and cancel immediately. Hard-coding an expected row string here instead would couple every
// behaviour test to the column layout, which usageRows.test.ts already owns.
async function rowsOf(open: (ui: PanelUi) => Promise<void>): Promise<string[]> {
  const probe = scriptedUi([undefined])
  await open(probe.ui)
  return probe.shown[0]?.options ?? []
}

function accountRow(rows: readonly string[], idPrefix: string): string {
  const row = rows.find((candidate) => candidate.startsWith(idPrefix))
  if (row === undefined) throw new Error(`no row for ${idPrefix}`)
  return row
}

// The one option that is NOT an account: every account row starts with an 8-hex id, so the refresh
// sentinel is identified by failing that shape rather than by matching its wording.
function refreshRow(rows: readonly string[]): string {
  const row = rows.find((candidate) => !/^[0-9a-f]{8} /.test(candidate))
  if (row === undefined) throw new Error("no refresh row")
  return row
}

// A pool the panel cannot reach must SAY so and stop. Opening an empty dialog would read as "the
// pool has no accounts", which is a different and much more alarming fact than "the master is down".
test("an unreachable master is reported and no dialog is opened", async () => {
  const { usage } = usageStub({ fetch: { ok: false, failure: { kind: "unreachable", detail: "econnrefused" } } })
  const { open, switched } = panelWith({ usage })
  const { ui, shown, notified } = scriptedUi([])

  await open(ui)

  expect(shown).toEqual([])
  expect(switched).toEqual([])
  expect(notified).toHaveLength(1)
  expect(notified[0]?.message).toContain("连不上")
  expect(notified[0]?.type).toBe("error")
})

// `-p` and other non-interactive runs have no dialog surface at all. senpi's own builtins answer this
// by notifying the same text block instead, and a panel that simply did nothing would look broken.
test("without a UI the panel is printed as one notification instead", async () => {
  const { usage } = usageStub({ fetch: { ok: true, view: TWO_ACCOUNTS } })
  const { open } = panelWith({ usage })
  const { ui, shown, notified } = scriptedUi([])

  await open({ ...ui, hasUI: false })

  expect(shown).toEqual([])
  expect(notified).toHaveLength(1)
  // Both accounts are present, so the operator learns the roster even here.
  expect(notified[0]?.message).toContain("af008f89")
  expect(notified[0]?.message).toContain("eaaa1a79")
})

// THE HAPPY PATH, and the assertion that matters is the PREFIX: the panel hands back a chosen string,
// and mapping that string to the wrong account would switch the operator somewhere they did not pick.
test("picking a row then 切换 switches to that row's account", async () => {
  const { usage } = usageStub({ fetch: { ok: true, view: TWO_ACCOUNTS } })
  const { open, switched } = panelWith({ usage })
  const rows = await rowsOf(open)
  // The SECOND account deliberately: an implementation that keyed rows by index, or by label, would
  // switch to the first one here and the test would catch it.
  const run = scriptedUi([accountRow(rows, "eaaa1a79"), "切换到此账号"])

  await open(run.ui)

  expect(switched).toEqual([{ slotName: "env", prefix: "eaaa1a79", label: "vince.dai3@potentia.ai", pin: "none" }])
  // Two dialogs: the account list, then the action list titled with the chosen account.
  expect(run.shown).toHaveLength(2)
  expect(run.shown[1]?.title).toContain("eaaa1a79")
})

// The pin action is the SAME switch plus the flag the master records, so it must reach switchTo with
// pin true — a pin sent as a plain switch would be rotated away on the very next renewal.
test("切换并钉住 sends the pin flag", async () => {
  const { usage } = usageStub({ fetch: { ok: true, view: TWO_ACCOUNTS } })
  const { open, switched } = panelWith({ usage })
  const rows = await rowsOf(open)
  const run = scriptedUi([accountRow(rows, "af008f89"), "切换并钉住此账号"])

  await open(run.ui)

  expect(switched).toEqual([{ slotName: "env", prefix: "af008f89", label: "vince.dai2@potentia.ai", pin: "on" }])
})

// The way BACK OUT of a pin. The pin lives in this process, so if the panel only ever offered "钉住"
// there would be no way to release one short of restarting omo — and the plain switch must stay
// distinguishable from the un-pin, because manualSwitch says a different sentence for each.
test("an already-pinned slot is offered the un-pin and reports it as one", async () => {
  const { usage } = usageStub({ fetch: { ok: true, view: TWO_ACCOUNTS } })
  const { open, switched } = panelWith({ usage, pinnedSlots: (idPrefix) => (idPrefix === "af008f89" ? ["env"] : []) })
  const rows = await rowsOf(open)
  const run = scriptedUi([accountRow(rows, "af008f89"), "取消钉住此账号"])

  await open(run.ui)

  expect(run.shown[1]?.options).toEqual(["切换到此账号", "取消钉住此账号", "返回"])
  expect(switched).toEqual([{ slotName: "env", prefix: "af008f89", label: "vince.dai2@potentia.ai", pin: "off" }])
})

// Escape resolves undefined rather than throwing, and the ONLY correct response is silence: a toast
// on cancel would punish the operator for closing a dialog they opened to look at.
test("cancelling the account list changes nothing and says nothing", async () => {
  const { usage } = usageStub({ fetch: { ok: true, view: TWO_ACCOUNTS } })
  const { open, switched } = panelWith({ usage })
  const { ui, notified } = scriptedUi([undefined])

  await open(ui)

  expect(switched).toEqual([])
  expect(notified).toEqual([])
})

// Same rule one level down. Reaching the action list is not a commitment to switch.
test("cancelling the action list changes nothing and says nothing", async () => {
  const { usage } = usageStub({ fetch: { ok: true, view: TWO_ACCOUNTS } })
  const { open, switched } = panelWith({ usage })
  const probe = scriptedUi([undefined])
  await open(probe.ui)
  const firstRow = (probe.shown[0]?.options ?? [])[0]

  const run = scriptedUi([firstRow, undefined])
  await open(run.ui)

  expect(switched).toEqual([])
  expect(run.notified).toEqual([])
})

// 返回 must land back on the LIST, not exit: a mis-tap on a row is the ordinary case, and being
// dropped out of the panel for it means reopening and re-reading the whole roster.
test("返回 goes back to the account list instead of closing", async () => {
  const { usage } = usageStub({ fetch: { ok: true, view: TWO_ACCOUNTS } })
  const { open, switched } = panelWith({ usage })
  const probe = scriptedUi([undefined])
  await open(probe.ui)
  const firstRow = (probe.shown[0]?.options ?? [])[0]

  const run = scriptedUi([firstRow, "返回", undefined])
  await open(run.ui)

  expect(switched).toEqual([])
  // list → actions → list
  expect(run.shown).toHaveLength(3)
  expect(run.shown[2]?.options).toEqual(run.shown[0]?.options ?? [])
})

// The refresh row asks the MASTER to sweep — a worker never calls Anthropic itself — and then keeps
// the panel open. Closing it after a refresh would make the fresh numbers unreadable.
test("the refresh row re-fetches and keeps the panel open", async () => {
  const refreshed = view([account("af008f89", "vince.dai2@potentia.ai", { windows: [{ label: "five_hour", utilization: 99 }] })])
  const stub = usageStub({ fetch: { ok: true, view: TWO_ACCOUNTS }, refresh: { ok: true, view: refreshed } })
  const { open } = panelWith({ usage: stub.usage })
  const probe = scriptedUi([undefined])
  await open(probe.ui)
  const refreshRow = (probe.shown[0]?.options ?? []).find((row) => !/^[0-9a-f]{8} /.test(row))
  expect(refreshRow).toBeDefined()

  const run = scriptedUi([refreshRow, undefined])
  await open(run.ui)

  expect(stub.refreshes()).toBe(1)
  expect(run.shown).toHaveLength(2)
  // The second render shows the REFRESHED numbers, not the ones the panel opened with.
  expect(run.shown[1]?.options.some((row) => row.includes("99%"))).toBe(true)
})

// A throttled refresh is the master's guard working as designed, NOT a fault: the panel says how long
// and stays open on the numbers it already had. Exiting here would read as a crash.
test("a throttled refresh reports the countdown and keeps the old numbers", async () => {
  const stub = usageStub({
    fetch: { ok: true, view: TWO_ACCOUNTS },
    refresh: { ok: false, failure: { kind: "throttled", retryAfterMs: 9_000 } },
  })
  const { open } = panelWith({ usage: stub.usage })
  const probe = scriptedUi([undefined])
  await open(probe.ui)
  const refreshRow = (probe.shown[0]?.options ?? []).find((row) => !/^[0-9a-f]{8} /.test(row))

  const run = scriptedUi([refreshRow, undefined])
  await open(run.ui)

  expect(run.notified).toHaveLength(1)
  expect(run.notified[0]?.message).toContain("9")
  // Still open, still showing the accounts it had.
  expect(run.shown).toHaveLength(2)
  expect(run.shown[1]?.options).toEqual(run.shown[0]?.options ?? [])
})

// With K slots the operator must say WHICH slot moves, because the others keep their own accounts and
// the master is told a different holder for each. One action list for two slots would pick silently.
test("two slots offer a switch per slot", async () => {
  const { usage } = usageStub({ fetch: { ok: true, view: TWO_ACCOUNTS } })
  const { open, switched } = panelWith({ usage, slots: ["env", "env-2"] })
  const probe = scriptedUi([undefined])
  await open(probe.ui)
  const firstRow = (probe.shown[0]?.options ?? [])[0]

  const run = scriptedUi([firstRow, "切换到此账号（槽位 env-2）"])
  await open(run.ui)

  expect(run.shown[1]?.options.some((option) => option.includes("槽位 env"))).toBe(true)
  expect(switched).toEqual([{ slotName: "env-2", prefix: "af008f89", label: "vince.dai2@potentia.ai", pin: "none" }])
})
