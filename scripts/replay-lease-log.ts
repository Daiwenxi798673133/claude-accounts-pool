import { parseLeaseLog, summarize } from "./lib/leaseLogReplay.ts"

const EXIT_USAGE = 2

function pct(part: number, whole: number): string {
  return whole === 0 ? "  n/a" : `${((100 * part) / whole).toFixed(1).padStart(5)}%`
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)}min`
}

async function main(): Promise<number> {
  const path = process.argv[2]
  if (path === undefined) {
    console.error("用法: bun scripts/replay-lease-log.ts <master 的 opencode.log>")
    console.error("取日志: scp potentia@<master>:~/.local/share/opencode/log/opencode.log /tmp/master.log")
    return EXIT_USAGE
  }

  const file = Bun.file(path)
  if (!(await file.exists())) {
    console.error(`读不到日志: ${path}`)
    return EXIT_USAGE
  }

  const events = parseLeaseLog(await file.text())
  if (events.length === 0) {
    console.error("这个文件里没有一条账号池日志行,确认它是 master 的 opencode.log")
    return EXIT_USAGE
  }
  const s = summarize(events)

  const span = `${new Date(s.from).toISOString().slice(0, 16)} → ${new Date(s.to).toISOString().slice(0, 16)}`
  console.log(`\n日志区间 ${span}   解析到 ${events.length} 条池日志\n`)

  console.log(`选号路径归因(共 ${s.leases} 次发牌)`)
  console.log(`  重新选举          ${String(s.paths.election).padStart(5)}  ${pct(s.paths.election, s.leases)}   ← 越低越好`)
  console.log(`  保号(worker 自报) ${String(s.paths.incumbentWorker).padStart(5)}  ${pct(s.paths.incumbentWorker, s.leases)}`)
  console.log(`  保号(亲和账本)    ${String(s.paths.incumbentAffinity).padStart(5)}  ${pct(s.paths.incumbentAffinity, s.leases)}   ← 新增兜底救回来的`)
  console.log(`  点名(手动/pin)    ${String(s.paths.preferred).padStart(5)}  ${pct(s.paths.preferred, s.leases)}`)
  console.log(`  误报限流留任      ${String(s.paths.misattributed).padStart(5)}  ${pct(s.paths.misattributed, s.leases)}`)

  console.log(`\n换号`)
  console.log(`  换号总次数        ${String(s.switches).padStart(5)}`)
  console.log(`  其中无限流诱因    ${String(s.switchesWithoutLimit).padStart(5)}  ${pct(s.switchesWithoutLimit, s.switches)}`)
  console.log(`  注意: 缓存在订阅上存活约 1 小时,空闲超过它之后换号本身不额外花钱。`)
  console.log(`        这份日志看不出 worker 当时是否在干活,所以上面这个数是上界,不是浪费量。`)

  console.log(`\n限流(共 ${s.rateLimits} 次)`)
  console.log(`  打在"交接时还干净"的号上   ${String(s.limitsOnCleanAccounts).padStart(5)}`)
  console.log(`  接手 1 小时内就被打爆      ${String(s.limitsWithinHourOfAdoption).padStart(5)}`)
  console.log(
    `  接手到打爆的间隔   p25 ${minutes(s.dwellBeforeLimitMs.p25)}  中位 ${minutes(s.dwellBeforeLimitMs.median)}  p75 ${minutes(s.dwellBeforeLimitMs.p75)}`,
  )

  console.log(`\n级联爆破(单 worker 90 分钟内打爆 ≥3 个号): ${s.cascades.length} 段`)
  for (const c of s.cascades.slice(-8)) {
    console.log(`  ${new Date(c.at).toISOString().slice(5, 16)}  ${c.workerId.slice(0, 22).padEnd(22)} ${c.accounts} 个号 / ${minutes(c.spanMs)}`)
  }

  const burned = Object.entries(s.burnRatesPerHour)
  console.log(`\n燃烧速率观测(利用率点/小时)`)
  if (burned.length === 0) {
    console.log(`  这份日志里没有 master:burn-observed —— 说明跑的是加观测之前的版本`)
  } else {
    for (const [prefix, rates] of burned.sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
      const peak = Math.max(...rates)
      const mean = rates.reduce((sum, r) => sum + r, 0) / rates.length
      console.log(`  ${prefix}  样本 ${String(rates.length).padStart(4)}  均值 ${mean.toFixed(1).padStart(6)}  峰值 ${peak.toFixed(1).padStart(6)}`)
    }
  }
  console.log()
  return 0
}

process.exit(await main())
