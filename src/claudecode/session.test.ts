import { expect, test } from "bun:test"
import { CLAUDE_CODE_TOKEN_VAR, RELAY_URL_VAR } from "./childEnv.ts"
import { RELAY_SERVICE, RELAY_VERSION, type AttachRequest } from "./relay.ts"
import type { AttachOutcome, RelayClient, RelayUp } from "./relayClient.ts"
import { EXIT_BLOCKED, EXIT_NO_LEASE, leaseFailureText, relayFailureText, runPooledSession, type SessionDeps } from "./session.ts"

const NOW = 1_700_000_000_000
const ACCOUNT = "af008f89-1111-2222-3333-444455556666"
const UP: RelayUp = {
  ok: true,
  spawned: false,
  health: { service: RELAY_SERVICE, version: RELAY_VERSION, pid: 4242, workerId: "vince-cc", masterUrl: "http://master:8787", sessions: 0 },
}
const attachedOk = (over: Partial<{ accountId: string; access: string; expiresAt: number; sessions: number }> = {}): AttachOutcome => ({
  ok: true,
  lease: { accountId: over.accountId ?? ACCOUNT, access: over.access ?? "shared-token", expiresAt: over.expiresAt ?? NOW + 3 * 3600_000 },
  sessions: over.sessions ?? 1,
})

type Harness = {
  pinValue: () => string | undefined
  deps: SessionDeps
  spawned: { argv: readonly string[]; env: NodeJS.ProcessEnv }[]
  notices: string[]
  attaches: AttachRequest[]
  detaches: number[]
  ensures: number
  beats: (() => Promise<void>)[]
  stopped: number
}

function harness(
  over: Partial<SessionDeps> & { up?: RelayUp; attach?: (input: AttachRequest) => AttachOutcome; storedPin?: string } = {},
): Harness {
  let pinned = over.storedPin
  const h: Harness = {
    spawned: [],
    notices: [],
    attaches: [],
    detaches: [],
    ensures: 0,
    beats: [],
    stopped: 0,
    pinValue: () => pinned,
    deps: undefined as never,
  }
  const relay: RelayClient = {
    ensureRunning: async () => (h.ensures++, over.up ?? UP),
    attach: async (input) => (h.attaches.push(input), (over.attach ?? (() => attachedOk()))(input)),
    detach: async (pid) => void h.detaches.push(pid),
  }
  const { up: _up, attach: _attach, storedPin: _storedPin, ...rest } = over
  h.deps = {
    relay,
    relayUrl: "http://127.0.0.1:18787",
    relayPort: 18787,
    relayLogPath: "/box/cc-relay.log",
    spawn: async (input) => (h.spawned.push(input), 0),
    env: { PATH: "/usr/bin" },
    readSettings: async () => ({}),
    notify: (line) => h.notices.push(line),
    masterUrl: "http://master:8787",
    workerId: "vince-cc",
    pid: 777,
    preference: {},
    pin: { read: () => pinned, write: (next) => void (pinned = next) },
    heartbeat: (beat) => {
      h.beats.push(beat)
      return () => void h.stopped++
    },
    now: () => NOW,
    ...rest,
  }
  return h
}

test("顺利路径:子进程指向 relay、带着共享租约启动,argv 原样透传,返回子进程退出码", async () => {
  const h = harness({ spawn: async (input) => (h.spawned.push(input), 42) })
  const code = await runPooledSession(h.deps, ["-p", "hello"])
  expect(code).toBe(42)
  expect(h.spawned).toHaveLength(1)
  // 不再往 argv 里塞任何东西(限流钩子已经由 relay 取代)。
  expect(h.spawned[0].argv).toEqual(["-p", "hello"])
  expect(h.spawned[0].env[RELAY_URL_VAR]).toBe("http://127.0.0.1:18787")
  expect(h.spawned[0].env[CLAUDE_CODE_TOKEN_VAR]).toBe("shared-token")
})

test("用这个启动器的 pid 登记,子进程退出后注销", async () => {
  const h = harness()
  await runPooledSession(h.deps, [])
  expect(h.attaches[0]).toEqual({ pid: 777 })
  expect(h.detaches).toEqual([777])
})

test("会话开始前告诉操作者:共享哪个号、几个会话在用、不用重开", async () => {
  const h = harness({ attach: () => attachedOk({ sessions: 3 }) })
  await runPooledSession(h.deps, [])
  const notice = h.notices.join("\n")
  expect(notice).toContain("af008f89")
  expect(notice).toContain("3 个会话")
  expect(notice).toContain("不用重开")
  // 账号 id 只出前 8 位十六进制 —— 与看板、日志、删号回执三处对齐。
  expect(notice).not.toContain("444455556666")
})

test("--pool-account:attach 带点名,且告诉操作者别的会话也跟着换了", async () => {
  const h = harness({ preference: { prefix: "af008f89", pinned: true }, attach: () => attachedOk({ sessions: 3 }) })
  await runPooledSession(h.deps, [])
  expect(h.attaches[0]).toEqual({ pid: 777, preferredAccountIdPrefix: "af008f89", pinned: true })
  expect(h.notices.join("\n")).toContain("另外 2 个会话")
})

// 守卫必须跑在 relay 之前:一台用不了租约的机器不该拉起一个会去占号的 relay。
test("环境里有更高优先级凭证时,拒绝启动,而且连 relay 都不碰", async () => {
  const h = harness({ env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-api03-x" } })
  const code = await runPooledSession(h.deps, [])
  expect(code).toBe(EXIT_BLOCKED)
  expect(h.ensures).toBe(0)
  expect(h.attaches).toEqual([])
  expect(h.spawned).toEqual([])
  expect(h.notices.join("\n")).toContain("unset ANTHROPIC_API_KEY")
})

test("操作者自己设了 ANTHROPIC_BASE_URL:拒绝,而不是静默盖掉", async () => {
  const h = harness({ env: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "http://gw" } })
  expect(await runPooledSession(h.deps, [])).toBe(EXIT_BLOCKED)
  expect(h.ensures).toBe(0)
})

test("settings 里有 apiKeyHelper 时同样拒绝", async () => {
  const h = harness({ readSettings: async () => ({ apiKeyHelper: "/bin/tok" }) })
  expect(await runPooledSession(h.deps, [])).toBe(EXIT_BLOCKED)
  expect(h.ensures).toBe(0)
})

test("端口被别的程序占着:78,说出怎么换端口", async () => {
  const h = harness({ up: { ok: false, reason: "foreign", detail: "HTTP 200" } })
  expect(await runPooledSession(h.deps, [])).toBe(EXIT_BLOCKED)
  expect(h.notices.join("\n")).toContain("ccRelayPort")
  expect(h.spawned).toEqual([])
})

test("relay 起不来:75,指向它的日志", async () => {
  const h = harness({ up: { ok: false, reason: "timeout" } })
  expect(await runPooledSession(h.deps, [])).toBe(EXIT_NO_LEASE)
  expect(h.notices.join("\n")).toContain("/box/cc-relay.log")
})

test("relay 是旧版本:照常启动,但提醒一句", async () => {
  const h = harness({ up: { ...UP, health: { ...UP.health, version: RELAY_VERSION + 1 } } as RelayUp })
  expect(await runPooledSession(h.deps, [])).toBe(0)
  expect(h.notices.join("\n")).toContain("另一个版本")
})

test("租不到号:报出该变体自己的补救建议,不启动", async () => {
  const h = harness({ attach: () => ({ ok: false, failure: { kind: "unreachable", detail: "ECONNREFUSED" } }) })
  const code = await runPooledSession(h.deps, [])
  expect(code).toBe(EXIT_NO_LEASE)
  expect(h.spawned).toEqual([])
  expect(h.notices.join("\n")).toContain("http://master:8787")
  expect(h.notices.join("\n")).toContain("ECONNREFUSED")
})

test("点名的号被拒:如实说出原因,不启动", async () => {
  const h = harness({ preference: { prefix: "af008f89" }, attach: () => ({ ok: false, failure: { kind: "refused", refused: "cooling" } }) })
  expect(await runPooledSession(h.deps, [])).toBe(EXIT_NO_LEASE)
  expect(h.notices.join("\n")).toContain("冷却")
})

// 「过期就什么都不写」的全仓 fail-safe 形状:这里的等价物是「过期就不启动」。
test("relay 交回已过期的租约时拒绝启动,并注销登记", async () => {
  const h = harness({ attach: () => attachedOk({ expiresAt: NOW - 1 }) })
  expect(await runPooledSession(h.deps, [])).toBe(EXIT_NO_LEASE)
  expect(h.spawned).toEqual([])
  expect(h.detaches).toEqual([777])
})

test("每个失败变体都有自己的文案,没有共用的兜底句", () => {
  const texts = [
    leaseFailureText({ kind: "no-account" }, "m"),
    leaseFailureText({ kind: "refused", refused: "cooling" }, "m"),
    leaseFailureText({ kind: "refused", refused: "at-capacity" }, "m"),
    leaseFailureText({ kind: "unreachable", detail: "x" }, "m"),
    leaseFailureText({ kind: "bad-response", detail: "x" }, "m"),
    leaseFailureText({ kind: "dead-access", accountId: ACCOUNT }, "m"),
  ]
  expect(new Set(texts).size).toBe(texts.length)
  expect(relayFailureText({ ok: false, reason: "foreign", detail: "x" }, 1, "l")).not.toBe(
    relayFailureText({ ok: false, reason: "timeout" }, 1, "l"),
  )
})

// 别名递归:人一定会把 `claude` 指到这个启动器,PATH 解析会让它无限 spawn 自己。
test("从自己启动的会话里再次被调用时立刻拒绝,不碰 relay 也不 spawn", async () => {
  const h = harness({ env: { PATH: "/usr/bin", CLAUDE_ACCOUNTS_POOL_SESSION: "1" } })
  expect(await runPooledSession(h.deps, [])).toBe(EXIT_BLOCKED)
  expect(h.ensures).toBe(0)
  expect(h.spawned).toEqual([])
  expect(h.notices.join("\n")).toContain("别名")
})

test("子进程环境带上哨兵,下一代才认得出自己在环里", async () => {
  const h = harness()
  await runPooledSession(h.deps, [])
  expect(h.spawned[0].env.CLAUDE_ACCOUNTS_POOL_SESSION).toBe("1")
})

// relay 在会话中途崩了,下一拍把它拉起来、把这个会话重新登记回去。
test("心跳:确认 relay 还在并重新登记,且【不带】点名", async () => {
  const h = harness({ preference: { prefix: "af008f89", pinned: false } })
  await runPooledSession(h.deps, [])
  expect(h.beats).toHaveLength(1)
  await h.beats[0]()
  expect(h.ensures).toBe(2)
  expect(h.attaches.at(-1)).toEqual({ pid: 777 })
})

test("子进程退出后停掉心跳", async () => {
  const h = harness()
  await runPooledSession(h.deps, [])
  expect(h.stopped).toBe(1)
})

test("子进程抛错(比如 claude 不存在)也要停心跳、注销登记", async () => {
  const h = harness({
    spawn: async () => {
      throw new Error("ENOENT")
    },
  })
  await expect(runPooledSession(h.deps, [])).rejects.toThrow("ENOENT")
  expect(h.stopped).toBe(1)
  expect(h.detaches).toEqual([777])
})

// 被拒绝的启动不该留下钉住:relay 下一次续期就会按它把整台机器搬过去。
test("守卫拦下的启动不落盘钉住", async () => {
  const h = harness({ env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k" }, preference: { prefix: "af008f89", pinned: true } })
  await runPooledSession(h.deps, [])
  expect(h.pinValue()).toBeUndefined()
})

test("relay 起不来的启动也不落盘钉住", async () => {
  const h = harness({ up: { ok: false, reason: "timeout" }, preference: { prefix: "af008f89", pinned: true } })
  await runPooledSession(h.deps, [])
  expect(h.pinValue()).toBeUndefined()
})

test("--pool-pin 在 attach 之前落盘(relay 被拒时交还的正是它)", async () => {
  let seenAtAttach: string | undefined
  const h = harness({ preference: { prefix: "af008f89", pinned: true }, attach: () => ((seenAtAttach = h.pinValue()), attachedOk()) })
  await runPooledSession(h.deps, [])
  expect(seenAtAttach).toBe("af008f89")
})

test("--pool-unpin 清掉钉住", async () => {
  const h = harness({ storedPin: "af008f89", preference: { pinned: false } })
  await runPooledSession(h.deps, [])
  expect(h.pinValue()).toBeUndefined()
})

// 钉住是机器级的:一次性点名只撑到下一次续期,不说出来操作者会以为号被莫名切回去了。
test("一次性点名而另一个号仍钉着:提醒下一次续期会切回去", async () => {
  const h = harness({ storedPin: "eaaa1a79", preference: { prefix: "af008f89" } })
  await runPooledSession(h.deps, [])
  expect(h.pinValue()).toBe("eaaa1a79")
  expect(h.notices.join("\n")).toContain("钉住的 eaaa1a79 仍然有效")
})
