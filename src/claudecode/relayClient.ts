// 启动器这一侧:找到本机的 relay(没有就拉起一个),登记这个会话,拿到当前共享租约。
//
// 【单例靠端口,不靠锁文件】。N 个启动器同时发现 relay 不在、同时各拉起一个,只有一个能绑上端口,
// 其余的绑定失败后自行退出(claude-pool-relay.ts)。启动器这边只需要轮询 health 直到有人应答。
// 端口本身就是那把锁,而且它不会在进程崩溃后变陈旧 —— 这正是锁文件做不到的。
import { log } from "../logger.ts"
import type { LeaseFailure } from "../worker/leaseClient.ts"
import { RELAY_ROUTES, RELAY_SERVICE, RELAY_VERSION, type AttachRequest, type AttachResponse, type RelayHealth } from "./relay.ts"

export type RelayUp =
  | { ok: true; health: RelayHealth; spawned: boolean }
  // 端口上有东西,但不是我们的 relay。绝不把租来的凭证发给它。
  | { ok: false; reason: "foreign"; detail: string }
  // 拉起了,但在时限内没有应答(relay 自己的日志里会有原因)。
  | { ok: false; reason: "timeout" }

export type AttachOutcome =
  | { ok: true; lease: { accountId: string; access: string; expiresAt: number }; sessions: number }
  | { ok: false; failure: LeaseFailure }

export type RelayClient = {
  ensureRunning: () => Promise<RelayUp>
  attach: (input: AttachRequest) => Promise<AttachOutcome>
  detach: (pid: number) => Promise<void>
}

export type RelayClientDeps = {
  fetchImpl: typeof fetch
  baseUrl: string
  // 拉起一个脱离终端的 relay 进程。不等它:是否起来由 health 轮询回答。
  spawnRelay: () => void
  sleep: (ms: number) => Promise<void>
  now: () => number
  startTimeoutMs?: number
}

const PROBE_TIMEOUT_MS = 1_000
// 控制面请求会触发 master 租约往返:单次 15s 超时,遇到死凭证还要排除后再租一次(deadLease),
// 所以要盖住两次 —— 否则 relay 还在正常等 master,启动器先以为它挂了。
const CONTROL_TIMEOUT_MS = 35_000
const POLL_MS = 100
const DEFAULT_START_TIMEOUT_MS = 10_000

type Probe = { kind: "absent" } | { kind: "relay"; health: RelayHealth } | { kind: "foreign"; detail: string }

function isRelayHealth(raw: unknown): raw is RelayHealth {
  return typeof raw === "object" && raw !== null && (raw as { service?: unknown }).service === RELAY_SERVICE
}

export function createRelayClient(deps: RelayClientDeps): RelayClient {
  const base = deps.baseUrl.replace(/\/+$/, "")

  async function probe(): Promise<Probe> {
    let res: Response
    try {
      res = await deps.fetchImpl(`${base}${RELAY_ROUTES.health}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) })
    } catch {
      // 连接被拒 / 超时:没有人在这个端口上。
      return { kind: "absent" }
    }
    const raw = await res.json().catch(() => undefined)
    if (res.ok && isRelayHealth(raw)) return { kind: "relay", health: raw }
    return { kind: "foreign", detail: `HTTP ${res.status}` }
  }

  return {
    ensureRunning: async () => {
      const first = await probe()
      if (first.kind === "relay") return { ok: true, health: first.health, spawned: false }
      if (first.kind === "foreign") return { ok: false, reason: "foreign", detail: first.detail }

      deps.spawnRelay()
      const deadline = deps.now() + (deps.startTimeoutMs ?? DEFAULT_START_TIMEOUT_MS)
      while (deps.now() < deadline) {
        await deps.sleep(POLL_MS)
        const seen = await probe()
        if (seen.kind === "relay") return { ok: true, health: seen.health, spawned: true }
        if (seen.kind === "foreign") return { ok: false, reason: "foreign", detail: seen.detail }
      }
      return { ok: false, reason: "timeout" }
    },

    attach: async (input) => {
      let res: Response
      try {
        res = await deps.fetchImpl(`${base}${RELAY_ROUTES.attach}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
          signal: AbortSignal.timeout(CONTROL_TIMEOUT_MS),
        })
      } catch (error) {
        return { ok: false, failure: { kind: "unreachable", detail: `relay: ${error instanceof Error ? error.message : String(error)}` } }
      }
      const raw = (await res.json().catch(() => undefined)) as AttachResponse | undefined
      if (!res.ok || raw === undefined || typeof raw.ok !== "boolean") {
        return { ok: false, failure: { kind: "bad-response", detail: `relay attach HTTP ${res.status}` } }
      }
      if (!raw.ok) return { ok: false, failure: raw.failure }
      return {
        ok: true,
        lease: { accountId: raw.accountId, access: raw.access, expiresAt: raw.expiresAt },
        sessions: raw.sessions,
      }
    },

    detach: async (pid) => {
      try {
        await deps.fetchImpl(`${base}${RELAY_ROUTES.detach}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ pid }),
          signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
        })
      } catch (error) {
        // relay 会按进程存活自己回收,这一步只是让它早点知道。
        log.debug("claudecode:relay-detach-failed", { error: error instanceof Error ? error.message : String(error) })
      }
    },
  }
}

/**
 * 跑着的 relay 与这个启动器对不上时给操作者的话:版本不同(git pull 之后)、或配置不同(换了 master /
 * 标签)。只提醒不拒绝 —— 会话照样能跑,只是跑在旧 relay 上;拒绝启动会让操作者在一个能用的系统前
 * 卡住。relay 在无会话 10 分钟后自行退出,下一个启动器就会拉起新的。
 */
export function relayNotices(health: RelayHealth, expected: { workerId: string; masterUrl: string }): string[] {
  const restart = `它会在所有会话结束 10 分钟后自行退出;想立刻换新,关掉所有 claude-pool 会话后 kill ${health.pid}。`
  const lines: string[] = []
  if (health.version !== RELAY_VERSION) {
    lines.push(`本机 relay(pid ${health.pid})是另一个版本(${health.version},启动器是 ${RELAY_VERSION})。${restart}`)
  }
  if (health.workerId !== expected.workerId || health.masterUrl !== expected.masterUrl) {
    lines.push(`本机 relay(pid ${health.pid})用的是另一份配置(${health.workerId} @ ${health.masterUrl})。${restart}`)
  }
  return lines
}
