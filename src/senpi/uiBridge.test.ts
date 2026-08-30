import { expect, test } from "bun:test"
import { uiIsRpcBridged } from "./uiBridge.ts"

// The two argv shapes measured on omo-ai 5.0.0-0.beta.26: the TUI client that owns the terminal, and
// the shared host daemon that actually runs the extension command handler.
test("the shared host daemon is bridged and the TUI client is not", () => {
  expect(
    uiIsRpcBridged([
      "/x/senpi/dist/cli-main.js",
      "--mode",
      "rpc",
      "--multi-session",
      "--listen",
      "unix:///tmp/host.sock",
    ]),
  ).toBe(true)
  expect(uiIsRpcBridged(["/x/senpi/dist/cli.js", "--extension", "/x/omo-ai/plugin"])).toBe(false)
})

test("`--mode=rpc` counts, and a non-rpc mode does not", () => {
  expect(uiIsRpcBridged(["cli.js", "--mode=rpc"])).toBe(true)
  expect(uiIsRpcBridged(["cli.js", "--mode", "interactive"])).toBe(false)
  expect(uiIsRpcBridged(["cli.js", "--mode"])).toBe(false)
})

// A path or a prompt that merely CONTAINS the word must not flip the surface: mistaking a live TUI
// for the bridge would replace a working dialog with a printed roster for everyone.
test("a bare 'rpc' argument is not a mode flag", () => {
  expect(uiIsRpcBridged(["/home/rpc/cli.js", "rpc", "--mode-of-transport", "rpc"])).toBe(false)
})
