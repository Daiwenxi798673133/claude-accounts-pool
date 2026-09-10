// Replay a master log and answer "is the pool churning accounts, and what is it costing us".
//
// WHY THIS EXISTS AS A COMMITTED TOOL rather than a one-off query. Anthropic isolates prompt caches
// per organization, and every pooled account is its own organization, so moving a live session to
// another account throws away the whole cached prefix: the new account pays a full-context cache
// WRITE at 2x base input where a hit would have cost 0.1x. A switch during active work therefore
// costs roughly twenty ordinary turns of that account's window, and the master log is the ONLY place
// that records how often the pool does it. Every policy proposal for this pool has to be checked
// against that history before it ships — one candidate (a per-worker circuit breaker limiting how
// many fresh accounts a worker may burn per window) looked obviously right and turned out to prevent
// only about a tenth of the observed exhaustions, which is a thing worth finding out for free.
//
// PURE ON PURPOSE, per scripts/AGENTS.md: everything here takes text and returns numbers, so the CLI
// owns all the IO and this half can be tested without a log file on disk.

// A parsed log line. `fields` keeps the raw key=value tail because the interesting keys differ per
// message and new ones get added by the master faster than this tool needs to know about them.
export type LogEvent = {
  at: number
  msg: string
  fields: Record<string, string>
}

const LINE_RE = /timestamp=(\S+) level=\w+ run=\S+ message="claude-accounts-usage ([^"]+)"(.*)/
const FIELD_RE = /(\w+)=("[^"]*"|\S+)/g

export function parseLeaseLog(text: string): LogEvent[] {
  const events: LogEvent[] = []
  for (const line of text.split("\n")) {
    const match = LINE_RE.exec(line)
    if (!match) continue
    const at = Date.parse(match[1])
    if (!Number.isFinite(at)) continue
    const fields: Record<string, string> = {}
    for (const [, key, value] of match[3].matchAll(FIELD_RE)) fields[key] = value.replace(/^"|"$/g, "")
    events.push({ at, msg: match[2], fields })
  }
  return events
}

// Which selection path each served lease took. THE HEADLINE METRIC: `election` is the path that can
// move a worker off a healthy account, and every one of those during active work is a discarded
// prompt cache. `incumbentAffinity` is the master's own book answering for a worker that forgot what
// it held — before that book existed those leases were all elections instead.
export type PathCounts = {
  election: number
  incumbentWorker: number
  incumbentAffinity: number
  preferred: number
  misattributed: number
}

// How close a companion line has to be to count as explaining the lease it belongs to. The master
// emits the reason and then serves within the same request, so this only has to clear scheduling
// jitter — wide enough to survive a slow refresh, far below the renewal cadence.
const PAIR_WINDOW_MS = 3_000

// A rate limit this recently is treated as the reason a worker moved. Deliberately generous: the
// report and the switch are separate requests and a worker retries in between, so a tight window
// would misfile forced rotations as gratuitous ones and overstate the waste this tool is measuring.
const CAUSE_WINDOW_MS = 20 * 60_000

// One worker reaching this many DISTINCT accounts inside CASCADE_WINDOW_MS. The shape of a pool being
// walked to death: each move rewrites the full context onto a fresh window, so a worker with a large
// session can retire several accounts faster than any of them can reset.
const CASCADE_MIN_ACCOUNTS = 3
const CASCADE_WINDOW_MS = 90 * 60_000

function nearestBefore(times: readonly number[], at: number, within: number): boolean {
  return times.some((t) => t <= at && at - t <= within)
}

export type Switch = {
  at: number
  workerId: string
  from: string
  to: string
  dwellMs: number
}

export type Cascade = {
  at: number
  workerId: string
  accounts: number
  spanMs: number
}

export type Summary = {
  from: number
  to: number
  leases: number
  paths: PathCounts
  switches: number
  // Switches with no rate limit anywhere near them. Before reading this as pure waste, note the
  // caveat the CLI prints: a switch after the prompt cache has already expired costs nothing extra,
  // and this log cannot tell an idle worker from a busy one.
  switchesWithoutLimit: number
  rateLimits: number
  // Rate limits that landed on an account nobody had reported spent in the five hours before this
  // worker adopted it — an account that was, as far as the pool knew, fresh when it was handed over.
  limitsOnCleanAccounts: number
  limitsWithinHourOfAdoption: number
  dwellBeforeLimitMs: { p25: number; median: number; p75: number }
  cascades: Cascade[]
  burnRatesPerHour: Record<string, number[]>
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

export function summarize(events: readonly LogEvent[]): Summary {
  const served = events.filter((e) => e.msg === "master:lease-served" && e.fields.workerId && e.fields.accountId)
  const limits = events.filter((e) => e.msg === "master:ratelimit-reported" && e.fields.workerId && e.fields.accountId)

  // Companion lines indexed by worker so a served lease can be attributed to the path that produced
  // it. Keyed on the message AND the worker: two workers renewing in the same instant must not lend
  // each other an explanation.
  const companions = new Map<string, number[]>()
  const affinityFlags = new Map<string, string[]>()
  for (const event of events) {
    const workerId = event.fields.workerId
    if (!workerId) continue
    if (event.msg === "master:lease-incumbent") {
      const key = `incumbent|${workerId}`
      companions.set(key, [...(companions.get(key) ?? []), event.at])
      // `source` was added with the affinity book; a log predating it has neither the field nor the
      // behaviour, and an absent value is reported as the worker's own claim rather than guessed at.
      affinityFlags.set(key, [...(affinityFlags.get(key) ?? []), event.fields.source ?? "worker"])
    } else if (event.msg === "master:lease-preferred" || event.msg === "master:lease-ratelimit-misattributed") {
      const key = `${event.msg}|${workerId}`
      companions.set(key, [...(companions.get(key) ?? []), event.at])
    }
  }

  const paths: PathCounts = { election: 0, incumbentWorker: 0, incumbentAffinity: 0, preferred: 0, misattributed: 0 }
  for (const lease of served) {
    const workerId = lease.fields.workerId
    const incumbentKey = `incumbent|${workerId}`
    const incumbentTimes = companions.get(incumbentKey) ?? []
    const matchIndex = incumbentTimes.findIndex((t) => Math.abs(t - lease.at) <= PAIR_WINDOW_MS)
    if (matchIndex >= 0) {
      if ((affinityFlags.get(incumbentKey) ?? [])[matchIndex] === "affinity") paths.incumbentAffinity++
      else paths.incumbentWorker++
      continue
    }
    if ((companions.get(`master:lease-preferred|${workerId}`) ?? []).some((t) => Math.abs(t - lease.at) <= PAIR_WINDOW_MS)) {
      paths.preferred++
      continue
    }
    if (
      (companions.get(`master:lease-ratelimit-misattributed|${workerId}`) ?? []).some(
        (t) => Math.abs(t - lease.at) <= PAIR_WINDOW_MS,
      )
    ) {
      paths.misattributed++
      continue
    }
    paths.election++
  }

  // Per-worker account timeline, from which a switch is any change of account between consecutive
  // leases. Resolution is the renewal cadence, so a worker that moved and came back inside one cycle
  // is invisible here — this undercounts churn and never overcounts it.
  const timelines = new Map<string, { at: number; accountId: string }[]>()
  for (const lease of served) {
    const workerId = lease.fields.workerId
    timelines.set(workerId, [...(timelines.get(workerId) ?? []), { at: lease.at, accountId: lease.fields.accountId }])
  }

  const switches: Switch[] = []
  const arrivals = new Map<string, { at: number; accountId: string }[]>()
  for (const [workerId, rows] of timelines) {
    rows.sort((a, b) => a.at - b.at)
    let current: string | undefined
    let since = 0
    for (const row of rows) {
      if (current === undefined) {
        current = row.accountId
        since = row.at
        arrivals.set(workerId, [{ at: row.at, accountId: row.accountId }])
        continue
      }
      if (row.accountId === current) continue
      switches.push({ at: row.at, workerId, from: current, to: row.accountId, dwellMs: row.at - since })
      current = row.accountId
      since = row.at
      arrivals.set(workerId, [...(arrivals.get(workerId) ?? []), { at: row.at, accountId: row.accountId }])
    }
  }

  const limitsByWorkerAccount = new Map<string, number[]>()
  const limitsByAccount = new Map<string, number[]>()
  for (const limit of limits) {
    const wa = `${limit.fields.workerId}|${limit.fields.accountId}`
    limitsByWorkerAccount.set(wa, [...(limitsByWorkerAccount.get(wa) ?? []), limit.at])
    const account = limit.fields.accountId
    limitsByAccount.set(account, [...(limitsByAccount.get(account) ?? []), limit.at])
  }

  let switchesWithoutLimit = 0
  for (const move of switches) {
    const own = limitsByWorkerAccount.get(`${move.workerId}|${move.from}`) ?? []
    const anyone = limitsByAccount.get(move.from) ?? []
    if (!nearestBefore(own, move.at, CAUSE_WINDOW_MS) && !nearestBefore(anyone, move.at, CAUSE_WINDOW_MS)) {
      switchesWithoutLimit++
    }
  }

  const dwellBeforeLimit: number[] = []
  let limitsOnCleanAccounts = 0
  let limitsWithinHourOfAdoption = 0
  for (const limit of limits) {
    const workerId = limit.fields.workerId
    const accountId = limit.fields.accountId
    const adopted = (arrivals.get(workerId) ?? [])
      .filter((a) => a.accountId === accountId && a.at <= limit.at)
      .map((a) => a.at)
      .pop()
    if (adopted === undefined) continue
    const dwell = limit.at - adopted
    dwellBeforeLimit.push(dwell)
    if (dwell <= 60 * 60_000) limitsWithinHourOfAdoption++
    // "Clean at handover": nobody had reported this account spent in the five hours before this
    // worker took it. An account that dies shortly after being adopted clean is one the pool
    // believed was healthy, which is the case a capacity check could have refused.
    const prior = (limitsByAccount.get(accountId) ?? []).filter((t) => t < adopted && adopted - t <= 5 * 3_600_000)
    if (prior.length === 0) limitsOnCleanAccounts++
  }
  dwellBeforeLimit.sort((a, b) => a - b)

  const perWorkerLimits = new Map<string, { at: number; accountId: string }[]>()
  for (const limit of limits) {
    const workerId = limit.fields.workerId
    perWorkerLimits.set(workerId, [
      ...(perWorkerLimits.get(workerId) ?? []),
      { at: limit.at, accountId: limit.fields.accountId },
    ])
  }
  const cascades: Cascade[] = []
  for (const [workerId, rows] of perWorkerLimits) {
    rows.sort((a, b) => a.at - b.at)
    for (let i = 0; i < rows.length; i++) {
      const seen = new Set<string>([rows[i].accountId])
      let last = i
      for (let j = i + 1; j < rows.length && rows[j].at - rows[i].at <= CASCADE_WINDOW_MS; j++) {
        seen.add(rows[j].accountId)
        last = j
      }
      if (seen.size < CASCADE_MIN_ACCOUNTS) continue
      // Overlapping runs describe ONE episode; keep the first and skip the rest of its window.
      const previous = cascades[cascades.length - 1]
      if (previous?.workerId === workerId && rows[i].at - previous.at <= CASCADE_WINDOW_MS) continue
      cascades.push({ at: rows[i].at, workerId, accounts: seen.size, spanMs: rows[last].at - rows[i].at })
    }
  }
  cascades.sort((a, b) => a.at - b.at)

  const burnRatesPerHour: Record<string, number[]> = {}
  for (const event of events) {
    if (event.msg !== "master:burn-observed") continue
    for (const [prefix, raw] of Object.entries(event.fields)) {
      const rate = Number(raw)
      if (!Number.isFinite(rate)) continue
      burnRatesPerHour[prefix] = [...(burnRatesPerHour[prefix] ?? []), rate]
    }
  }

  return {
    from: events.length > 0 ? events[0].at : 0,
    to: events.length > 0 ? events[events.length - 1].at : 0,
    leases: served.length,
    paths,
    switches: switches.length,
    switchesWithoutLimit,
    rateLimits: limits.length,
    limitsOnCleanAccounts,
    limitsWithinHourOfAdoption,
    dwellBeforeLimitMs: {
      p25: percentile(dwellBeforeLimit, 0.25),
      median: percentile(dwellBeforeLimit, 0.5),
      p75: percentile(dwellBeforeLimit, 0.75),
    },
    cascades,
    burnRatesPerHour,
  }
}
