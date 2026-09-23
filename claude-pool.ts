#!/usr/bin/env bun
// 入口链 C:用账号池的号起一个原生 Claude Code 会话。
//
// 并列于 tui.tsx(opencode 插件)与 senpi-extension.ts(omo 扩展)。前两条把凭证塞进一个长期活着的
// 宿主;这一条把 `claude` 的 ANTHROPIC_BASE_URL 指向本机 relay(claude-pool-relay.ts),由 relay 在每个
// 请求上把凭证换成全机共享的当前租约。
//
// 原因在 issue #83:claude 2.1.278 实测,凭证在进程内冻结。所以换 token 这件事挪到了进程外面 ——
// 会话中途续期、撞额度换号都由 relay 做,会话不用重开。
//
//   claude-pool                              # 等价于 `claude`,但用池子的号
//   claude-pool -p "..."                     # 参数原样透传
//   claude-pool --pool-account af008f89      # 把本机共享号切到这个号
//   claude-pool --pool-account af008f89 --pool-pin   # 并且以后一直用它
//   claude-pool --pool-unpin                 # 取消钉住
//   CLAUDE_BIN=/path/to/claude claude-pool
//
// 并发多开是支持的,而且【所有会话共用一个号】—— 这是有意的:到期、撞墙都只处理一次,不会一瞬间
// 切走 N 个号。
//
// 这台机器必须先被 configure-worker 配过(~/.claude-accounts-pool/senpi-worker.json)。
import { parsePoolArgs } from "./src/claudecode/args.ts"
import { readPoolConfig } from "./src/claudecode/config.ts"
import { createSessionDeps } from "./src/claudecode/install.ts"
import { EXIT_BLOCKED, runPooledSession } from "./src/claudecode/session.ts"

const config = readPoolConfig(process.env)
if (!config) {
  process.stderr.write(
    "这台机器还没并进账号池。先跑:\n" +
      "  bun run scripts/configure-worker.ts --master <master地址> --worker <这台机器的标签>\n",
  )
  process.exit(EXIT_BLOCKED)
}

// 只摘【最前面】连续的几个 --pool-* 参数,遇到第一个不是的就停止解析,其余原样透传 ——
// 启动器不认识 claude 的参数,也不该假装认识:今天多一个新 flag,这里不需要改。
const parsed = parsePoolArgs(process.argv.slice(2))
if (!parsed.ok) {
  process.stderr.write(`${parsed.error}\n`)
  process.exit(EXIT_BLOCKED)
}

// 钉住意图的落盘、登记与注销都在 runPooledSession 里:钉住要等守卫通过再写(被拒绝的启动不该留下
// 一个会把整台机器搬走的钉住),登记的生命周期就是会话的生命周期。这里不再有
// process.exit 之前要做的清理 —— process.exit 会直接终止进程、finally 根本不跑。
const deps = createSessionDeps(config, process.env, process.cwd(), parsed.args)
process.exit(await runPooledSession(deps, parsed.args.rest))
