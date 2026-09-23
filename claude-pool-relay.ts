#!/usr/bin/env bun
// 本机中间层(relay)—— 由 claude-pool 启动器按需拉起,不是给人敲的。
//
// 本机所有 claude-pool 会话的 ANTHROPIC_BASE_URL 都指向这里。它持有全机共享的那一个租约,把每个请求
// 的凭证换成当前租约后原样转发给 api.anthropic.com;到期续期、撞额度换号都在这里、且只发生一次。
// 设计与实测见 issue #83,逻辑在 src/claudecode/relay.ts。
//
// 【单例靠端口】多个启动器同时拉起多个 relay 时,只有一个绑得上端口,其余的在这里安静退出。
// 【闲置退出】所有会话结束 RELAY_IDLE_EXIT_MS 之后自行退出,空着的 relay 不该在 master 的持有者账本上
// 一直占一个位子。【常驻模式】(CAP_CC_RELAY_RESIDENT=1,make setup 装的 launchd 任务)不退出:
// 手敲的 claude 与后台会话不经过会登记 pid 的启动器之外的任何东西,闲置退出会让 launchd 反复重启它。
import { initLogger, log } from "./src/logger.ts"
import { createFileLogClient } from "./src/senpi/logSink.ts"
import { readPoolConfig, relayLogPath } from "./src/claudecode/config.ts"
import { createRelayDeps, RELAY_TICK_MS } from "./src/claudecode/install.ts"
import { createRelay } from "./src/claudecode/relay.ts"

const config = readPoolConfig(process.env)
// 没有 worker 配置 = 这台机器不在池子里。启动器不会在这种情况下拉起 relay,所以这只可能是有人手敲。
if (!config) {
  process.stderr.write("这台机器还没并进账号池,relay 无事可做。\n")
  process.exit(78)
}

initLogger(createFileLogClient(process.env, relayLogPath(process.env)))
const resident = process.env.CAP_CC_RELAY_RESIDENT === "1"
const relay = createRelay(createRelayDeps(config, process.env))

let server: ReturnType<typeof Bun.serve>
try {
  server = Bun.serve({
    // 只绑回环:访问控制就是绑定地址。
    hostname: "127.0.0.1",
    port: config.relayPort,
    // 【必须关掉】Bun 默认 10s 空闲就断连接(issue #75 在 master 上踩过)。流式应答在模型思考时
    // 可以停很久不出字节,10s 一到连接被掐,会话里看到的是一次莫名其妙的网络错误。
    idleTimeout: 0,
    fetch: (req) => relay.handle(req),
  })
} catch (error) {
  const code = (error as NodeJS.ErrnoException)?.code
  // 端口被占:多半是并发拉起时另一个 relay 先绑上了 —— 这正是单例的实现方式,安静退出。
  // 若占着的其实是别的程序,启动器的 health 探测会认出来并告诉操作者。
  if (code === "EADDRINUSE") {
    log.info("claudecode:relay-port-taken", { port: config.relayPort, pid: process.pid })
    process.exit(0)
  }
  log.error("claudecode:relay-bind-fail", { port: config.relayPort, error: error instanceof Error ? error.message : String(error) })
  process.exit(1)
}

log.info("claudecode:relay-started", { pid: process.pid, port: config.relayPort, workerId: config.workerId, resident })

const timer = setInterval(() => {
  if (relay.tick() !== "exit" || resident) return
  // 闲置判据只看"最近一次请求开始的时刻",一条比闲置窗口还长的流(没有登记的孤儿会话发起的)
  // 此刻可能还在回传。有在飞的请求就再等一拍,而且优雅关闭 —— 强制关会把它拦腰截断。
  if (server.pendingRequests > 0) return
  log.info("claudecode:relay-idle-exit", { pid: process.pid })
  clearInterval(timer)
  void server.stop().then(() => process.exit(0))
}, RELAY_TICK_MS)

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    log.info("claudecode:relay-signal", { pid: process.pid, signal })
    server.stop(true)
    process.exit(0)
  })
}
