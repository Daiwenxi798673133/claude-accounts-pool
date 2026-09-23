// 钩子进程自己的逻辑:读报文 → 分类 → 该上报的上报。
//
// 这是一个【短命进程】,由 Claude Code 在一轮对话因 API 错误结束时拉起,输出被整个丢弃(官方文档:
// exit code、stdout、stderr 对会话都没有影响)。所以这里没有任何"返回值影响调用方"的设计空间 ——
// 它只有副作用,而副作用只有一个:让 master 知道这个号的额度打满了。
//
// 为什么这条上报值钱:worker 的限流认知此前只在本机。同一个空号会被继续发给别的机器,每台都得自己
// 撞一次墙才知道 —— src/senpi/limitReport.ts 的开头记的就是这件事。Claude Code 这条链比 opencode
// 那条更早拿到信号:docs/limitations.md 记着「成功响应的限流头拿不到」,而 StopFailure 是服务端错误
// 分类后直接给到的。
//
// 为什么【不】做去重(与 limitReport.ts 的选择相反,这是有意的):那个模块的调用点是每一轮 turn_start,
// 封锁期间会被连续打到,不去重就是对着 master 连发。这里的调用点是"一轮对话失败了"——由人按回车
// 驱动,频率天然受限。为此引入一个跨进程的标记文件,等于用一个会变陈旧、会误抑制下一次真实限流的
// 状态,去换一个本来就不存在的问题。master 的 markCooldown 本身能吸收重复。
import { log } from "../logger.ts"
import { classify } from "./hookEvent.ts"

export type HookRunDeps = {
  // 整段 stdin。由组合根读取,因为"怎么读一个流"是运行时的事。
  readStdin: () => Promise<string>
  // 只要 leaseClient 的这一个动词 —— 它自己吞掉全部故障并返回 false,所以这里既不重试也不抛。
  // 与 src/senpi/limitReport.ts 的依赖形状一致。
  reportRateLimit: (input: { accountId: string; headers: Record<string, string> }) => Promise<boolean>
  // 本次会话租到的账号。undefined 意味着这个钩子被挂在了一个不是池子起的会话上 —— 不是错误,
  // 只是没什么可上报的。
  accountId: string | undefined
}

export async function runHook(deps: HookRunDeps): Promise<void> {
  let raw: unknown
  try {
    raw = JSON.parse(await deps.readStdin())
  } catch (error) {
    log.warn("claudecode:hook-unparseable", { error: error instanceof Error ? error.message : String(error) })
    return
  }

  const action = classify(raw)
  if (action.kind === "ignore") {
    log.debug("claudecode:hook-ignored", { reason: action.reason })
    return
  }

  // 租约在这条会话里已经不能用了。【绝不】当成限流上报 —— 那会把一个额度健康的账号打进冷却,
  // 而它的问题只是这枚 access token 过期或被吊销了。
  //
  // 也无法自救:凭证在进程内冻结(issue #83),这个钩子拿不到、也改不了那枚 token。所以这里只留
  // 一条日志。操作者看到的是 claude 自己报的那个错,而修复动作只有一个 —— 重开会话。
  if (action.kind === "dead-lease") {
    log.warn("claudecode:hook-dead-lease", { errorType: action.errorType, accountId: deps.accountId?.slice(0, 8) })
    return
  }

  if (deps.accountId === undefined || deps.accountId.length === 0) {
    log.warn("claudecode:hook-no-account", { errorType: action.errorType })
    return
  }

  // headers 是空的,resetsAt 缺省 —— StopFailure 的报文里两样都没有(官方 schema 只有 error_type /
  // error_message)。limitReport.ts 记过为什么缺省反而诚实:拿客户端自己的重试窗口冒充配额重置点,
  // 会让 master 一分钟后又把空号发给下一台机器。没有期限的报告会让 master 记一个待定冷却,由它
  // 自己的用量轮询把真实期限填上。
  const reported = await deps.reportRateLimit({ accountId: deps.accountId, headers: {} })
  if (reported) {
    log.info("claudecode:hook-limit-reported", { accountId: deps.accountId.slice(0, 8) })
    return
  }
  // 报不到就算了:master 往往只是暂时不可达,而这一轮对话已经失败了,没有什么在等这条遥测。
  log.warn("claudecode:hook-limit-report-failed", { accountId: deps.accountId.slice(0, 8) })
}
