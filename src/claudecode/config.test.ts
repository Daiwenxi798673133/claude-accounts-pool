import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CC_RELAY_DEFAULT_PORT, CC_UPSTREAM_DEFAULT, parseRelayPort, readPoolConfig, relayLogPath, relayUrl, resolveBaseWorkerId, upstreamUrl } from "./config.ts"

test("relay 端口:缺省、合法值、非法值一律落回默认", () => {
  expect(parseRelayPort(undefined)).toBe(CC_RELAY_DEFAULT_PORT)
  expect(parseRelayPort(19000)).toBe(19000)
  expect(parseRelayPort("19000")).toBe(19000)
  // 不是"报错不启动",是"落回一个能跑的值" —— 与 senpi 的 parseSlotCount 同一条规矩。
  expect(parseRelayPort(80)).toBe(CC_RELAY_DEFAULT_PORT) // 特权端口,操作者身份绑不上
  expect(parseRelayPort(70000)).toBe(CC_RELAY_DEFAULT_PORT)
  expect(parseRelayPort("abc")).toBe(CC_RELAY_DEFAULT_PORT)
  expect(parseRelayPort(19000.5)).toBe(CC_RELAY_DEFAULT_PORT)
})

// 与 master 撞端口,relay 会把 master 认成"别的程序"而拒绝启动。
test("默认端口避开 master 的 8787", () => {
  expect(CC_RELAY_DEFAULT_PORT).not.toBe(8787)
})

test("relay 只绑回环", () => {
  expect(relayUrl(18787)).toBe("http://127.0.0.1:18787")
})

test("标签优先级:环境变量 > 配置文件 > 由 senpi 标签推导", () => {
  expect(resolveBaseWorkerId("vince-local.senpi", "vince-cc", { CAP_CC_WORKER: "from-env" })).toBe("from-env")
  expect(resolveBaseWorkerId("vince-local.senpi", "vince-cc", {})).toBe("vince-cc")
  expect(resolveBaseWorkerId("vince-local.senpi", undefined, {})).toBe("vince-local.senpi.cc")
})

// 推导出来的默认值必须仍然是合法标签,否则 master 会 400 —— 而那会发生在一台"没配过 ccWorkerId
// 但一切看起来正常"的机器上。
test("推导出的默认标签合法", () => {
  expect(resolveBaseWorkerId("vince-local.senpi", undefined, {})).toMatch(/^[A-Za-z0-9._-]{1,64}$/)
})

test("空字符串当作没配", () => {
  expect(resolveBaseWorkerId("base", "", { CAP_CC_WORKER: "" })).toBe("base.cc")
})

test("上游默认是 Anthropic 本身,只有显式覆盖才改", () => {
  expect(upstreamUrl({})).toBe(CC_UPSTREAM_DEFAULT)
  expect(upstreamUrl({ CAP_CC_UPSTREAM: "" })).toBe(CC_UPSTREAM_DEFAULT)
  expect(upstreamUrl({ CAP_CC_UPSTREAM: "http://127.0.0.1:9" })).toBe("http://127.0.0.1:9")
})

test("relay 日志不与 senpi 的日志共用一个文件", () => {
  const path = relayLogPath({ CAP_LEASE_CACHE_DIR: "/box" })
  expect(path).toBe("/box/cc-relay.log")
  expect(path).not.toContain("senpi")
})

// 回归:这两个字段曾经从 readWorkerConfig 的返回值(只有 senpi 认的三个字段)里读,写进文件也不生效。
test("ccWorkerId / ccRelayPort 从配置文件里读得到", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-config-"))
  try {
    writeFileSync(
      join(dir, "senpi-worker.json"),
      JSON.stringify({ version: 1, masterUrl: "http://m:8787", workerId: "box.senpi", ccWorkerId: "box-cc", ccRelayPort: 19123 }),
    )
    expect(readPoolConfig({ CAP_LEASE_CACHE_DIR: dir })).toEqual({ masterUrl: "http://m:8787", workerId: "box-cc", relayPort: 19123 })
    // 环境变量仍然优先。
    expect(readPoolConfig({ CAP_LEASE_CACHE_DIR: dir, CAP_CC_WORKER: "env-cc", CAP_CC_RELAY_PORT: "19999" })).toEqual({
      masterUrl: "http://m:8787",
      workerId: "env-cc",
      relayPort: 19999,
    })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
