// /pool 面板的执行部分:读状态、执行切号 / 钉住 / 取消钉住,产出钩子应答。网络与存储全部注入。
//
// 切号走的是 relay 的 attach(带 preferredAccountIdPrefix)—— 与 `claude-pool --pool-account` 同一条路径,
// 所以点名规则完全一样:master 不服务的号如实拒绝、绝不换成别的;钉住的号被拒时由 relay 交还钉住。
import type { UsageSnapshotView } from "../cloud/protocol.ts"
import type { ClaudeCodePoolConfig } from "./config.ts"
import { helpText, hookResponse, parsePanelCommand, renderPanel, resolveTarget } from "./panel.ts"
import type { PinStore } from "./pin.ts"
import type { RelayHealth } from "./relay.ts"
import type { RelayClient } from "./relayClient.ts"
import { leaseFailureText } from "./session.ts"

export type PanelDeps = {
  prompt: string
  config: ClaudeCodePoolConfig | undefined
  health: () => Promise<RelayHealth | undefined>
  usage: () => Promise<UsageSnapshotView | undefined>
  relay: Pick<RelayClient, "attach">
  pin: PinStore
  // 登记给 relay 的 pid。钩子进程随即退出,relay 下一拍按存活回收 —— 不会占着一个会话名额。
  pid: number
}

/** 钩子要写到 stdout 的东西;undefined = 不是 /pool,原样放行。 */
export async function runPanel(deps: PanelDeps): Promise<string | undefined> {
  const command = parsePanelCommand(deps.prompt)
  if (command === undefined) return undefined
  if (command.kind === "help") return hookResponse(helpText(command.error))
  if (deps.config === undefined) {
    return hookResponse("这台机器还没并进账号池。在仓库目录执行 make setup。")
  }
  const config = deps.config

  // attachedSelf:这次调用刚用钩子自己的 pid 做过 attach —— relay 要到下一拍才把它回收,
  // 此刻的会话数里多算了它一个。
  const view = async (notice?: string, attachedSelf = false): Promise<string> => {
    const [health, snapshot] = await Promise.all([deps.health(), deps.usage()])
    const sessions = health === undefined ? undefined : Math.max(0, health.sessions - (attachedSelf ? 1 : 0))
    return hookResponse(
      renderPanel({
        snapshot,
        ...(health?.accountId === undefined ? {} : { current: health.accountId }),
        ...(sessions === undefined ? {} : { sessions }),
        ...(deps.pin.read() === undefined ? {} : { pin: deps.pin.read() }),
        workerId: config.workerId,
        ...(notice === undefined ? {} : { notice }),
      }),
    )
  }

  if (command.kind === "list") {
    const health = await deps.health()
    return view(health === undefined ? "本机 relay 不在:在仓库目录执行 make status 看看。" : undefined)
  }

  if (command.kind === "unpin") {
    const had = deps.pin.read()
    deps.pin.write(undefined)
    return view(had === undefined ? "本来就没有钉住。" : `✓ 已取消钉住 ${had}。当前号不变,下一次续期由账号池按用量挑。`)
  }

  // switch
  const snapshot = await deps.usage()
  let prefix: string
  if (snapshot === undefined) {
    // 拿不到面板:编号无从对应,但一个明确的 id 前缀仍然可以直接交给 master 去认。
    if (!/^[0-9a-f]{4,}$/i.test(command.target)) return view("拿不到账号列表,编号对不上号。用 id 前缀再试一次。")
    prefix = command.target.toLowerCase()
  } else {
    const target = resolveTarget(command.target, snapshot.accounts)
    if (!target.ok) return view(target.reason)
    prefix = target.account.idPrefix
  }

  // 钉住意图先落盘,再点名 —— relay 被 master 拒绝时交还的正是这里写下的那个(与启动器同一顺序)。
  if (command.pin) deps.pin.write(prefix)
  const attached = await deps.relay.attach({ pid: deps.pid, preferredAccountIdPrefix: prefix, pinned: command.pin })
  // 失败的 attach 不会把 pid 留在登记里(relay 失败时删掉它),所以这里不用减。
  if (!attached.ok) return view(`✗ 没有切过去:${leaseFailureText(attached.failure, config.masterUrl)}`)
  // attach 把钩子自己的 pid 也算进了会话数,报给人看时减掉。
  const others = Math.max(0, attached.sessions - 1)
  const who = others > 0 ? `本机 ${others} 个会话从下一个请求起用它` : "之后本机的 claude 会话都用它"
  return view(`✓ 已切到 ${attached.lease.accountId.slice(0, 8)}${command.pin ? " 并钉住" : ""},${who}。`, true)
}
