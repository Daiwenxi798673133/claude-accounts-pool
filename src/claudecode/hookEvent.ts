// StopFailure 报文的解析与分类 —— 纯函数,不碰网络也不碰磁盘。
//
// 这个钩子是这条链上唯一的「服务端说了什么」的信号源。opencode 那条链拿不到请求级钩子
// (docs/limitations.md:「worker 无法在请求层被拦住、成功响应的限流头拿不到」),Claude Code
// 这边反而有:StopFailure 按 error_type 分流,matcher 精确匹配。
//
// 报文里【没有】的东西,决定了这个模块能做什么(实测自官方 hooks 文档的 schema):
//   · 没有 headers      → 上报时 headers 只能是 {},与 src/senpi/limitReport.ts 同样的处境
//   · 没有 retry-after / 重置时间 → 上报时不带 resetsAt。这不是偷懒:limitReport.ts 记过一次实测,
//     把客户端自己的重试窗口当成配额重置点发给 master,会让 master 一分钟后又把空号发给下一台机器。
//     缺省反而诚实 —— master 记一个待定冷却,由它自己的用量轮询把真实期限填上。
//   · 没有账号信息      → accountId 必须由启动器注进子进程环境(见 childEnv.ts 的 POOL_ACCOUNT_VAR)
export type StopFailurePayload = {
  hook_event_name?: unknown
  // 错误类型有【两个】可能的字段名,两个都读。官方文档(2026-09 抓取)写的是 `error_type` +
  // `error_message`;而 claude 2.1.278 实际发出来的是 `error` + `last_assistant_message` —— 实测报文:
  //
  //   {"hook_event_name":"StopFailure","error":"authentication_failed",
  //    "last_assistant_message":"Please run /login · API Error: 401 OAuth token is invalid", ...}
  //
  // 只读文档写的那个,每一个真实事件都会落进 ignore 分支,而钩子的输出被客户端整个丢弃 —— 于是
  // 整条上报链静默失效,没有任何地方会报错。两个都读的成本是零,而赌对其中一个的代价是全盘无声。
  error?: unknown
  error_type?: unknown
  last_assistant_message?: unknown
  error_message?: unknown
  session_id?: unknown
}

// 官方 schema 的全集。写全而不是只列我们关心的那两个,是为了让「新增一个类型」在这里可见 ——
// 一个没被列进来的 error_type 会落进 ignore 分支,而那正是我们想在某天回头审视的地方。
export const ERROR_TYPES = [
  "rate_limit",
  "overloaded",
  "authentication_failed",
  "oauth_org_not_allowed",
  "account_on_hold",
  "billing_error",
  "invalid_request",
  "model_not_found",
  "server_error",
  "max_output_tokens",
  "cloud_credential_error",
  "unknown",
] as const
export type ErrorType = (typeof ERROR_TYPES)[number]

export type HookAction =
  // 上报给 master:这个账号的额度打满了,别的机器不该再各撞一次墙。
  | { kind: "report-limit"; errorType: ErrorType }
  // 租约在这条会话里已经不可用,但【绝不上报为限流】—— 那会把一个额度健康的账号打进冷却。
  // 凭证在进程内冻结(issue #83),所以本进程无法自救,能做的只有留一条日志。
  | { kind: "dead-lease"; errorType: ErrorType }
  | { kind: "ignore"; reason: string }

// 哪些 error_type 算「这枚租约不能用了」。分成一张表而不是 if 链,理由与全仓其它按变体建的表一致:
// 新增一个要不要归进来,是一次看得见的编辑。
const DEAD_LEASE: Partial<Record<ErrorType, true>> = {
  authentication_failed: true,
  oauth_org_not_allowed: true,
  account_on_hold: true,
}

function isErrorType(value: unknown): value is ErrorType {
  return typeof value === "string" && (ERROR_TYPES as readonly string[]).includes(value)
}

/**
 * 报文 → 动作。无法识别的一律 ignore 并说明理由:钩子的输出被客户端整个丢弃,所以这里的
 * 「理由」只会进我们自己的日志 —— 它存在是为了排查,不是为了给谁看。
 */
export function classify(raw: unknown): HookAction {
  if (typeof raw !== "object" || raw === null) return { kind: "ignore", reason: "报文不是对象" }
  const payload = raw as StopFailurePayload
  // 事件名核对:同一个脚本将来可能被挂到别的事件上,而那些事件的报文形状完全不同。
  if (payload.hook_event_name !== "StopFailure") {
    return { kind: "ignore", reason: `不是 StopFailure 事件(${String(payload.hook_event_name)})` }
  }
  // 实测字段优先,文档字段兜底。哪天客户端改回文档那个名字,这里不用动。
  const rawType = payload.error ?? payload.error_type
  if (!isErrorType(rawType)) {
    return { kind: "ignore", reason: `无法识别的错误类型(${String(rawType)})` }
  }
  const errorType = rawType
  if (errorType === "rate_limit") return { kind: "report-limit", errorType }
  if (DEAD_LEASE[errorType]) return { kind: "dead-lease", errorType }
  // overloaded / server_error 之类是服务端的事,与账号额度无关:上报会冤枉一个好号。
  return { kind: "ignore", reason: `${errorType} 与账号额度无关` }
}
