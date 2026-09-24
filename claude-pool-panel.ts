#!/usr/bin/env bun
// /pool 面板 —— 由 make setup 装进 ~/.claude/settings.json 的 UserPromptSubmit 钩子调用,不是给人敲的。
//
// 钩子的 sh 外壳(~/.claude-accounts-pool/bin/claude-pool-prompt-hook)先用 grep 判断这条输入是不是
// /pool,不是就直接放行、根本不起 bun;是 /pool 才把钩子报文转给本文件。逻辑在 src/claudecode/panelRun.ts。
//
// 输出一个 decision: block 的 JSON:Claude Code 把 reason 显示给用户、不进上下文、不发起模型请求。
// 任何意外都要变成一段给人看的文字,而不是一个让输入卡住的崩溃。
import { readPoolConfig, relayUrl } from "./src/claudecode/config.ts"
import { hookResponse } from "./src/claudecode/panel.ts"
import { runPanel } from "./src/claudecode/panelRun.ts"
import { createPinStore } from "./src/claudecode/pin.ts"
import { RELAY_ROUTES, RELAY_SERVICE, type RelayHealth } from "./src/claudecode/relay.ts"
import { createRelayClient } from "./src/claudecode/relayClient.ts"
import { CLOUD_ROUTES, type UsageSnapshotView } from "./src/cloud/protocol.ts"

try {
  const raw = (await new Response(process.stdin as unknown as ReadableStream).json()) as { prompt?: unknown }
  const prompt = typeof raw.prompt === "string" ? raw.prompt : ""
  const env = process.env
  const config = readPoolConfig(env)
  const base = config === undefined ? "" : relayUrl(config.relayPort)

  const out = await runPanel({
    prompt,
    config,
    health: async () => {
      try {
        const res = await fetch(`${base}${RELAY_ROUTES.health}`, { signal: AbortSignal.timeout(1_500) })
        const body = (await res.json()) as RelayHealth
        return body.service === RELAY_SERVICE ? body : undefined
      } catch {
        return undefined
      }
    },
    usage: async () => {
      if (config === undefined) return undefined
      try {
        const res = await fetch(`${config.masterUrl}${CLOUD_ROUTES.usage}`, { signal: AbortSignal.timeout(5_000) })
        return res.ok ? ((await res.json()) as UsageSnapshotView) : undefined
      } catch {
        return undefined
      }
    },
    // 面板从不拉起 relay:接管装好时它由 launchd 常驻;不在就如实说,而不是在一次按键里偷偷起一个进程。
    relay: createRelayClient({
      fetchImpl: fetch,
      baseUrl: base,
      spawnRelay: () => {},
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      now: Date.now,
      controlTimeoutMs: 20_000,
    }),
    pin: createPinStore(env),
    pid: process.pid,
  })
  if (out !== undefined) process.stdout.write(out)
} catch (error) {
  process.stdout.write(hookResponse(`/pool 面板出错了:${error instanceof Error ? error.message : String(error)}`))
}
process.exit(0)
