// GATE 0 / EXPERIMENT 2 — cross-expiry refresh OWNERSHIP.
//
// Questions: (a) is Anthropic's refresh token single-use / rotating? (b) does a master's refresh
// INVALIDATE an access token already in flight on a worker? (c) can the pre-refresh token be
// replayed? Together these decide whether refreshing MUST be centralised on one master.
//
// Owner-run diagnostic, NOT a test. It CONSUMES AND ROTATES a real refresh token, so every
// network call is gated behind --yes. READ-ONLY on local credential files, but it CANNOT be
// read-only server-side — rotating the chain IS the measurement — hence: sacrificial accounts
// only, and the target must be re-logged-in afterwards.
//
//   bun scripts/gate0-refresh-ownership.ts                      # dry run, protocol only
//   bun scripts/gate0-refresh-ownership.ts --yes --account <id> # real run — SACRIFICIAL ONLY
import { loadAccounts, providerOf, type StoredAccount } from "../src/accounts.ts"
import { CLIENT_ID, NETWORK_TIMEOUT_MS, OAUTH_BETA, TOKEN_URL, USAGE_ENDPOINT } from "../src/constants.ts"
import { redactBody, redactHeaders } from "../src/logger.ts"

const PROTOCOL = `
════════════════════════════════════════════════════════════════════════
 GATE 0 / 实验二:跨过期的 refresh 归属权
════════════════════════════════════════════════════════════════════════

要回答的问题
  中心 master 持有全部 refresh token,worker 只拿短时效 access token。
  1) Anthropic 的 refresh token 是不是「一次性 + 轮换」的?
  2) master 做的这次刷新,会不会让 worker 手里【已经在飞】的旧 access token 失效?
  3) 刷新前的那张 refresh token 还能不能重放?

前置条件(强制)
  · 目标必须是一个【可牺牲】账号:本实验会真的消耗并轮换它的 refresh token。
  · 脚本【不写】本地账号库,所以跑完之后本地那张 refresh 已经是死的,该账号必须
    重新登录(opencode auth login,经 ex-machina)才能恢复。
  · 绝不要对你日常在用的账号跑这个脚本。

步骤(--yes 后自动执行,无需人工介入)
  1. 从账号库读出 access1 / refresh1(只打印前 8 位 + 长度,绝不打印完整 token)。
  2. POST ${TOKEN_URL}
     body: {grant_type:"refresh_token", refresh_token:refresh1, client_id:CLIENT_ID}
     → 得到 access2 / refresh2,比较 refresh2 是否 !== refresh1(是否轮换)。
  3. 拿【旧的】access1 去打 ${USAGE_ENDPOINT} → 刷新后旧 access 还有效吗?
  4. 再用 refresh1 发第二次刷新 → 报告状态码 / 错误,证明一次性还是可重放。
  5. 打印结论表:是否轮换 / 旧 access 是否仍有效 / refresh1 是否可重放。

结论怎么读
  · 若 refresh1【一次性且轮换】:任何第二个独立的刷新者都会永久打断这条链 —— 它拿到的
    refresh 会被第一个刷新者的轮换立刻作废,反之亦然,最终服务端以 invalid_grant 拒绝
    双方。这正是架构必须把刷新集中在唯一 master 上的原因:refresh 归属权只能独占。
  · 若旧 access1 刷新后【仍然有效】:master 可以安全地在后台刷新,worker 在飞的请求
    不会被打断(access 与 refresh 生命周期解耦)。
  · 若旧 access1 刷新后【立刻失效】:master 每次刷新都会打断 worker,租借协议必须改成
    「先租新 token、再让旧 token 自然过期」的重叠窗口模型。

诚实性说明
  · ${USAGE_ENDPOINT} 已知有持续 429。第 3 问撞 429 时报「无法判定」,不重试也不下结论。
  · 第 2 步失败(例如 400 invalid_grant = 本地这张链本来就已经死了)时,后面几问都无从
    谈起,脚本报 INCONCLUSIVE 并以非零码退出。
`

type Args = { yes: boolean; accountId?: string }
type Parsed = { ok: true; args: Args } | { ok: false; error: string }

function parseArgs(argv: readonly string[]): Parsed {
  let yes = false
  let accountId: string | undefined
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === "--yes") {
      yes = true
      continue
    }
    if (arg === "--account") {
      const value = argv[index + 1]
      if (value === undefined || value.startsWith("--")) return { ok: false, error: "--account 需要一个账号 id" }
      accountId = value
      index++
      continue
    }
    return { ok: false, error: `未知参数: ${arg}` }
  }
  return { ok: true, args: { yes, accountId } }
}

/** Tokens are NEVER printed in full: the owner is expected to paste this output into an issue. */
function redactToken(token: string): string {
  return `${token.slice(0, 8)}…(len=${token.length})`
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

type HttpResult = { status: number; ok: boolean; headerKeys: string[]; body: string }

async function describe(res: Response): Promise<HttpResult> {
  const headers: Record<string, string> = {}
  res.headers.forEach((value, key) => { headers[key] = value })
  return { status: res.status, ok: res.ok, headerKeys: redactHeaders(headers), body: await res.text().catch(() => "") }
}

function report(step: string, result: HttpResult): void {
  console.log(`  ${step} → status=${result.status}`)
  console.log(`     headerKeys: ${result.headerKeys.join(", ")}`)
  console.log(`     body: ${redactBody(result.body)}`)
}

// Same shape as src/usage.ts doRefreshToken so the experiment measures the request the
// production refresher actually sends, not a look-alike.
function postRefresh(refresh: string): Promise<Response> {
  return fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/plain, */*", "User-Agent": "axios/1.13.6" },
    body: JSON.stringify({ grant_type: "refresh_token", refresh_token: refresh, client_id: CLIENT_ID }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
}

function probeUsage(access: string): Promise<Response> {
  return fetch(USAGE_ENDPOINT, {
    headers: { Authorization: `Bearer ${access}`, "anthropic-beta": OAUTH_BETA },
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })
}

type TokenPair = { access: string; refresh: string }

function parseTokenPair(body: string): TokenPair | undefined {
  let json: unknown
  try {
    json = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) return undefined
  const record = json as Record<string, unknown>
  const access = record["access_token"]
  const refresh = record["refresh_token"]
  if (typeof access !== "string" || typeof refresh !== "string") return undefined
  return { access, refresh }
}

function printBanner(account: StoredAccount): void {
  console.log("╔══════════════════════════════════════════════════════════════════════╗")
  console.log("║  ⚠  警告:本次运行会【真的消耗并轮换】一张真实的 refresh token       ║")
  console.log("║     · 跑完之后本地账号库里的那张 refresh 已经失效(脚本不回写)       ║")
  console.log("║     · 该账号必须重新登录才能恢复 —— 只能对可牺牲账号运行            ║")
  console.log("║     · 新 token 不会被打印(绝不输出完整凭据),因此无法手工恢复       ║")
  console.log("╚══════════════════════════════════════════════════════════════════════╝")
  console.log(`  目标账号: ${account.label}  (id=${account.id})`)
}

function verdict(rotated: boolean, oldAccess: string, replayable: string): string {
  if (!rotated) return "最终裁决:NO-ROTATION — 服务端返回了同一张 refresh,刷新权无需独占(与预期不符,请复核 body)。"
  if (replayable === "否") return "最终裁决:CENTRALISE — refresh 是一次性且轮换的,刷新权必须由唯一 master 独占。"
  return `最终裁决:MIXED — 轮换=是, refresh1 可重放=${replayable}, 旧 access 仍有效=${oldAccess};请人工判读上表。`
}

async function runLive(accountId: string): Promise<number> {
  const file = await loadAccounts()
  const account = file.accounts.find((item) => item.id === accountId)
  if (!account) {
    console.error(`账号未找到: ${accountId}(账号库里没有这个 id)`)
    return 2
  }
  const provider = providerOf(account)
  if (provider !== "anthropic") {
    console.error(`账号 ${accountId} 的 provider 是 ${provider},本实验只针对 anthropic 的 OAuth 链。`)
    return 2
  }
  printBanner(account)

  const refresh1 = account.refresh
  const access1 = account.access
  console.log("\n[1/4] 记录刷新前的凭据")
  console.log(`  refresh1 ${redactToken(refresh1)}`)
  console.log(`  access1  ${access1 ? redactToken(access1) : "缺失"}`)
  console.log(`  expires  ${account.expires ? new Date(account.expires).toISOString() : "未知"}`)
  if (!access1) {
    console.error("  本地没有 access1,第 3 问(旧 access 是否仍有效)无从测量。拒绝为一个只能给出半个答案的运行去烧掉真实 refresh token。")
    return 2
  }
  const access1Expired = account.expires !== undefined && account.expires < Date.now()
  if (access1Expired) console.log("  ⚠ access1 按本地记录已自然过期:第 3 问会被「自身过期」混淆,结果不可单独采信。")

  console.log("\n[2/4] 用 refresh1 刷新一次")
  const refreshResult = await describe(await postRefresh(refresh1))
  report("POST /v1/oauth/token", refreshResult)
  const pair = refreshResult.ok ? parseTokenPair(refreshResult.body) : undefined
  if (!pair) {
    console.error("\n最终裁决:INCONCLUSIVE — 第一次刷新未拿到 token 对,后续三问无从判定。")
    return 1
  }
  const rotated = pair.refresh !== refresh1
  console.log(`  access2  ${redactToken(pair.access)}`)
  console.log(`  refresh2 ${redactToken(pair.refresh)}`)
  console.log(`  refresh 是否轮换: ${rotated ? "是(refresh2 !== refresh1)" : "否(服务端返回同一张)"}`)

  console.log("\n[3/4] 刷新之后,拿旧的 access1 去打 usage")
  const probeResult = await describe(await probeUsage(access1))
  report("GET /api/oauth/usage (access1)", probeResult)
  const oldAccess = probeResult.status === 429 ? "无法判定(429)" : probeResult.ok ? "是" : `否(${probeResult.status})`

  console.log("\n[4/4] 重放 refresh1,再刷一次")
  const replayResult = await describe(await postRefresh(refresh1))
  report("POST /v1/oauth/token (replay refresh1)", replayResult)
  const replayable = replayResult.ok ? "是" : "否"

  console.log("\n── 结论表 ────────────────────────────────────────────────────────────")
  console.log(`  refresh 是否轮换?          ${rotated ? "是" : "否"}`)
  console.log(`  刷新后旧 access1 仍有效?   ${oldAccess}${access1Expired ? "  (已被自身过期混淆)" : ""}`)
  console.log(`  refresh1 可重放?           ${replayable}(status=${replayResult.status})`)
  console.log("\n结论怎么读:refresh 一次性 + 轮换 ⇒ 任何第二个独立刷新者都会永久打断这条链,")
  console.log("这正是架构必须把刷新集中在唯一 master 上、由它独占 refresh 归属权的原因。")
  console.log(`\n提醒:${account.label} 的本地 refresh 链现在已失效,请重新登录一次。`)
  console.log(`\n${verdict(rotated, oldAccess, replayable)}`)
  return 0
}

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2))
  if (!parsed.ok) {
    console.error(parsed.error)
    console.error("用法: bun scripts/gate0-refresh-ownership.ts [--yes --account <账号id>]")
    return 2
  }
  // SAFETY GATE — checked before ANY network call: everything below `runLive` is unreachable
  // without --yes, so a bare invocation is guaranteed to be zero-network.
  if (!parsed.args.yes) {
    console.log(PROTOCOL)
    console.log("这是 DRY RUN:没有发起任何网络请求,也没有消耗任何 token。")
    console.log("真跑请加 --yes --account <账号id>,且【只能】用可牺牲账号。")
    console.log("\n最终裁决:DRY RUN — 只打印协议,未做任何实验。")
    return 0
  }
  if (!parsed.args.accountId) {
    console.error("--yes 必须配合 --account <账号id>:绝不对「默认账号」跑这个会烧 token 的实验。")
    return 2
  }
  return runLive(parsed.args.accountId)
}

try {
  process.exitCode = await main()
} catch (error) {
  // Not redundant with Bun's own non-zero exit: an unhandled rejection prints a stack trace
  // and NO verdict line, which is exactly what a pasted transcript must never be ambiguous about.
  console.error(`\n运行失败: ${redactBody(errorMessage(error))}`)
  console.error("\n最终裁决:ERROR — 实验未完成(操作性失败),链的状态可能已被部分改变。")
  process.exitCode = 1
}
