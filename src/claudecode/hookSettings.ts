// 把限流钩子挂到子进程上 —— 不碰操作者的 settings 文件。
//
// 通道是 `claude --settings <JSON 字符串>`:官方文档说它接受「文件路径或一个 JSON 字符串」,并且是
// 「load additional settings」(合并,不是替换)。用内联 JSON 而不是临时文件,是为了省掉一整套生命周期:
// 没有文件要创建、要清理、要在崩溃后回收。JSON 里【没有凭证】,只有一个脚本路径,所以它出现在 ps 的
// 命令行里是无害的 —— 凭证走的是环境变量,不是 argv。
//
// 为什么不写 ~/.claude/settings.json:那是操作者的文件,而本链路的全部前提就是「不碰你自己的配置」。
// 往那里挂钩子还会污染他们手敲的每一个 claude 会话。
import { POOL_ACCOUNT_VAR } from "./childEnv.ts"

// 我们真正会动作的那几个 error_type。matcher 用精确匹配的 `|` 连接 —— 官方文档:只含字母、数字、
// `_` 和 `|` 时按精确匹配处理,出现连字符/空格/逗号才会被当成正则。这里刻意停在精确匹配这一侧。
export const HOOK_MATCHER = "rate_limit|authentication_failed|oauth_org_not_allowed|account_on_hold"

export function hookSettingsJson(hookPath: string): string {
  return JSON.stringify({
    hooks: {
      StopFailure: [{ matcher: HOOK_MATCHER, hooks: [{ type: "command", command: hookPath }] }],
    },
  })
}

export type ArgvOutcome = {
  argv: string[]
  // 没挂上时的原因,给操作者一句话。挂上了就是 undefined。
  skipped?: string
}

// `--settings` 的两种写法都要认出来:commander 同时接受 `--settings x` 和 `--settings=x`。
function carriesSettings(argv: readonly string[]): boolean {
  return argv.some((arg) => arg === "--settings" || arg.startsWith("--settings="))
}

/**
 * 在操作者的参数【前面】插入我们的 --settings。
 *
 * 放前面而不是后面:后面的位置可能落在 `claude -p "prompt"` 的位置参数之后,那会改变 commander
 * 对位置参数的解析。放最前面则永远是一个规规矩矩的选项。
 *
 * 操作者自己传了 --settings 时【不硬塞】。两个 --settings 的合并语义我们没有验证过,而一条我们
 * 自己都说不清的命令行,比"这次没有限流上报"糟糕得多 —— 后者只是少了一条遥测,前者可能让整个
 * 会话以一种谁都没预料的方式配置起来。
 */
export function withHookSettings(argv: readonly string[], hookPath: string | undefined): ArgvOutcome {
  if (hookPath === undefined) return { argv: [...argv], skipped: "找不到钩子脚本" }
  if (carriesSettings(argv)) {
    return {
      argv: [...argv],
      skipped: "你自己传了 --settings,本次不挂限流上报钩子(撞限流时 master 不会知道,别的机器会各撞一次)",
    }
  }
  return { argv: ["--settings", hookSettingsJson(hookPath), ...argv] }
}

// 实测(claude 2.1.278,2026-09-23):`-p` 模式下 StopFailure 【不触发】—— 同一次对照里 SessionStart 与
// UserPromptSubmit 都触发了,Stop 与 StopFailure 都没有;换成真 pty 的交互式会话,四个全部触发。
// 所以钩子照挂(挂着无害),但要说一句:否则一台只跑 `-p` 的机器会以为自己在上报限流,而 master
// 那边永远收不到,同一个空号继续发给别的机器 —— 这正是这条钩子存在要解决的问题本身。
export function printModeNotice(argv: readonly string[]): string | undefined {
  const isPrint = argv.some((arg) => arg === "-p" || arg === "--print")
  return isPrint
    ? "-p 模式下 Claude Code 不触发 StopFailure,本次撞限流不会上报给 master(交互式会话正常上报)"
    : undefined
}

/** 钩子进程自己需要的环境:账号 id 从这里来,因为 StopFailure 的报文里没有账号信息。 */
export const HOOK_REQUIRED_VARS = [POOL_ACCOUNT_VAR] as const
