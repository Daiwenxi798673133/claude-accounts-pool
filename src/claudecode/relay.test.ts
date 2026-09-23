import { expect, test } from "bun:test"
import type { LeaseOutcome } from "../worker/leaseClient.ts"
import { createRelay, RELAY_IDLE_EXIT_MS, RELAY_ROUTES, RELAY_SERVICE, type AttachResponse, type RelayHealth } from "./relay.ts"
import { createSharedLease, type SharedLeaseDeps } from "./sharedLease.ts"

const A = "aaaaaaaa-0000-0000-0000-000000000000"
const B = "bbbbbbbb-0000-0000-0000-000000000000"
const BASE = "http://127.0.0.1:18787"
const QUOTA_HEADERS = {
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-representative-claim": "five_hour",
  "anthropic-ratelimit-unified-reset": "1790000000",
}

type Seen = { url: string; method: string; authorization: string | null; body: string; headers: Headers }
type LeaseCall = Parameters<SharedLeaseDeps["lease"]>[0]

// 假上游按 access 决定回什么:测试只需要说"哪枚 token 撞额度、哪枚是死的"。
function harness(
  opts: {
    upstream?: (seen: Seen) => Response | Promise<Response>
    leases?: ((call: LeaseCall) => LeaseOutcome)[]
    alive?: Set<number>
    leaseDelay?: number
  } = {},
) {
  let now = 1_700_000_000_000
  const seen: Seen[] = []
  const leaseCalls: LeaseCall[] = []
  const reports: string[] = []
  const answers = [...(opts.leases ?? [])]
  const grant = (accountId: string, access: string): LeaseOutcome => ({ ok: true, lease: { accountId, access, expiresAt: now + 3 * 3600_000 } })
  const shared = createSharedLease({
    lease: async (call) => {
      leaseCalls.push(call)
      if (opts.leaseDelay) await new Promise((r) => setTimeout(r, opts.leaseDelay))
      return (answers.shift() ?? (() => grant(A, "access-A")))(call)
    },
    reportRateLimit: async ({ accountId }) => (reports.push(accountId), true),
    pin: { read: () => undefined, write: () => {} },
    now: () => now,
  })
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const headers = new Headers(init?.headers)
    const body = init?.body === undefined ? "" : new TextDecoder().decode(init.body as ArrayBuffer)
    const entry: Seen = { url: String(input), method: init?.method ?? "GET", authorization: headers.get("authorization"), body, headers }
    seen.push(entry)
    return (opts.upstream ?? (() => new Response("ok", { status: 200 })))(entry)
  }) as typeof fetch
  const alive = opts.alive ?? new Set<number>()
  const relay = createRelay({
    shared,
    fetchImpl,
    upstream: "https://api.anthropic.com/",
    identity: { pid: 4242, port: 18787, workerId: "vince-cc", masterUrl: "http://master:8787" },
    isAlive: (pid) => alive.has(pid),
    newRequestId: () => "rid",
    now: () => now,
  })
  return { relay, seen, leaseCalls, reports, grant, alive, advance: (ms: number) => void (now += ms) }
}

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })

test("转发:路径与查询串原样、方法原样、body 原样,只换凭证", async () => {
  const h = harness()
  const res = await h.relay.handle(post("/v1/messages?beta=true", { model: "m", stream: true }, { authorization: "Bearer frozen" }))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("ok")
  expect(h.seen).toHaveLength(1)
  expect(h.seen[0].url).toBe("https://api.anthropic.com/v1/messages?beta=true")
  expect(h.seen[0].method).toBe("POST")
  expect(h.seen[0].authorization).toBe("Bearer access-A")
  expect(JSON.parse(h.seen[0].body)).toEqual({ model: "m", stream: true })
})

test("GET 不带 body", async () => {
  const h = harness()
  await h.relay.handle(new Request(`${BASE}/v1/models`))
  expect(h.seen[0].method).toBe("GET")
  expect(h.seen[0].body).toBe("")
})

test("上游的状态码与响应头原样回给客户端,content-encoding 保留", async () => {
  const h = harness({
    upstream: () => new Response("x", { status: 400, headers: { "content-encoding": "gzip", "request-id": "req_1" } }),
  })
  const res = await h.relay.handle(post("/v1/messages", {}))
  expect(res.status).toBe(400)
  expect(res.headers.get("content-encoding")).toBe("gzip")
  expect(res.headers.get("request-id")).toBe("req_1")
})

test("撞额度:换号后在新号上重发,客户端只看到成功", async () => {
  const h = harness({
    leases: [() => h.grant(A, "access-A"), () => h.grant(B, "access-B")],
    upstream: (s) =>
      s.authorization === "Bearer access-A" ? new Response("{}", { status: 429, headers: QUOTA_HEADERS }) : new Response("done"),
  })
  const res = await h.relay.handle(post("/v1/messages", { n: 1 }))
  expect(res.status).toBe(200)
  expect(await res.text()).toBe("done")
  expect(h.seen.map((s) => s.authorization)).toEqual(["Bearer access-A", "Bearer access-B"])
  // 重放的是同一个请求体。
  expect(h.seen[1].body).toBe(h.seen[0].body)
  expect(h.reports).toEqual([A])
})

// 端到端地钉住整个设计的核心承诺:5 个会话共用一个号、同时撞墙,只换一个号。
test("5 个并发请求同时在 A 上撞额度:只上报一次、只换一次号,5 个都成功", async () => {
  let release!: () => void
  const gate = new Promise<void>((r) => (release = r))
  let arrivedOnA = 0
  const h = harness({
    leaseDelay: 10,
    leases: [() => h.grant(A, "access-A"), () => h.grant(B, "access-B")],
    upstream: async (s) => {
      if (s.authorization === "Bearer access-A") {
        // 等 5 个都到了 A 再一起回 429 —— 保证它们确实是"同时"撞的,而不是一个换完号别的才出发。
        if (++arrivedOnA === 5) release()
        await gate
        return new Response("{}", { status: 429, headers: QUOTA_HEADERS })
      }
      return new Response("done")
    },
  })
  await h.relay.handle(new Request(`${BASE}${RELAY_ROUTES.health}`)) // 不触发租约
  const results = await Promise.all(Array.from({ length: 5 }, (_, i) => h.relay.handle(post("/v1/messages", { i }))))
  expect(results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200])
  expect(h.reports).toEqual([A])
  expect(h.leaseCalls.filter((c) => c.reason === "ratelimit")).toHaveLength(1)
  expect(h.seen.filter((s) => s.authorization === "Bearer access-B")).toHaveLength(5)
})

test("不带配额头的 429 原样交给客户端:不上报、不换号、不重发", async () => {
  const h = harness({ upstream: () => new Response("{}", { status: 429, headers: { "retry-after": "5" } }) })
  const res = await h.relay.handle(post("/v1/messages", {}))
  expect(res.status).toBe(429)
  expect(h.seen).toHaveLength(1)
  expect(h.reports).toEqual([])
})

test("换号失败(池子空了):把原始 429 交给客户端,它会显示自己的额度文案", async () => {
  const h = harness({
    leases: [() => h.grant(A, "access-A"), () => ({ ok: false, failure: { kind: "no-account" } })],
    upstream: () => new Response("{}", { status: 429, headers: QUOTA_HEADERS }),
  })
  const res = await h.relay.handle(post("/v1/messages", {}))
  expect(res.status).toBe(429)
  expect(res.headers.get("anthropic-ratelimit-unified-representative-claim")).toBe("five_hour")
  expect(h.seen).toHaveLength(1)
})

test("401:续期后用新 access 重发", async () => {
  const h = harness({
    leases: [() => h.grant(A, "dead"), () => h.grant(A, "fresh")],
    upstream: (s) => (s.authorization === "Bearer dead" ? new Response("{}", { status: 401 }) : new Response("done")),
  })
  const res = await h.relay.handle(post("/v1/messages", {}))
  expect(res.status).toBe(200)
  expect(h.seen.map((s) => s.authorization)).toEqual(["Bearer dead", "Bearer fresh"])
})

test("手里没有租约且 master 不可达:回 503 让客户端退避重试,不碰上游", async () => {
  const h = harness({ leases: [() => ({ ok: false, failure: { kind: "unreachable", detail: "ECONNREFUSED" } })] })
  const res = await h.relay.handle(post("/v1/messages", {}))
  expect(res.status).toBe(503)
  const body = (await res.json()) as { type: string; error: { message: string } }
  expect(body.type).toBe("error")
  expect(body.error.message).toContain("http://master:8787")
  expect(h.seen).toHaveLength(0)
})

test("池子没号:回不带配额头的 429,客户端直接显示这句话", async () => {
  const h = harness({ leases: [() => ({ ok: false, failure: { kind: "no-account" } })] })
  const res = await h.relay.handle(post("/v1/messages", {}))
  expect(res.status).toBe(429)
  expect(res.headers.get("anthropic-ratelimit-unified-status")).toBeNull()
})

test("上游连不上:502,而不是把异常抛给 Bun", async () => {
  const h = harness({
    upstream: () => {
      throw new Error("getaddrinfo ENOTFOUND api.anthropic.com")
    },
  })
  const res = await h.relay.handle(post("/v1/messages", {}))
  expect(res.status).toBe(502)
})

test("health:报身份与当前号前 8 位,access 绝不出现", async () => {
  const h = harness()
  await h.relay.handle(post("/v1/messages", {}))
  const res = await h.relay.handle(new Request(`${BASE}${RELAY_ROUTES.health}`))
  const text = await res.text()
  const health = JSON.parse(text) as RelayHealth
  expect(health.service).toBe(RELAY_SERVICE)
  expect(health.workerId).toBe("vince-cc")
  expect(health.accountId).toBe("aaaaaaaa")
  expect(text).not.toContain("access-A")
})

test("attach:登记会话、交回共享租约;同一个 pid 重复 attach 不重复计数", async () => {
  const h = harness()
  const first = (await (await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 11 }))).json()) as AttachResponse
  expect(first.ok && first.accountId).toBe(A)
  expect(first.ok && first.access).toBe("access-A")
  await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 11 }))
  const second = (await (await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 12 }))).json()) as AttachResponse
  expect(second.ok && second.sessions).toBe(2)
  // 两个会话拿到的是同一个号 —— 全机共用。
  expect(second.ok && second.accountId).toBe(A)
  expect(h.leaseCalls).toHaveLength(1)
})

test("attach 带点名:把全机共享号切过去", async () => {
  const h = harness({ leases: [() => h.grant(A, "access-A"), () => h.grant(B, "access-B")] })
  await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 11 }))
  const named = (await (await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 12, preferredAccountIdPrefix: "bbbbbbbb", pinned: true }))).json()) as AttachResponse
  expect(named.ok && named.accountId).toBe(B)
  expect(h.leaseCalls[1]).toMatchObject({ preferredAccountIdPrefix: "bbbbbbbb", pinned: true, currentAccountId: A })
  // 之后所有会话的请求都走 B。
  await h.relay.handle(post("/v1/messages", {}))
  expect(h.seen.at(-1)?.authorization).toBe("Bearer access-B")
})

test("attach 失败:如实交回失败,且这个 pid 不留在登记里", async () => {
  const h = harness({ leases: [() => ({ ok: false, failure: { kind: "no-account" } })] })
  const res = (await (await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 11 }))).json()) as AttachResponse
  expect(res.ok).toBe(false)
  expect(!res.ok && res.failure.kind).toBe("no-account")
  expect(h.relay.sessionCount()).toBe(0)
})

test("attach 报文不合法:400", async () => {
  const h = harness()
  expect((await h.relay.handle(post(RELAY_ROUTES.attach, { pid: -1 }))).status).toBe(400)
  expect((await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 1, pinned: "yes" }))).status).toBe(400)
})

test("detach:注销会话", async () => {
  const h = harness()
  await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 11 }))
  expect((await h.relay.handle(post(RELAY_ROUTES.detach, { pid: 11 }))).status).toBe(204)
  expect(h.relay.sessionCount()).toBe(0)
})

test("tick:kill -9 掉的启动器不会来 detach,按进程存活回收", async () => {
  const h = harness({ alive: new Set([11]) })
  await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 11 }))
  await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 12 }))
  expect(h.relay.tick()).toBe("stay")
  expect(h.relay.sessionCount()).toBe(1)
})

test("tick:没有会话且闲置够久才退出", async () => {
  const h = harness()
  await h.relay.handle(post("/v1/messages", {}))
  h.advance(RELAY_IDLE_EXIT_MS - 1)
  expect(h.relay.tick()).toBe("stay")
  h.advance(1)
  expect(h.relay.tick()).toBe("exit")
})

test("tick:有活会话就不退出,不论闲置多久", async () => {
  const h = harness({ alive: new Set([11]) })
  await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 11 }))
  h.advance(RELAY_IDLE_EXIT_MS * 10)
  expect(h.relay.tick()).toBe("stay")
})

test("tick:有会话时顺手续期,不让下一个请求去等 master", async () => {
  const h = harness({ alive: new Set([11]) })
  await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 11 }))
  h.advance(3 * 3600_000 - 60_000)
  h.relay.tick()
  await new Promise((r) => setTimeout(r, 0))
  expect(h.leaseCalls).toHaveLength(2)
  expect(h.leaseCalls[1]).toEqual({ reason: "prelease", currentAccountId: A })
})

test("未知控制路由:404,不转发给上游", async () => {
  const h = harness()
  expect((await h.relay.handle(new Request(`${BASE}/__claude-pool/nope`))).status).toBe(404)
  expect(h.seen).toHaveLength(0)
})

// 回环挡不住本机浏览器里的网页。claude 与启动器从不发 Origin,Host 永远是 127.0.0.1:<端口>。
test("带 Origin 的请求一律 403:浏览器里的网页不能用 relay", async () => {
  const h = harness()
  const res = await h.relay.handle(post("/v1/messages", {}, { origin: "https://evil.example" }))
  expect(res.status).toBe(403)
  const attach = await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 11 }, { origin: "https://evil.example" }))
  expect(attach.status).toBe(403)
  expect(h.seen).toHaveLength(0)
  expect(h.relay.sessionCount()).toBe(0)
})

test("Host 不是 127.0.0.1:<端口>(DNS rebinding)一律 403,access 不会被读走", async () => {
  const h = harness()
  const res = await h.relay.handle(
    new Request("http://evil.example:18787" + RELAY_ROUTES.attach, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ pid: 11 }),
    }),
  )
  expect(res.status).toBe(403)
  expect(await res.text()).not.toContain("access-A")
  expect(h.leaseCalls).toHaveLength(0)
})

test("localhost:<端口> 同样放行", async () => {
  const h = harness()
  const res = await h.relay.handle(new Request("http://localhost:18787" + RELAY_ROUTES.health))
  expect(res.status).toBe(200)
})

// 浏览器的"简单 POST"(text/plain)不经 CORS 预检;要求 JSON 就把它挡在外面。
test("控制面的 POST 不是 application/json:415", async () => {
  const h = harness()
  const res = await h.relay.handle(
    new Request(`${BASE}${RELAY_ROUTES.attach}`, { method: "POST", headers: { "content-type": "text/plain" }, body: JSON.stringify({ pid: 11 }) }),
  )
  expect(res.status).toBe(415)
  expect(h.relay.sessionCount()).toBe(0)
})

test("pid 1 不收:它永远算活着,登记它 relay 就永不退出", async () => {
  const h = harness()
  expect((await h.relay.handle(post(RELAY_ROUTES.attach, { pid: 1 }))).status).toBe(400)
})

// 只有 /v1/messages 上的 401 说明凭证死了;别处的 401 拿去判死凭证,会把整台机器换到别的号上。
test("别的路径上的 401 原样交给客户端,不判死凭证、不续期", async () => {
  const h = harness({ upstream: () => new Response("{}", { status: 401 }) })
  const res = await h.relay.handle(new Request(`${BASE}/api/oauth/profile`))
  expect(res.status).toBe(401)
  expect(h.leaseCalls).toHaveLength(1) // 只有首次 ensure
  expect(h.seen).toHaveLength(1)
})
