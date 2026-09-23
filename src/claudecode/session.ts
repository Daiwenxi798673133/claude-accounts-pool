// One pooled `claude` session, start to finish: guard → relay → attach → spawn → the child's exit code.
//
// THE CREDENTIAL IS NOT DECIDED HERE ANY MORE. Measured on claude 2.1.278 (issue #83): the token a
// Claude Code process resolves at startup is frozen for that process. So the child is pointed at this
// machine's relay (ANTHROPIC_BASE_URL), and the relay swaps that frozen token for the machine's CURRENT
// lease on every request — renewing it before expiry, switching accounts when quota runs out. The
// session never has to be reopened for either.
//
// ONE ACCOUNT PER MACHINE, shared by every session (issue #83 decision). This launcher does not lease
// anything itself: it asks the relay for the shared lease, and gets the same answer every concurrent
// launcher gets. That is the natural limit — a quota wall or an expiry is handled once, by the relay,
// not once per open session.
import type { LeaseFailure } from "../worker/leaseClient.ts"
import type { LeaseRefusal } from "../cloud/protocol.ts"
import { buildChildEnv, POOL_SESSION_SENTINEL, type Blocker } from "./childEnv.ts"
import { applyPinIntent, type PinStore } from "./pin.ts"
import { relayNotices, type RelayClient, type RelayUp } from "./relayClient.ts"

// sysexits codes, not 1-for-everything: the operator's shell (and any wrapper script) can tell
// "this machine is configured wrong, fixing it is on you" apart from "the pool had nothing right
// now, try again later". Both are distinct from whatever the child itself exits with.
export const EXIT_BLOCKED = 78 // EX_CONFIG
export const EXIT_NO_LEASE = 75 // EX_TEMPFAIL

// Deliberately NOT reusing src/worker/manualSwitch.ts's refusal table: that one is worded for an
// operator who pressed enter on a row and is told "未切号" — a sentence that makes no sense to
// someone whose session never started. Same variants, different situation, so same-shaped table,
// different words. Merging them would cost one of the two its remedy.
const REFUSAL_TEXT: Record<LeaseRefusal, string> = {
  unknown: "master 说没有这个账号。账号库可能刚改过,去看板核对后再试。",
  ambiguous: "指定的 id 前缀在账号库里匹配到多个账号,master 拒绝猜。用更长的前缀。",
  cooling: "这个账号额度已满正在冷却。换一个,或等冷却结束。",
  "needs-reauth": "这个账号的刷新链断了,需要在 master 上重新登录一次。",
  "at-capacity": "这个账号已经有足够多的机器在用了,账号池不再往上加人。换一个。",
}

// A table by variant, for the reason stated in CONVENTIONS: each failure has its own remedy, and a
// merged "租约失败" line would throw every one of them away. `unreachable` is the one an operator
// actually hits — it is the master being down — so it says where to look.
export function leaseFailureText(failure: LeaseFailure, masterUrl: string): string {
  switch (failure.kind) {
    case "no-account":
      return "账号池现在没有可用账号(都在冷却或已满员)。稍后再试。"
    case "refused":
      return REFUSAL_TEXT[failure.refused]
    case "unreachable":
      return `连不上 master(${masterUrl}):${failure.detail}。确认它在跑、且这台机器能到它的地址。`
    case "bad-response":
      return `master 的应答看不懂:${failure.detail}。多半是两端版本不一致。`
    // Only a NAMED account can end here: the automatic path steps around a dead token by excluding
    // its account, but a named one may not be swapped for another (usage attribution depends on
    // "what I asked for is what I got").
    case "dead-access":
      return `master 发回的凭证在本机已经被判定失效(账号 ${failure.accountId.slice(0, 8)})。等它在 master 上刷新后再点名,或换一个号。`
  }
}

// 每种 relay 故障一句补救。foreign 是配置问题(换端口),timeout 是本机进程问题(看日志)。
export function relayFailureText(up: Extract<RelayUp, { ok: false }>, port: number, logPath: string): string {
  switch (up.reason) {
    case "foreign":
      return (
        `端口 ${port} 上有别的程序在听(${up.detail}),不是账号池的 relay。` +
        `在 ~/.claude-accounts-pool/senpi-worker.json 里加 "ccRelayPort": <另一个端口>,或设 CAP_CC_RELAY_PORT。`
      )
    case "timeout":
      return `本机 relay 没能按时起来。看它的日志:${logPath}`
  }
}

export function blockerText(blockers: readonly Blocker[]): string {
  const lines = blockers.map((b) => `  · ${b.remedy}`)
  return ["没有启动 claude:这台机器上有优先级更高的凭证,池子租约会被无声忽略。", ...lines].join("\n")
}

export type SessionDeps = {
  relay: RelayClient
  // The relay's own address, handed to the child as ANTHROPIC_BASE_URL.
  relayUrl: string
  relayPort: number
  relayLogPath: string
  // Runs the child and resolves with ITS exit code. Injected rather than imported so a test never
  // spawns a real `claude`, and so the composition root owns the stdio decision (inherit).
  spawn: (input: { argv: readonly string[]; env: NodeJS.ProcessEnv }) => Promise<number>
  env: NodeJS.ProcessEnv
  // The settings that will apply to the child, already parsed; undefined when unreadable. See
  // childEnv.settingsBlockers for why undefined is "unknown" rather than "clean".
  readSettings: () => Promise<unknown>
  // Everything the operator sees before the child takes over the terminal. Goes to stderr in the
  // composition root, so it cannot pollute a piped stdout.
  notify: (line: string) => void
  masterUrl: string
  workerId: string
  // This launcher's pid — what the relay registers. The launcher lives exactly as long as its child.
  pid: number
  // --pool-account / --pool-pin / --pool-unpin on this command line. The prefix switches the MACHINE's
  // shared account; `pinned` true/false sets/clears the pin the relay names on every automatic lease.
  preference: { prefix?: string; pinned?: boolean }
  pin: PinStore
  // Runs `beat` periodically while the child is alive; returns the function that stops it. A relay
  // that crashed mid-session is brought back and this session re-registered by the next beat —
  // otherwise every open session would lose its route to Anthropic until someone started a new one.
  heartbeat: (beat: () => Promise<void>) => () => void
  now?: () => number
}

export async function runPooledSession(deps: SessionDeps, argv: readonly string[]): Promise<number> {
  const now = deps.now ?? Date.now

  // FIRST, before anything with a side effect. A launcher that reached here from inside a session it
  // started is an alias loop (see POOL_SESSION_SENTINEL): every generation would register with the
  // relay and hand the child to a copy of itself. Refusing costs one confusing launch.
  if (deps.env[POOL_SESSION_SENTINEL] === "1") {
    deps.notify(
      "检测到自我调用:本启动器又启动了自己。多半是把 `claude` 别名指到了它。" +
        "别名应当指向真正的 claude 可执行文件,或给启动器设 CLAUDE_BIN 指明它。",
    )
    return EXIT_BLOCKED
  }

  // THE GUARD RUNS BEFORE THE RELAY, and the order is the point: a machine that cannot use a lease
  // should not start a relay that books one out of the pool.
  const settings = await deps.readSettings()
  // relayUrl 也交进去:从一个已经走池子的会话里(比如它的 Bash 工具)再起 claude-pool,环境里继承来的
  // 正是 relay 自己的地址,那不是操作者设的网关。
  const dryRun = buildChildEnv({ env: deps.env, access: "", settings, relayUrl: deps.relayUrl })
  if (!dryRun.ok) {
    deps.notify(blockerText(dryRun.blockers))
    return EXIT_BLOCKED
  }

  const up = await deps.relay.ensureRunning()
  if (!up.ok) {
    deps.notify(relayFailureText(up, deps.relayPort, deps.relayLogPath))
    return up.reason === "foreign" ? EXIT_BLOCKED : EXIT_NO_LEASE
  }
  for (const line of relayNotices(up.health, { workerId: deps.workerId, masterUrl: deps.masterUrl })) {
    deps.notify(`账号池:${line}`)
  }

  // 钉住意图【在守卫与 relay 都通过之后】落盘,且在 attach 之前:被拒绝的启动不该留下一个钉住 ——
  // relay 下一次续期就会把整台机器搬过去;而 attach 被 master 拒绝时,relay 交还的正是这里写下的那个。
  applyPinIntent(deps.pin, { accountPrefix: deps.preference.prefix, pin: deps.preference.pinned })
  const storedPin = deps.pin.read()
  if (deps.preference.prefix !== undefined && deps.preference.pinned !== true && storedPin !== undefined && storedPin !== deps.preference.prefix) {
    deps.notify(`账号池:钉住的 ${storedPin} 仍然有效,下一次续期会切回它。想改钉这个号,加 --pool-pin;想取消钉住,用 --pool-unpin。`)
  }

  const attached = await deps.relay.attach({
    pid: deps.pid,
    ...(deps.preference.prefix === undefined
      ? {}
      : { preferredAccountIdPrefix: deps.preference.prefix, pinned: deps.preference.pinned === true }),
  })
  if (!attached.ok) {
    deps.notify(leaseFailureText(attached.failure, deps.masterUrl))
    return EXIT_NO_LEASE
  }
  const lease = attached.lease

  // FAIL-SAFE, matching the repo's "过期就什么都不写" shape. The relay renews before handing a lease
  // out, so reaching here means its clock and ours disagree — and a child started on a spent token
  // would have its direct-to-Anthropic requests 401 from the first second.
  if (lease.expiresAt <= now()) {
    deps.notify(`relay 交回的租约已经过期(账号 ${lease.accountId.slice(0, 8)})。不启动。`)
    await deps.relay.detach(deps.pid)
    return EXIT_NO_LEASE
  }

  const child = buildChildEnv({ env: deps.env, access: lease.access, relayUrl: deps.relayUrl, settings })
  // Unreachable in practice — the same inputs passed the dry run above — but the type says it can
  // fail, and inventing an `as` to get past that would be the one place this lane could start an
  // unguarded session.
  if (!child.ok) {
    deps.notify(blockerText(child.blockers))
    await deps.relay.detach(deps.pid)
    return EXIT_BLOCKED
  }

  const others = attached.sessions - 1
  if (deps.preference.prefix !== undefined && others > 0) {
    deps.notify(`账号池:已把本机共享账号切到 ${lease.accountId.slice(0, 8)},正在跑的另外 ${others} 个会话从下一个请求起也用它。`)
  }
  deps.notify(
    `账号池:本机共享账号 ${lease.accountId.slice(0, 8)}(本机 ${attached.sessions} 个会话在用)。` +
      "到期自动续期,撞额度自动换号,会话不用重开。",
  )

  // 心跳里的 attach 【不带】点名:点名是这一次命令行的意图,不该每一拍重放一遍 —— 那会把别的会话
  // 之后发起的点名反复切回来。
  const stop = deps.heartbeat(async () => {
    const again = await deps.relay.ensureRunning()
    if (again.ok) await deps.relay.attach({ pid: deps.pid })
  })

  // finally, not sequential: a child that throws (missing executable) must still deregister.
  try {
    return await deps.spawn({ argv, env: child.env })
  } finally {
    stop()
    await deps.relay.detach(deps.pid).catch(() => {})
  }
}
