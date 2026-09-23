import { expect, test } from "bun:test"
import { HOOK_MATCHER, hookSettingsJson, printModeNotice, withHookSettings } from "./hookSettings.ts"

test("生成的 settings 把钩子挂在 StopFailure 上,命令是给定的绝对路径", () => {
  const parsed = JSON.parse(hookSettingsJson("/opt/pool/claude-pool-hook.ts")) as any
  expect(parsed.hooks.StopFailure[0].matcher).toBe(HOOK_MATCHER)
  expect(parsed.hooks.StopFailure[0].hooks[0]).toEqual({ type: "command", command: "/opt/pool/claude-pool-hook.ts" })
})

// matcher 只含字母/数字/下划线/竖线时按精确匹配处理;出现连字符、空格或逗号会被当成正则。
// 这条测试钉住的是"我们停在精确匹配这一侧"。
test("matcher 不含会让它降级成正则的字符", () => {
  expect(HOOK_MATCHER).toMatch(/^[A-Za-z0-9_|]+$/)
})

test("settings JSON 里没有凭证 —— 它会出现在 ps 的命令行里", () => {
  const json = hookSettingsJson("/opt/pool/hook.ts")
  expect(json).not.toContain("sk-ant")
  expect(json).not.toContain("OAUTH_TOKEN")
})

test("--settings 插在操作者参数的最前面", () => {
  const out = withHookSettings(["-p", "写点什么"], "/opt/pool/hook.ts")
  expect(out.skipped).toBeUndefined()
  expect(out.argv[0]).toBe("--settings")
  expect(out.argv.slice(2)).toEqual(["-p", "写点什么"])
})

// 放最前面而不是最后:追加在位置参数之后会改变 commander 对位置参数的解析。
test("位置参数的相对顺序不被打乱", () => {
  const out = withHookSettings(["--model", "sonnet", "讲个笑话"], "/opt/pool/hook.ts")
  expect(out.argv.slice(2)).toEqual(["--model", "sonnet", "讲个笑话"])
})

test.each([
  [["--settings", "/my/own.json", "-p", "x"]],
  [["--settings=/my/own.json"]],
])("操作者自己传了 --settings 时不硬塞,并说明代价:%j", (argv) => {
  const out = withHookSettings(argv, "/opt/pool/hook.ts")
  expect(out.argv).toEqual(argv)
  expect(out.skipped).toContain("--settings")
  // 代价必须说出口:少的是遥测,不是功能 —— 操作者要能判断这次要不要在意。
  expect(out.skipped).toContain("限流")
})

test("找不到钩子脚本时,启动照常进行,只是不挂钩子", () => {
  const out = withHookSettings(["-p", "x"], undefined)
  expect(out.argv).toEqual(["-p", "x"])
  expect(out.skipped).toBeDefined()
})

test("不修改传进来的 argv 数组", () => {
  const argv = ["-p", "x"]
  withHookSettings(argv, "/opt/pool/hook.ts")
  expect(argv).toEqual(["-p", "x"])
})

// 实测:-p 下 StopFailure 不触发(同一次对照里 SessionStart / UserPromptSubmit 触发了,Stop 与
// StopFailure 没有;交互式 pty 下四个全触发)。不说这一句,一台只跑 -p 的机器会以为自己在上报。
test.each([["-p"], ["--print"]])("%s 模式提醒:这次撞限流不会上报", (flag) => {
  expect(printModeNotice([flag, "hello"])).toContain("不会上报")
})

test("交互式不打扰", () => {
  expect(printModeNotice([])).toBeUndefined()
  expect(printModeNotice(["--model", "sonnet"])).toBeUndefined()
})
