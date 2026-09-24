import { expect, test } from "bun:test"
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"
import { RELAY_SERVICE, RELAY_VERSION, type RelayHealth } from "./relay.ts"
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
const SNAPSHOT: UsageSnapshotView = { at: 0, stale: false, accounts: [account("b657773c"), account("ea15869e")] }
const HEALTH: RelayHealth = { service: RELAY_SERVICE, version: RELAY_VERSION, pid: 1, workerId: "vince.cc", masterUrl: "http://m", sessions: 2, accountId: "b657773c" }

const deps = (over: Partial<PanelDeps> = {}): PanelDeps => ({
  prompt: "/pool",
  config: { masterUrl: "http://m", workerId: "vince.cc", relayPort: 18787 },
  health: async () => HEALTH,
  usage: async () => SNAPSHOT,
  readPin: () => undefined,
  ...over,
})
const reason = (out: string | undefined): string => (JSON.parse(out ?? "{}") as { reason: string }).reason

test("不是 /pool:返回 undefined,钩子原样放行", async () => {
  expect(await runPanel(deps({ prompt: "fix the bug" }))).toBeUndefined()
})

test("/pool:列出全池,当前号与钉住标出来", async () => {
  const text = reason(await runPanel(deps({ readPin: () => "ea15869e" })))
  expect(text).toContain("共享 b657773c · 2 个会话在用")
  expect(text).toMatch(/1\s+b657773c.*← 当前/)
  expect(text).toMatch(/2\s+ea15869e.*📌 钉住/)
})

// issue #101:衍生命令不要了 —— 带参数也只是看面板,不会切号。
test("/pool 带参数:照样只显示面板", async () => {
  const text = reason(await runPanel(deps({ prompt: "/pool 2" })))
  expect(text).toContain("共享 b657773c")
})

test("relay 不在:面板照出,并提示 make status", async () => {
  const text = reason(await runPanel(deps({ health: async () => undefined })))
  expect(text).toContain("make status")
  expect(text).toContain("共享 尚未领取")
})

test("这台机器没配过:指向 make setup", async () => {
  expect(reason(await runPanel(deps({ config: undefined })))).toContain("make setup")
})
