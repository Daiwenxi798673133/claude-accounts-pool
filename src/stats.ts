import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export type TimeRange = "all" | "7d" | "30d"

export type Overview = {
  totalTokens: number
  input: number
  output: number
  cache: number
  cost: number
  sessions: number
  messages: number
  prompts: number
  modelsUsed: number
  activeDays: number
  spanDays: number
  favoriteModel?: string
  longestStreak: number
  currentStreak: number
}

export type GroupStat = {
  id: string
  messages: number
  input: number
  output: number
  cache: number
  cost: number
  pct: number
  sessions: number
  activeDays: number
  prompts: number
  rate?: number
}

export type DailyPoint = { day: string; tokens: number }

export type StatsData = {
  overview: Overview
  models: GroupStat[]
  providers: GroupStat[]
  daily: DailyPoint[]
  dailyByModel: Record<string, DailyPoint[]>
  dailyByProvider: Record<string, DailyPoint[]>
}

export type RawRow = {
  t: number
  session: string
  role: string
  model: string | null
  provider: string | null
  input: number | null
  output: number | null
  cread: number | null
  cwrite: number | null
  cost: number | null
  tcreated: number | null
  tcompleted: number | null
}

function dbCandidates(): string[] {
  const list: string[] = []
  if (process.env.OPENCODE_DATA_DIR) list.push(join(process.env.OPENCODE_DATA_DIR, "opencode.db"))
  if (process.env.XDG_DATA_HOME) list.push(join(process.env.XDG_DATA_HOME, "opencode", "opencode.db"))
  list.push(join(homedir(), ".local", "share", "opencode", "opencode.db"))
  list.push(join(homedir(), "Library", "Application Support", "opencode", "opencode.db"))
  return list
}

export function resolveDbPath(): string | undefined {
  for (const candidate of dbCandidates()) if (existsSync(candidate)) return candidate
  return undefined
}

// One full-table scan pulling a flat projection of every message; all per-range
// aggregation then happens in memory so switching All/7d/30d never re-hits SQLite.
export function loadRows(): RawRow[] {
  const path = resolveDbPath()
  if (!path) throw new Error("找不到 opencode.db(设置 OPENCODE_DATA_DIR 或确认 OpenCode 已产生会话)")
  const db = new Database(path, { readonly: true })
  try {
    return db
      .query(
        `SELECT m.time_created AS t, m.session_id AS session,
           json_extract(m.data,'$.role') AS role,
           COALESCE(json_extract(m.data,'$.modelID'), json_extract(m.data,'$.model.modelID')) AS model,
           COALESCE(json_extract(m.data,'$.providerID'), json_extract(m.data,'$.model.providerID')) AS provider,
           CAST(json_extract(m.data,'$.tokens.input') AS INTEGER) AS input,
           CAST(json_extract(m.data,'$.tokens.output') AS INTEGER) AS output,
           CAST(json_extract(m.data,'$.tokens.cache.read') AS INTEGER) AS cread,
           CAST(json_extract(m.data,'$.tokens.cache.write') AS INTEGER) AS cwrite,
           CAST(json_extract(m.data,'$.cost') AS REAL) AS cost,
           CAST(json_extract(m.data,'$.time.created') AS INTEGER) AS tcreated,
           CAST(json_extract(m.data,'$.time.completed') AS INTEGER) AS tcompleted
         FROM message m`,
      )
      .all() as RawRow[]
  } finally {
    db.close()
  }
}

const DAY_MS = 86_400_000

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

function localDay(t: number): string {
  const d = new Date(t)
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function dayToMs(day: string): number {
  return new Date(`${day}T00:00:00Z`).getTime()
}

function streaks(activeDays: string[]): { longest: number; current: number } {
  if (activeDays.length === 0) return { longest: 0, current: 0 }
  const sorted = [...new Set(activeDays)].sort()
  let longest = 1
  let run = 1
  for (let i = 1; i < sorted.length; i++) {
    if (dayToMs(sorted[i]) - dayToMs(sorted[i - 1]) === DAY_MS) longest = Math.max(longest, ++run)
    else run = 1
  }
  const today = new Date()
  today.setUTCHours(0, 0, 0, 0)
  const last = dayToMs(sorted[sorted.length - 1])
  if (today.getTime() - last > DAY_MS) return { longest, current: 0 }
  let current = 1
  let cursor = last
  for (let i = sorted.length - 2; i >= 0; i--) {
    if (cursor - dayToMs(sorted[i]) === DAY_MS) {
      current++
      cursor = dayToMs(sorted[i])
    } else break
  }
  return { longest, current }
}

type Acc = {
  messages: number
  input: number
  output: number
  cache: number
  cost: number
  durMs: number
  prompts: number
  sessions: Set<string>
  days: Set<string>
  dayTokens: Map<string, number>
}

function newAcc(): Acc {
  return { messages: 0, input: 0, output: 0, cache: 0, cost: 0, durMs: 0, prompts: 0, sessions: new Set(), days: new Set(), dayTokens: new Map() }
}

function groupStats(byId: Map<string, Acc>): { stats: GroupStat[]; daily: Record<string, DailyPoint[]> } {
  let ioTotal = 0
  for (const acc of byId.values()) ioTotal += acc.input + acc.output
  if (ioTotal <= 0) ioTotal = 1

  const stats: GroupStat[] = []
  const daily: Record<string, DailyPoint[]> = {}
  for (const [id, acc] of byId) {
    const durSec = acc.durMs / 1000
    stats.push({
      id,
      messages: acc.messages,
      input: acc.input,
      output: acc.output,
      cache: acc.cache,
      cost: acc.cost,
      pct: ((acc.input + acc.output) / ioTotal) * 100,
      sessions: acc.sessions.size,
      activeDays: acc.days.size,
      prompts: acc.prompts,
      rate: durSec > 0 ? acc.output / durSec : undefined,
    })
    daily[id] = [...acc.dayTokens.entries()].map(([day, tokens]) => ({ day, tokens })).sort((a, b) => a.day.localeCompare(b.day))
  }
  stats.sort((a, b) => b.input + b.output - (a.input + a.output))
  return { stats, daily }
}

export function aggregate(rows: RawRow[], range: TimeRange = "all"): StatsData {
  const now = Date.now()
  const cutoff = range === "7d" ? now - 7 * DAY_MS : range === "30d" ? now - 30 * DAY_MS : 0

  const total = newAcc()
  const byModel = new Map<string, Acc>()
  const byProvider = new Map<string, Acc>()
  const dayTokens = new Map<string, number>()
  let messages = 0
  let prompts = 0

  const bump = (map: Map<string, Acc>, key: string | null): Acc | undefined => {
    if (!key) return undefined
    let acc = map.get(key)
    if (!acc) {
      acc = newAcc()
      map.set(key, acc)
    }
    return acc
  }

  for (const r of rows) {
    if (r.t < cutoff) continue
    messages++
    total.sessions.add(r.session)
    if (r.role === "user") {
      prompts++
      const gm = bump(byModel, r.model)
      if (gm) gm.prompts++
      const gp = bump(byProvider, r.provider)
      if (gp) gp.prompts++
      continue
    }
    if (r.role !== "assistant") continue

    const input = r.input ?? 0
    const output = r.output ?? 0
    const cache = (r.cread ?? 0) + (r.cwrite ?? 0)
    const cost = r.cost ?? 0
    const dur = r.tcompleted && r.tcreated && r.tcompleted > r.tcreated ? r.tcompleted - r.tcreated : 0
    const day = localDay(r.t)

    total.messages++
    total.input += input
    total.output += output
    total.cache += cache
    total.cost += cost
    total.days.add(day)
    dayTokens.set(day, (dayTokens.get(day) ?? 0) + input + output)

    for (const [map, key] of [
      [byModel, r.model],
      [byProvider, r.provider],
    ] as const) {
      const acc = bump(map, key)
      if (!acc) continue
      acc.messages++
      acc.input += input
      acc.output += output
      acc.cache += cache
      acc.cost += cost
      acc.durMs += dur
      acc.sessions.add(r.session)
      acc.days.add(day)
      acc.dayTokens.set(day, (acc.dayTokens.get(day) ?? 0) + input + output)
    }
  }

  const model = groupStats(byModel)
  const provider = groupStats(byProvider)
  const daily: DailyPoint[] = [...dayTokens.entries()].map(([day, tokens]) => ({ day, tokens })).sort((a, b) => a.day.localeCompare(b.day))
  const { longest, current } = streaks([...total.days])
  const firstDay = daily.length > 0 ? daily[0].day : undefined
  const spanDays = firstDay ? Math.floor((now - dayToMs(firstDay)) / DAY_MS) + 1 : total.days.size
  const favorite = [...model.stats].sort((a, b) => b.messages - a.messages)[0]?.id

  return {
    overview: {
      totalTokens: total.input + total.output + total.cache,
      input: total.input,
      output: total.output,
      cache: total.cache,
      cost: total.cost,
      sessions: total.sessions.size,
      messages,
      prompts,
      modelsUsed: model.stats.length,
      activeDays: total.days.size,
      spanDays,
      favoriteModel: favorite,
      longestStreak: longest,
      currentStreak: current,
    },
    models: model.stats,
    providers: provider.stats,
    daily,
    dailyByModel: model.daily,
    dailyByProvider: provider.daily,
  }
}

export function collectStats(range: TimeRange = "all"): StatsData {
  return aggregate(loadRows(), range)
}
