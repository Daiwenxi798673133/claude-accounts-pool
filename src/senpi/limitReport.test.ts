import { expect, test } from "bun:test"
import { createLimitReporter } from "./limitReport.ts"

type Sent = { accountId: string; headers: Record<string, string> }

function reporter(answers: boolean[] = []): { report: ReturnType<typeof createLimitReporter>["report"]; sent: Sent[] } {
  const sent: Sent[] = []
  const { report } = createLimitReporter({
    reportRateLimit: (input) => {
      sent.push(input)
      return Promise.resolve(answers[sent.length - 1] ?? true)
    },
  })
  return { report, sent }
}

// 封锁期间每一轮 turn_start 都会走审计,不去重就是对着 master 连打 —— 而一次封锁只有一个事实可报。
test("同一次封锁只上报一次", async () => {
  const { report, sent } = reporter()
  await report({ accountId: "acct-a", blockedUntil: 5_000 })
  await report({ accountId: "acct-a", blockedUntil: 5_000 })
  await report({ accountId: "acct-a", blockedUntil: 5_000 })
  expect(sent.map((one) => one.accountId)).toEqual(["acct-a"])
})

// 期限变了就是新的一次封锁:上一次的冷却 master 可能已经按用量轮询放掉了。
test("换一次封锁会再上报一枪", async () => {
  const { report, sent } = reporter()
  await report({ accountId: "acct-a", blockedUntil: 5_000 })
  await report({ accountId: "acct-a", blockedUntil: 9_000 })
  expect(sent).toHaveLength(2)
})

// senpi 有时只留 blockReason 不留 blockedUntil,那也是一次封锁,而且同样只该报一次。
test("没有期限的封锁照样上报，且仍然去重", async () => {
  const { report, sent } = reporter()
  await report({ accountId: "acct-a" })
  await report({ accountId: "acct-a" })
  expect(sent).toHaveLength(1)
})

// 账号各自成账:一个号打满不代表另一个号也打满。
test("不同账号各报各的", async () => {
  const { report, sent } = reporter()
  await report({ accountId: "acct-a", blockedUntil: 5_000 })
  await report({ accountId: "acct-b", blockedUntil: 5_000 })
  expect(sent.map((one) => one.accountId)).toEqual(["acct-a", "acct-b"])
})

// 这条钉住的是一个判断,不是一个实现细节:senpi 的 blockedUntil 是它自己的重试窗口(实测比真实的 5 小时
// 重置点早一个多小时),拿它冒充 resetsAt 会让 master 一分钟后又把这个空号发给下一台机器。什么都不带
// 时 master 记的是"待定冷却",由它自己的用量轮询填真实期限。headers 空也是同一个道理:senpi 把 429
// 的报文丢了,没有可以诚实填进去的东西。
test("上报不携带 resetsAt，headers 为空", async () => {
  const { report, sent } = reporter()
  await report({ accountId: "acct-a", blockedUntil: 5_000 })
  expect(sent[0]).toEqual({ accountId: "acct-a", headers: {} })
  expect(Object.hasOwn(sent[0]!, "resetsAt")).toBe(false)
})

// master 暂时不可达时,报不到的代价是别的机器继续撞这个空号,所以下一轮还站着同一个封锁就该再试。
test("上报失败后下一轮重试，成功后不再重试", async () => {
  const { report, sent } = reporter([false, true])
  await report({ accountId: "acct-a", blockedUntil: 5_000 })
  await report({ accountId: "acct-a", blockedUntil: 5_000 })
  await report({ accountId: "acct-a", blockedUntil: 5_000 })
  expect(sent).toHaveLength(2)
})
