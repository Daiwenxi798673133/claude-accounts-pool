/** @jsxImportSource @opentui/solid */
import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { DailyPoint, GroupStat, StatsData, TimeRange } from "./stats.ts"

export type StatsState = { loading: boolean; data?: StatsData; error?: string }

type ThemeColor = TuiPluginApi["theme"]["current"]["text"]
type HeatCell = { level: number; blank: boolean }
type Point = { x: number; y: number }

const LEVEL_CHARS = ["·", "░", "▒", "▓", "█"]
const LEVEL_HEX = ["#7a3b1e", "#a0501f", "#cf6a26", "#f0883e"]
const ORANGE = "#f0883e"
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const ROW_LABELS = ["Mon", "", "Wed", "", "Fri", "", "Sun"]
const CHART_ROWS = 7
const BRAILLE = [
  [0x01, 0x08],
  [0x02, 0x10],
  [0x04, 0x20],
  [0x40, 0x80],
]
const RANGES: [TimeRange, string][] = [
  ["all", "All"],
  ["7d", "7天"],
  ["30d", "30天"],
]
const TABS = ["总览", "模型", "提供方"]

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function fmtCost(n: number): string {
  return `$${n.toFixed(2)}`
}

function fmtRate(n: number): string {
  return `${n.toFixed(2)} tok/s`
}

function fmtMag(n: number): string {
  if (n >= 1e9) return `${trimMag(n / 1e9)}B`
  if (n >= 1e6) return `${trimMag(n / 1e6)}M`
  if (n >= 1e3) return `${trimMag(n / 1e3)}k`
  return String(Math.round(n))
}

function trimMag(x: number): string {
  if (x >= 10) return String(Math.round(x))
  return (Math.round(x * 10) / 10).toString()
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function localDayKey(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function addDays(d: Date, n: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + n)
  return out
}

function fmtXDate(day: string): string {
  const month = MONTHS[Number(day.slice(5, 7)) - 1] ?? "?"
  return `${day.slice(2, 4)} ${month} ${Number(day.slice(8, 10))}`
}

function buildDayAxis(daily: DailyPoint[]): string[] {
  if (daily.length === 0) return []
  const end = new Date(`${daily[daily.length - 1].day}T00:00:00`)
  const out: string[] = []
  let cursor = new Date(`${daily[0].day}T00:00:00`)
  let guard = 0
  while (cursor.getTime() <= end.getTime() && guard < 1000) {
    out.push(localDayKey(cursor))
    cursor = addDays(cursor, 1)
    guard++
  }
  return out
}

function buildHeatmap(daily: DailyPoint[], weeks: number): { header: string; rows: HeatCell[][] } {
  const map = new Map<string, number>()
  let max = 0
  for (const d of daily) {
    map.set(d.day, d.tokens)
    if (d.tokens > max) max = d.tokens
  }
  if (max <= 0) max = 1

  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const monday = addDays(today, -((today.getDay() + 6) % 7))

  const rows: HeatCell[][] = []
  for (let r = 0; r < 7; r++) {
    const row: HeatCell[] = []
    for (let c = 0; c < weeks; c++) {
      const cell = addDays(monday, -(weeks - 1 - c) * 7 + r)
      if (cell.getTime() > today.getTime()) {
        row.push({ level: 0, blank: true })
        continue
      }
      const tokens = map.get(localDayKey(cell)) ?? 0
      const level = tokens <= 0 ? 0 : clamp(Math.ceil((tokens / max) * 4), 1, 4)
      row.push({ level, blank: false })
    }
    rows.push(row)
  }

  const gutter = 5
  const header = new Array(gutter + weeks).fill(" ")
  let prevMonth = -1
  for (let c = 0; c < weeks; c++) {
    const month = addDays(monday, -(weeks - 1 - c) * 7).getMonth()
    if (c > 0 && month !== prevMonth) {
      const abbr = MONTHS[month]
      const start = gutter + c
      if (start + abbr.length <= header.length && header[start] === " ") {
        for (let k = 0; k < abbr.length; k++) header[start + k] = abbr[k]
      }
    }
    prevMonth = month
  }
  return { header: header.join(""), rows }
}

function cellChar(cell: HeatCell): string {
  return cell.blank ? " " : LEVEL_CHARS[cell.level]
}

function cellColor(cell: HeatCell, theme: TuiPluginApi["theme"]["current"]): ThemeColor | string {
  if (cell.blank || cell.level === 0) return theme.textMuted
  return LEVEL_HEX[cell.level - 1]
}

function runsOf(row: HeatCell[], theme: TuiPluginApi["theme"]["current"]): { text: string; color: ThemeColor | string }[] {
  const runs: { text: string; color: ThemeColor | string }[] = []
  for (const cell of row) {
    const ch = cellChar(cell)
    const color = cellColor(cell, theme)
    const last = runs[runs.length - 1]
    if (last && last.color === color && last.text[0] === ch) last.text += ch
    else runs.push({ text: ch, color })
  }
  return runs
}

function drawLine(a: Point, b: Point, set: (x: number, y: number) => void): void {
  let x0 = a.x
  let y0 = a.y
  const dx = Math.abs(b.x - x0)
  const dy = -Math.abs(b.y - y0)
  const sx = x0 < b.x ? 1 : -1
  const sy = y0 < b.y ? 1 : -1
  let err = dx + dy
  for (;;) {
    set(x0, y0)
    if (x0 === b.x && y0 === b.y) break
    const e2 = 2 * err
    if (e2 >= dy) {
      err += dy
      x0 += sx
    }
    if (e2 <= dx) {
      err += dx
      y0 += sy
    }
  }
}

function brailleRows(values: number[], plotCols: number, rows: number, max: number): string[] {
  const dotW = plotCols * 2
  const dotH = rows * 4
  const grid = new Uint8Array(plotCols * rows)
  const n = values.length
  const set = (dx: number, dy: number): void => {
    if (dx < 0 || dy < 0 || dx >= dotW || dy >= dotH) return
    grid[(dy >> 2) * plotCols + (dx >> 1)] |= BRAILLE[dy & 3][dx & 1]
  }
  const points: Point[] = values.map((v, i) => ({
    x: n <= 1 ? 0 : Math.round((i / (n - 1)) * (dotW - 1)),
    y: Math.round((1 - clamp(v / max, 0, 1)) * (dotH - 1)),
  }))
  if (points.length === 1) set(points[0].x, points[0].y)
  for (let i = 0; i < points.length - 1; i++) drawLine(points[i], points[i + 1], set)

  const out: string[] = []
  for (let r = 0; r < rows; r++) {
    let line = ""
    for (let c = 0; c < plotCols; c++) {
      const code = grid[r * plotCols + c]
      line += code === 0 ? " " : String.fromCharCode(0x2800 + code)
    }
    out.push(line)
  }
  return out
}

function buildXAxis(days: string[], plotCols: number): string {
  const gutter = 6
  const arr = new Array(gutter + plotCols).fill(" ")
  const n = days.length
  if (n === 0) return arr.join("")
  const count = Math.min(5, n)
  for (let k = 0; k < count; k++) {
    const i = count <= 1 ? 0 : Math.round((k / (count - 1)) * (n - 1))
    const label = fmtXDate(days[i])
    const dotX = n <= 1 ? 0 : Math.round((i / (n - 1)) * (plotCols * 2 - 1))
    let start = gutter + Math.floor(dotX / 2) - Math.floor(label.length / 2)
    start = clamp(start, 0, arr.length - label.length)
    let free = true
    for (let j = -1; j <= label.length; j++) {
      const p = start + j
      if (p >= 0 && p < arr.length && arr[p] !== " ") {
        free = false
        break
      }
    }
    if (!free) continue
    for (let j = 0; j < label.length; j++) arr[start + j] = label[j]
  }
  return arr.join("")
}

function Header(props: { api: TuiPluginApi; tab: () => number; range: () => TimeRange }) {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="row" justifyContent="space-between" width="100%">
      <box flexDirection="row" gap={2} paddingLeft={1}>
        <For each={TABS}>
          {(label, i) => {
            const active = () => props.tab() === i()
            return <text fg={active() ? theme().primary : theme().textMuted}>{active() ? <b>{label}</b> : label}</text>
          }}
        </For>
      </box>
      <box flexDirection="row" gap={2}>
        <For each={RANGES}>
          {(r) => {
            const active = () => props.range() === r[0]
            return <text fg={active() ? theme().primary : theme().textMuted}>{active() ? <b>{r[1]}</b> : r[1]}</text>
          }}
        </For>
      </box>
      <text fg={theme().textMuted}>Sqlite</text>
    </box>
  )
}

function StatRow(props: { api: TuiPluginApi; ll: string; lv: string; rl?: string; rv?: string }) {
  const theme = () => props.api.theme.current
  return (
    <box flexDirection="row" paddingLeft={1}>
      <box width={34} flexDirection="row">
        <text fg={theme().textMuted}>{`${props.ll}: `}</text>
        <text fg={theme().text}>{props.lv}</text>
      </box>
      <box flexDirection="row">
        <text fg={theme().textMuted}>{props.rl !== undefined ? `${props.rl}: ` : ""}</text>
        <text fg={theme().text}>{props.rv ?? ""}</text>
      </box>
    </box>
  )
}

function Heatmap(props: { api: TuiPluginApi; daily: () => DailyPoint[]; weeks: () => number }) {
  const theme = () => props.api.theme.current
  const grid = createMemo(() => buildHeatmap(props.daily(), props.weeks()))
  return (
    <box flexDirection="column">
      <text fg={theme().textMuted}>{grid().header}</text>
      <For each={grid().rows}>
        {(row, r) => {
          const gutter = ` ${(ROW_LABELS[r()] ?? "").padEnd(3)} `
          const runs = createMemo(() => runsOf(row, theme()))
          return (
            <box flexDirection="row">
              <text fg={theme().textMuted}>{gutter}</text>
              <For each={runs()}>{(run) => <text fg={run.color}>{run.text}</text>}</For>
            </box>
          )
        }}
      </For>
      <box flexDirection="row">
        <text fg={theme().textMuted}>     Less </text>
        <text fg={theme().textMuted}>{`${LEVEL_CHARS[0]} `}</text>
        <For each={LEVEL_HEX}>
          {(hex, i) => (
            <>
              <text fg={hex}>{LEVEL_CHARS[i() + 1]}</text>
              <text fg={theme().textMuted}> </text>
            </>
          )}
        </For>
        <text fg={theme().textMuted}>More</text>
      </box>
    </box>
  )
}

function Chart(props: { api: TuiPluginApi; values: () => number[]; days: () => string[]; cols: () => number }) {
  const theme = () => props.api.theme.current
  const view = createMemo(() => {
    const values = props.values()
    const plotCols = Math.max(12, props.cols() - 6)
    const max = Math.max(1, ...values)
    return { plotCols, max, lines: brailleRows(values, plotCols, CHART_ROWS, max) }
  })
  return (
    <box flexDirection="column">
      <For each={view().lines}>
        {(line, r) => {
          const label = r() % 2 === 0 ? fmtMag((view().max * (CHART_ROWS - 1 - r())) / (CHART_ROWS - 1)) : ""
          return (
            <box flexDirection="row">
              <text fg={theme().textMuted}>{`${label.padStart(5)}│`}</text>
              <text fg={ORANGE}>{line}</text>
            </box>
          )
        }}
      </For>
      <text fg={theme().textMuted}>{`     └${"─".repeat(view().plotCols)}`}</text>
      <text fg={theme().textMuted}>{buildXAxis(props.days(), view().plotCols)}</text>
    </box>
  )
}

function SeriesBody(props: {
  api: TuiPluginApi
  list: () => GroupStat[]
  dailyBy: () => Record<string, DailyPoint[]>
  daily: () => DailyPoint[]
  index: () => number
  cols: () => number
}) {
  const theme = () => props.api.theme.current
  const clamped = createMemo(() => {
    const n = props.list().length
    return n === 0 ? 0 : clamp(props.index(), 0, n - 1)
  })
  const selected = createMemo(() => props.list()[clamped()])
  const axis = createMemo(() => buildDayAxis(props.daily()))
  const values = createMemo(() => {
    const s = selected()
    if (!s) return []
    const series = new Map((props.dailyBy()[s.id] ?? []).map((p) => [p.day, p.tokens]))
    return axis().map((day) => series.get(day) ?? 0)
  })
  return (
    <Show when={selected()} fallback={<text fg={theme().textMuted}> 暂无数据</text>}>
      {(stat) => (
        <box flexDirection="column">
          <Chart api={props.api} values={values} days={axis} cols={props.cols} />
          <box flexDirection="row" paddingLeft={3} paddingTop={1}>
            <text fg={ORANGE}>● </text>
            <text fg={theme().text}>{stat().id}</text>
            <text fg={theme().textMuted}>
              {`  (${stat().pct.toFixed(2)}%) | ${clamped() + 1}/${props.list().length} | j/k ↑/↓`}
            </text>
          </box>
          <box flexDirection="column" paddingTop={1}>
            <StatRow api={props.api} ll="总 tokens" lv={fmtTokens(stat().input + stat().output + stat().cache)} rl="总花费" rv={fmtCost(stat().cost)} />
            <StatRow api={props.api} ll="输入" lv={fmtTokens(stat().input)} rl="会话" rv={String(stat().sessions)} />
            <StatRow api={props.api} ll="输出" lv={fmtTokens(stat().output)} rl="消息" rv={String(stat().messages)} />
            <StatRow api={props.api} ll="缓存" lv={fmtTokens(stat().cache)} rl="提问" rv={String(stat().prompts)} />
            <Show
              when={stat().rate}
              fallback={<StatRow api={props.api} ll="活跃天数" lv={String(stat().activeDays)} />}
            >
              {(rate) => (
                <StatRow api={props.api} ll="速率" lv={fmtRate(rate())} rl="活跃天数" rv={String(stat().activeDays)} />
              )}
            </Show>
          </box>
        </box>
      )}
    </Show>
  )
}

function OverviewBody(props: { api: TuiPluginApi; data: () => StatsData; cols: () => number }) {
  const theme = () => props.api.theme.current
  const overview = () => props.data().overview
  const weeks = () => clamp(props.cols() - 5, 20, 53)
  const factoid = createMemo(() => {
    const words = overview().input + overview().output
    const books = words / 90_000
    const years = words / (16_000 * 365)
    return ` 这些输入输出文字 ≈ ${books.toFixed(1)} 本长篇小说，够一个人不停嘴说上 ${years.toFixed(2)} 年。`
  })
  return (
    <box flexDirection="column">
      <Heatmap api={props.api} daily={() => props.data().daily} weeks={weeks} />
      <box flexDirection="column" paddingTop={1}>
        <box flexDirection="row" paddingLeft={1}>
          <text fg={theme().textMuted}>常用模型: </text>
          <text fg={ORANGE}>{overview().favoriteModel ?? "—"}</text>
        </box>
        <StatRow api={props.api} ll="总 tokens" lv={fmtTokens(overview().totalTokens)} rl="总花费" rv={fmtCost(overview().cost)} />
        <StatRow api={props.api} ll="输入" lv={fmtTokens(overview().input)} rl="会话" rv={String(overview().sessions)} />
        <StatRow api={props.api} ll="输出" lv={fmtTokens(overview().output)} rl="消息" rv={String(overview().messages)} />
        <StatRow api={props.api} ll="缓存" lv={fmtTokens(overview().cache)} rl="提问" rv={String(overview().prompts)} />
        <StatRow api={props.api} ll="模型数" lv={String(overview().modelsUsed)} rl="活跃天数" rv={`${overview().activeDays} / ${overview().spanDays}`} />
        <StatRow api={props.api} ll="连续天数" lv={`最长 ${overview().longestStreak} · 当前 ${overview().currentStreak}`} />
      </box>
      <box paddingTop={1}>
        <text fg={theme().textMuted}>{factoid()}</text>
      </box>
    </box>
  )
}

function Hint(props: { api: TuiPluginApi; tab: () => number }) {
  const theme = () => props.api.theme.current
  const text = () => {
    const select = props.tab() === 0 ? "" : " | j/k 选择"
    return ` <tab> ←/→ h/l 切页 | r 切范围 | 1/2/3 选范围${select} | q 退出`
  }
  return (
    <box paddingTop={1}>
      <text fg={theme().textMuted}>{text()}</text>
    </box>
  )
}

function StatsPanel(props: { api: TuiPluginApi; state: () => StatsState; reload: (range: TimeRange) => void }) {
  const api = props.api
  const theme = () => api.theme.current
  const dims = useTerminalDimensions()
  const cols = createMemo(() => clamp((dims().width || 80) - 10, 24, 58))
  const [tab, setTab] = createSignal(0)
  const [range, setRange] = createSignal<TimeRange>("all")
  const [modelSel, setModelSel] = createSignal(0)
  const [providerSel, setProviderSel] = createSignal(0)

  function pickRange(next: TimeRange): void {
    if (next === range()) return
    setRange(next)
    props.reload(next)
  }

  function cycleRange(): void {
    const order: TimeRange[] = ["all", "7d", "30d"]
    pickRange(order[(order.indexOf(range()) + 1) % order.length])
  }

  function moveSelection(delta: number): void {
    const data = props.state().data
    if (!data) return
    if (tab() === 1 && data.models.length > 0) setModelSel((i) => clamp(i + delta, 0, data.models.length - 1))
    else if (tab() === 2 && data.providers.length > 0) setProviderSel((i) => clamp(i + delta, 0, data.providers.length - 1))
  }

  useKeyboard((evt) => {
    const name = evt.name
    if (name === "q" || name === "escape") {
      evt.preventDefault()
      evt.stopPropagation()
      api.ui.dialog.clear()
      return
    }
    if (name === "tab" || name === "right" || name === "l") {
      evt.preventDefault()
      evt.stopPropagation()
      setTab((t) => (t + 1) % 3)
      return
    }
    if (name === "left" || name === "h") {
      evt.preventDefault()
      evt.stopPropagation()
      setTab((t) => (t + 2) % 3)
      return
    }
    if (name === "r") {
      evt.preventDefault()
      evt.stopPropagation()
      cycleRange()
      return
    }
    if (name === "1" || name === "2" || name === "3") {
      evt.preventDefault()
      evt.stopPropagation()
      pickRange(RANGES[Number(name) - 1][0])
      return
    }
    if (name === "up" || name === "k") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelection(-1)
      return
    }
    if (name === "down" || name === "j") {
      evt.preventDefault()
      evt.stopPropagation()
      moveSelection(1)
    }
  })

  return (
    <box overflow="hidden" paddingTop={1} paddingBottom={1} flexDirection="column">
      <Header api={api} tab={tab} range={range} />
      <text fg={theme().textMuted}>{"─".repeat(cols())}</text>
      <Show when={!props.state().loading} fallback={<text fg={theme().textMuted}> 统计中…（读取本地会话库）</text>}>
        <Show when={!props.state().error} fallback={<text fg={theme().error}> {props.state().error}</text>}>
          <Show when={props.state().data} fallback={<text fg={theme().textMuted}> 暂无数据</text>}>
            {(data) => (
              <box flexDirection="column">
                <Switch>
                  <Match when={tab() === 0}>
                    <OverviewBody api={api} data={data} cols={cols} />
                  </Match>
                  <Match when={tab() === 1}>
                    <SeriesBody
                      api={api}
                      list={() => data().models}
                      dailyBy={() => data().dailyByModel}
                      daily={() => data().daily}
                      index={modelSel}
                      cols={cols}
                    />
                  </Match>
                  <Match when={tab() === 2}>
                    <SeriesBody
                      api={api}
                      list={() => data().providers}
                      dailyBy={() => data().dailyByProvider}
                      daily={() => data().daily}
                      index={providerSel}
                      cols={cols}
                    />
                  </Match>
                </Switch>
              </box>
            )}
          </Show>
        </Show>
      </Show>
      <Hint api={api} tab={tab} />
    </box>
  )
}

export function openStatsDialog(api: TuiPluginApi, state: () => StatsState, reload: (range: TimeRange) => void): void {
  api.ui.dialog.setSize("xlarge")
  api.ui.dialog.replace(() => <StatsPanel api={api} state={state} reload={reload} />)
}
