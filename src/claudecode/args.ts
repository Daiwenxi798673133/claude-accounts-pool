// 从命令行里摘出【我们自己的】参数,其余一个字节不动地交给 claude。
//
// 这条链的契约是「参数一个都不解析」,本模块是那句话唯一的例外,所以例外的边界必须能一句话说完:
//
//   只认最前面的连续几个 --pool-* 参数;遇到第一个不是 --pool-* 的东西就【停止解析】,
//   从那里开始到结尾全部原样透传。
//
// 停在前导位置而不是全程扫描,是因为 claude 的参数里可以出现任意字符串(`claude -p "--pool-pin"`),
// 全程扫描就会去解释别人的数据。前导位置则永远是命令行上属于我们的那一段。
//
// 名字带 pool 前缀,不叫 --account:万一哪天 Claude Code 自己加了同名参数,`claude-pool --account x`
// 就会变成谁也说不清该给谁的东西。我们的参数必须一眼看出是我们的。
export type PoolArgs = {
  accountPrefix?: string
  // true = 钉住(以后每次启动都用它);false = 取消钉住;undefined = 不动现有设置。
  pin?: boolean
  // 交给 claude 的那一段。
  rest: string[]
}

export type ParseResult = { ok: true; args: PoolArgs } | { ok: false; error: string }

const PREFIX_PATTERN = /^[0-9a-f]{4,}$/i

export function parsePoolArgs(argv: readonly string[]): ParseResult {
  let accountPrefix: string | undefined
  let pin: boolean | undefined
  let index = 0

  const takeValue = (inline: string | undefined, next: string | undefined, flag: string): string | undefined => {
    if (inline !== undefined) return inline
    if (next === undefined || next.startsWith("-")) return undefined
    return next
  }

  while (index < argv.length) {
    const arg = argv[index]
    if (!arg.startsWith("--pool-")) break

    const eq = arg.indexOf("=")
    const name = eq === -1 ? arg : arg.slice(0, eq)
    const inline = eq === -1 ? undefined : arg.slice(eq + 1)

    if (name === "--pool-account") {
      const value = takeValue(inline, argv[index + 1], name)
      if (value === undefined) return { ok: false, error: "--pool-account 需要一个账号 id 前缀(看板上显示的前 8 位)" }
      // 前缀是十六进制的账号 id 片段。挡住明显不是前缀的东西,好过把它发给 master 再拿一个 409 回来。
      if (!PREFIX_PATTERN.test(value)) {
        return { ok: false, error: `「${value}」不像账号 id 前缀。要的是看板上那串十六进制的前几位,至少 4 位。` }
      }
      accountPrefix = value.toLowerCase()
      index += eq === -1 ? 2 : 1
      continue
    }
    if (name === "--pool-pin") {
      pin = true
      index += 1
      continue
    }
    if (name === "--pool-unpin") {
      pin = false
      index += 1
      continue
    }
    return { ok: false, error: `不认识的参数 ${name}(本启动器只认 --pool-account / --pool-pin / --pool-unpin)` }
  }

  // 钉住是【对某个具体账号】的声明,所以它不能独自出现 —— 与协议里 `pinned` 必须伴随
  // `preferredAccountIdPrefix` 是同一条规矩:钉住一个「排名派给我的号」是说不通的,因为下一次
  // 启动之前谁也不知道那会是哪个。
  if (pin === true && accountPrefix === undefined) {
    return { ok: false, error: "--pool-pin 必须配 --pool-account:钉住的是某个具体账号,不是「下次排名派给我的那个」" }
  }

  return { ok: true, args: { accountPrefix, pin, rest: argv.slice(index) } }
}
