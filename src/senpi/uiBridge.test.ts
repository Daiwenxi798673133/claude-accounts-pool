import { expect, test } from "bun:test"
import { UI_ANSWERS_ENV, uiSurface } from "./uiBridge.ts"

const NOTHING_DECLARED: Record<string, string | undefined> = {}
const ANSWERS: Record<string, string | undefined> = { [UI_ANSWERS_ENV]: "1" }

const DAEMON_ARGV = [
  "/x/senpi/dist/cli-main.js",
  "--mode",
  "rpc",
  "--multi-session",
  "--listen",
  "unix:///tmp/host.sock",
]
const TUI_ARGV = ["/x/senpi/dist/cli.js", "--extension", "/x/omo-ai/plugin"]

// The two argv shapes measured on omo-ai 5.0.0-0.beta.26: the TUI client that owns the terminal, and
// the shared host daemon that actually runs the extension command handler.
test("未声明时：共享宿主判为桥接，TUI 客户端不是", () => {
  expect(uiSurface(DAEMON_ARGV, NOTHING_DECLARED).bridged).toBe(true)
  expect(uiSurface(TUI_ARGV, NOTHING_DECLARED).bridged).toBe(false)
})

test("`--mode=rpc` 算，非 rpc 的 mode 不算", () => {
  expect(uiSurface(["cli.js", "--mode=rpc"], NOTHING_DECLARED).bridged).toBe(true)
  expect(uiSurface(["cli.js", "--mode", "interactive"], NOTHING_DECLARED).bridged).toBe(false)
  expect(uiSurface(["cli.js", "--mode"], NOTHING_DECLARED).bridged).toBe(false)
})

// A path or a prompt that merely CONTAINS the word must not flip the surface: mistaking a live TUI
// for the bridge would replace a working dialog with a printed roster for everyone.
test("裸 'rpc' 参数不是 mode 标志", () => {
  expect(uiSurface(["/home/rpc/cli.js", "rpc", "--mode-of-transport", "rpc"], NOTHING_DECLARED).bridged).toBe(false)
})

// The four combinations of the two inputs, spelled out one by one rather than derived: the whole
// value of the capability bit is that ONE of these four cells changed, and a table that computes the
// expectation from the same expression as the implementation would agree with a wrong implementation.
test("组合 1/4：声明应答 + argv 是 rpc —— 能力位把降级掰回来", () => {
  expect(uiSurface(DAEMON_ARGV, ANSWERS)).toEqual({ bridged: false, argvRpc: true, declared: true })
})

test("组合 2/4：未声明 + argv 是 rpc —— 仍然降级", () => {
  expect(uiSurface(DAEMON_ARGV, NOTHING_DECLARED)).toEqual({ bridged: true, argvRpc: true, declared: false })
})

// The one-way property, stated as a test rather than trusted to the expression: a declaration on a
// surface that was never bridged must stay false. If this ever reads true the bit has become a gate
// that can FORCE a dialog onto a live TUI, which is the failure it exists to prevent.
test("组合 3/4：声明应答 + argv 不是 rpc —— 不得反向掰成桥接", () => {
  expect(uiSurface(TUI_ARGV, ANSWERS)).toEqual({ bridged: false, argvRpc: false, declared: true })
})

test("组合 4/4：未声明 + argv 不是 rpc —— 本来就是真 TUI", () => {
  expect(uiSurface(TUI_ARGV, NOTHING_DECLARED)).toEqual({ bridged: false, argvRpc: false, declared: false })
})

// Strictly the string "1". `"0"` is the trap: it is truthy, so a truthy test would read a host that
// explicitly said "I do NOT answer" as one that does, and hang the command — the exact direction the
// whole judgment is arranged to fall away from.
test("只有字面 \"1\" 算声明，其余一律视为未声明", () => {
  for (const value of ["0", "", "true", "yes", "1 ", "01", "TRUE"]) {
    const surface = uiSurface(DAEMON_ARGV, { [UI_ANSWERS_ENV]: value })
    expect(surface.declared).toBe(false)
    expect(surface.bridged).toBe(true)
  }
})

// A neighbouring variable must not be read as the declaration.
test("变量名拼错不算声明", () => {
  expect(uiSurface(DAEMON_ARGV, { CAP_UI_ANSWER: "1", CAP_UI_ANSWERS_: "1" }).declared).toBe(false)
})
