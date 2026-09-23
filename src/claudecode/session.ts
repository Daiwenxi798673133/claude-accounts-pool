// One pooled `claude` session, start to finish: lease → guard → spawn → the child's exit code.
//
// WHY THERE IS NO RENEWAL LOOP HERE, and why that is not an omission. Measured on claude 2.1.278
// (issue #83): the credential a Claude Code process resolves at startup is FROZEN for that process.
// Rewriting settings.json mid-session — rename or in-place, headless or interactive — leaves the next
// request carrying the token the process started with, and even a 401 does not make it re-read. So a
// session's account is decided exactly once, here, before the child exists. Rotation happens at
// session boundaries or not at all.
//
// The cost is stated to the operator up front rather than discovered at hour four: a lease's horizon
// is bounded by MASTER_REFRESH_THRESHOLD_MS, so a session outliving it dies on a 401 that nothing in
// this lane can heal. Printing the remaining time is the only honest thing available.
import type { LeaseFailure } from "../worker/leaseClient.ts"
import type { ClaimedLease } from "./claims.ts"
import type { LeaseRefusal } from "../cloud/protocol.ts"
import { buildChildEnv, POOL_SESSION_SENTINEL, type Blocker } from "./childEnv.ts"
import { printModeNotice, withHookSettings } from "./hookSettings.ts"

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
    // NEVER PRODUCED BY THIS LANE — the dead-access guard belongs to senpi's renewal loop, which has
    // a previous 401 to compare against. Handled anyway because the union is exhaustive by design:
    // a variant added to LeaseFailure must become a compile error here, not a silent fallthrough.
    case "dead-access":
      return `master 发回的凭证在本机已经被判定失效(账号 ${failure.accountId.slice(0, 8)})。这不该出现在这条链上,请附日志开 issue。`
  }
}

// 声明层的失败与租约层的失败分开成文案,理由与全仓其它按变体建的表一致:三种失败的补救动作
// 完全不同 —— 等一会、关掉一个会话、去看 master —— 合并成一句"租不到号"就把它们全丢了。
export function claimedLeaseText(result: Extract<ClaimedLease, { ok: false }>, masterUrl: string): string {
  switch (result.reason) {
    case "lock-unavailable":
      return "拿不到本机的账号声明锁(另一个会话正在启动,或上一个崩在了临界区里)。稍等几秒重试。"
    case "at-capacity":
      return `这台机器已经有 ${result.held} 个池子会话在跑,到上限了。关掉一个,或调大 ccSlots。`
    case "lease-failed":
      return leaseFailureText(result.failure, masterUrl)
  }
}

export function blockerText(blockers: readonly Blocker[]): string {
  const lines = blockers.map((b) => `  · ${b.remedy}`)
  return ["没有启动 claude:这台机器上有优先级更高的凭证,池子租约会被无声忽略。", ...lines].join("\n")
}

/** 剩余有效期,给操作者一个「这个会话能活多久」的数字。 */
export function horizonText(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return "已过期"
  const minutes = Math.floor(ms / 60_000)
  return minutes >= 60 ? `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m` : `${minutes}m`
}

export type SessionDeps = {
  // 领租约,并把"本机已占哪些号"的排除集与声明写在同一个临界区里(见 claims.ts)。返回的 release
  // 由本模块在子进程退出后调用 —— 租约的生命周期与会话的生命周期是同一件事,所以它归这里管。
  lease: () => Promise<ClaimedLease>
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
  // 本次会话的 workerId(带槽位号)。随环境交给钩子,让限流上报用的是发出这次租约的那个标签。
  workerId?: string
  // 限流上报钩子脚本的绝对路径,undefined 表示这次不挂(找不到脚本,或操作者自己传了 --settings)。
  hookPath?: string
  now?: () => number
}

export async function runPooledSession(deps: SessionDeps, argv: readonly string[]): Promise<number> {
  const now = deps.now ?? Date.now

  // FIRST, before anything with a side effect. A launcher that reached here from inside a session it
  // started is an alias loop (see POOL_SESSION_SENTINEL): every generation would lease an account and
  // hand it to a child that does the same. Refusing costs one confusing launch; not refusing costs the
  // pool every account it has.
  if (deps.env[POOL_SESSION_SENTINEL] === "1") {
    deps.notify(
      "检测到自我调用:本启动器又启动了自己。多半是把 `claude` 别名指到了它。" +
        "别名应当指向真正的 claude 可执行文件,或给启动器设 CLAUDE_BIN 指明它。",
    )
    return EXIT_BLOCKED
  }

  // THE GUARD RUNS BEFORE THE LEASE, and the order is the point: a machine that cannot use a lease
  // should not book one out of the pool. Leasing first would take an account away from a worker that
  // could have used it, then refuse to start anyway.
  const settings = await deps.readSettings()
  const dryRun = buildChildEnv({ env: deps.env, access: "", settings })
  if (!dryRun.ok) {
    deps.notify(blockerText(dryRun.blockers))
    return EXIT_BLOCKED
  }

  const claimed = await deps.lease()
  if (!claimed.ok) {
    deps.notify(claimedLeaseText(claimed, deps.masterUrl))
    return EXIT_NO_LEASE
  }
  const lease = claimed.lease

  // FAIL-SAFE, matching the repo's "过期就什么都不写" shape. The master will not serve a spent
  // horizon, so reaching here means something is wrong between the two clocks — and starting a
  // session on it would burn the operator's turn on a credential that 401s immediately.
  const remaining = lease.expiresAt - now()
  if (remaining <= 0) {
    deps.notify(`master 发回的租约已经过期(账号 ${lease.accountId.slice(0, 8)})。不启动。两端时钟可能不同步。`)
    await claimed.release()
    return EXIT_NO_LEASE
  }

  const child = buildChildEnv({
    env: deps.env,
    access: lease.access,
    accountId: lease.accountId,
    workerId: deps.workerId,
    settings,
  })
  // Unreachable in practice — the same inputs passed the dry run above — but the type says it can
  // fail, and inventing an `as` to get past that would be the one place this lane could start an
  // unguarded session.
  if (!child.ok) {
    deps.notify(blockerText(child.blockers))
    await claimed.release()
    return EXIT_BLOCKED
  }

  deps.notify(
    `账号池:已租到 ${lease.accountId.slice(0, 8)},本次会话凭证有效期 ${horizonText(lease.expiresAt, now())}。` +
      "会话中途不会换号,到期后需要重开。",
  )

  // 限流上报钩子。挂不上不是失败:少的是给【别的机器】看的遥测,这一次会话照常能跑。所以只说一句,
  // 不拦启动 —— 反过来(为了一条遥测拒绝启动)才是本末倒置。
  const hooked = withHookSettings(argv, deps.hookPath)
  if (hooked.skipped !== undefined) deps.notify(`账号池:${hooked.skipped}`)
  else {
    const printNotice = printModeNotice(argv)
    if (printNotice !== undefined) deps.notify(`账号池:${printNotice}`)
  }

  // 声明活到子进程结束为止,一秒都不多 —— 多出来的每一秒都是别的会话被无谓排除的一秒。
  // finally 而不是顺序执行:子进程抛错(可执行文件不存在之类)同样要还回声明。
  try {
    return await deps.spawn({ argv: hooked.argv, env: child.env })
  } finally {
    await claimed.release().catch(() => {})
  }
}
