import { expect, test } from "bun:test"
import { applyPinIntent, resolvePreference, type PinStore } from "./pin.ts"

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

test("什么都没指定:不点名,由排名派号", () => {
  expect(resolvePreference({ heldAccountIds: [] })).toEqual({})
})

test("命令行点名:一次性的,pinned 为 false", () => {
  expect(resolvePreference({ cliPrefix: "af008f89", heldAccountIds: [] })).toEqual({
    prefix: "af008f89",
    pinned: false,
  })
})

test("命令行点名 + 钉住:pinned 为 true", () => {
  expect(resolvePreference({ cliPrefix: "af008f89", cliPin: true, heldAccountIds: [] })).toEqual({
    prefix: "af008f89",
    pinned: true,
  })
})

test("之前钉过的号,下次启动自动点名并维持钉住", () => {
  expect(resolvePreference({ storedPin: "af008f89", heldAccountIds: [] })).toEqual({
    prefix: "af008f89",
    pinned: true,
  })
})

test("命令行点名盖过已钉住的那个,且这次只是一次性的", () => {
  expect(resolvePreference({ cliPrefix: "eaaa1a79", storedPin: "af008f89", heldAccountIds: [] })).toEqual({
    prefix: "eaaa1a79",
    pinned: false,
  })
})

test("取消钉住之后就不点名了", () => {
  expect(resolvePreference({ cliPin: false, storedPin: "af008f89", heldAccountIds: [] })).toEqual({})
})

// 并发下唯一的真正分歧点:点名与排除集会互相矛盾 —— 我们已经把它放进排除集了(它确实被本机占着),
// 再点名它等于同时对 master 说「别给我这个」和「就要这个」。
test("要点名的号正被本机另一个会话占着:这次退回排名派号,并说清楚", () => {
  const pref = resolvePreference({
    cliPrefix: "af008f89",
    heldAccountIds: ["af008f89-1111-2222-3333-444455556666"],
  })
  expect(pref.prefix).toBeUndefined()
  expect(pref.notice).toContain("另一个会话占着")
})

test("被占着时钉住不丢 —— 那个会话结束后会继续点名它", () => {
  const pref = resolvePreference({
    storedPin: "af008f89",
    heldAccountIds: ["af008f89-1111-2222-3333-444455556666"],
  })
  expect(pref.prefix).toBeUndefined()
  expect(pref.notice).toContain("钉住没有取消")
})

test("别人占着【别的】号不影响点名", () => {
  expect(
    resolvePreference({ cliPrefix: "af008f89", heldAccountIds: ["eaaa1a79-0000-0000-0000-000000000000"] }).prefix,
  ).toBe("af008f89")
})

test("钉住意图落盘:只在明确表达时才写", () => {
  const store = fakeStore()
  expect(applyPinIntent(store, { accountPrefix: "af008f89", pin: true })).toBe(true)
  expect(store.value()).toBe("af008f89")

  expect(applyPinIntent(store, { accountPrefix: "af008f89" })).toBe(false)
  expect(store.value()).toBe("af008f89") // 一次性点名不动已有的钉住

  expect(applyPinIntent(store, { pin: false })).toBe(true)
  expect(store.value()).toBeUndefined()
})
