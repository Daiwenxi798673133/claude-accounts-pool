import { expect, test } from "bun:test"
import { RELAY_SERVICE, RELAY_VERSION, type AttachRequest } from "./relay.ts"
import type { AttachOutcome, RelayClient, RelayUp } from "./relayClient.ts"
import { launcherEnv, shellExports, type LauncherEnvDeps } from "./launcherEnv.ts"

const NOW = 1_700_000_000_000
const RELAY = "http://127.0.0.1:18787"
const UP: RelayUp = {
  ok: true,
  spawned: false,
  health: { service: RELAY_SERVICE, version: RELAY_VERSION, pid: 1, workerId: "w", masterUrl: "http://m", sessions: 0 },
}

function harness(over: Partial<LauncherEnvDeps> & { up?: RelayUp; attach?: AttachOutcome } = {}) {
  const attaches: AttachRequest[] = []
  let ensures = 0
  const relay: RelayClient = {
    ensureRunning: async () => (ensures++, over.up ?? UP),
    attach: async (input) => (
      attaches.push(input),
      over.attach ?? { ok: true, lease: { accountId: "af008f89-1111", access: "pool-token", expiresAt: NOW + 3_600_000 }, sessions: 1 }
    ),
    detach: async () => {},
  }
  const { up: _up, attach: _attach, ...rest } = over
  const deps: LauncherEnvDeps = {
    installed: () => true,
    config: { masterUrl: "http://m", workerId: "w", relayPort: 18787 },
    env: { PATH: "/usr/bin", HOME: "/h" },
    readSettings: async () => ({}),
    relay,
    relayUrl: RELAY,
    relayLogPath: "/h/.claude-accounts-pool/cc-relay.log",
    pid: 4321,
    repoDir: "/repo",
    now: () => NOW,
    ...rest,
  }
  return { deps, attaches, ensures: () => ensures }
}

test("注入:base URL 指向 relay、带上当前共享租约,且只输出变了的变量", async () => {
  const h = harness()
  const out = await launcherEnv(h.deps)
  expect(out.kind).toBe("inject")
  if (out.kind !== "inject") return
  expect(out.vars).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "pool-token", ANTHROPIC_BASE_URL: RELAY, ENABLE_TOOL_SEARCH: "true" })
})

// exec 不换 pid:登记的就是随后那个 claude 进程本身,它退出后 relay 按存活回收。
test("用启动器的 pid 登记", async () => {
  const h = harness()
  await launcherEnv(h.deps)
  expect(h.attaches).toEqual([{ pid: 4321 }])
})

// 启动器契约:会被 Claude Code 嵌套调用。
test("嵌套调用:继承来的 relay 地址是自己的,不拒绝;旧 token 换成当前的", async () => {
  const h = harness({ env: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: RELAY, CLAUDE_CODE_OAUTH_TOKEN: "stale", ENABLE_TOOL_SEARCH: "true" } })
  const out = await launcherEnv(h.deps)
  expect(out.kind === "inject" && out.vars).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "pool-token" })
})

// 启动器被嵌套调用是常态;哨兵只属于 claude-pool 那条防别名递归的路径。
test("不置自我调用哨兵", async () => {
  const out = await launcherEnv(harness().deps)
  expect(out.kind === "inject" && "CLAUDE_ACCOUNTS_POOL_SESSION" in out.vars).toBe(false)
})

// 撤回之后,还没重启的会话与后台服务仍指着这个启动器 —— 它们该拿到原生 Claude Code。
test("接管已撤回(清单不在):原样放行,不碰 relay", async () => {
  const h = harness({ installed: () => false })
  expect(await launcherEnv(h.deps)).toEqual({ kind: "passthrough" })
  expect(h.ensures()).toBe(0)
})

test("更高优先级的凭证在场:拒绝,并告诉操作者怎么一键退回", async () => {
  const h = harness({ env: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-x" } })
  const out = await launcherEnv(h.deps)
  expect(out.kind).toBe("refuse")
  if (out.kind !== "refuse") return
  expect(out.code).toBe(78)
  expect(out.message).toContain("unset ANTHROPIC_API_KEY")
  expect(out.message).toContain("cd /repo && make revert")
  expect(h.ensures()).toBe(0)
})

test("操作者自己的网关地址仍然拒绝", async () => {
  const out = await launcherEnv(harness({ env: { PATH: "/usr/bin", ANTHROPIC_BASE_URL: "http://gw" } }).deps)
  expect(out.kind === "refuse" && out.code).toBe(78)
})

// 放行 = 钱记在操作者自己的号上且无从察觉。所以拒绝。
test("领不到租约:拒绝,绝不放行成操作者自己的号", async () => {
  const out = await launcherEnv(harness({ attach: { ok: false, failure: { kind: "unreachable", detail: "ECONNREFUSED" } } }).deps)
  expect(out.kind).toBe("refuse")
  expect(out.kind === "refuse" && out.code).toBe(75)
  expect(out.kind === "refuse" && out.message).toContain("make revert")
})

test("relay 起不来:拒绝", async () => {
  const out = await launcherEnv(harness({ up: { ok: false, reason: "timeout" } }).deps)
  expect(out.kind === "refuse" && out.message).toContain("cc-relay.log")
})

test("池子配置不见了:拒绝,指向 make setup", async () => {
  const out = await launcherEnv(harness({ config: undefined }).deps)
  expect(out.kind === "refuse" && out.message).toContain("make setup")
})

test("export 语句:单引号正确转义,可被 sh eval 还原", async () => {
  const text = shellExports({ A: "plain", B: "it's $HOME `x`" })
  expect(text).toBe(`export A='plain'\nexport B='it'\\''s $HOME \`x\`'`)
  const proc = Bun.spawn(["sh", "-c", `${text}\nprintf '%s' "$B"`], { stdout: "pipe" })
  expect(await new Response(proc.stdout).text()).toBe("it's $HOME `x`")
})

test("export 名字不合法:抛出,不进 eval", () => {
  expect(() => shellExports({ "A;rm -rf /": "x" })).toThrow()
})
