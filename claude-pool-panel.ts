#!/usr/bin/env bun
// /pool 面板 —— 由 make setup 装进 ~/.claude/settings.json 的 UserPromptSubmit 钩子调用,不是给人敲的。
//
// 钩子的 sh 外壳(~/.claude-accounts-pool/bin/claude-pool-prompt-hook)先用 grep 判断这条输入是不是
// /pool,不是就直接放行、根本不起 bun;是 /pool 才把钩子报文转给本文件。逻辑在 src/claudecode/panelRun.ts,
// 真实依赖在 src/claudecode/install.ts 的 createPanelDeps。
//
// 输出一个 decision: block 的 JSON:Claude Code 把 reason 显示给用户、不进上下文、不发起模型请求。
// 任何意外都要变成一段给人看的文字,而不是一个让输入卡住的崩溃。
import { readPoolConfig } from "./src/claudecode/config.ts"
import { createPanelDeps } from "./src/claudecode/install.ts"
import { hookResponse } from "./src/claudecode/panel.ts"
import { runPanel } from "./src/claudecode/panelRun.ts"

try {
  const raw = (await new Response(process.stdin as unknown as ReadableStream).json()) as { prompt?: unknown }
  const prompt = typeof raw.prompt === "string" ? raw.prompt : ""
  const out = await runPanel(createPanelDeps(prompt, readPoolConfig(process.env), process.env))
  if (out !== undefined) process.stdout.write(out)
} catch (error) {
  process.stdout.write(hookResponse(`/pool 面板出错了:${error instanceof Error ? error.message : String(error)}`))
}
process.exit(0)
