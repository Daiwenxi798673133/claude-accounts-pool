import { afterEach, expect, test } from "bun:test"
import { MASTER_BIND_RETRY_BASE_MS, MASTER_BIND_RETRY_CAP_MS } from "../constants.ts"
import { initLogger } from "../logger.ts"
import { startWithBindRetry } from "./bindRetry.ts"

// `start` is a fake, never a real Bun.serve: the case that matters is an interface that APPEARS
// between two attempts, and no test can make a real one appear. What Bun actually throws for a
// missing address is recorded in the module header instead.

type FakeServer = { id: number; stopped: boolean; stop: () => void }

function fakeServer(id: number): FakeServer {
  const server: FakeServer = { id, stopped: false, stop: () => (server.stopped = true) }
  return server
}

// Bun's own wording for a hostname that is not on this box — the misleading EADDRINUSE included.
function bindError(): Error {
  return Object.assign(new Error("Failed to start server. Is port 8787 in use?"), { code: "EADDRINUSE" })
}

// Fails the first `failures` attempts, then binds.
function flakyStart(failures: number) {
  let attempts = 0
  const servers: FakeServer[] = []
  return {
    start: (): FakeServer => {
      attempts++
      if (attempts <= failures) throw bindError()
      const server = fakeServer(attempts)
      servers.push(server)
      return server
    },
    attempts: () => attempts,
    servers,
  }
}

type Logged = { level?: string; message?: string; extra?: Record<string, unknown> }

function captureLogs(): Logged[] {
  const logs: Logged[] = []
  initLogger({ app: { log: (entry: Logged) => void logs.push(entry) } })
  return logs
}

afterEach(() => initLogger(undefined))

const base = { hostname: "100.64.0.36", port: 8787 }

test("地址已就绪：第一次就绑上，而且在函数返回前同步完成，不等待", async () => {
  const flaky = flakyStart(0)
  const slept: number[] = []
  const handle = startWithBindRetry({
    ...base,
    start: flaky.start,
    signal: new AbortController().signal,
    sleep: async (ms) => void slept.push(ms),
  })
  // 同步：插件装载顺序与改动前一致，健康开机时端口在 installCloudMaster 返回时就已打开。
  expect(flaky.attempts()).toBe(1)
  expect((await handle.bound)?.id).toBe(1)
  expect(slept).toEqual([])
})

test("地址晚到：失败时记 bind-fail 并退避重试，地址出现后绑上", async () => {
  const logs = captureLogs()
  const flaky = flakyStart(2)
  const slept: number[] = []
  const handle = startWithBindRetry({
    ...base,
    start: flaky.start,
    signal: new AbortController().signal,
    sleep: async (ms) => void slept.push(ms),
  })

  expect((await handle.bound)?.id).toBe(3)
  expect(slept).toEqual([MASTER_BIND_RETRY_BASE_MS, 2 * MASTER_BIND_RETRY_BASE_MS])
  // 这条日志就是这次修复要补上的可见性：以前绑定失败被插件加载器吞掉，日志里一个字都没有。
  const fails = logs.filter((entry) => entry.message?.endsWith("master:lease-server-bind-fail"))
  expect(fails.length).toBe(2)
  expect(fails[0].level).toBe("warn")
  expect(fails[0].extra).toMatchObject({ hostname: "100.64.0.36", port: 8787, attempt: 1, errCode: "EADDRINUSE" })
})

test("退避封顶：断网再久，两次尝试的间隔也不超过上限", async () => {
  const flaky = flakyStart(12)
  const slept: number[] = []
  const handle = startWithBindRetry({
    ...base,
    start: flaky.start,
    signal: new AbortController().signal,
    sleep: async (ms) => void slept.push(ms),
  })

  expect((await handle.bound)?.id).toBe(13)
  expect(slept.length).toBe(12)
  expect(Math.max(...slept)).toBe(MASTER_BIND_RETRY_CAP_MS)
  expect(slept.at(-1)).toBe(MASTER_BIND_RETRY_CAP_MS)
})

test("等待中插件被卸载：不再尝试，bound 以 undefined 结束", async () => {
  const flaky = flakyStart(Number.POSITIVE_INFINITY)
  const controller = new AbortController()
  let wake: () => void = () => {}
  const handle = startWithBindRetry({
    ...base,
    start: flaky.start,
    signal: controller.signal,
    sleep: () => new Promise<void>((resolve) => (wake = resolve)),
  })

  expect(flaky.attempts()).toBe(1)
  controller.abort()
  wake()
  expect(await handle.bound).toBeUndefined()
  expect(flaky.attempts()).toBe(1)
})

test("handle.stop() 同样中止重试", async () => {
  const flaky = flakyStart(Number.POSITIVE_INFINITY)
  let wake: () => void = () => {}
  const handle = startWithBindRetry({
    ...base,
    start: flaky.start,
    signal: new AbortController().signal,
    sleep: () => new Promise<void>((resolve) => (wake = resolve)),
  })

  handle.stop()
  wake()
  expect(await handle.bound).toBeUndefined()
  expect(flaky.attempts()).toBe(1)
})

test("绑上之后 stop() 与 abort 都会关掉那台 server", async () => {
  const viaStop = startWithBindRetry({
    ...base,
    start: flakyStart(1).start,
    signal: new AbortController().signal,
    sleep: async () => {},
  })
  const stopped = await viaStop.bound
  viaStop.stop()
  expect(stopped?.stopped).toBe(true)

  const controller = new AbortController()
  const viaAbort = startWithBindRetry({ ...base, start: flakyStart(1).start, signal: controller.signal, sleep: async () => {} })
  const aborted = await viaAbort.bound
  controller.abort()
  expect(aborted?.stopped).toBe(true)
})

test("signal 在调用前就已中止：一次都不尝试", async () => {
  const flaky = flakyStart(0)
  const controller = new AbortController()
  controller.abort()
  const handle = startWithBindRetry({ ...base, start: flaky.start, signal: controller.signal, sleep: async () => {} })

  expect(await handle.bound).toBeUndefined()
  expect(flaky.attempts()).toBe(0)
})
