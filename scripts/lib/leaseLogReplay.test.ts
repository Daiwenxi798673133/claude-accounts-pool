import { expect, test } from "bun:test"
import { parseLeaseLog, summarize } from "./leaseLogReplay.ts"

function line(at: string, msg: string, fields: Record<string, string | number> = {}): string {
  const tail = Object.entries(fields)
    .map(([key, value]) => ` ${key}=${value}`)
    .join("")
  return `timestamp=${at} level=INFO run=deadbeef message="claude-accounts-usage ${msg}"${tail}`
}

test("只认账号池自己的日志行,其余一概跳过", () => {
  const events = parseLeaseLog(
    [
      `timestamp=2026-09-08T00:00:00.000Z level=INFO run=deadbeef message="loading tui config" path=/tmp/x`,
      "这一行根本不是日志",
      line("2026-09-08T00:00:01.000Z", "master:lease-served", { workerId: "w1", accountId: "acct-a" }),
    ].join("\n"),
  )

  expect(events).toHaveLength(1)
  expect(events[0].msg).toBe("master:lease-served")
  expect(events[0].fields).toEqual({ workerId: "w1", accountId: "acct-a" })
})

test("按 source 把保号拆成 worker 自报与亲和账本兜底,其余算重新选举", () => {
  const events = parseLeaseLog(
    [
      // A lease with no companion line is an election — the path that can move a worker off a
      // healthy account.
      line("2026-09-08T00:00:00.000Z", "master:lease-served", { workerId: "w1", accountId: "acct-a" }),
      line("2026-09-08T01:00:00.000Z", "master:lease-incumbent", { workerId: "w1", accountId: "acct-a", source: "worker" }),
      line("2026-09-08T01:00:00.100Z", "master:lease-served", { workerId: "w1", accountId: "acct-a" }),
      line("2026-09-08T02:00:00.000Z", "master:lease-incumbent", { workerId: "w1", accountId: "acct-a", source: "affinity" }),
      line("2026-09-08T02:00:00.100Z", "master:lease-served", { workerId: "w1", accountId: "acct-a" }),
      line("2026-09-08T03:00:00.000Z", "master:lease-preferred", { workerId: "w1", accountId: "acct-a", pinned: "true" }),
      line("2026-09-08T03:00:00.100Z", "master:lease-served", { workerId: "w1", accountId: "acct-a" }),
    ].join("\n"),
  )

  const s = summarize(events)
  expect(s.leases).toBe(4)
  expect(s.paths).toEqual({
    election: 1,
    incumbentWorker: 1,
    incumbentAffinity: 1,
    preferred: 1,
    misattributed: 0,
  })
})

test("一份没有 source 字段的旧日志把保号全算作 worker 自报,不猜成亲和", () => {
  const events = parseLeaseLog(
    [
      line("2026-09-08T01:00:00.000Z", "master:lease-incumbent", { workerId: "w1", accountId: "acct-a" }),
      line("2026-09-08T01:00:00.100Z", "master:lease-served", { workerId: "w1", accountId: "acct-a" }),
    ].join("\n"),
  )

  // The field arrived with the affinity book. A log written before it has neither the field nor the
  // behaviour, so crediting the book here would invent a fix that machine never ran.
  const s = summarize(events)
  expect(s.paths.incumbentWorker).toBe(1)
  expect(s.paths.incumbentAffinity).toBe(0)
})

test("换号按有无限流诱因分开计数", () => {
  const events = parseLeaseLog(
    [
      line("2026-09-08T00:00:00.000Z", "master:lease-served", { workerId: "w1", accountId: "acct-a" }),
      // Moved with nothing reported against acct-a — the switch this tool exists to count.
      line("2026-09-08T01:00:00.000Z", "master:lease-served", { workerId: "w1", accountId: "acct-b" }),
      line("2026-09-08T02:00:00.000Z", "master:ratelimit-reported", { workerId: "w1", accountId: "acct-b", headerKeys: "[]" }),
      line("2026-09-08T02:01:00.000Z", "master:lease-served", { workerId: "w1", accountId: "acct-c" }),
    ].join("\n"),
  )

  const s = summarize(events)
  expect(s.switches).toBe(2)
  expect(s.switchesWithoutLimit).toBe(1)
  expect(s.rateLimits).toBe(1)
})

test("统计接手时还干净的号被打爆,以及接手到打爆的间隔", () => {
  const events = parseLeaseLog(
    [
      line("2026-09-08T00:00:00.000Z", "master:lease-served", { workerId: "w1", accountId: "acct-a" }),
      line("2026-09-08T01:00:00.000Z", "master:lease-served", { workerId: "w1", accountId: "acct-b" }),
      // Adopted clean at 01:00 and dead 30 minutes later: nobody had reported acct-b spent before
      // the handover, so the pool handed over an account it believed was healthy.
      line("2026-09-08T01:30:00.000Z", "master:ratelimit-reported", { workerId: "w1", accountId: "acct-b", headerKeys: "[]" }),
    ].join("\n"),
  )

  const s = summarize(events)
  expect(s.limitsOnCleanAccounts).toBe(1)
  expect(s.limitsWithinHourOfAdoption).toBe(1)
  expect(s.dwellBeforeLimitMs.median).toBe(30 * 60_000)
})

test("单 worker 90 分钟内打爆三个号算一段级联,重叠的窗口不重复计", () => {
  const events = parseLeaseLog(
    [
      line("2026-09-08T06:30:00.000Z", "master:ratelimit-reported", { workerId: "w1", accountId: "acct-a" }),
      line("2026-09-08T06:35:00.000Z", "master:ratelimit-reported", { workerId: "w1", accountId: "acct-b" }),
      line("2026-09-08T07:03:00.000Z", "master:ratelimit-reported", { workerId: "w1", accountId: "acct-c" }),
      line("2026-09-08T07:21:00.000Z", "master:ratelimit-reported", { workerId: "w1", accountId: "acct-d" }),
    ].join("\n"),
  )

  const s = summarize(events)
  expect(s.cascades).toHaveLength(1)
  expect(s.cascades[0].accounts).toBe(4)
  expect(s.cascades[0].spanMs).toBe(51 * 60_000)
})

test("汇总燃烧速率观测行,按账号前缀归集", () => {
  const events = parseLeaseLog(
    [
      line("2026-09-08T00:00:00.000Z", "master:burn-observed", { "af008f89": 12.5, "13622244": 3 }),
      line("2026-09-08T00:05:00.000Z", "master:burn-observed", { "af008f89": 30 }),
    ].join("\n"),
  )

  const s = summarize(events)
  expect(s.burnRatesPerHour).toEqual({ af008f89: [12.5, 30], "13622244": [3] })
})
