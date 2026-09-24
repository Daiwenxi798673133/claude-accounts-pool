import { expect, test } from "bun:test"
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"
import { RELAY_SERVICE, RELAY_VERSION, type AttachRequest, type RelayHealth } from "./relay.ts"
import type { AttachOutcome } from "./relayClient.ts"
import { runPanel, type PanelDeps } from "./panelRun.ts"

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

function harness(over: Partial<PanelDeps> & { attach?: (input: AttachRequest) => AttachOutcome; storedPin?: string } = {}) {
  let pin = over.storedPin
  const attaches: AttachRequest[] = []
  const { attach, storedPin: _s, ...rest } = over
  const deps: PanelDeps = {
    prompt: "/pool",
    config: { masterUrl: "http://m", workerId: "vince.cc", relayPort: 18787 },
    health: async () => HEALTH,
    usage: async () => SNAPSHOT,
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
    ...rest,
  }
  return { deps, attaches, pin: () => pin }
}

const reason = (out: string | undefined): string => (JSON.parse(out ?? "{}") as { reason: string }).reason

test("不是 /pool:返回 undefined,钩子原样放行", async () => {
  expect(await runPanel(harness({ prompt: "fix the bug" }).deps)).toBeUndefined()
})

test("/pool:列出全池,当前号标出来,一个号都不切", async () => {
  const h = harness()
  const text = reason(await runPanel(h.deps))
  expect(text).toContain("共享 b657773c")
  expect(text).toMatch(/1\s+b657773c.*← 当前/)
  expect(h.attaches).toEqual([])
})

test("/pool 3:经 relay 点名 #3,本机其它会话一起换", async () => {
  const h = harness({ prompt: "/pool 3" })
  const text = reason(await runPanel(h.deps))
  expect(h.attaches).toEqual([{ pid: 4242, preferredAccountIdPrefix: "2277483b", pinned: false }])
  // attach 把钩子自己的 pid 也算进了会话数:3 - 1 = 2。
  expect(text).toContain("✓ 已切到 2277483b,本机 2 个会话从下一个请求起用它")
  // 面板上的会话数同样不算钩子自己(HEALTH.sessions = 2,减掉刚 attach 的钩子 pid)。
  expect(text).toContain("1 个会话在用")
  expect(h.pin()).toBeUndefined()
})

test("/pool pin 2:先落盘钉住,再点名,点名带 pinned", async () => {
  let pinAtAttach: string | undefined
  const h = harness({
    prompt: "/pool pin 2",
    attach: (input) => ((pinAtAttach = h.pin()), { ok: true, lease: { accountId: `${input.preferredAccountIdPrefix}-x`, access: "t", expiresAt: 1 }, sessions: 1 }),
  })
  const text = reason(await runPanel(h.deps))
  expect(pinAtAttach).toBe("ea15869e")
  expect(h.attaches[0]).toEqual({ pid: 4242, preferredAccountIdPrefix: "ea15869e", pinned: true })
  expect(text).toContain("并钉住")
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

test("/pool unpin:清掉钉住,说清楚当前号不变", async () => {
  const h = harness({ prompt: "/pool unpin", storedPin: "ea15869e" })
  const text = reason(await runPanel(h.deps))
  expect(h.pin()).toBeUndefined()
  expect(text).toContain("✓ 已取消钉住 ea15869e")
})

test("relay 不在:如实说,指向 make status", async () => {
  expect(reason(await runPanel(harness({ health: async () => undefined }).deps))).toContain("make status")
})

test("这台机器没配过:指向 make setup", async () => {
  expect(reason(await runPanel(harness({ config: undefined }).deps))).toContain("make setup")
})

test("看不懂的命令:给用法", async () => {
  expect(reason(await runPanel(harness({ prompt: "/pool pin" }).deps))).toContain("/pool 用法")
})
