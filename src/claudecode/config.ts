// 这条链自己的配置:连哪个 master(与 senpi 共用)、以什么标签租号(自己的)、relay 听哪个端口。
//
// 【为什么 workerId 要自己一个,而不是沿用 senpi 那个】master 的租约账本按 workerId 键。两条链共用
// 一个标签,master 就只记得住最后租的那一条,于是它对这台机器的持有者计数是错的 —— 同一个号会被
// 同时派给两条链,一个 5 小时窗口被双倍烧。给这条链一个自己的标签,master 就分别记账,
// fewestHolders 会让两条链自动互相绕开。跨链协调交给 master,本机不共享任何文件。
//
// 【一台机器只有一个标签】—— 本机所有 claude 会话经由同一个 relay、共用同一个号(issue #83 定稿),
// 所以不再有槽位、不再有带编号的子标签。
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { leaseCacheDir } from "../senpi/leaseCache.ts"
import { readWorkerConfig, workerConfigPath } from "../senpi/workerConfig.ts"

// 默认端口。避开 master 的 8787 —— issue #83 的探针、e2e 的假 master 都爱用它,同机调试时撞上会让
// relay 误以为端口被"别的程序"占着。
export const CC_RELAY_DEFAULT_PORT = 18787

// relay 的上游。只有测试会改(CAP_CC_UPSTREAM),生产永远是 Anthropic 本身。
export const CC_UPSTREAM_DEFAULT = "https://api.anthropic.com"

export type ClaudeCodePoolConfig = { masterUrl: string; workerId: string; relayPort: number }

export function parseRelayPort(raw: string | number | undefined): number {
  if (raw === undefined) return CC_RELAY_DEFAULT_PORT
  const parsed = typeof raw === "number" ? raw : Number(raw)
  // 特权端口不收:relay 以操作者身份运行,绑不上 1024 以下,与其启动时才发现,不如在这里就回到默认。
  if (!Number.isInteger(parsed) || parsed < 1024 || parsed > 65535) return CC_RELAY_DEFAULT_PORT
  return parsed
}

/**
 * 标签的来源,按优先级:环境变量 → 配置文件里的 `ccWorkerId` → 由 senpi 的标签推导。
 *
 * 推导出的默认值(`<senpi 标签>.cc`)保证了「没配过也能跑,且不会与 senpi 撞标签」;显式配置则让
 * 操作者能起一个短名字(比如 `vince-cc`),那是看板上会被人读到的东西。
 */
export function resolveBaseWorkerId(senpiWorkerId: string, stored: unknown, env: NodeJS.ProcessEnv): string {
  const fromEnv = env.CAP_CC_WORKER
  if (typeof fromEnv === "string" && fromEnv.length > 0) return fromEnv
  if (typeof stored === "string" && stored.length > 0) return stored
  return `${senpiWorkerId}.cc`
}

// 这条链自己的两个字段要从【原始文件】读:readWorkerConfig 只交回 senpi 认的那三个字段。之前这里
// 把它的返回值当成原始文件来读,于是 ccWorkerId / ccRelayPort 写进文件也从来没生效过(e2e 抓到的)。
function rawWorkerFile(env: NodeJS.ProcessEnv): Record<string, unknown> {
  try {
    const raw: unknown = JSON.parse(readFileSync(workerConfigPath(env), "utf8"))
    return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

export function readPoolConfig(env: NodeJS.ProcessEnv = process.env): ClaudeCodePoolConfig | undefined {
  const base = readWorkerConfig(env)
  if (!base) return undefined
  // 同一个文件,只是多读两个字段 —— 配置手术仅追加,这里也一样:读不到就用默认,不报错。
  // 旧版写进去的 `ccSlots` 被安静地忽略:它描述的是一个已经不存在的形状,不值得为它拒绝启动。
  const raw = rawWorkerFile(env) as { ccWorkerId?: unknown; ccRelayPort?: unknown }
  return {
    masterUrl: base.masterUrl,
    workerId: resolveBaseWorkerId(base.workerId, raw.ccWorkerId, env),
    relayPort: parseRelayPort(
      (env.CAP_CC_RELAY_PORT as string | undefined) ?? (typeof raw.ccRelayPort === "number" ? raw.ccRelayPort : undefined),
    ),
  }
}

/** relay 的地址。只绑回环 —— 访问控制就是绑定地址,与 master 同一个取舍。 */
export function relayUrl(port: number): string {
  return `http://127.0.0.1:${port}`
}

export function upstreamUrl(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.CAP_CC_UPSTREAM
  return typeof override === "string" && override.length > 0 ? override : CC_UPSTREAM_DEFAULT
}

/** relay 的日志。它是脱离终端的后台进程,没有别的地方可写。 */
export function relayLogPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(leaseCacheDir(env), "cc-relay.log")
}

/**
 * make setup 的接管清单:它装了什么、改了什么,make revert 照单撤回。进程启动器也看它 ——
 * 清单不在,就说明接管已撤回,启动器原样放行(见 launcherEnv.ts)。
 */
export function takeoverManifestPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(leaseCacheDir(env), "cc-takeover.json")
}
