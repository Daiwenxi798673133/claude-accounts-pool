import { expect, test } from "bun:test"
import type { UsageAccountView, UsageSnapshotView } from "../cloud/protocol.ts"
import { RELAY_SERVICE, RELAY_VERSION, type RelayHealth } from "./relay.ts"
import { renderStatusLine, statusSnapshot, STATUS_USAGE_MAX_AGE_MS, STATUS_USAGE_TTL_MS, type CachedUsage } from "./statusLine.ts"

const NOW = Date.parse("2026-09-24T00:00:00Z")
const account = (over: Partial<UsageAccountView> = {}): UsageAccountView => ({
  idPrefix: "42036c61",
  label: "cca1@potentia.ai",
  windows: [
    { label: "five_hour", utilization: 4, resetsAt: "2026-09-24T04:45:00Z" },
    { label: "seven_day", utilization: 90 },
    { label: "Fable", utilization: 15 },
  ],
  hasUsage: true,
  coolingDown: false,
  excluded: false,
  needsReauth: false,
  ...over,
})
const SNAPSHOT: UsageSnapshotView = { at: NOW, stale: false, accounts: [account()] }
const HEALTH: RelayHealth = { service: RELAY_SERVICE, version: RELAY_VERSION, pid: 1, workerId: "w", masterUrl: "m", sessions: 1, accountId: "42036c61" }
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "")

test("一行:当前号的名字与前缀、5h / 7d 进度条、百分比、重置倒计时", () => {
  const line = renderStatusLine({ health: HEALTH, snapshot: SNAPSHOT, now: NOW })
  expect(plain(line)).toBe("账号池 ● cca1 42036c61 · 5h ░░░░░░░░░░ 4% 4h 45m · 7d █████████░ 90%")
  // 与面板同一套分档:90% 是红的。
  expect(line).toContain("\x1b[31m█████████░\x1b[0m")
  expect(line).not.toContain("\n")
})

test("钉住、冷却、需重新登录都标在名字后面", () => {
  const line = plain(renderStatusLine({ health: HEALTH, snapshot: { ...SNAPSHOT, accounts: [account({ coolingDown: true, needsReauth: true })] }, pin: "42036c61", now: NOW }))
  expect(line).toStartWith("账号池 ● cca1 42036c61 已钉住 冷却中 需重新登录 · ")
})

test("relay 不在、还没领号、快照里没有这个号:各说各的", () => {
  expect(plain(renderStatusLine({ health: undefined, snapshot: SNAPSHOT, now: NOW }))).toBe("账号池 relay 不在")
  expect(plain(renderStatusLine({ health: { ...HEALTH, accountId: undefined }, snapshot: SNAPSHOT, now: NOW }))).toBe("账号池 还没领到号")
  expect(plain(renderStatusLine({ health: { ...HEALTH, accountId: "deadbeef" }, snapshot: SNAPSHOT, now: NOW }))).toBe("账号池 ● deadbeef · 用量未知")
  expect(plain(renderStatusLine({ health: HEALTH, snapshot: undefined, now: NOW }))).toBe("账号池 ● 42036c61 · 用量未知")
})

function cache(initial?: CachedUsage) {
  let stored = initial
  let fetches = 0
  return {
    deps: (now: number, fetched: UsageSnapshotView | undefined) => ({
      read: () => stored,
      write: (next: CachedUsage) => void (stored = next),
      fetch: async () => (fetches++, fetched),
      now: () => now,
    }),
    stored: () => stored,
    fetches: () => fetches,
  }
}

test("快照缓存:20 秒内共用,不去 master", async () => {
  const c = cache({ fetchedAt: NOW, view: SNAPSHOT })
  expect(await statusSnapshot(c.deps(NOW + STATUS_USAGE_TTL_MS - 1, undefined))).toBe(SNAPSHOT)
  expect(c.fetches()).toBe(0)
})

test("快照缓存:过期就去 master 取,取到就写回", async () => {
  const fresh = { ...SNAPSHOT, at: NOW + 1 }
  const c = cache({ fetchedAt: NOW, view: SNAPSHOT })
  expect(await statusSnapshot(c.deps(NOW + STATUS_USAGE_TTL_MS, fresh))).toBe(fresh)
  expect(c.stored()).toEqual({ fetchedAt: NOW + STATUS_USAGE_TTL_MS, view: fresh })
})

test("快照缓存:master 连不上时 10 分钟内的旧快照还拿来画,更旧就不画数字", async () => {
  const c = cache({ fetchedAt: NOW, view: SNAPSHOT })
  expect(await statusSnapshot(c.deps(NOW + STATUS_USAGE_MAX_AGE_MS - 1, undefined))).toBe(SNAPSHOT)
  expect(await statusSnapshot(c.deps(NOW + STATUS_USAGE_MAX_AGE_MS, undefined))).toBeUndefined()
  expect(await statusSnapshot(cache().deps(NOW, undefined))).toBeUndefined()
})

test("快照缓存:时钟回拨(缓存时间在未来)不当成新鲜", async () => {
  const c = cache({ fetchedAt: NOW + 60_000, view: SNAPSHOT })
  await statusSnapshot(c.deps(NOW, SNAPSHOT))
  expect(c.fetches()).toBe(1)
})
