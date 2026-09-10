import { providerOf, type StoredAccount } from "../accounts.ts"
import type { LeaseRefusal } from "../cloud/protocol.ts"
import { MASTER_USAGE_POLL_INTERVAL_MS, MAX_ACCOUNT_HOLDERS } from "../constants.ts"
import { log } from "../logger.ts"
import { latestMaxedReset, type NormalizedWindow, PROVIDERS, scoreWindows } from "../providers.ts"
import type { UsageResponse } from "../usage.ts"

// Which account should the next lease use? That is the whole job of this module: no network, no
// token handling, no disk. Usage snapshots arrive from outside via setUsageCache.
//
// The cooldown model below is REIMPLEMENTED from src/autoswitch.ts rather than imported, and that
// is deliberate: autoswitch owns TUI concerns (it takes a TuiPluginApi, subscribes to session
// events, toasts, opens dialogs, re-prompts sessions), so importing it here would drag a whole TUI
// runtime into a headless master process and make this module untestable without one. Only the
// proven slice is carried over — the two-map cooldown book and the pool filter — and the shared
// PURE helpers (scoreWindows / latestMaxedReset / PROVIDERS.anthropic.normalize) really are
// imported, so scoring and reset resolution keep exactly one implementation.
//
// STICKY ON RENEWAL, AND THAT REVERSES WHAT THIS FILE SAID FOR MOST OF ITS LIFE. The old rule was
// "no worker→account affinity, ever" — maximum throughput (usage-based rotation) chosen over
// prompt-cache locality, with pickPreferred explicitly not an exception because it remembered nothing
// about who asked. The pool owner rejected that default after living with it: re-ranking on EVERY
// renewal moved a worker off a perfectly healthy account roughly every four hours over a few points
// of utilization, and from the outside it read as the pool switching accounts for no reason.
//
// pickIncumbent is the amendment. A routine renewal KEEPS its account; only an account that cannot be
// served moves the worker — and `cooling` is one of those, so stickiness ends exactly where a
// subscription limit begins. Ranking still owns every FIRST pick and every rotation.
//
// The old promise is quoted rather than deleted because it was load-bearing: anything written against
// "a worker never stays put" is now wrong, and a silent replacement would hide that.
//
// THE PIN IS NARROWER THAN THE NEW DEFAULT, NOT WIDER, which is most of what is left of it: renewal
// stickiness holds whatever account you are on until it becomes unservable, while a pin holds ONE
// NAMED account and overrides the `excluded` flag (pickPreferred does not refuse it, pickIncumbent
// does). The FLAG on the lease book still serves exactly two read-only purposes — telling the
// dashboard which holders will not move, and steering a pick for a DIFFERENT worker around the
// reservation.
//
// The lease book below is NOT the affinity that paragraph forbids — it is its OPPOSITE. It remembers
// who holds what in order to push the next lease AWAY from an account already in use, so two workers
// stop racing to the same "emptiest" account and burning one subscription window at double rate while
// the rest of the pool idles. Affinity would pull a worker BACK to the account it left; this pushes
// every worker apart. Do not let it grow into the former.
//
// AND NOW THERE IS AN AFFINITY BOOK — added as a SECOND map rather than by loosening the one above,
// so the instruction in that paragraph still holds literally: the two books answer different
// questions ("who is on this account right now" vs "where was this worker working") and must be able
// to disagree.
//
// MEASURED CAUSE, not a preference. pickIncumbent can only fire when the RENEWAL CARRIES
// `currentAccountId`, and that value lives in a worker process's memory (`heldAccountId` in
// src/worker/leaseKeeper.ts), seeded at startup only when a still-warm lease is found. A machine that
// slept, or an omo host restarted past its lease horizon, therefore renews with NO incumbent hint and
// gets a fresh election. Over six weeks of master log the election path took 59.3% of all leases while
// the documented sticky path took 17.2%, and 518 of the last 639 elections had no rate limit anywhere
// near them. So the master remembers the binding ITSELF instead of trusting the worker to.
//
// WHY IT IS WORTH A PERSISTED MAP: Anthropic caches prompt prefixes per ORGANIZATION ("Different
// organizations never share caches, even if they use identical prompts"), and every pooled account is
// its own organization. Each of those elections moved a live session onto a cold cache, making the new
// account pay a full-context cache WRITE at 2x base input against 0.1x for a read — a switch during
// active work costs roughly twenty ordinary turns of that account's window.
//
// STILL NOT A RESERVATION, and every existing refusal outranks it: the recalled id goes through
// pickIncumbent unchanged, so cooling, needsReauth, excluded, and "another slot of this worker already
// holds it" all still move the worker. This book only supplies the hint the worker forgot.
//
// KEYED BY workerId, exactly as the lease book is, which inherits the same multi-slot limitation:
// senpi runs several slots under ONE workerId, so a recall serves whichever slot asks first and the
// siblings fall through to the ranked pick via `excludeIds`. Strictly better than forgetting outright,
// never worse — and NOT a reason to put slot identity on the wire, which is a protocol change.

const COOLDOWN_KV_KEY = "claude-accounts-usage.master.cooldown"

// A SEPARATE key from the cooldown book on purpose: one holds "which accounts are spent", the other
// "who was working where". Sharing a record would let one malformed half discard the other.
const AFFINITY_KV_KEY = "claude-accounts-usage.master.affinity"

// How long a binding still answers after that worker was last served. Covers the gap this book exists
// for — an overnight sleep or an editor restart; every cold start observed in the log was past three
// hours — while still letting a worker gone for a day rejoin through the ranked pick, which is where
// the pool gets its chance to rebalance. It also bounds the stored object: a label that never comes
// back leaves at most a day of entries behind.
//
// DELIBERATELY NOT the prompt cache's own lifetime, which is an hour on a subscription. A binding
// older than that no longer saves a cache write, but it still keeps one worker's usage on ONE
// subscription instead of smeared across the pool, and that is worth keeping past the point where the
// cache has gone cold.
const AFFINITY_TTL_MS = 24 * 60 * 60_000

// How much of the utilization series to keep per account. The poller sweeps every
// MASTER_USAGE_POLL_INTERVAL_MS, so an hour is about a dozen samples — enough that one noisy sweep
// cannot dominate the slope, short enough that the answer describes what this account is doing NOW
// rather than what it did before lunch. Derived from the poll interval for the same reason
// USAGE_CACHE_TTL_MS is: changing the cadence must not silently change what "recent" means.
const BURN_HISTORY_MS = 12 * MASTER_USAGE_POLL_INTERVAL_MS

// A drop this large reads as a WINDOW RESET rather than as negative consumption, and the series
// restarts there. Quota does not un-spend itself, so a real decline can only mean the window rolled
// over; averaging across that boundary would report a negative burn rate for an account that just
// got its capacity back — the single most dangerous number to be wrong about, because it makes an
// account look infinitely durable exactly when it is about to be handed to somebody.
const BURN_RESET_DROP = 5

// A snapshot older than two whole poll intervals means POLLING is broken, not that the accounts are
// idle — `/api/oauth/usage` is known to stay angry long past the request that upset it. Ranking by
// numbers that stale keeps aiming every worker at an account that has since been drained, so past
// this age the pick falls back to round-robin. Derived from the poll interval so changing the poll
// cadence cannot silently invalidate this window.
const USAGE_CACHE_TTL_MS = 2 * MASTER_USAGE_POLL_INTERVAL_MS

// How long after a worker MOVES to an account this master refuses to believe that worker's
// rate-limit report about it. A worker that has held an account for seconds cannot have spent a
// five-hour window on it — the report is a failure that predates the move, blamed on the account
// the worker had already adopted by the time it handled the error.
//
// MEASURED, not guessed: one real cascade on a machine running four OpenCode processes off a single
// shared auth.json reported three different accounts in eight seconds (gaps of 3.0s and 4.5s), and
// cooled two healthy ones. The window has to clear the widest observed gap with room, and it can
// afford to: the cost of an over-long window is at most ONE wasted retry on an account that really
// was spent, while the cost of an under-short one is a healthy account pulled out of the pool.
export const RATELIMIT_ADOPTION_GRACE_MS = 15_000

export type SchedulerDeps = {
  kv: { get: <V>(key: string, fallback?: V) => V; set: (key: string, value: unknown) => void }
  // Injected so tests can drive recovery deterministically. EVERY time read in this module goes
  // through it; a stray Date.now() would silently escape the injected clock.
  now?: () => number
}

export type UsageSnapshotEntry = { id: string; usage: UsageResponse }

// The READ-ONLY view of the poller's latest sweep, for the master's usage dashboard.
//
// `stale` is decided HERE, not by the caller, because USAGE_CACHE_TTL_MS is the very threshold past
// which this scheduler stops ranking by these numbers. A dashboard drawing its own line — even from
// an exported copy of the constant — could show a green light for a snapshot selection has already
// abandoned, which is the one thing a monitoring surface may never do.
export type UsageSnapshot = {
  // Epoch ms of the last completed sweep, `0` when none has ever completed — which reads as stale
  // by construction rather than needing a separate "no data yet" flag.
  at: number
  stale: boolean
  byId: Map<string, UsageResponse>
}

export type PickInput = {
  accounts: StoredAccount[]
  // The account the caller is leaving (the worker's current lease), excluded from this pick and
  // used as the rotation anchor. NOT an affinity record — nothing here remembers the worker.
  exclude?: string
  // Whose request this is, so the holder count can DISCOUNT this worker's own outstanding lease.
  // Without it a routine renewal reads its own hold as contention and demotes the account it already
  // has, moving the worker off a perfectly good account roughly every four hours for no reason.
  workerId?: string
  // Accounts the caller already holds. Narrows the candidate list and NOTHING else — `exclude` stays
  // the rotation anchor, because "I am leaving A" and "A is already taken" are different claims and
  // conflating them would re-anchor the walk on an arbitrary member of this list.
  excludeIds?: readonly string[]
}

// What the operator's named account resolved to. A union rather than `StoredAccount | undefined`
// because the caller must tell the four refusals apart to say anything useful about them.
export type PreferredPick = { ok: true; account: StoredAccount } | { ok: false; refusal: LeaseRefusal }

export type PreferredInput = {
  accounts: StoredAccount[]
  // The prefix as the usage view published it (UsageAccountView.idPrefix), not a full account id.
  prefix: string
  // Whose request this is, so the capacity check can DISCOUNT this worker's own outstanding lease.
  // Without it an operator re-naming the account a worker already holds would be refused for a hold
  // that is about to be replaced rather than added to.
  workerId?: string
}

export type IncumbentInput = {
  accounts: StoredAccount[]
  // A FULL account id, not a prefix: this is the account the worker says it already holds, which it
  // learned from a lease this master minted — never something a human typed.
  accountId: string
  // The accounts this worker's OTHER slots already hold. A multi-slot worker renews slot by slot, and
  // holding the incumbent must never book one account into two slots of the same machine.
  excludeIds?: readonly string[]
}

export type Scheduler = {
  pickAccount: (input: PickInput) => StoredAccount | undefined
  pickPreferred: (input: PreferredInput) => PreferredPick
  // The account a routine renewal should KEEP, or undefined when keeping it is not possible and the
  // caller must fall back to a ranked pick. This is the pool's stickiness, and it lives here rather
  // than in the lease route because it is a selection policy like every other one in this file.
  pickIncumbent: (input: IncumbentInput) => StoredAccount | undefined
  // `workerId` names who is reporting, so a report about an account that worker adopted seconds ago
  // can be discarded as misattributed (RATELIMIT_ADOPTION_GRACE_MS). Optional because the report is
  // best-effort telemetry: a caller that cannot say who it is still gets its account cooled.
  reportRateLimit: (accountId: string, resetsAt?: number, workerId?: string) => void
  setUsageCache: (entries: UsageSnapshotEntry[]) => void
  isCoolingDown: (accountId: string) => boolean
  getUsageSnapshot: () => UsageSnapshot
  // Called once per lease actually SERVED, never on one merely picked: a pick that then fails to mint
  // a token leaves the worker holding whatever it had, and booking that account would make the pool
  // steer around a hold nobody has.
  recordLease: (input: { workerId: string; accountId: string; expiresAt: number; pinned: boolean }) => void
  // Did this worker MOVE to this account within RATELIMIT_ADOPTION_GRACE_MS? Exposed so the lease
  // route can spare a `ratelimit` request the pointless rotation whose report it is already about
  // to discard — one judgement, both decisions, so the two can never disagree.
  justAdopted: (workerId: string, accountId: string) => boolean
  holdersOf: (accountId: string) => string[]
  // The subset of holdersOf that PINNED this account. A subset by construction — the flag lives on the
  // lease record — which is the invariant both renderers of UsageAccountView.pinnedBy rely on.
  pinnersOf: (accountId: string) => string[]
  // The account this worker was last SERVED, for a renewal that arrives without `currentAccountId` —
  // which is what a worker that just restarted sends. Answers undefined past AFFINITY_TTL_MS, so a
  // long-absent label rejoins through ranking rather than being pulled back to a day-old account.
  recallAffinity: (workerId: string) => string | undefined
  // What this account's quota is DOING, not merely where it stands: utilization points per hour over
  // the retained series, plus when it reaches 100 at that rate. A level gauge cannot tell a 90%-and-idle
  // account from a 60%-and-collapsing one, and it is the SECOND that is about to refuse every request —
  // which is why ranking by level alone kept handing out accounts that died within the hour.
  //
  // undefined while the series is too short to have a slope. That is the honest answer and deliberately
  // NOT zero, which a caller would read as "idle, safe to load up".
  burnOf: (accountId: string) => { util: number; ratePerHour: number; exhaustsInMs?: number } | undefined
}

export function createScheduler(deps: SchedulerDeps): Scheduler {
  const now = deps.now ?? Date.now
  // Cooling with a KNOWN deadline. The only map that is ever persisted, because it is the only one
  // holding an instant that survives a restart.
  const cooldown = new Map<string, number>()
  // Cooling with an UNKNOWN deadline (INV-M2). The SOLE encoding of "cooling, deadline unknown" —
  // never a sentinel inside `cooldown`, never handed to scheduleRecovery, where a fabricated
  // deadline clamps to ~1ms and fires a FALSE recovery. Mirrors autoswitch's cooldownPending.
  const cooldownPending = new Set<string>()
  const recoveryTimers = new Map<string, ReturnType<typeof setTimeout>>()
  // WHO HOLDS WHAT, keyed by worker rather than by account. That direction is the whole design: a
  // worker writes its lease into ONE auth.json slot and so can hold exactly one account, which makes
  // a re-lease overwrite the previous entry and release the old account for free — no release verb on
  // the wire, and nothing for a worker that dies mid-switch to leak.
  //
  // NOT PERSISTED, deliberately, unlike the cooldown book: a restarted master has not served any of
  // these leases and cannot renew them, whereas the tokens themselves keep working until their own
  // expiry. Restoring the book would make the pool steer around holds it can no longer observe; an
  // empty one merely under-counts for at most one renewal cycle, after which every live worker has
  // re-registered itself by asking.
  //
  // `adoptedAt` is when this worker MOVED here, NOT when it last re-leased: a renewal or a re-serve
  // of the same account leaves it untouched. That distinction is what keeps the misattribution guard
  // from looping — a worker whose account really IS spent gets it handed straight back once, and the
  // second report lands outside the grace window and is believed.
  const leases = new Map<string, { accountId: string; expiresAt: number; pinned: boolean; adoptedAt: number }>()
  // WORKER → WHERE IT WAS WORKING. Unlike the lease book above this one IS persisted: its entire
  // purpose is to survive the restart that loses the worker's own copy of the same fact. `at` is the
  // last time this worker was served, which is what AFFINITY_TTL_MS is measured against.
  const affinity = new Map<string, { accountId: string; at: number }>()
  // Per-account utilization series, the raw material for burnOf. Bounded by BURN_HISTORY_MS and pruned
  // on write, so a master running for weeks holds at most an hour of samples per account. NOT persisted:
  // a slope stitched across a restart gap would span however long the process was down.
  const burnHistory = new Map<string, { at: number; util: number }[]>()
  let usageCache: { at: number; byId: Map<string, UsageResponse> } = { at: 0, byId: new Map() }
  // Rotation cursor for the no-usage-data path. An id, not an index, so it stays meaningful when
  // the caller's account list changes shape between picks.
  let lastPickedId: string | undefined

  function persistCooldown(): void {
    const at = now()
    const snapshot: Record<string, number> = {}
    for (const [id, until] of cooldown) if (until > at) snapshot[id] = until
    deps.kv.set(COOLDOWN_KV_KEY, snapshot)
  }

  // Lapsed entries leave on the way out, so the stored object stays bounded without a sweep timer —
  // the same shape persistCooldown uses. Deleting from a Map while iterating it is well-defined.
  function persistAffinity(): void {
    const at = now()
    const snapshot: Record<string, { accountId: string; at: number }> = {}
    for (const [workerId, bound] of affinity) {
      if (at - bound.at > AFFINITY_TTL_MS) {
        affinity.delete(workerId)
        continue
      }
      snapshot[workerId] = bound
    }
    deps.kv.set(AFFINITY_KV_KEY, snapshot)
  }

  // Swept on read as well as on write: a master that serves nobody for a day would otherwise keep
  // answering with bindings it has had no occasion to persist past.
  function recallAffinity(workerId: string): string | undefined {
    const bound = affinity.get(workerId)
    if (!bound) return undefined
    if (now() - bound.at > AFFINITY_TTL_MS) {
      affinity.delete(workerId)
      persistAffinity()
      return undefined
    }
    return bound.accountId
  }

  // Estimated recovery, exactly as in autoswitch: the deadline came from the caller (or from a
  // usage snapshot's resets_at), so an elapsed timer means the quota SHOULD be back. We do not
  // re-verify against the API before clearing — the account simply rejoins selection.
  function scheduleRecovery(id: string, until: number): void {
    const existing = recoveryTimers.get(id)
    if (existing) clearTimeout(existing)
    const timer = setTimeout(() => {
      recoveryTimers.delete(id)
      cooldown.delete(id)
      persistCooldown()
    }, Math.max(0, until - now()))
    // The pool's recovery clock must never be the reason a process stays alive; the master's HTTP
    // server owns that decision.
    timer.unref?.()
    recoveryTimers.set(id, timer)
  }

  function markCooldown(id: string, until?: number): void {
    if (until !== undefined && Number.isFinite(until)) {
      cooldownPending.delete(id)
      cooldown.set(id, until)
      persistCooldown()
      scheduleRecovery(id, until)
      return
    }
    // INV-M2: an unknown deadline must never DOWNGRADE a known one. Two workers holding the same
    // account both hit the limit; only one response carried an authoritative reset. Letting the
    // second report erase it would also cancel the scheduled recovery and strand the account until
    // the next usage poll.
    const active = cooldown.get(id)
    if (active !== undefined && active > now()) return
    // An expired-but-unswept entry is leaving the map, so the store has to hear about it.
    if (cooldown.delete(id)) persistCooldown()
    cooldownPending.add(id)
  }

  function clearCooldown(id: string): void {
    const timer = recoveryTimers.get(id)
    if (timer) {
      clearTimeout(timer)
      recoveryTimers.delete(id)
    }
    cooldownPending.delete(id)
    if (cooldown.delete(id)) persistCooldown()
  }

  function isCoolingDown(id: string): boolean {
    if (cooldownPending.has(id)) return true
    const until = cooldown.get(id)
    return until !== undefined && until > now()
  }

  // Swept on read rather than by a timer, exactly as the usage poller's own cooldown map: the book is
  // consulted nowhere else, and dropping the lapsed entry here keeps it from growing without bound
  // over a master that runs for weeks. An expired lease is not a hold — that token is already dead by
  // INV-CLOUD-4, and whoever held it will book its replacement by asking.
  function activeLeases(accountId: string, at: number, ignoreWorkerId?: string): { workerId: string; pinned: boolean }[] {
    const held: { workerId: string; pinned: boolean }[] = []
    for (const [workerId, hold] of leases) {
      if (hold.expiresAt <= at) {
        leases.delete(workerId)
        continue
      }
      if (hold.accountId !== accountId || workerId === ignoreWorkerId) continue
      held.push({ workerId, pinned: hold.pinned })
    }
    return held
  }

  // THE MISATTRIBUTION GUARD. A worker reports a rate limit against whatever account it believes it
  // holds, and that belief is a shared on-disk record every session and every OpenCode process on
  // that machine rewrites — so a failure raised on account A can arrive blaming account B, the one a
  // sibling adopted in the seconds between the failure and its handling. This master is the only
  // party that knows when each worker actually moved, so it is the only one that can tell the two
  // apart, which is why the check lives here and not on the worker.
  //
  // An EXPIRED lease answers false: the token is dead by INV-CLOUD-4, so whatever the worker just
  // hit, it was not this book's account.
  function justAdopted(workerId: string, accountId: string): boolean {
    const held = leases.get(workerId)
    if (!held || held.accountId !== accountId) return false
    const at = now()
    return held.expiresAt > at && at - held.adoptedAt < RATELIMIT_ADOPTION_GRACE_MS
  }

  function activeHolders(accountId: string, at: number, ignoreWorkerId?: string): string[] {
    return activeLeases(accountId, at, ignoreWorkerId).map((hold) => hold.workerId)
  }

  // Fewest CURRENT holders wins outright, ranked ABOVE utilization rather than blended with it. So an
  // account nobody holds beats an emptier one somebody is already on, and that ordering is the point:
  // two workers sharing an account burn a single five-hour window at double rate while the rest of the
  // pool idles, which costs the pool far more capacity than a few points of utilization ever does.
  //
  // A narrowing pass, deliberately NOT a term in `score`: holder count and utilization share no unit,
  // so any weighted sum of them would re-order silently as one side's scale drifted.
  function fewestHolders(candidates: StoredAccount[], at: number, workerId?: string): StoredAccount[] {
    const counts = new Map<string, number>()
    let fewest = Number.POSITIVE_INFINITY
    for (const account of candidates) {
      const count = activeHolders(account.id, at, workerId).length
      counts.set(account.id, count)
      if (count < fewest) fewest = count
    }
    return candidates.filter((account) => counts.get(account.id) === fewest)
  }

  // Steers a pick AWAY from an account somebody else has pinned, but only within the tier
  // fewestHolders already chose — deliberately WEAKER than holder count, and that ordering is the
  // whole correctness of it. A pinner IS a holder, so fewestHolders already demotes a pinned account
  // by one; ranking pin-avoidance ABOVE it would send this worker to a 3-holder account at 95% in
  // order to avoid an unshared one at 5%, which costs the pool far more than the reservation it was
  // protecting. Here it decides TIES only: two accounts held by one worker each, one of them pinned,
  // now resolve to the one whose holder is still free to rotate off.
  //
  // A PREFERENCE, NEVER A RESERVATION: if every candidate is pinned the whole list survives, because
  // a pool that refuses to serve its own accounts is worse for everyone than a shared window. Nothing
  // here can make a pin deny capacity.
  function unpinnedFirst(candidates: StoredAccount[], at: number, workerId?: string): StoredAccount[] {
    const free = candidates.filter((account) => activeLeases(account.id, at, workerId).every((hold) => !hold.pinned))
    return free.length > 0 ? free : candidates
  }

  // Pinned to the anthropic normalizer, matching the anthropic-only pool in pickAccount. `undefined`
  // scores +Infinity — the honest unknown, which sorts last rather than being guessed at.
  function score(id: string): number {
    const usage = usageCache.byId.get(id)
    return scoreWindows(usage ? PROVIDERS.anthropic.normalize(usage) : undefined)
  }

  // Lowest utilization wins; `undefined` means "rank tells us nothing, rotate instead".
  // Reduce rather than sort: two accounts with no snapshot both score +Infinity, and
  // `Infinity - Infinity` is NaN — a comparator returning NaN leaves the order engine-defined.
  // A strict `<` keeps the earlier candidate and stays deterministic.
  function rankByUsage(candidates: StoredAccount[], at: number): StoredAccount | undefined {
    if (at - usageCache.at > USAGE_CACHE_TTL_MS) return undefined
    // A snapshot covering none of the candidates is not data: every score would be +Infinity and
    // the "ranking" would freeze selection onto whichever account happens to come first.
    if (!candidates.some((account) => usageCache.byId.has(account.id))) return undefined
    let best = candidates[0]
    let bestScore = score(best.id)
    for (const account of candidates) {
      const value = score(account.id)
      if (value < bestScore) {
        best = account
        bestScore = value
      }
    }
    return best
  }

  // Anchor = the caller's `exclude` when given (it names the account the worker is leaving, fresher
  // than our own bookkeeping), else the last account handed out. Rotation walks the FULL pool order
  // rather than the candidate list, so a cooling account still holds its slot and the survivors keep
  // their relative turn order instead of reshuffling every time someone cools.
  function roundRobin(pool: StoredAccount[], candidates: StoredAccount[], exclude?: string): StoredAccount {
    const anchor = exclude ?? lastPickedId
    const start = anchor === undefined ? -1 : pool.findIndex((account) => account.id === anchor)
    for (let offset = 1; offset <= pool.length; offset++) {
      const id = pool[(start + offset + pool.length) % pool.length].id
      const match = candidates.find((account) => account.id === id)
      if (match) return match
    }
    // Unreachable while candidates ⊆ pool, which pickAccount guarantees; kept as the total return.
    return candidates[0]
  }

  function pickAccount(input: PickInput): StoredAccount | undefined {
    const at = now()
    // INV-M1: a lease is written into the worker's auth.json `anthropic` entry, so the pool is
    // ANTHROPIC-only. Read through providerOf, never `account.provider === "anthropic"`: every
    // record written before multi-provider support lacks the field and would be dropped.
    const pool = input.accounts.filter((account) => providerOf(account) === "anthropic")
    const candidates = pool.filter(
      (account) =>
        account.id !== input.exclude &&
        input.excludeIds?.includes(account.id) !== true &&
        !isCoolingDown(account.id) &&
        !account.excluded &&
        !account.needsReauth &&
        // THE HARD CEILING, and deliberately a REFUSAL rather than another narrowing pass like
        // fewestHolders below: that one only decides which account is nicer when several are free,
        // and it happily hands out a fifth seat on the emptiest account when every account is busy.
        // Past MAX_ACCOUNT_HOLDERS the answer has to be "not this one" even if the alternative is
        // no lease at all — a 503 costs one worker a retry, a shared window costs everyone on it.
        activeHolders(account.id, at, input.workerId).length < MAX_ACCOUNT_HOLDERS,
    )
    if (candidates.length === 0) return undefined
    // Narrowed by holder count FIRST, then ranked within that tier by the existing rules. Applying the
    // narrowing before rankByUsage rather than after is what makes it hold even with no usage data at
    // all: holder count is always known, so the round-robin fallback rotates within the least-held
    // tier instead of across the whole pool.
    const leastHeld = unpinnedFirst(fewestHolders(candidates, at, input.workerId), at, input.workerId)
    const picked = rankByUsage(leastHeld, at) ?? roundRobin(pool, leastHeld, input.exclude)
    lastPickedId = picked.id
    return picked
  }

  // The OPERATOR's pick, arriving as the prefix the usage view publishes. Deliberately NOT a branch
  // inside pickAccount: that function's whole job is to rank and rotate, and a named account must do
  // neither — the human has already decided.
  //
  // `excluded` IS NOT A REFUSAL HERE, unlike in pickAccount, and that asymmetry is the point: the
  // flag means "never AUTO-switch to this one", so a human naming it in a panel is the exact case it
  // does not cover. The other two flags are refusals because serving them cannot work: a cooling
  // account's quota is spent (its token is fine, so the switch would "succeed" and the next turn
  // would 429), and a needs-reauth account's refresh chain is broken, so no access can be minted.
  function pickPreferred(input: PreferredInput): PreferredPick {
    // ANTHROPIC-only through providerOf, exactly as pickAccount (INV-M1): a lease is written into the
    // worker's `anthropic` auth entry, so a ChatGPT record must not be nameable through here either.
    const matches = input.accounts.filter(
      (account) => providerOf(account) === "anthropic" && account.id.startsWith(input.prefix),
    )
    if (matches.length === 0) return { ok: false, refusal: "unknown" }
    // Refused, NOT resolved to the first match. Two accounts sharing a prefix means the row the
    // operator pressed and the account we would serve may be different ones, and silently switching
    // to the wrong subscription is worse than not switching at all.
    if (matches.length > 1) return { ok: false, refusal: "ambiguous" }
    const account = matches[0]
    if (account.needsReauth === true) return { ok: false, refusal: "needs-reauth" }
    if (isCoolingDown(account.id)) return { ok: false, refusal: "cooling" }
    // A THIRD REFUSAL THAT IS NOT ABOUT THIS ACCOUNT BEING BROKEN, unlike the two above: the account
    // is perfectly servable, there is just no seat left on it. Refused rather than deferred to the
    // human because a cap a name can walk through is not a cap — the operator would simply move the
    // fourth machine onto the account by hand and rediscover why the ceiling exists.
    if (activeHolders(account.id, now(), input.workerId).length >= MAX_ACCOUNT_HOLDERS) {
      return { ok: false, refusal: "at-capacity" }
    }
    // The rotation cursor names whoever was handed out LAST, and that is now this account. Leaving it
    // stale would make the next round-robin walk start from an account nobody holds. A cursor, not
    // affinity: see the no-stickiness note at the top of this file.
    lastPickedId = account.id
    return { ok: true, account }
  }

  // THE POOL'S STICKINESS. A routine renewal KEEPS the account it already holds; only an account that
  // cannot be served moves the worker. Ranking still owns every first pick and every rotation — it
  // just no longer re-runs an election the worker already won.
  //
  // EVERY REFUSAL, AND WHY IT IS ONE:
  //   * cooling — the quota is spent. THE case the pool owner asked to keep rotating on: stickiness
  //     ends exactly where the limit begins.
  //   * needsReauth — the refresh chain is broken, so no access token can be minted for it at all.
  //   * excluded — the flag means "drain this one", and a renewal that kept holding it would never let
  //     it drain. Deliberately the OPPOSITE of pickPreferred, where the flag does not refuse: there a
  //     human is naming the row, here a timer is.
  //   * absent from the library, or not anthropic — the id names nothing this pool can lease (INV-M1).
  //   * already held by another slot of the SAME worker — keeping it would book one account twice.
  function pickIncumbent(input: IncumbentInput): StoredAccount | undefined {
    const account = input.accounts.find((entry) => entry.id === input.accountId)
    if (!account || providerOf(account) !== "anthropic") return undefined
    if (account.needsReauth === true || account.excluded === true) return undefined
    if (isCoolingDown(account.id)) return undefined
    if (input.excludeIds?.includes(account.id) === true) return undefined
    // The rotation cursor names whoever was handed out LAST, exactly as pickPreferred maintains it:
    // leaving it stale would make the next round-robin walk start from an account nobody holds.
    lastPickedId = account.id
    return account
  }

  // THE BINDING WINDOW, not the five-hour one: an account refuses requests when ANY of its windows
  // reaches 100, so the peak across windows is what actually decides when it dies. Tracking only
  // five_hour would call a weekly-exhausted account healthy right up until it refuses everything.
  function peakUtilization(windows: readonly NormalizedWindow[]): number | undefined {
    let peak: number | undefined
    for (const win of windows) {
      if (!Number.isFinite(win.utilization)) continue
      if (peak === undefined || win.utilization > peak) peak = win.utilization
    }
    return peak
  }

  function recordBurnSample(id: string, windows: readonly NormalizedWindow[], at: number): void {
    const util = peakUtilization(windows)
    if (util === undefined) return
    const series = burnHistory.get(id) ?? []
    const last = series[series.length - 1]
    // A reset ROLLS THE SERIES OVER rather than bending its slope — see BURN_RESET_DROP.
    const rolled = last !== undefined && util < last.util - BURN_RESET_DROP ? [] : series
    rolled.push({ at, util })
    burnHistory.set(
      id,
      rolled.filter((sample) => at - sample.at <= BURN_HISTORY_MS),
    )
  }

  function burnOf(accountId: string): { util: number; ratePerHour: number; exhaustsInMs?: number } | undefined {
    const series = burnHistory.get(accountId)
    if (series === undefined || series.length < 2) return undefined
    const first = series[0]
    const last = series[series.length - 1]
    const elapsed = last.at - first.at
    if (elapsed <= 0) return undefined
    const ratePerHour = ((last.util - first.util) / elapsed) * 3_600_000
    // A flat or falling series has NO exhaustion instant, and omitting the field is how that is said.
    // Reporting one anyway — a huge number, or a negative one — reads as "this account lasts forever"
    // to a caller that only checks whether the field is there.
    if (ratePerHour <= 0) return { util: last.util, ratePerHour }
    return {
      util: last.util,
      ratePerHour,
      exhaustsInMs: Math.max(0, ((100 - last.util) / ratePerHour) * 3_600_000),
    }
  }

  function setUsageCache(entries: UsageSnapshotEntry[]): void {
    const byId = new Map<string, UsageResponse>()
    for (const entry of entries) byId.set(entry.id, entry.usage)
    usageCache = { at: now(), byId }
    // A MAXED window IS cooldown evidence, not merely the thing that resolves a worker's report:
    // quota gets spent by paths that never report to this master (an account used outside the pool,
    // a worker that hit the wall and died), and an account sitting at 100% with no cooldown is still
    // servable — pickPreferred refuses only cooling and needs-reauth, so an operator naming it gets a
    // token whose very next request 429s, and pickAccount hands it out as soon as the rest cool.
    //
    // Also the ONLY path that can resolve a deadline-less cooldown, so an INV-M2 exclusion is never
    // permanent. But ONLY a PENDING one is dropped when no window is maxed: a timed cooldown came
    // with an authoritative deadline and owns a recovery timer, and over-cooling merely delays an
    // account rejoining selection while under-cooling costs a second burn. An account MISSING from
    // the snapshot taught us nothing and keeps cooling — absence of data is not evidence of recovery.
    for (const [id, usage] of byId) {
      // Normalized ONCE and shared: the burn series and the cooldown verdict must be reading the same
      // windows, or the dashboard could show an account burning toward a limit this loop already cooled.
      const windows = PROVIDERS.anthropic.normalize(usage)
      recordBurnSample(id, windows, usageCache.at)
      const resetsAt = latestMaxedReset(windows, now())
      if (resetsAt !== undefined) markCooldown(id, resetsAt)
      else if (cooldownPending.has(id)) clearCooldown(id)
    }
    // ONE line per sweep, not one per account. This is the calibration data for a capacity check that
    // does not exist yet — the numbers a safety margin would have to be chosen from — and a single
    // greppable line per sweep is what makes it readable out of the same log everything else came from.
    // Id prefixes only, per this file's display convention.
    const observed: Record<string, number> = {}
    for (const id of byId.keys()) {
      const burn = burnOf(id)
      if (burn !== undefined && burn.ratePerHour !== 0) observed[id.slice(0, 8)] = Math.round(burn.ratePerHour * 10) / 10
    }
    if (Object.keys(observed).length > 0) log.info("master:burn-observed", observed)
  }

  // A FRESH Map every call: the next sweep replaces `usageCache` wholesale, so handing out the live
  // map would let a caller iterate a collection that is swapped underneath it — and let it delete
  // entries selection still ranks by. The UsageResponse values are shared by reference on purpose:
  // every consumer of this snapshot is read-only (it is serialised to JSON and discarded), so
  // deep-cloning each payload would cost a copy per poll to prevent a mutation nobody performs.
  function getUsageSnapshot(): UsageSnapshot {
    return { at: usageCache.at, stale: now() - usageCache.at > USAGE_CACHE_TTL_MS, byId: new Map(usageCache.byId) }
  }

  // Restore on construction so a master restart does not re-lease accounts that are still spent.
  // The stored type is a claim, not a proof (it came back from an untyped JSON store), hence the
  // runtime shape check; already-expired entries are DROPPED rather than restored, since they are
  // not cooldowns any more and carrying them would grow the stored object without bound.
  const stored = deps.kv.get<Record<string, number>>(COOLDOWN_KV_KEY, {})
  const startedAt = now()
  for (const [id, until] of Object.entries(stored ?? {})) {
    if (typeof until !== "number" || until <= startedAt) continue
    cooldown.set(id, until)
    scheduleRecovery(id, until)
  }

  // Same claim-not-proof treatment as the cooldown book, but validated PER ENTRY rather than
  // all-or-nothing: one malformed record must not cost every other worker its binding. Entries already
  // past the window are dropped rather than restored — restoring them would answer one recall with a
  // stale account before the first persist had a chance to sweep them.
  const storedAffinity = deps.kv.get<Record<string, { accountId: string; at: number }>>(AFFINITY_KV_KEY, {})
  for (const [workerId, bound] of Object.entries(storedAffinity ?? {})) {
    if (typeof bound?.accountId !== "string" || typeof bound?.at !== "number") continue
    if (startedAt - bound.at > AFFINITY_TTL_MS) continue
    affinity.set(workerId, { accountId: bound.accountId, at: bound.at })
  }

  return {
    pickAccount,
    pickPreferred,
    pickIncumbent,
    recallAffinity,
    burnOf,
    reportRateLimit: (accountId: string, resetsAt?: number, workerId?: string) => {
      if (workerId !== undefined && justAdopted(workerId, accountId)) {
        log.info("master:ratelimit-misattributed", { workerId, accountId })
        return
      }
      markCooldown(accountId, resetsAt)
    },
    setUsageCache,
    isCoolingDown,
    getUsageSnapshot,
    recordLease: (input) => {
      const held = leases.get(input.workerId)
      const adoptedAt = held?.accountId === input.accountId ? held.adoptedAt : now()
      leases.set(input.workerId, {
        accountId: input.accountId,
        expiresAt: input.expiresAt,
        pinned: input.pinned,
        adoptedAt,
      })
      // The binding is refreshed on EVERY serve, not only on a move: `at` measures how recently this
      // worker was active, which is what decides whether the recall is still worth answering. Writing
      // it here rather than at pick time inherits this function's contract — a pick whose mint failed
      // never reaches it, so the book never claims a worker went somewhere it was never sent.
      affinity.set(input.workerId, { accountId: input.accountId, at: now() })
      persistAffinity()
    },
    justAdopted,
    holdersOf: (accountId: string) => activeHolders(accountId, now()),
    pinnersOf: (accountId: string) =>
      activeLeases(accountId, now())
        .filter((hold) => hold.pinned)
        .map((hold) => hold.workerId),
  }
}
