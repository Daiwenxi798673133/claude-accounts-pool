import { expect, test } from "bun:test"
import { parsePoolArgs } from "./args.ts"

const ok = (argv: string[]) => {
  const r = parsePoolArgs(argv)
  if (!r.ok) throw new Error(r.error)
  return r.args
}

test("没有我们的参数时,原样透传", () => {
  expect(ok(["-p", "hello"])).toEqual({ accountPrefix: undefined, pin: undefined, rest: ["-p", "hello"] })
})

test("摘出 --pool-account,其余透传", () => {
  expect(ok(["--pool-account", "af008f89", "-p", "x"])).toEqual({
    accountPrefix: "af008f89",
    pin: undefined,
    rest: ["-p", "x"],
  })
})

test("=" + "写法也认", () => {
  expect(ok(["--pool-account=af008f89", "--model", "sonnet"]).rest).toEqual(["--model", "sonnet"])
})

test("前缀大小写归一 —— 看板给的是小写十六进制", () => {
  expect(ok(["--pool-account", "AF008F89"]).accountPrefix).toBe("af008f89")
})

test("钉住与取消钉住", () => {
  expect(ok(["--pool-account", "af008f89", "--pool-pin"]).pin).toBe(true)
  expect(ok(["--pool-unpin"]).pin).toBe(false)
  expect(ok(["-p", "x"]).pin).toBeUndefined()
})

// 前导位置才解析:claude 的参数里可以出现任意字符串,全程扫描就会去解释别人的数据。
test("非前导位置的同名字符串不被解释", () => {
  const args = ok(["-p", "写个脚本,参数叫 --pool-pin"])
  expect(args.pin).toBeUndefined()
  expect(args.rest).toEqual(["-p", "写个脚本,参数叫 --pool-pin"])
})

test("我们的参数出现在 claude 参数之后时不摘 —— 那已经是 claude 的地盘", () => {
  const args = ok(["--model", "sonnet", "--pool-account", "af008f89"])
  expect(args.accountPrefix).toBeUndefined()
  expect(args.rest).toEqual(["--model", "sonnet", "--pool-account", "af008f89"])
})

test("缺少值时报错,而不是把下一个参数吞掉当值", () => {
  expect(parsePoolArgs(["--pool-account", "-p", "x"])).toEqual({
    ok: false,
    error: "--pool-account 需要一个账号 id 前缀(看板上显示的前 8 位)",
  })
})

test("明显不是前缀的值当场挡住,不去换一个 409 回来", () => {
  const r = parsePoolArgs(["--pool-account", "vince@example.com"])
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error).toContain("不像账号 id 前缀")
})

test("太短的前缀也挡住 —— 一位十六进制几乎必然匹配到多个账号", () => {
  expect(parsePoolArgs(["--pool-account", "af"]).ok).toBe(false)
})

// 与协议里「pinned 必须伴随 preferredAccountIdPrefix」同一条规矩。
test("--pool-pin 不能独自出现", () => {
  const r = parsePoolArgs(["--pool-pin"])
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error).toContain("必须配 --pool-account")
})

test("不认识的 --pool-* 明确报错,而不是当成 claude 的参数透传出去", () => {
  const r = parsePoolArgs(["--pool-whatever"])
  expect(r.ok).toBe(false)
  if (r.ok) return
  expect(r.error).toContain("不认识的参数")
})
