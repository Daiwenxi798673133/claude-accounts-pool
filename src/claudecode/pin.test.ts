import { expect, test } from "bun:test"
import { applyPinIntent, type PinStore } from "./pin.ts"

function fakeStore(initial?: string): PinStore & { value: () => string | undefined; writes: number } {
  let value = initial
  let writes = 0
  return {
    read: () => value,
    write: (next) => {
      value = next
      writes++
    },
    value: () => value,
    get writes() {
      return writes
    },
  }
}

test("钉住意图落盘:只在明确表达时才写", () => {
  const store = fakeStore()
  expect(applyPinIntent(store, { accountPrefix: "af008f89", pin: true })).toBe(true)
  expect(store.value()).toBe("af008f89")

  expect(applyPinIntent(store, { accountPrefix: "af008f89" })).toBe(false)
  expect(store.value()).toBe("af008f89") // 一次性点名不动已有的钉住

  expect(applyPinIntent(store, { pin: false })).toBe(true)
  expect(store.value()).toBeUndefined()
})
