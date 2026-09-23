#!/usr/bin/env bun
// 入口链 C:用账号池的号起一个原生 Claude Code 会话。
//
// 并列于 tui.tsx(opencode 插件)与 senpi-extension.ts(omo 扩展)。前两条都是把凭证塞进一个
// 长期活着的宿主;这一条不一样 —— 它只在会话开始前做一次事,然后把终端整个让给 `claude`。
//
// 原因在 issue #83:claude 2.1.278 实测,凭证在进程内冻结。改 settings、送 401,都不会让一个
// 已经在跑的会话换掉 token。所以「每会话一租约」不是简化,是这个客户端唯一允许的形状。
//
//   claude-pool                  # 等价于 `claude`,但用池子的号
//   claude-pool -p "..."         # 参数原样透传
//   CLAUDE_BIN=/path/to/claude claude-pool
//
// 这台机器必须先被 configure-worker 配过(~/.claude-accounts-pool/senpi-worker.json)。
import { createSessionDeps } from "./src/claudecode/install.ts"
import { EXIT_BLOCKED, runPooledSession } from "./src/claudecode/session.ts"
import { resolveWorkerConfig } from "./src/senpi/workerConfig.ts"

// 复用 senpi 那份 per-machine 配置,不另起一份。名字带 senpi 是历史包袱,内容是「这台机器
// 连哪个 master、以什么身份」—— 与本链路要问的是同一件事,而两份配置意味着两份会漂移的真相。
const config = resolveWorkerConfig(process.env)
if (!config) {
  process.stderr.write(
    "这台机器还没并进账号池。先跑:\n" +
      "  bun run scripts/configure-worker.ts --master <master地址> --worker <这台机器的标签>\n",
  )
  process.exit(EXIT_BLOCKED)
}

// argv 从第 3 个起:[0]=bun, [1]=本文件, 其余全是要转交给 claude 的。一个都不解析、一个都不吞 ——
// 启动器不认识 claude 的参数,也不该假装认识:今天多一个新 flag,这里不需要改。
const code = await runPooledSession(createSessionDeps(config, process.env, process.cwd()), process.argv.slice(2))
process.exit(code)
