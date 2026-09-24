import { expect, test } from "bun:test"
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"
import { RELAY_SERVICE, RELAY_VERSION, type AttachRequest, type RelayHealth } from "./relay.ts"
import type { AttachOutcome } from "./relayClient.ts"
import { runPanel, type PanelDeps, type UsageRefresh } from "./panelRun.ts"

const account = (idPrefix: string): UsageAccountView => ({
  idPrefix,
  label: `${idPrefix}@example.com`,
  windows: [{ label: "five_hour", utilization: 5 }],
  hasUsage: true,
  coolingDown: false,
  excluded: false,
  needsReauth: false,
})
const SNAPSHOT: UsageSnapshotView = { at: 0, stale: false, accounts: [account("b657773c"), account("ea15869e"), account("2277483b")] }
const HEALTH: RelayHealth = {
  service: RELAY_SERVICE,
  version: RELAY_VERSION,
  pid: 1,
  workerId: "vince.cc",
  masterUrl: "http://m",
  sessions: 2,
  accountId: "b657773c",
}

function harness(
  over: Partial<PanelDeps> & { attach?: (input: AttachRequest) => AttachOutcome; storedPin?: string; refresh?: () => UsageRefresh } = {},
) {
  let pin = over.storedPin
  const attaches: AttachRequest[] = []
  let refreshes = 0
  const { attach, storedPin: _s, refresh, ...rest } = over
  const deps: PanelDeps = {
    prompt: "/pool",
    config: { masterUrl: "http://m", workerId: "vince.cc", relayPort: 18787 },
    health: async () => HEALTH,
    usage: async () => SNAPSHOT,
    refreshUsage: async () => (refreshes++, refresh?.() ?? { ok: true, view: SNAPSHOT }),
    relay: {
      attach: async (input) => (
        attaches.push(input),
        attach?.(input) ?? {
          ok: true,
          lease: { accountId: `${input.preferredAccountIdPrefix}-full-id`, access: "tok", expiresAt: 9e15 },
          sessions: 3,
        }
      ),
    },
    pin: { read: () => pin, write: (next) => void (pin = next) },
    pid: 4242,
    terminalWidth: () => undefined,
    now: () => 0,
    ...rest,
  }
  return { deps, attaches, pin: () => pin, refreshes: () => refreshes }
}

const reason = (out: string | undefined): string =>
  (JSON.parse(out ?? "{}") as { reason: string }).reason.replace(/\x1b\[[0-9;]*m/g, "")

test("不是 /pool:返回 undefined,钩子原样放行", async () => {
  expect(await runPanel(harness({ prompt: "fix the bug" }).deps)).toBeUndefined()
})

test("/pool:列出全池,当前号标出来,一个号都不切", async () => {
  const h = harness()
  const text = reason(await runPanel(h.deps))
  expect(text).toContain("本机 vince.cc · 2 个会话在用")
  expect(text).toMatch(/1 ● b657773c@example\.com In Use/)
  expect(text).toMatch(/2 ○ ea15869e@example\.com/)
  expect(h.attaches).toEqual([])
})

test("/pool 3:经 relay 点名 #3,本机其它会话一起换", async () => {
  const h = harness({ prompt: "/pool 3" })
  const text = reason(await runPanel(h.deps))
  expect(h.attaches).toEqual([{ pid: 4242, preferredAccountIdPrefix: "2277483b", pinned: false }])
  // attach 把钩子自己的 pid 也算进了会话数:3 - 1 = 2。
  expect(text).toContain("✓ 已切到「2277483b@example.com」,续期会保住它,撞限额才换号;本机 2 个会话从下一个请求起用它。")
  // 面板上的会话数同样不算钩子自己(HEALTH.sessions = 2,减掉刚 attach 的钩子 pid)。
  expect(text).toContain("1 个会话在用")
  expect(h.pin()).toBeUndefined()
})

test("/pool <id 前缀>:按前缀点名", async () => {
  const h = harness({ prompt: "/pool ea15" })
  await runPanel(h.deps)
  expect(h.attaches[0]?.preferredAccountIdPrefix).toBe("ea15869e")
})

test("切到本机本来就在用的号:不发点名,说没有变化", async () => {
  const h = harness({ prompt: "/pool 1" })
  expect(reason(await runPanel(h.deps))).toContain("本机本来就在用「b657773c@example.com」")
  expect(h.attaches).toEqual([])
})

test("/pool 2 pin:先落盘钉住,再点名,点名带 pinned", async () => {
  let pinAtAttach: string | undefined
  const h = harness({
    prompt: "/pool 2 pin",
    attach: (input) => ((pinAtAttach = h.pin()), { ok: true, lease: { accountId: `${input.preferredAccountIdPrefix}-x`, access: "t", expiresAt: 1 }, sessions: 1 }),
  })
  const text = reason(await runPanel(h.deps))
  expect(pinAtAttach).toBe("ea15869e")
  expect(h.attaches[0]).toEqual({ pid: 4242, preferredAccountIdPrefix: "ea15869e", pinned: true })
  expect(text).toContain("✓ 已钉住「ea15869e@example.com」")
  expect(h.pin()).toBe("ea15869e")
})

test("#97 的写法 /pool pin 2 也认", async () => {
  const h = harness({ prompt: "/pool pin 2" })
  await runPanel(h.deps)
  expect(h.attaches[0]).toEqual({ pid: 4242, preferredAccountIdPrefix: "ea15869e", pinned: true })
})

// OMO 的 p:同一个键,已钉住的号上按就是取消。
test("对已钉住的号再 /pool N pin:取消钉住,当前号不动", async () => {
  const h = harness({ prompt: "/pool 1 pin", storedPin: "b657773c" })
  const text = reason(await runPanel(h.deps))
  expect(h.pin()).toBeUndefined()
  expect(h.attaches).toEqual([])
  expect(text).toContain("✓ 已取消钉住「b657773c@example.com」:当前号不变")
})

test("钉住失败:钉住还原成原来的,不留一个会被反复点名的钉住", async () => {
  const h = harness({
    prompt: "/pool 3 pin",
    storedPin: "b657773c",
    attach: () => ({ ok: false, failure: { kind: "refused", refused: "cooling" } }),
  })
  await runPanel(h.deps)
  expect(h.pin()).toBe("b657773c")
  const fresh = harness({ prompt: "/pool 3 pin", attach: () => ({ ok: false, failure: { kind: "unreachable", detail: "x" } }) })
  await runPanel(fresh.deps)
  expect(fresh.pin()).toBeUndefined()
})

test("钉住着 A 时手动切到 B:A 的钉住放掉(不然下一次续期会切回 A),并说出来", async () => {
  const h = harness({ prompt: "/pool 3", storedPin: "ea15869e" })
  const text = reason(await runPanel(h.deps))
  expect(h.attaches[0]).toEqual({ pid: 4242, preferredAccountIdPrefix: "2277483b", pinned: false })
  expect(h.pin()).toBeUndefined()
  expect(text).toContain("原来钉住的 ea15869e 已取消")
})

test("切号失败时原来的钉住不动", async () => {
  const h = harness({ prompt: "/pool 3", storedPin: "ea15869e", attach: () => ({ ok: false, failure: { kind: "no-account" } }) })
  await runPanel(h.deps)
  expect(h.pin()).toBe("ea15869e")
})

// 用量归属依赖"我要的就是我拿到的":被拒就如实说,绝不换成别的号。
test("master 拒绝点名:如实说出原因", async () => {
  const h = harness({ prompt: "/pool 2", attach: () => ({ ok: false, failure: { kind: "refused", refused: "cooling" } }) })
  const text = reason(await runPanel(h.deps))
  expect(text).toContain("✗ 没有切过去")
  expect(text).toContain("冷却")
})

test("编号越界:不发任何点名", async () => {
  const h = harness({ prompt: "/pool 9" })
  expect(reason(await runPanel(h.deps))).toContain("没有 #9")
  expect(h.attaches).toEqual([])
})

test("拿不到账号列表时,id 前缀仍可直接交给 master;编号不行", async () => {
  const byPrefix = harness({ prompt: "/pool 2277483b", usage: async () => undefined })
  await runPanel(byPrefix.deps)
  expect(byPrefix.attaches[0]?.preferredAccountIdPrefix).toBe("2277483b")
  const byNumber = harness({ prompt: "/pool 3", usage: async () => undefined })
  expect(reason(await runPanel(byNumber.deps))).toContain("用 id 前缀")
  expect(byNumber.attaches).toEqual([])
})

test("relay 不在:面板照看,切号如实拒绝,都指向 make status", async () => {
  expect(reason(await runPanel(harness({ health: async () => undefined }).deps))).toContain("make status")
  const h = harness({ prompt: "/pool 2", health: async () => undefined })
  expect(reason(await runPanel(h.deps))).toContain("✗ 没法切号")
  expect(h.attaches).toEqual([])
})

test("/pool r:让 master 采一轮,面板画刚采到的数", async () => {
  const fresh = { ...SNAPSHOT, accounts: [account("b657773c"), { ...account("ea15869e"), label: "fresh@example.com" }] }
  const h = harness({ prompt: "/pool r", refresh: () => ({ ok: true, view: fresh }) })
  const text = reason(await runPanel(h.deps))
  expect(h.refreshes()).toBe(1)
  expect(text).toContain("✓ master 刚采完一轮用量")
  expect(text).toContain("fresh@example.com")
})

test("/pool r 被 master 节流:说还要等多久,照样画面板", async () => {
  const h = harness({ prompt: "/pool r", refresh: () => ({ ok: false, message: "master 刚刷新过用量，12 秒后可再刷新" }) })
  const text = reason(await runPanel(h.deps))
  expect(text).toContain("12 秒后可再刷新")
  expect(text).toContain("账号池用量")
})

test("这台机器没配过:指向 make setup", async () => {
  expect(reason(await runPanel(harness({ config: undefined }).deps))).toContain("make setup")
})

test("看不懂的命令:给用法", async () => {
  expect(reason(await runPanel(harness({ prompt: "/pool pin" }).deps))).toContain("/pool 用法")
  expect(reason(await runPanel(harness({ prompt: "/pool 1 2 3" }).deps))).toContain("看不懂")
})
