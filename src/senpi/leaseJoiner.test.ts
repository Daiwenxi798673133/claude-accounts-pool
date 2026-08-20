import { expect, test } from "bun:test"
import { createLeaseJoiner } from "./leaseJoiner.ts"

function deferred(): { promise: Promise<void>; resolve: () => void; reject: (error: Error) => void } {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

// THE REGRESSION THIS FILE EXISTS FOR. A caller arriving mid-tick used to get a resolved no-op and
// proceed with no token, which sent the turn down senpi's ambient branch and charged it to the
// machine's own credential instead of the leased account.
test("a caller arriving mid-tick joins the running lease instead of skipping it", async () => {
  const gate = deferred()
  let ticks = 0
  const join = createLeaseJoiner(() => {
    ticks += 1
    return gate.promise
  })

  const first = join()
  const second = join()
  expect(ticks).toBe(1)

  let secondSettled = false
  void second.then(() => {
    secondSettled = true
  })
  // Still pending while the lease is in flight — the whole point. A microtask turn is enough to
  // catch a promise that resolved immediately.
  await Promise.resolve()
  expect(secondSettled).toBe(false)

  gate.resolve()
  await Promise.all([first, second])
  expect(secondSettled).toBe(true)
  expect(ticks).toBe(1)
})

test("a caller arriving after a settled tick starts a new one", async () => {
  let ticks = 0
  const join = createLeaseJoiner(() => {
    ticks += 1
    return Promise.resolve()
  })

  await join()
  await join()
  expect(ticks).toBe(2)
})

// Cleared in `finally`, not `then`: pinning every later caller to one failed attempt would strand a
// worker whose master was merely restarting.
test("a rejected tick does not pin later callers to the same failure", async () => {
  const first = deferred()
  const ticks: Array<Promise<void>> = [first.promise, Promise.resolve()]
  let index = 0
  const join = createLeaseJoiner(() => ticks[index++])

  const failing = join()
  first.reject(new Error("master unreachable"))
  await expect(failing).rejects.toThrow("master unreachable")

  await join()
  expect(index).toBe(2)
})
