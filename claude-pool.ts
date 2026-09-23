#!/usr/bin/env bun
// 入口链 C:用账号池的号起一个原生 Claude Code 会话。
//
// 并列于 tui.tsx(opencode 插件)与 senpi-extension.ts(omo 扩展)。前两条都是把凭证塞进一个
// 长期活着的宿主;这一条只在会话开始前做一次事,然后把终端整个让给 `claude`。
//
// 原因在 issue #83:claude 2.1.278 实测,凭证在进程内冻结。改 settings、送 401,都不会让一个
// 已经在跑的会话换掉 token。所以「每会话一租约」不是简化,是这个客户端唯一允许的形状。
//
//   claude-pool                  # 等价于 `claude`,但用池子的号
//   claude-pool -p "..."         # 参数原样透传
//   CLAUDE_BIN=/path/to/claude claude-pool
//
// 这台机器必须先被 configure-worker 配过(~/.claude-accounts-pool/senpi-worker.json)。
import { readPoolConfig } from "./src/claudecode/config.ts"
import { createSessionDeps, createSlotAcquire, slotLockTarget } from "./src/claudecode/install.ts"
import { EXIT_BLOCKED, EXIT_NO_LEASE, runPooledSession } from "./src/claudecode/session.ts"
import { acquireSlot } from "./src/claudecode/slots.ts"

const config = readPoolConfig(process.env)
if (!config) {
  process.stderr.write(
    "这台机器还没并进账号池。先跑:\n" +
      "  bun run scripts/configure-worker.ts --master <master地址> --worker <这台机器的标签>\n",
  )
  process.exit(EXIT_BLOCKED)
}

// 槽位【先于】租约拿到,因为槽位号就是这次会话的 workerId,而 master 的租约账本按 workerId 键 ——
// 没有槽位就没有身份,没有身份就没法让 master 把这个会话记成一个独立持有者。
const slot = await acquireSlot({
  baseWorkerId: config.baseWorkerId,
  slots: config.slots,
  acquire: createSlotAcquire(process.env),
  lockTargetFor: (name) => slotLockTarget(name, process.env),
})
if (!slot) {
  process.stderr.write(
    `这台机器的 ${config.slots} 个并发位都占着了。等一个会话结束,或调大 ccSlots(上限见 CC_MAX_SLOTS)。\n`,
  )
  process.exit(EXIT_NO_LEASE)
}

// argv 从第 3 个起:[0]=bun, [1]=本文件, 其余全是要转交给 claude 的。一个都不解析、一个都不吞 ——
// 启动器不认识 claude 的参数,也不该假装认识:今天多一个新 flag,这里不需要改。
// process.exit() 会【立刻】终止进程,finally 不会跑 —— 所以释放必须发生在 exit 之前,不能写成
// try { ...; process.exit(code) } finally { release() }。那样槽位永远不会被主动还回去,只能等
// stale 到期,而 stale 是给崩溃准备的兜底,不是正常路径。
let code = EXIT_NO_LEASE
try {
  const deps = createSessionDeps({ masterUrl: config.masterUrl, workerId: slot.workerId }, process.env, process.cwd())
  code = await runPooledSession(deps, process.argv.slice(2))
} finally {
  // 正常退出时立刻还回去,别让下一个会话等 stale 到期。被 SIGKILL 时这里跑不到,那种情况正是
  // stale 存在的理由。
  await slot.release().catch(() => {})
}
process.exit(code)
