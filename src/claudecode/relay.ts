// 本机中间层:claude → 127.0.0.1 → api.anthropic.com,途中把凭证换成全机共享的当前租约。
//
// 【它为什么存在】issue #83 实测:凭证在 claude 进程内冻结,改 settings、送 401 都换不掉。这条互斥只对
// 客户端【内部】成立 —— 冻结的是进程手里那枚 token,不是发到 Anthropic 的那枚。把换 token 这件事
// 挪到进程外面,OAuth 车道(订阅计费)与会话内轮换就同时拿到了。E1/E2a 的探针本来就是在
// ANTHROPIC_BASE_URL=127.0.0.1 下测的:自定义 base URL 不影响 OAuth 车道。
//
// 本模块是 Request → Response 的纯处理器,网络与时间全部注入;Bun.serve、定时器、进程退出在
// claude-pool-relay.ts(组合根)。
//
// 两类路由:
//   /__claude-pool/*  控制面,只给 claude-pool 启动器用(health / attach / detach)
//   其余一切           原样转发给上游,只换凭证
import { log, redactBody } from "../logger.ts"
import type { LeaseFailure } from "../worker/leaseClient.ts"
import type { SharedLease, SharedLeaseResult } from "./sharedLease.ts"
import { downstreamHeaders, isQuotaExhausted, relayErrorResponse, upstreamHeaders } from "./relayWire.ts"

export const RELAY_SERVICE = "claude-pool-relay"
// 启动器与 relay 之间控制面的版本。relay 比启动器活得久(它服务全机所有会话),git pull 之后跑着的
// 可能还是旧的那个 —— 启动器靠这个数字发现并说一句,而不是跟一个听不懂新字段的 relay 各说各话。
export const RELAY_VERSION = 1

export const RELAY_ROUTES = Object.freeze({
  health: "/__claude-pool/health",
  attach: "/__claude-pool/attach",
  detach: "/__claude-pool/detach",
})

// 没有会话之后再等这么久才退出。不是 0:会话之间常有几分钟空档(关一个、开下一个),每次都冷启动
// 一个 relay 就要多一次租约往返;也不能太长 —— 空着的 relay 仍在 master 的持有者账本上占一个位子,
// 直到租约自然到期。
export const RELAY_IDLE_EXIT_MS = 10 * 60_000

export type RelayHealth = {
  service: typeof RELAY_SERVICE
  version: number
  pid: number
  workerId: string
  masterUrl: string
  sessions: number
  // 只出前 8 位,且只在手里有租约时出现。health 是无鉴权的本机接口,access 绝不在这里。
  accountId?: string
  expiresAt?: number
}

export type AttachRequest = { pid: number; preferredAccountIdPrefix?: string; pinned?: boolean }

export type AttachResponse =
  | { ok: true; accountId: string; access: string; expiresAt: number; sessions: number }
  | { ok: false; failure: LeaseFailure }

export type RelayDeps = {
  shared: SharedLease
  fetchImpl: typeof fetch
  // 上游地址,生产是 https://api.anthropic.com;只有测试会改(CAP_CC_UPSTREAM)。
  upstream: string
  identity: { pid: number; workerId: string; masterUrl: string }
  // 会话登记的是启动器进程的 pid,它与 claude 子进程同生共死。kill -9 掉的启动器不会来 detach,
  // 所以每次 tick 都按存活回收。
  isAlive: (pid: number) => boolean
  newRequestId: () => string
  now: () => number
}

export type Relay = {
  handle: (req: Request) => Promise<Response>
  /** 定时调用:回收死会话、有会话时顺手续期、无会话且闲置够久时返回 "exit"。 */
  tick: () => "stay" | "exit"
  sessionCount: () => number
}

const BODYLESS = new Set(["GET", "HEAD"])

// 失败变体 → 状态码 + 会话里显示的那句话。按变体建表,理由与全仓一致:补救动作各不相同。
// 5xx 让客户端按退避重试(master 在重启时正是想要的),429 让它直接显示、不重试(池子空了重试是空转)。
function failureResponse(failure: LeaseFailure, masterUrl: string): Response {
  switch (failure.kind) {
    case "no-account":
      return relayErrorResponse(429, "账号池:现在没有可用账号(都在冷却或已满员),稍后再试。")
    case "refused":
      return relayErrorResponse(429, `账号池:master 拒绝了这次租约(${failure.refused})。`)
    case "unreachable":
      return relayErrorResponse(503, `账号池:连不上 master(${masterUrl}):${failure.detail}`)
    case "bad-response":
      return relayErrorResponse(502, `账号池:master 的应答看不懂:${failure.detail}。多半是两端版本不一致。`)
    case "dead-access":
      return relayErrorResponse(503, `账号池:master 发回的凭证已被判定失效(账号 ${failure.accountId.slice(0, 8)}),正在等它刷新。`)
  }
}

function parseAttach(raw: unknown): AttachRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { pid, preferredAccountIdPrefix, pinned } = raw as Record<string, unknown>
  if (!Number.isInteger(pid) || (pid as number) <= 0) return undefined
  if (preferredAccountIdPrefix !== undefined && (typeof preferredAccountIdPrefix !== "string" || preferredAccountIdPrefix.length === 0)) {
    return undefined
  }
  if (pinned !== undefined && typeof pinned !== "boolean") return undefined
  return {
    pid: pid as number,
    ...(preferredAccountIdPrefix === undefined ? {} : { preferredAccountIdPrefix: preferredAccountIdPrefix as string }),
    ...(pinned === undefined ? {} : { pinned: pinned as boolean }),
  }
}

export function createRelay(deps: RelayDeps): Relay {
  const sessions = new Set<number>()
  let lastActivity = deps.now()
  const upstream = deps.upstream.replace(/\/+$/, "")

  function health(): RelayHealth {
    const lease = deps.shared.current()
    return {
      service: RELAY_SERVICE,
      version: RELAY_VERSION,
      pid: deps.identity.pid,
      workerId: deps.identity.workerId,
      masterUrl: deps.identity.masterUrl,
      sessions: sessions.size,
      ...(lease === undefined ? {} : { accountId: lease.accountId.slice(0, 8), expiresAt: lease.expiresAt }),
    }
  }

  async function control(req: Request, path: string): Promise<Response> {
    if (path === RELAY_ROUTES.health && req.method === "GET") return Response.json(health())
    if (path === RELAY_ROUTES.attach && req.method === "POST") {
      const input = parseAttach(await req.json().catch(() => undefined))
      if (!input) return Response.json({ error: "malformed attach" }, { status: 400 })
      sessions.add(input.pid)
      lastActivity = deps.now()
      const result =
        input.preferredAccountIdPrefix === undefined
          ? await deps.shared.ensure()
          : await deps.shared.name(input.preferredAccountIdPrefix, input.pinned === true)
      if (!result.ok) {
        // 启动器拿到失败就不会起会话,所以这个 pid 不该留在登记里占着 relay 不退出。
        // 心跳路径(同一个 pid 反复 attach)失败时也一样:它下一次 tick 会再登记回来。
        sessions.delete(input.pid)
        return Response.json({ ok: false, failure: result.failure } satisfies AttachResponse)
      }
      const body: AttachResponse = { ok: true, ...result.lease, sessions: sessions.size }
      return Response.json(body)
    }
    if (path === RELAY_ROUTES.detach && req.method === "POST") {
      const raw = (await req.json().catch(() => undefined)) as { pid?: unknown } | undefined
      if (Number.isInteger(raw?.pid)) sessions.delete(raw?.pid as number)
      lastActivity = deps.now()
      return new Response(null, { status: 204 })
    }
    return Response.json({ error: "unknown control route" }, { status: 404 })
  }

  async function send(req: Request, url: string, body: ArrayBuffer | undefined, access: string): Promise<Response> {
    return deps.fetchImpl(url, {
      method: req.method,
      headers: upstreamHeaders(req.headers, access, deps.newRequestId),
      body,
      redirect: "manual",
      // 会话按 Esc 中断时客户端断开,上游这一发也跟着取消,而不是在后台把整段生成烧完。
      signal: req.signal,
      // 【必须】不解压:Bun 默认解压 body 却保留 content-encoding 头,原样回传会让客户端二次解压。
      // 字节原样过,头原样过,两边才对得上(实测 Bun 1.4.2)。
      decompress: false,
    } as RequestInit)
  }

  async function forward(req: Request, path: string, search: string): Promise<Response> {
    lastActivity = deps.now()
    const url = `${upstream}${path}${search}`
    // 请求体整段读进来:换号或续期之后要原样重放。429 / 401 在上游开始流式应答之前就返回,
    // 所以重放发生时客户端那边还一个字节都没收到。
    const body = BODYLESS.has(req.method) ? undefined : await req.arrayBuffer()

    let lease: SharedLeaseResult = await deps.shared.ensure()
    if (!lease.ok) return failureResponse(lease.failure, deps.identity.masterUrl)

    try {
      let res = await send(req, url, body, lease.lease.access)
      if (isQuotaExhausted(res.status, res.headers)) {
        const next = await deps.shared.quotaExhausted(lease.lease.accountId, res.headers)
        // 换成了别的号才重发。换不成(池子空了)就把原始 429 交给客户端 —— 它会显示自己的额度文案,
        // 那比 relay 编一句更准确。
        if (next.ok && next.lease.accountId !== lease.lease.accountId) {
          await res.body?.cancel().catch(() => {})
          lease = next
          res = await send(req, url, body, next.lease.access)
        }
      } else if (res.status === 401) {
        const next = await deps.shared.unauthorized(lease.lease.access)
        if (next.ok && next.lease.access !== lease.lease.access) {
          await res.body?.cancel().catch(() => {})
          lease = next
          res = await send(req, url, body, next.lease.access)
        }
      }
      if (res.status >= 400) {
        log.warn("claudecode:relay-upstream-status", { status: res.status, path, accountId: lease.lease.accountId.slice(0, 8) })
      }
      // 每个请求一行,只在 CLAUDE_AUTOSWITCH_DEBUG 下出现(logger 的 debug 门):"这一发到底走的哪个号"
      // 是会话中途换号唯一的直接证据,但常开就是每次 API 调用一行日志。
      log.debug("claudecode:relay-forward", { method: req.method, path, status: res.status, accountId: lease.lease.accountId.slice(0, 8) })
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers: downstreamHeaders(res.headers) })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      // 客户端自己断开的(Esc)不是故障,不记 warn。
      if (!req.signal.aborted) log.warn("claudecode:relay-upstream-fail", { path, detail: redactBody(detail, 200) })
      return relayErrorResponse(502, `账号池 relay 连不上上游:${redactBody(detail, 200)}`)
    }
  }

  return {
    handle: async (req) => {
      const url = new URL(req.url)
      if (url.pathname.startsWith("/__claude-pool/")) return control(req, url.pathname)
      return forward(req, url.pathname, url.search)
    },

    tick: () => {
      for (const pid of sessions) if (!deps.isAlive(pid)) sessions.delete(pid)
      if (sessions.size > 0) {
        lastActivity = deps.now()
        // 有人在用就提前续上,而不是让下一个请求去等一次 master 往返。失败只记日志 —— ensure 自己会
        // 在手里那枚还能用时接着用。
        void deps.shared.ensure().catch(() => {})
        return "stay"
      }
      return deps.now() - lastActivity >= RELAY_IDLE_EXIT_MS ? "exit" : "stay"
    },

    sessionCount: () => sessions.size,
  }
}
