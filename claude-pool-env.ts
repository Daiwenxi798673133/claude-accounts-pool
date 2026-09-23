#!/usr/bin/env bun
// make setup 装的进程启动器的"大脑" —— 由 ~/.claude-accounts-pool/bin/claude-pool-launch(sh 外壳)调用,
// 不是给人敲的。
//
//   claude-pool-launch <claude 二进制> <参数…>
//     └─ pool_env=$(bun claude-pool-env.ts $$)   ← 本文件:决定注入什么,输出 export 语句
//     └─ eval "$pool_env"; exec "$@"             ← 外壳:Bun 没有 execve,exec 只能由 sh 做
//
// 成功时 stdout 只有 export 语句、stderr 一个字节都不写(启动器契约:exec 前不向终端输出)。
// 拒绝时把原因写到 stderr 并以非零退出 —— Claude Code 会把它当作这个进程的失败原因显示出来。
import { existsSync } from "node:fs"
import { dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { readPoolConfig, relayLogPath, relayUrl, takeoverManifestPath } from "./src/claudecode/config.ts"
import { readSettings, spawnRelay } from "./src/claudecode/install.ts"
import { launcherEnv, shellExports } from "./src/claudecode/launcherEnv.ts"
import { createRelayClient } from "./src/claudecode/relayClient.ts"

const pid = Number(process.argv[2])
if (!Number.isInteger(pid) || pid <= 1) {
  process.stderr.write("claude-pool-env.ts 需要启动器的 pid 作为唯一参数(由 claude-pool-launch 传入)。\n")
  process.exit(64)
}

const env = process.env
const config = readPoolConfig(env)
const port = config?.relayPort
const url = port === undefined ? "" : relayUrl(port)
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

const outcome = await launcherEnv({
  installed: () => existsSync(takeoverManifestPath(env)),
  config,
  env,
  readSettings: () => readSettings(env, process.cwd()),
  relay: createRelayClient({
    fetchImpl: fetch,
    baseUrl: url,
    spawnRelay: spawnRelay(env),
    sleep,
    now: Date.now,
    // 启动器契约:约 3 秒内到达 exec。relay 常驻时这两步都是本机往返,远用不到这么久;只有 relay 正在
    // 排队换号(或 master 很慢)时才会等满 —— 那时宁可早点拒绝并说清原因,也不要让 Claude Code 干等。
    startTimeoutMs: 2_000,
    controlTimeoutMs: 4_000,
  }),
  relayUrl: url,
  relayLogPath: relayLogPath(env),
  pid,
  repoDir: dirname(fileURLToPath(import.meta.url)),
})

switch (outcome.kind) {
  case "passthrough":
    process.exit(0)
  case "inject":
    process.stdout.write(`${shellExports(outcome.vars)}\n`)
    process.exit(0)
  case "refuse":
    process.stderr.write(`${outcome.message}\n`)
    process.exit(outcome.code)
}
