import { expect, test } from "bun:test"
import { CC_DEFAULT_SLOTS, CC_MAX_SLOTS, claimLockTarget, claimsPath, parseSlots, resolveBaseWorkerId } from "./config.ts"

test("槽位数:缺省、封顶、非法值一律落回默认", () => {
  expect(parseSlots(undefined)).toBe(CC_DEFAULT_SLOTS)
  expect(parseSlots(3)).toBe(3)
  expect(parseSlots("3")).toBe(3)
  expect(parseSlots(99)).toBe(CC_MAX_SLOTS)
  // 不是"报错不启动",是"落回一个能跑的值" —— 与 senpi 的 parseSlotCount 同一条规矩。
  expect(parseSlots(0)).toBe(CC_DEFAULT_SLOTS)
  expect(parseSlots(-1)).toBe(CC_DEFAULT_SLOTS)
  expect(parseSlots("abc")).toBe(CC_DEFAULT_SLOTS)
  expect(parseSlots(2.5)).toBe(CC_DEFAULT_SLOTS)
})

test("基名优先级:环境变量 > 配置文件 > 由 senpi 标签推导", () => {
  expect(resolveBaseWorkerId("vince-local.senpi", "vince-cc", { CAP_CC_WORKER: "from-env" })).toBe("from-env")
  expect(resolveBaseWorkerId("vince-local.senpi", "vince-cc", {})).toBe("vince-cc")
  expect(resolveBaseWorkerId("vince-local.senpi", undefined, {})).toBe("vince-local.senpi.cc")
})

// 推导出来的默认值必须仍然是合法标签,否则 master 会 400 —— 而那会发生在一台"没配过 ccWorkerId
// 但一切看起来正常"的机器上。
test("推导出的默认基名加上槽位号后仍然合法", () => {
  const derived = resolveBaseWorkerId("vince-local.senpi", undefined, {})
  expect(`${derived}.8`).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
})

test("空字符串当作没配", () => {
  expect(resolveBaseWorkerId("base", "", { CAP_CC_WORKER: "" })).toBe("base.cc")
})

// 与 senpi 的文件各不相干:那边的租约会被它的 keeper adopt 并续期,这边的是冻结的。共用一份
// 就等于让另一条链去续期一条我们管不了的租约。
test("声明簿与锁文件都不与 senpi 共用", () => {
  const env = { CAP_LEASE_CACHE_DIR: "/box" }
  expect(claimsPath(env)).toBe("/box/cc-claims.json")
  expect(claimLockTarget(env)).toBe("/box/cc-claims.lock")
  expect(claimsPath(env)).not.toContain("senpi")
  expect(claimLockTarget(env)).not.toContain("senpi")
})

// 一把锁保护【声明簿】这一个资源,不是每个会话一把 —— 每会话一把就等于没锁。
test("锁只有一把,与会话无关", () => {
  expect(claimLockTarget({ CAP_LEASE_CACHE_DIR: "/box" })).toBe(claimLockTarget({ CAP_LEASE_CACHE_DIR: "/box" }))
})
