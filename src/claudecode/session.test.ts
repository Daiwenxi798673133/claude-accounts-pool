import { expect, test } from "bun:test"
import type { ClaimedLease } from "./claims.ts"
import { CLAUDE_CODE_TOKEN_VAR } from "./childEnv.ts"
import { EXIT_BLOCKED, EXIT_NO_LEASE, horizonText, leaseFailureText, runPooledSession, type SessionDeps } from "./session.ts"

const NOW = 1_700_000_000_000
let released = 0
const okLease = (over: Partial<{ accountId: string; access: string; expiresAt: number }> = {}): ClaimedLease => ({
  ok: true,
  lease: { accountId: "af008f89-1111-2222-3333-444455556666", access: "leased-token", expiresAt: NOW + 3 * 3600_000, ...over },
  release: async () => void released++,
})

type Harness = { deps: SessionDeps; spawned: { argv: readonly string[]; env: NodeJS.ProcessEnv }[]; notices: string[]; leases: number }

function harness(over: Partial<SessionDeps> = {}): Harness {
  const spawned: Harness["spawned"] = []
  const notices: string[] = []
  const h: Harness = {
    spawned,
    notices,
    leases: 0,
    deps: {
      lease: async () => {
        h.leases++
        return okLease()
      },
      spawn: async (input) => {
        spawned.push(input)
        return 0
      },
      env: { PATH: "/usr/bin" },
      readSettings: async () => ({}),
      notify: (line) => notices.push(line),
      masterUrl: "http://master:8787",
      now: () => NOW,
      ...over,
    },
  }
  return h
}

test("顺利路径:租约注入子进程,argv 原样透传,返回子进程退出码", async () => {
  const h = harness({ spawn: async (input) => (h.spawned.push(input), 42) })
  const code = await runPooledSession(h.deps, ["-p", "hello"])
  expect(code).toBe(42)
  expect(h.spawned).toHaveLength(1)
  expect(h.spawned[0].argv).toEqual(["-p", "hello"])
  expect(h.spawned[0].env[CLAUDE_CODE_TOKEN_VAR]).toBe("leased-token")
})

test("会话开始前告诉操作者:租到哪个号、还能活多久、中途不换号", async () => {
  const h = harness()
  await runPooledSession(h.deps, [])
  const notice = h.notices.join("\n")
  expect(notice).toContain("af008f89")
  expect(notice).toContain("3h00m")
  expect(notice).toContain("中途不会换号")
  // 账号 id 只出前 8 位十六进制 —— 与看板、日志、删号回执三处对齐。
  expect(notice).not.toContain("444455556666")
})

// 守卫必须跑在租约之前:一台用不了租约的机器不该先把账号从池子里占走。
test("环境里有更高优先级凭证时,拒绝启动,而且一次租约都不发", async () => {
  const h = harness({ env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-api03-x" } })
  const code = await runPooledSession(h.deps, [])
  expect(code).toBe(EXIT_BLOCKED)
  expect(h.leases).toBe(0)
  expect(h.spawned).toEqual([])
  expect(h.notices.join("\n")).toContain("unset ANTHROPIC_API_KEY")
})

test("settings 里有 apiKeyHelper 时同样拒绝,同样不发租约", async () => {
  const h = harness({ readSettings: async () => ({ apiKeyHelper: "/bin/tok" }) })
  const code = await runPooledSession(h.deps, [])
  expect(code).toBe(EXIT_BLOCKED)
  expect(h.leases).toBe(0)
})

test("租不到号:报出该变体自己的补救建议,不启动", async () => {
  const h = harness({ lease: async () => ({ ok: false, reason: "lease-failed", failure: { kind: "unreachable", detail: "ECONNREFUSED" } }) })
  const code = await runPooledSession(h.deps, [])
  expect(code).toBe(EXIT_NO_LEASE)
  expect(h.spawned).toEqual([])
  expect(h.notices.join("\n")).toContain("http://master:8787")
  expect(h.notices.join("\n")).toContain("ECONNREFUSED")
})

// 「过期就什么都不写」的全仓 fail-safe 形状:这里的等价物是「过期就不启动」。
test("master 发回已过期的租约时拒绝启动,而不是起一个立刻 401 的会话", async () => {
  const h = harness({ lease: async () => okLease({ expiresAt: NOW - 1 }) })
  const code = await runPooledSession(h.deps, [])
  expect(code).toBe(EXIT_NO_LEASE)
  expect(h.spawned).toEqual([])
  expect(h.notices.join("\n")).toContain("时钟")
})

test("每个租约失败变体都有自己的文案,没有共用的兜底句", () => {
  const texts = [
    leaseFailureText({ kind: "no-account" }, "m"),
    leaseFailureText({ kind: "refused", refused: "cooling" }, "m"),
    leaseFailureText({ kind: "refused", refused: "at-capacity" }, "m"),
    leaseFailureText({ kind: "unreachable", detail: "x" }, "m"),
    leaseFailureText({ kind: "bad-response", detail: "x" }, "m"),
  ]
  expect(new Set(texts).size).toBe(texts.length)
})

test("剩余时长按小时/分钟分档", () => {
  expect(horizonText(NOW + 3 * 3600_000 + 7 * 60_000, NOW)).toBe("3h07m")
  expect(horizonText(NOW + 45 * 60_000, NOW)).toBe("45m")
  expect(horizonText(NOW - 1, NOW)).toBe("已过期")
})

// 别名递归:人一定会把 `claude` 指到这个启动器,PATH 解析会让它无限 spawn 自己,
// 每一代都占着一个永远用不上的租约。
test("从自己启动的会话里再次被调用时立刻拒绝,不租号也不 spawn", async () => {
  const h = harness({ env: { PATH: "/usr/bin", CLAUDE_ACCOUNTS_POOL_SESSION: "1" } })
  const code = await runPooledSession(h.deps, [])
  expect(code).toBe(EXIT_BLOCKED)
  expect(h.leases).toBe(0)
  expect(h.spawned).toEqual([])
  expect(h.notices.join("\n")).toContain("别名")
})

test("子进程环境带上哨兵,下一代才认得出自己在环里", async () => {
  const h = harness()
  await runPooledSession(h.deps, [])
  expect(h.spawned[0].env.CLAUDE_ACCOUNTS_POOL_SESSION).toBe("1")
})

test("限流上报钩子经 --settings 挂到子进程上,账号 id 随环境送进去", async () => {
  const h = harness({ hookPath: "/opt/pool/claude-pool-hook.ts" })
  await runPooledSession(h.deps, ["-p", "x"])
  const settingsIndex = h.spawned[0].argv.indexOf("--settings")
  expect(settingsIndex).toBe(0)
  expect(h.spawned[0].argv[settingsIndex + 1]).toContain("claude-pool-hook.ts")
  expect(h.spawned[0].argv.slice(2)).toEqual(["-p", "x"])
  // 钩子是另一个进程,报文里又没有账号信息,所以这是它认得出「这轮是哪个号撞的墙」的唯一途径。
  expect(h.spawned[0].env.CLAUDE_ACCOUNTS_POOL_ACCOUNT).toBe("af008f89-1111-2222-3333-444455556666")
})

// 挂不上不该拦住启动:少的是给别的机器看的遥测,这次会话照常能跑。
test("操作者自己传了 --settings:照常启动,但说清楚代价", async () => {
  const h = harness({ hookPath: "/opt/pool/claude-pool-hook.ts" })
  const code = await runPooledSession(h.deps, ["--settings", "/my/own.json"])
  expect(code).toBe(0)
  expect(h.spawned[0].argv).toEqual(["--settings", "/my/own.json"])
  expect(h.notices.join("\n")).toContain("限流")
})

test("找不到钩子脚本时照常启动", async () => {
  const h = harness({ hookPath: undefined })
  expect(await runPooledSession(h.deps, ["-p", "x"])).toBe(0)
  expect(h.spawned[0].argv).toEqual(["-p", "x"])
})

// 钩子必须用【发出这次租约的那个标签】上报,否则 master 收到的是一个并不持有该账号的身份 ——
// 它的持有者账本按 workerId 键,对不上就等于在给别人记账。
test("会话的 workerId(带槽位号)随环境送给钩子", async () => {
  const h = harness({ workerId: "vince-cc.2", hookPath: "/opt/pool/hook.ts" })
  await runPooledSession(h.deps, [])
  expect(h.spawned[0].env.CLAUDE_ACCOUNTS_POOL_WORKER).toBe("vince-cc.2")
})

// 声明活到子进程结束为止,一秒都不多 —— 多出来的每一秒都是别的会话被无谓排除的一秒。
test("子进程退出后归还账号声明", async () => {
  released = 0
  const h = harness()
  await runPooledSession(h.deps, [])
  expect(released).toBe(1)
})

test("子进程抛错(比如 claude 不存在)也要归还声明", async () => {
  released = 0
  const h = harness({ spawn: async () => { throw new Error("ENOENT") } })
  await expect(runPooledSession(h.deps, [])).rejects.toThrow("ENOENT")
  expect(released).toBe(1)
})

test("守卫拦下时没有租约,也就没有声明要还", async () => {
  released = 0
  const h = harness({ env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "k" } })
  await runPooledSession(h.deps, [])
  expect(released).toBe(0)
})

test("声明层的三种失败各有各的文案", async () => {
  const texts = new Set<string>()
  for (const lease of [
    async () => ({ ok: false, reason: "lock-unavailable" }) as ClaimedLease,
    async () => ({ ok: false, reason: "at-capacity", held: 2 }) as ClaimedLease,
    async () => ({ ok: false, reason: "lease-failed", failure: { kind: "no-account" } }) as ClaimedLease,
  ]) {
    const h = harness({ lease })
    await runPooledSession(h.deps, [])
    texts.add(h.notices.join("\n"))
  }
  expect(texts.size).toBe(3)
})
