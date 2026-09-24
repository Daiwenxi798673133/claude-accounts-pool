#!/usr/bin/env bun
// Claude Code 底部状态栏 —— 由 make setup 装进 ~/.claude/settings.json 的 statusLine 调用,不是给人敲的。
//
// sh 外壳(~/.claude-accounts-pool/bin/claude-pool-statusline)先确认接管还在、bun 与本文件都在,
// 才起 bun。逻辑在 src/claudecode/statusLine.ts,真实依赖在 src/claudecode/install.ts 的 createStatusDeps。
//
// 只写一行到 stdout。状态栏出任何问题都不该变成一行报错挂在屏幕底下:没配过就什么都不输出,
// 意外就只说一句"账号池 ?"。stdin 上 Claude Code 给的会话 JSON 用不到,不读。
import { readPoolConfig } from "./src/claudecode/config.ts"
import { createStatusDeps } from "./src/claudecode/install.ts"
import { renderStatusLine } from "./src/claudecode/statusLine.ts"

try {
  const config = readPoolConfig(process.env)
  if (config !== undefined) {
    const deps = createStatusDeps(config, process.env)
    const [health, snapshot] = await Promise.all([deps.health(), deps.snapshot()])
    const pin = deps.pin.read()
    process.stdout.write(`${renderStatusLine({ health, snapshot, ...(pin === undefined ? {} : { pin }), now: deps.now() })}\n`)
  }
} catch {
  process.stdout.write("账号池 ?\n")
}
process.exit(0)
