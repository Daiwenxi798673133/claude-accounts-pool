// /pool 面板的执行部分:读 relay 与 master 的状态,产出钩子应答。只读 —— 不切号、不改钉住(issue #101)。
// 网络与存储全部注入。
import type { UsageSnapshotView } from "../cloud/protocol.ts"
import type { ClaudeCodePoolConfig } from "./config.ts"
import { hookResponse, isPoolCommand, renderPanel } from "./panel.ts"
import type { RelayHealth } from "./relay.ts"

export type PanelDeps = {
  prompt: string
  config: ClaudeCodePoolConfig | undefined
  health: () => Promise<RelayHealth | undefined>
  usage: () => Promise<UsageSnapshotView | undefined>
  // 本机的钉住(只读,用来在面板上标出来)。
  readPin: () => string | undefined
}

/** 钩子要写到 stdout 的东西;undefined = 不是 /pool,原样放行。 */
export async function runPanel(deps: PanelDeps): Promise<string | undefined> {
  if (!isPoolCommand(deps.prompt)) return undefined
  if (deps.config === undefined) return hookResponse("这台机器还没并进账号池。在仓库目录执行 make setup。")

  const [health, snapshot] = await Promise.all([deps.health(), deps.usage()])
  const pin = deps.readPin()
  return hookResponse(
    renderPanel({
      snapshot,
      ...(health?.accountId === undefined ? {} : { current: health.accountId }),
      ...(health === undefined ? {} : { sessions: health.sessions }),
      ...(pin === undefined ? {} : { pin }),
      workerId: deps.config.workerId,
      ...(health === undefined ? { notice: "本机 relay 不在:在仓库目录执行 make status 看看。" } : {}),
    }),
  )
}
