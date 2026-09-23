// make setup 装的进程启动器的决策部分:这个 Claude Code 进程该带着什么环境启动。
//
// 【它在什么位置】官方启动器契约(CLAUDE_CODE_PROCESS_WRAPPER,corporate-launcher 文档):Claude Code 从
// 自己二进制拉起的每一个进程 —— 后台服务、agent view 会话、更新后的自我重启、Remote Control、队友
// pane —— 都以 `<启动器> <claude 二进制> <参数…>` 的形式启动,启动器注入环境后 `exec "$@"`。终端里手敲
// 的 claude 不在契约内,由 PATH 前面的 `claude` 转发脚本接上同一个启动器(同样是文档给的做法)。
//
// sh 外壳负责 exec(Bun 没有 execve),本模块负责判断:放行、注入、还是拒绝。
//
// 【契约里约束本模块的几条】
//   · 约 3 秒内到达 exec —— relay 常驻(launchd),领租约通常是一次本机往返;attach 用短超时。
//   · 会被嵌套调用 —— 环境里继承来的 relay 地址是自己的,不是操作者设的网关(envBlockers 认得它)。
//   · exec 前不向终端写东西 —— 成功路径一个字节都不写;拒绝时才写,那会作为崩溃原因显示出来。
//
// 【失败是拒绝,不是放行】放行 = 会话照跑、钱记在操作者自己的号上且无从察觉(senpi-extension.ts:676
// 那个 ambient fallback)。所以拒绝,并且每条拒绝都告诉操作者怎么一键退回原生 Claude Code。
// 唯一的放行是"接管已经撤回"(清单不在了):那时操作者明确不要池子了,还没重启的旧后台服务不该因为
// 仍指着这个启动器就继续走池子。
import type { ClaudeCodePoolConfig } from "./config.ts"
import { buildChildEnv } from "./childEnv.ts"
import type { RelayClient } from "./relayClient.ts"
import { blockerText, EXIT_BLOCKED, EXIT_NO_LEASE, leaseFailureText, relayFailureText } from "./session.ts"

export type LauncherEnvOutcome =
  // 接管已撤回:什么都不注入,原样 exec。
  | { kind: "passthrough" }
  | { kind: "inject"; vars: Record<string, string> }
  | { kind: "refuse"; code: number; message: string }

export type LauncherEnvDeps = {
  // 接管清单(cc-takeover.json)是否还在。
  installed: () => boolean
  config: ClaudeCodePoolConfig | undefined
  env: NodeJS.ProcessEnv
  readSettings: () => Promise<unknown>
  relay: RelayClient
  relayUrl: string
  relayLogPath: string
  // 启动器 sh 的 $$。exec 不换 pid,所以登记的就是随后那个 claude 进程本身 —— 它退出后 relay 按存活回收。
  pid: number
  // 给拒绝文案用:在哪个目录跑 make revert。
  repoDir: string
  now?: () => number
}

function refusal(code: number, reason: string, repoDir: string): LauncherEnvOutcome {
  return {
    kind: "refuse",
    code,
    message: [
      `账号池接管的 Claude Code 没有启动:${reason}`,
      `想先恢复原生 Claude Code(用你自己的号):cd ${repoDir} && make revert`,
    ].join("\n"),
  }
}

export async function launcherEnv(deps: LauncherEnvDeps): Promise<LauncherEnvOutcome> {
  if (!deps.installed()) return { kind: "passthrough" }
  if (deps.config === undefined) {
    return refusal(EXIT_BLOCKED, "找不到池子配置(~/.claude-accounts-pool/senpi-worker.json)。重跑 make setup。", deps.repoDir)
  }

  const settings = await deps.readSettings()
  const dryRun = buildChildEnv({ env: deps.env, access: "", settings, relayUrl: deps.relayUrl, sentinel: false })
  if (!dryRun.ok) return refusal(EXIT_BLOCKED, blockerText(dryRun.blockers), deps.repoDir)

  const up = await deps.relay.ensureRunning()
  if (!up.ok) {
    return refusal(up.reason === "foreign" ? EXIT_BLOCKED : EXIT_NO_LEASE, relayFailureText(up, deps.config.relayPort, deps.relayLogPath), deps.repoDir)
  }

  const attached = await deps.relay.attach({ pid: deps.pid })
  if (!attached.ok) return refusal(EXIT_NO_LEASE, leaseFailureText(attached.failure, deps.config.masterUrl), deps.repoDir)
  const now = deps.now ?? Date.now
  if (attached.lease.expiresAt <= now()) {
    return refusal(EXIT_NO_LEASE, `relay 交回的租约已经过期(账号 ${attached.lease.accountId.slice(0, 8)})。`, deps.repoDir)
  }

  const child = buildChildEnv({ env: deps.env, access: attached.lease.access, relayUrl: deps.relayUrl, settings, sentinel: false })
  // 同样的输入刚通过了空跑;类型上仍可能失败,就按失败处理,而不是用 `as` 糊过去。
  if (!child.ok) return refusal(EXIT_BLOCKED, blockerText(child.blockers), deps.repoDir)

  // 只输出【变了的】变量:契约要求继承来的环境原样传下去,我们只做加法。
  const vars: Record<string, string> = {}
  for (const [name, value] of Object.entries(child.env)) {
    if (typeof value === "string" && deps.env[name] !== value) vars[name] = value
  }
  return { kind: "inject", vars }
}

const SHELL_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

/** `export NAME='value'` 一行一个,供 sh 外壳 eval。值用单引号包住,内部的单引号按 '\'' 转义。 */
export function shellExports(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => {
      // 名字来自我们自己的常量表,这里只是兜底:一个不合法的名字进了 eval 就是注入。
      if (!SHELL_NAME.test(name)) throw new Error(`refusing to export invalid shell name: ${name}`)
      return `export ${name}='${value.replace(/'/g, `'\\''`)}'`
    })
    .join("\n")
}
