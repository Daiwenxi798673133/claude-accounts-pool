import { expect, test } from "bun:test"
import { RELAY_ROUTES, RELAY_SERVICE, RELAY_VERSION, type RelayHealth } from "./relay.ts"
import { createRelayClient, relayNotices } from "./relayClient.ts"

const health = (over: Partial<RelayHealth> = {}): RelayHealth => ({
  service: RELAY_SERVICE,
  version: RELAY_VERSION,
  pid: 4242,
  workerId: "vince-cc",
  masterUrl: "http://master:8787",
  sessions: 0,
  ...over,
})

// 假端口:`state` 决定 health 探测看到什么。拉起 relay = 把 state 在 `upAfter` 次探测后翻成 "relay"。
function harness(opts: { initial: "absent" | "relay" | "foreign"; upAfter?: number; neverUp?: boolean }) {
  let state = opts.initial
  let probes = 0
  let spawned = 0
  let now = 0
  const calls: { url: string; body?: unknown }[] = []
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
    if (url.endsWith(RELAY_ROUTES.health)) {
      probes++
      if (spawned > 0 && !opts.neverUp && probes > (opts.upAfter ?? 1)) state = "relay"
      if (state === "absent") throw new Error("ECONNREFUSED")
      if (state === "foreign") return new Response("<html>", { status: 200 })
      return Response.json(health())
    }
    if (url.endsWith(RELAY_ROUTES.attach)) {
      return Response.json({ ok: true, accountId: "aaaaaaaa-0", access: "tok", expiresAt: 99, sessions: 1 })
    }
    return new Response(null, { status: 204 })
  }) as typeof fetch
  const client = createRelayClient({
    fetchImpl,
    baseUrl: "http://127.0.0.1:18787/",
    spawnRelay: () => void spawned++,
    sleep: async (ms) => void (now += ms),
    now: () => now,
    startTimeoutMs: 1_000,
  })
  return { client, calls, spawned: () => spawned }
}

test("relay 已在跑:直接用,不拉起新的", async () => {
  const h = harness({ initial: "relay" })
  const up = await h.client.ensureRunning()
  expect(up.ok && up.spawned).toBe(false)
  expect(h.spawned()).toBe(0)
})

test("relay 不在:拉起一个,轮询到它应答为止", async () => {
  const h = harness({ initial: "absent", upAfter: 3 })
  const up = await h.client.ensureRunning()
  expect(up.ok && up.spawned).toBe(true)
  expect(h.spawned()).toBe(1)
})

// 绝不把租来的凭证发给一个不认识的程序。
test("端口上是别的程序:拒绝,不拉起", async () => {
  const h = harness({ initial: "foreign" })
  const up = await h.client.ensureRunning()
  expect(up.ok).toBe(false)
  expect(!up.ok && up.reason).toBe("foreign")
  expect(h.spawned()).toBe(0)
})

test("拉起了但一直不应答:按时限失败", async () => {
  const h = harness({ initial: "absent", neverUp: true })
  const up = await h.client.ensureRunning()
  expect(!up.ok && up.reason).toBe("timeout")
})

test("attach:报文原样发出,应答翻成租约", async () => {
  const h = harness({ initial: "relay" })
  const out = await h.client.attach({ pid: 7, preferredAccountIdPrefix: "bbbbbbbb", pinned: true })
  expect(out.ok && out.lease.access).toBe("tok")
  const sent = h.calls.find((c) => c.url.endsWith(RELAY_ROUTES.attach))
  expect(sent?.url).toBe(`http://127.0.0.1:18787${RELAY_ROUTES.attach}`)
  expect(sent?.body).toEqual({ pid: 7, preferredAccountIdPrefix: "bbbbbbbb", pinned: true })
})

test("attach 时 relay 不在了:unreachable,而不是抛出", async () => {
  const client = createRelayClient({
    fetchImpl: (async () => {
      throw new Error("ECONNREFUSED")
    }) as unknown as typeof fetch,
    baseUrl: "http://127.0.0.1:1",
    spawnRelay: () => {},
    sleep: async () => {},
    now: () => 0,
  })
  const out = await client.attach({ pid: 1 })
  expect(!out.ok && out.failure.kind).toBe("unreachable")
})

test("版本、配置都对得上:没有提醒", () => {
  expect(relayNotices(health(), { workerId: "vince-cc", masterUrl: "http://master:8787" })).toEqual([])
})

test("旧版本 relay(git pull 之后)与换了配置的 relay 各提醒一句,并说出怎么换新", () => {
  const lines = relayNotices(health({ version: RELAY_VERSION + 1, workerId: "old" }), {
    workerId: "vince-cc",
    masterUrl: "http://master:8787",
  })
  expect(lines).toHaveLength(2)
  for (const line of lines) expect(line).toContain("kill 4242")
})
