#!/usr/bin/env bun
// 入口链 C:用账号池的号起一个原生 Claude Code 会话。
//
// 并列于 tui.tsx(opencode 插件)与 senpi-extension.ts(omo 扩展)。前两条都是把凭证塞进一个
// 长期活着的宿主;这一条只在会话开始前做一次事,然后把终端整个让给 `claude`。
//
// 原因在 issue #83:claude 2.1.278 实测,凭证在进程内冻结。改 settings、送 401,都不会让一个
// 已经在跑的会话换掉 token。所以「每会话一租约」不是简化,是这个客户端唯一允许的形状。
//
//   claude-pool                              # 等价于 `claude`,但用池子的号
//   claude-pool -p "..."                     # 参数原样透传
//   claude-pool --pool-account af008f89      # 这次会话点名这个号
//   claude-pool --pool-account af008f89 --pool-pin   # 以后每次启动都点名它
//   claude-pool --pool-unpin                 # 取消钉住
//   CLAUDE_BIN=/path/to/claude claude-pool
//
// 并发多开是支持的:所有会话共用一个 workerId,靠本机的声明簿(src/claudecode/claims.ts)保证
// 它们不会拿到同一个账号。
//
// 这台机器必须先被 configure-worker 配过(~/.claude-accounts-pool/senpi-worker.json)。
import { parsePoolArgs } from "./src/claudecode/args.ts"
import { readPoolConfig } from "./src/claudecode/config.ts"
import { applyPinIntent, createPinStore } from "./src/claudecode/pin.ts"
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

// 钉住意图【先落盘】,与 src/worker/pin.ts 的顺序一致:并发启动的另一个会话必须立刻看到新意图,
// 否则它会按旧的钉住去点名。被 master 拒绝时再交还 —— 那是唯一允许放弃钉住的路径。
applyPinIntent(createPinStore(process.env), parsed.args)
//
// 租约的申领与归还都在 runPooledSession 里,因为租约的生命周期就是会话的生命周期。这里不再有
// process.exit 之前要做的清理 —— 之前那版把清理写在 finally 里,而 process.exit 会直接终止进程、
// finally 根本不跑。
const deps = createSessionDeps(
  { masterUrl: config.masterUrl, workerId: config.baseWorkerId },
  process.env,
  process.cwd(),
  config.slots,
  parsed.args,
)
process.exit(await runPooledSession(deps, parsed.args.rest))
