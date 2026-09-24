// /pool 面板的执行部分:读 relay 与 master 的状态,执行切号 / 钉住 / 取消钉住 / 刷新,产出钩子应答。
// 网络与存储全部注入。
//
// 切号走 relay 的 attach(带 preferredAccountIdPrefix)—— 与 `claude-pool --pool-account` 同一条路径,
// 所以点名规则完全一样:master 不服务的号如实拒绝、绝不换成别的;本机所有会话一起换(一台机器一个号)。
// 钉住照抄 OMO 的 `p`(worker/install.ts onPin):先落盘、再点名,点名失败就把钉住还原。
import type { UsageSnapshotView } from "../cloud/protocol.ts"
import type { ClaudeCodePoolConfig } from "./config.ts"
import { helpText, hookResponse, parsePanelCommand, renderPanel, resolveTarget, samePrefix, type Notice } from "./panel.ts"
import type { PinStore } from "./pin.ts"
import type { RelayHealth } from "./relay.ts"
import type { RelayClient } from "./relayClient.ts"
import { leaseFailureText } from "./session.ts"

export type UsageRefresh = { ok: true; view: UsageSnapshotView } | { ok: false; message: string }

export type PanelDeps = {
  prompt: string
  config: ClaudeCodePoolConfig | undefined
  health: () => Promise<RelayHealth | undefined>
  usage: () => Promise<UsageSnapshotView | undefined>
  // OMO 的 `r`:让 master 立刻采一轮。失败(含 master 的 30 秒节流)变成一句给人看的话。
  refreshUsage: () => Promise<UsageRefresh>
  relay: Pick<RelayClient, "attach">
  pin: PinStore
  // 登记给 relay 的 pid。钩子进程随即退出,relay 下一拍按存活回收 —— 不会占着一个会话名额。
  pid: number
  terminalWidth: () => number | undefined
  now: () => number
}

const RELAY_DOWN = "本机 relay 不在:在仓库目录执行 make status 看看。"

/** 钩子要写到 stdout 的东西;undefined = 不是 /pool,原样放行。 */
export async function runPanel(deps: PanelDeps): Promise<string | undefined> {
  const command = parsePanelCommand(deps.prompt)
  if (command === undefined) return undefined
  if (command.kind === "help") return hookResponse(helpText(command.error))
  if (deps.config === undefined) return hookResponse("这台机器还没并进账号池。在仓库目录执行 make setup。")
  const config = deps.config

  // attachedSelf:这次调用刚用钩子自己的 pid 做过 attach —— relay 要到下一拍才把它回收,
  // 此刻的会话数里多算了它一个。
  const show = async (input: { notices?: Notice[]; snapshot?: UsageSnapshotView; attachedSelf?: boolean } = {}): Promise<string> => {
    const [health, snapshot] = await Promise.all([deps.health(), input.snapshot === undefined ? deps.usage() : input.snapshot])
    const notices = [...(input.notices ?? []), ...(health === undefined ? [{ tone: "warn" as const, text: RELAY_DOWN }] : [])]
    const pin = deps.pin.read()
    const width = deps.terminalWidth()
    return hookResponse(
      renderPanel({
        snapshot,
        relayUp: health !== undefined,
        ...(health?.accountId === undefined ? {} : { current: health.accountId }),
        ...(health === undefined ? {} : { sessions: Math.max(0, health.sessions - (input.attachedSelf ? 1 : 0)) }),
        ...(pin === undefined ? {} : { pin }),
        workerId: config.workerId,
        notices,
        ...(width === undefined ? {} : { terminalWidth: width }),
        now: deps.now(),
      }),
    )
  }

  if (command.kind === "list") return show()

  if (command.kind === "refresh") {
    const refreshed = await deps.refreshUsage()
    return refreshed.ok
      ? show({ snapshot: refreshed.view, notices: [{ tone: "ok", text: "✓ master 刚采完一轮用量。" }] })
      : show({ notices: [{ tone: "warn", text: refreshed.message }] })
  }

  // ── switch ──
  const snapshot = await deps.usage()
  let prefix: string
  let label: string
  if (snapshot === undefined) {
    // 拿不到面板:编号无从对应,但一个明确的 id 前缀仍然可以直接交给 master 去认。
    if (!/^[0-9a-f]{4,}$/i.test(command.target)) {
      return show({ notices: [{ tone: "error", text: "✗ 拿不到账号列表,编号对不上号。用 id 前缀再试一次。" }] })
    }
    prefix = command.target.toLowerCase()
    label = prefix
  } else {
    const target = resolveTarget(command.target, snapshot.accounts)
    if (!target.ok) return show({ snapshot, notices: [{ tone: "error", text: `✗ ${target.reason}` }] })
    prefix = target.account.idPrefix
    label = target.account.label
  }

  const previousPin = deps.pin.read()
  const pinnedHere = previousPin !== undefined && samePrefix(previousPin, prefix)

  // 对已钉住的号再按一次 `p` = 取消钉住。当前号不动:取消钉住说的是"以后别再点名它",不是"现在换走"。
  // master 那边的钉住标记在下一次续期时跟着清掉(那次租约不再带 pinned)。
  if (command.pin && pinnedHere) {
    deps.pin.write(undefined)
    return show({ snapshot, notices: [{ tone: "ok", text: `✓ 已取消钉住「${label}」:当前号不变,续期恢复按用量轮换。` }] })
  }

  const health = await deps.health()
  if (health === undefined) return show({ snapshot, notices: [{ tone: "error", text: "✗ 没法切号:本机所有会话共用 relay 手里的号,relay 不在就无从换起。" }] })
  if (!command.pin && health.accountId !== undefined && samePrefix(health.accountId, prefix)) {
    return show({ snapshot, notices: [{ tone: "ok", text: `本机本来就在用「${label}」,没有变化。` }] })
  }

  // 钉住意图先落盘,再点名 —— relay 被 master 拒绝时交还的正是这里写下的那个(与启动器同一顺序)。
  if (command.pin) deps.pin.write(prefix)
  const attached = await deps.relay.attach({ pid: deps.pid, preferredAccountIdPrefix: prefix, pinned: command.pin })
  if (!attached.ok) {
    // 任何失败都还原(OMO onPin 同样如此):没切过去的号不能留着一个钉住,下一次续期会反复去点它。
    if (command.pin) deps.pin.write(previousPin)
    // 失败的 attach 不会把 pid 留在登记里(relay 失败时删掉它),所以会话数不用减。
    return show({ notices: [{ tone: "error", text: `✗ 没有切过去:${leaseFailureText(attached.failure, config.masterUrl)}` }] })
  }

  const notices: Notice[] = []
  const others = Math.max(0, attached.sessions - 1)
  const who = others > 0 ? `本机 ${others} 个会话从下一个请求起用它` : "之后本机的 claude 会话都用它"
  notices.push({
    tone: "ok",
    text: command.pin
      ? `✓ 已钉住「${label}」,额度用满前不再被账号池轮换走;${who}。`
      : `✓ 已切到「${label}」,续期会保住它,撞限额才换号;${who}。`,
  })
  // 手动切到别的号时,原来的钉住必须一起放掉:它还在的话,下一次续期 relay 会点名它、把本机切回去,
  // 这一次切号就只活到下一次续期。
  if (!command.pin && previousPin !== undefined && !pinnedHere) {
    deps.pin.write(undefined)
    notices.push({ tone: "warn", text: `原来钉住的 ${previousPin} 已取消,不然下一次续期会切回它。` })
  }
  return show({ notices, attachedSelf: true })
}
