import { expect, test } from "bun:test"
import type { StoredAccount } from "../accounts.ts"
import { MASTER_USAGE_POLL_INTERVAL_MS } from "../constants.ts"
import type { UsageResponse } from "../usage.ts"
import { createScheduler, RATELIMIT_ADOPTION_GRACE_MS, type SchedulerDeps } from "./scheduler.ts"

const COOLDOWN_KEY = "claude-accounts-usage.master.cooldown"

// In-memory stand-in for the TUI api's kv, built as a PLAIN OBJECT on purpose: the master runs
// headless and has no TuiPluginApi at all, so constructing a real one here would test a coupling
// the scheduler must not have. `snapshot()` reads the raw stored value, which pins BOTH the key
// name and the exact persisted shape.
function makeKv(seed?: Record<string, number>): { kv: SchedulerDeps["kv"]; snapshot: () => unknown } {
  const store = new Map<string, unknown>()
  if (seed) store.set(COOLDOWN_KEY, seed)
  const kv: SchedulerDeps["kv"] = {
    // The `as V` casts mirror the real kv exactly: a JSON-backed store cannot prove its payload's
    // type, so the unavoidable cast lives at the boundary here just as it does in the TUI api.
    get: <V>(key: string, fallback?: V): V => (store.has(key) ? (store.get(key) as V) : (fallback as V)),
    set: (key: string, value: unknown): void => {
      store.set(key, value)
    },
  }
  return { kv, snapshot: () => store.get(COOLDOWN_KEY) }
}

// No `provider` field on purpose. These are LEGACY-shaped records — the ones providerOf() reads as
// anthropic and a hand-rolled `provider === "anthropic"` filter silently drops. Running the WHOLE
// suite against that shape means such a filter cannot pass this file.
function account(id: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return { id, label: id, refresh: `refresh-${id}`, ...extra }
}

function usage(utilization: number, resets_at?: string): UsageResponse {
  return { five_hour: { utilization, resets_at } }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test("pickIncumbent 保住可服务的当前账号，即便另一个账号用量更低", () => {
  const { kv } = makeKv()
  const scheduler = createScheduler({ kv, now: () => 1_000 })
  scheduler.setUsageCache([
    { id: "a", usage: usage(90) },
    { id: "b", usage: usage(1) },
  ])
  const accounts = [account("a"), account("b")]

  // The ranked verb WOULD move this worker to b — that contrast is the whole fixture. pickIncumbent is
  // the verb that declines to hold the election in the first place.
  expect(scheduler.pickAccount({ accounts })?.id).toBe("b")
  expect(scheduler.pickIncumbent({ accounts, accountId: "a" })?.id).toBe("a")
})

test("pickIncumbent 对不可服务的当前账号一律放手，交回排名轮换", () => {
  const { kv } = makeKv()
  const scheduler = createScheduler({ kv, now: () => 1_000 })
  const accounts = [
    account("cool"),
    account("reauth", { needsReauth: true }),
    account("drained", { excluded: true }),
    account("chatgpt", { provider: "openai" }),
  ]
  scheduler.reportRateLimit("cool")

  // 撞限额冷却中：这正是操作者唯一希望它换号的时刻。
  expect(scheduler.pickIncumbent({ accounts, accountId: "cool" })).toBeUndefined()
  // 刷新链断了，铸不出 token。
  expect(scheduler.pickIncumbent({ accounts, accountId: "reauth" })).toBeUndefined()
  // `excluded` 的语义是"把这个号腾空"，保着它就永远腾不空。
  expect(scheduler.pickIncumbent({ accounts, accountId: "drained" })).toBeUndefined()
  // 池子是 anthropic-only(INV-M1)：ChatGPT 记录不能从这条路被保住。
  expect(scheduler.pickIncumbent({ accounts, accountId: "chatgpt" })).toBeUndefined()
  // 账号库里已经没有这条记录了(被删号)。
  expect(scheduler.pickIncumbent({ accounts, accountId: "nobody" })).toBeUndefined()
})

test("pickIncumbent 不把同一个账号保进本机的第二个槽位", () => {
  const { kv } = makeKv()
  const scheduler = createScheduler({ kv, now: () => 1_000 })
  const accounts = [account("a"), account("b")]

  // 多槽位 worker 逐槽续租，excludeIds 是"我别的槽位已经占了这些"。保号绝不能把一个账号
  // 同时记到同一台机器的两个槽位上。
  expect(scheduler.pickIncumbent({ accounts, accountId: "a", excludeIds: ["a"] })).toBeUndefined()
  expect(scheduler.pickIncumbent({ accounts, accountId: "a", excludeIds: ["b"] })?.id).toBe("a")
})

test("picks lowest-usage available account", () => {
  const { kv } = makeKv()
  const scheduler = createScheduler({ kv, now: () => 1_000 })
  // `z` is a ChatGPT record sitting at 0% — the most tempting candidate by score, and precisely
  // the one a provider-blind pool would lease to a Claude worker.
  const accounts = [account("a"), account("b"), account("c"), account("z", { provider: "openai" })]

  scheduler.setUsageCache([
    { id: "a", usage: usage(90) },
    { id: "b", usage: usage(12) },
    { id: "c", usage: usage(55) },
    { id: "z", usage: usage(0) },
  ])

  expect(scheduler.pickAccount({ accounts })?.id).toBe("b")
  // Repeating the pick returns the SAME account: ranking is stateless. This is the deliberate
  // absence of stickiness seen from the other side — throughput comes from always aiming at the
  // emptiest account, never from remembering which worker asked.
  expect(scheduler.pickAccount({ accounts })?.id).toBe("b")
  // `exclude` drops the leader, and the NEXT-LOWEST wins — not the round-robin successor.
  expect(scheduler.pickAccount({ accounts, exclude: "b" })?.id).toBe("c")

  // An account with no snapshot sorts LAST (+Infinity), never first: unknown usage is not zero usage.
  expect(scheduler.pickAccount({ accounts: [...accounts, account("d")] })?.id).toBe("b")

  // excluded / needsReauth are skipped even when they rank best.
  const flagged = [account("a"), account("b", { excluded: true }), account("c", { needsReauth: true })]
  expect(scheduler.pickAccount({ accounts: flagged })?.id).toBe("a")
  expect(scheduler.pickAccount({ accounts: [account("b", { excluded: true })] })).toBeUndefined()

  // Utilization is the MAX across windows, so a maxed weekly window outranks an idle 5h one —
  // scoring only `five_hour` would lease the account that is one message from a 429.
  scheduler.setUsageCache([
    { id: "a", usage: { five_hour: { utilization: 5 }, seven_day: { utilization: 99 } } },
    { id: "b", usage: { five_hour: { utilization: 40 } } },
  ])
  expect(scheduler.pickAccount({ accounts: [account("a"), account("b")] })?.id).toBe("b")
})

test("falls back to round-robin without usage data", () => {
  const { kv } = makeKv()
  let clock = 1_000
  const scheduler = createScheduler({ kv, now: () => clock })
  const accounts = [account("a"), account("b"), account("c")]

  // Given no snapshot has ever been set, successive picks ROTATE, so a burst of workers spreads
  // across the pool instead of stampeding onto whichever account happens to sort first.
  expect(scheduler.pickAccount({ accounts })?.id).toBe("a")
  expect(scheduler.pickAccount({ accounts })?.id).toBe("b")
  expect(scheduler.pickAccount({ accounts })?.id).toBe("c")
  expect(scheduler.pickAccount({ accounts })?.id).toBe("a")

  // `exclude` overrides the internal cursor as the rotation anchor: the caller naming the account
  // it is leaving is fresher information than our own record of the last hand-out.
  expect(scheduler.pickAccount({ accounts, exclude: "b" })?.id).toBe("c")

  // A STALE snapshot is not data. The master polls usage on an interval; once the numbers predate
  // several intervals the poll itself is broken (`/oauth/usage` stays angry for a long time after
  // a 429), and ranking by them would keep aiming every worker at an account since drained.
  // Ranking would return "c" twice here; rotation continues from the cursor instead.
  scheduler.setUsageCache([
    { id: "a", usage: usage(99) },
    { id: "b", usage: usage(99) },
    { id: "c", usage: usage(1) },
  ])
  clock += 60 * 60_000
  expect([scheduler.pickAccount({ accounts })?.id, scheduler.pickAccount({ accounts })?.id]).toEqual(["a", "b"])

  // A FRESH snapshot covering NONE of the candidates is not data either — an empty poll result
  // (every account answered 429) must not freeze selection onto whichever account sorts first.
  scheduler.setUsageCache([])
  expect([scheduler.pickAccount({ accounts })?.id, scheduler.pickAccount({ accounts })?.id]).toEqual(["c", "a"])
})

test("never picks a cooling-down account", () => {
  const clock = 1_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => clock })
  const accounts = [account("a"), account("b")]

  // Given `a` is by far the emptiest account...
  scheduler.setUsageCache([
    { id: "a", usage: usage(3) },
    { id: "b", usage: usage(88) },
  ])
  expect(scheduler.pickAccount({ accounts })?.id).toBe("a")

  // ...when it hits its subscription limit, usage rank NEVER overrides the cooldown. The snapshot
  // still says `a` is empty (it was taken before the limit); believing it would hand every worker
  // the one account guaranteed to 429.
  scheduler.reportRateLimit("a", clock + 60 * 60_000)
  expect(scheduler.isCoolingDown("a")).toBe(true)
  expect(scheduler.pickAccount({ accounts })?.id).toBe("b")
  expect(scheduler.pickAccount({ accounts })?.id).toBe("b")

  // Same on the round-robin path, where nothing else would keep `a` out of the rotation.
  const rr = createScheduler({ kv: makeKv().kv, now: () => clock })
  rr.reportRateLimit("a", clock + 60 * 60_000)
  expect(rr.pickAccount({ accounts })?.id).toBe("b")
  expect(rr.pickAccount({ accounts })?.id).toBe("b")

  // A deadline-less cooldown excludes exactly as hard as a timed one — that is the whole point of
  // representing it at all rather than skipping the report.
  scheduler.reportRateLimit("b", undefined)
  expect(scheduler.isCoolingDown("b")).toBe(true)
  expect(scheduler.pickAccount({ accounts })).toBeUndefined()
})

test("reportRateLimit starts cooldown and recovery restores availability", async () => {
  const { kv, snapshot } = makeKv()
  // Anchored to the real clock so a deadline expressed in it also lands correctly on the real
  // setTimeout the scheduler arms; the offset lets the test step time forward on demand.
  const base = Date.now()
  let offset = 0
  const scheduler = createScheduler({ kv, now: () => base + offset })
  const accounts = [account("a"), account("b")]

  // --- known deadline: cooldown + a real recovery timer ------------------------------------
  scheduler.reportRateLimit("a", base + 60)
  expect(scheduler.isCoolingDown("a")).toBe(true)
  expect(snapshot()).toEqual({ a: base + 60 })
  expect(scheduler.pickAccount({ accounts })?.id).toBe("b")

  // An unknown deadline must NOT downgrade a known one: a live timed cooldown is strictly better
  // information, and dropping it would also drop the scheduled recovery.
  scheduler.reportRateLimit("a", undefined)
  expect(snapshot()).toEqual({ a: base + 60 })

  offset = 300
  await sleep(300)
  // The fired TIMER, not the clock arithmetic, is what proves recovery is AUTOMATIC: only the
  // timer's re-persist can remove the entry from the stored snapshot.
  expect(snapshot()).toEqual({})
  expect(scheduler.isCoolingDown("a")).toBe(false)
  expect(scheduler.pickAccount({ accounts, exclude: "b" })?.id).toBe("a")

  // --- unknown deadline: excluded, but NO fabricated countdown -----------------------------
  scheduler.reportRateLimit("b", undefined)
  expect(scheduler.isCoolingDown("b")).toBe(true)
  // Never persisted: there is no instant to persist. A sentinel (0, or now+1ms) would read back
  // on restart as an already-expired cooldown and the exclusion would silently vanish.
  expect(snapshot()).toEqual({})
  await sleep(60)
  offset = 60 * 60_000
  // Still cooling an hour later. A fabricated deadline would have clamped to ~1ms and staged a
  // FALSE recovery — the exact failure src/autoswitch.ts keeps a separate pending set to avoid.
  expect(scheduler.isCoolingDown("b")).toBe(true)

  // --- a fresh snapshot is the ONLY thing that resolves an unknown deadline -----------------
  // Still maxed, and now the snapshot carries the real reset ⇒ upgrade to a timed cooldown, so
  // automatic recovery becomes possible again.
  const resetsAt = base + 60 * 60_000 + 5_000
  scheduler.setUsageCache([{ id: "b", usage: usage(100, new Date(resetsAt).toISOString()) }])
  expect(scheduler.isCoolingDown("b")).toBe(true)
  expect(snapshot()).toEqual({ b: resetsAt })

  // No longer maxed ⇒ the report was a false alarm and the cooldown is dropped outright.
  scheduler.reportRateLimit("c", undefined)
  scheduler.setUsageCache([{ id: "c", usage: usage(20) }])
  expect(scheduler.isCoolingDown("c")).toBe(false)

  // An account MISSING from the snapshot learns nothing and keeps cooling — absence of data is
  // not evidence of recovery.
  scheduler.reportRateLimit("d", undefined)
  scheduler.setUsageCache([{ id: "c", usage: usage(20) }])
  expect(scheduler.isCoolingDown("d")).toBe(true)
})

test("a maxed snapshot cools an account nobody ever reported", () => {
  const { kv, snapshot } = makeKv()
  const clock = 1_000_000
  const scheduler = createScheduler({ kv, now: () => clock })
  const accounts = [account("spent"), account("idle")]
  const resetsAt = clock + 40 * 60_000

  // Given NO reportRateLimit for `spent` — its quota was burned by something this master never saw
  // (used outside the pool, or by a worker that died before it could report).
  scheduler.setUsageCache([
    { id: "spent", usage: usage(100, new Date(resetsAt).toISOString()) },
    { id: "idle", usage: usage(20) },
  ])

  // Then the snapshot alone is enough: the dashboard's badge, selection and the named-pick refusal
  // all read this one flag, so all three stop lying about an account that cannot serve a request.
  expect(scheduler.isCoolingDown("spent")).toBe(true)
  expect(snapshot()).toEqual({ spent: resetsAt })
  expect(scheduler.pickAccount({ accounts })?.id).toBe("idle")
  expect(scheduler.pickPreferred({ accounts, prefix: "spent" })).toEqual({ ok: false, refusal: "cooling" })

  // A TIMED cooldown is not dropped by a later snapshot that is merely no longer maxed — the
  // deadline is authoritative and recovery is the timer's job. Only pending ones are resolved here.
  scheduler.setUsageCache([{ id: "spent", usage: usage(30) }])
  expect(scheduler.isCoolingDown("spent")).toBe(true)

  // A maxed window whose reset already passed is not a cooldown: latestMaxedReset drops it, and
  // fabricating a deadline for `fresh` would exclude it on nothing.
  scheduler.setUsageCache([{ id: "fresh", usage: usage(100, new Date(clock - 1).toISOString()) }])
  expect(scheduler.isCoolingDown("fresh")).toBe(false)
})

test("getUsageSnapshot reports the poller's data with the scheduler's own staleness verdict", () => {
  const { kv } = makeKv()
  let clock = 1_000_000
  const scheduler = createScheduler({ kv, now: () => clock })
  const accounts = [account("a"), account("b")]

  // Before any sweep completes: `at` is 0 and the snapshot already reads STALE. A dashboard has to
  // distinguish "polling has produced nothing yet" from "the whole pool is at 0%", and the zero
  // instant does that without a third flag someone can forget to check.
  const initial = scheduler.getUsageSnapshot()
  expect(initial.at).toBe(0)
  expect(initial.stale).toBe(true)
  expect(initial.byId.size).toBe(0)

  const polledAt = clock
  scheduler.setUsageCache([{ id: "a", usage: usage(42) }])
  const fresh = scheduler.getUsageSnapshot()
  expect(fresh.at).toBe(polledAt)
  expect(fresh.stale).toBe(false)
  expect(fresh.byId.get("a")).toEqual(usage(42))

  // The Map handed out is a COPY. A caller mutating it — a "let me just drop the rows I don't want
  // to render" — must not be able to reach into the cache selection is still ranking by.
  fresh.byId.delete("a")
  fresh.byId.set("z", usage(0))
  expect(scheduler.getUsageSnapshot().byId.get("a")).toEqual(usage(42))
  expect(scheduler.getUsageSnapshot().byId.has("z")).toBe(false)

  // THE STALENESS LINE IS THE SAME ONE SELECTION USES — that identity is the whole reason `stale`
  // is computed inside the scheduler. Exactly AT the window: still ranked (`a` is the only account
  // with a snapshot, so it wins on utilization) and still reported fresh.
  clock = polledAt + 2 * MASTER_USAGE_POLL_INTERVAL_MS
  expect(scheduler.getUsageSnapshot().stale).toBe(false)
  expect(scheduler.pickAccount({ accounts })?.id).toBe("a")

  // One millisecond past it, BOTH flip together: ranking falls back to round-robin (so the pick
  // moves off `a` despite its 42% still being the only number available) and the dashboard is told
  // the numbers are no longer current. A page applying its own threshold could show a green light
  // for a snapshot selection had already abandoned.
  clock += 1
  expect(scheduler.getUsageSnapshot().stale).toBe(true)
  expect(scheduler.pickAccount({ accounts })?.id).toBe("b")
})

test("cooldown state round-trips through injected kv", () => {
  const base = 5_000_000
  const clock = base
  // A pre-existing snapshot, as a master restart finds it: one live cooldown and one that expired
  // while the process was down.
  const { kv, snapshot } = makeKv({ live: base + 30 * 60_000, expired: base - 1 })
  const first = createScheduler({ kv, now: () => clock })

  expect(first.isCoolingDown("live")).toBe(true)
  // Dropped on load rather than restored: a deadline in the past is not a cooldown, and keeping it
  // would grow the stored object without bound.
  expect(first.isCoolingDown("expired")).toBe(false)

  first.reportRateLimit("fresh", base + 45 * 60_000)
  expect(snapshot()).toEqual({ live: base + 30 * 60_000, fresh: base + 45 * 60_000 })

  // A deadline-less cooldown is in-memory ONLY: there is no instant to write, and inventing one is
  // the fabrication this module refuses to do.
  first.reportRateLimit("pending", undefined)
  expect(snapshot()).toEqual({ live: base + 30 * 60_000, fresh: base + 45 * 60_000 })

  // A second scheduler over the SAME kv is what a master restart looks like.
  const second = createScheduler({ kv, now: () => clock })
  expect(second.isCoolingDown("live")).toBe(true)
  expect(second.isCoolingDown("fresh")).toBe(true)
  expect(second.isCoolingDown("expired")).toBe(false)
  expect(second.isCoolingDown("pending")).toBe(false)

  // The restored cooldowns really do steer selection in the new process, not just isCoolingDown.
  expect(second.pickAccount({ accounts: [account("live"), account("fresh"), account("spare")] })?.id).toBe("spare")
})

test("pickPreferred serves the named account regardless of rank, and refuses what it cannot serve", () => {
  const clock = 1_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => clock })
  const accounts = [
    account("aaaa1111-full"),
    account("bbbb2222-idle"),
    account("cccc3333-off", { excluded: true }),
    account("dddd4444-dead", { needsReauth: true }),
    account("eeee5555-gpt", { provider: "openai" }),
  ]

  // Given `bbbb2222-idle` is the emptiest account, so ranked selection would always answer it...
  scheduler.setUsageCache([
    { id: "aaaa1111-full", usage: usage(91) },
    { id: "bbbb2222-idle", usage: usage(4) },
    { id: "cccc3333-off", usage: usage(20) },
  ])
  expect(scheduler.pickAccount({ accounts })?.id).toBe("bbbb2222-idle")

  // ...naming the FULLEST one still hands it over. Rank has no vote once a human has chosen: the
  // operator can see the same 91% we can, and may have a reason (a specific subscription's model
  // access, say) that no utilization number encodes.
  const named = scheduler.pickPreferred({ accounts, prefix: "aaaa1111" })
  expect(named).toEqual({ ok: true, account: accounts[0] })

  // `excluded` IS SERVABLE HERE, and that asymmetry with pickAccount is the design: the flag means
  // "never AUTO-switch to this one", which is exactly the case a manual pick is not.
  expect(scheduler.pickAccount({ accounts })?.id).not.toBe("cccc3333-off")
  expect(scheduler.pickPreferred({ accounts, prefix: "cccc3333" })).toEqual({ ok: true, account: accounts[2] })

  // A broken refresh chain is refused: the master cannot mint an access token for it at all, so
  // "switching" would hand the worker nothing and strand the session.
  expect(scheduler.pickPreferred({ accounts, prefix: "dddd4444" })).toEqual({ ok: false, refusal: "needs-reauth" })

  // A spent account is refused too, even though its token is perfectly valid — the switch would
  // "succeed" and the operator's very next request would 429.
  scheduler.reportRateLimit("aaaa1111-full", clock + 60 * 60_000)
  expect(scheduler.pickPreferred({ accounts, prefix: "aaaa1111" })).toEqual({ ok: false, refusal: "cooling" })

  // Unknown, and ANTHROPIC-ONLY: the ChatGPT record is not merely deprioritised but unnameable, since
  // a lease is written into the worker's `anthropic` auth entry (INV-M1).
  expect(scheduler.pickPreferred({ accounts, prefix: "zzzz9999" })).toEqual({ ok: false, refusal: "unknown" })
  expect(scheduler.pickPreferred({ accounts, prefix: "eeee5555" })).toEqual({ ok: false, refusal: "unknown" })

  // Ambiguity is refused rather than resolved to the first match: the row the operator pressed and
  // the account we would serve may be different ones, and switching to the wrong subscription
  // silently is worse than not switching.
  const twins = [account("ffff6666-one"), account("ffff6666-two")]
  expect(scheduler.pickPreferred({ accounts: twins, prefix: "ffff6666" })).toEqual({ ok: false, refusal: "ambiguous" })
})

test("a named pick moves the rotation cursor but creates no affinity", () => {
  const clock = 2_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => clock })
  const accounts = [account("a"), account("b"), account("c")]

  // Given no usage data at all, selection is pure round-robin from the last account handed out
  expect(scheduler.pickPreferred({ accounts, prefix: "b" })).toEqual({ ok: true, account: accounts[1] })

  // The next rotation continues from `b` — the account really was handed out, and a cursor left
  // pointing at whoever preceded it would replay a stale turn order.
  expect(scheduler.pickAccount({ accounts })?.id).toBe("c")

  // AND NOTHING IS STICKY. With a snapshot present, the very next renewal ranks by utilization like
  // any other pick: the manual choice is not remembered, which is the documented no-affinity design
  // (the operator is told as much when the switch succeeds).
  scheduler.setUsageCache([
    { id: "a", usage: usage(2) },
    { id: "b", usage: usage(97) },
    { id: "c", usage: usage(50) },
  ])
  expect(scheduler.pickPreferred({ accounts, prefix: "b" })).toEqual({ ok: true, account: accounts[1] })
  expect(scheduler.pickAccount({ accounts })?.id).toBe("a")
})

test("an account someone holds loses to a free one, even when the free one is fuller", () => {
  const at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })
  const accounts = [account("a"), account("b")]
  // `a` is far emptier, so the OLD ranking answers `a` every time. That is the distinguishing fixture:
  // holder count must outrank utilization, or this case cannot tell the two policies apart.
  scheduler.setUsageCache([
    { id: "a", usage: usage(5) },
    { id: "b", usage: usage(80) },
  ])
  expect(scheduler.pickAccount({ accounts })?.id).toBe("a")

  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: false })

  expect(scheduler.pickAccount({ accounts, workerId: "w2" })?.id).toBe("b")
  // …while the holder itself renews back onto `a`: its own lease is discounted, so from w1's view `a`
  // is still unheld and still the emptiest. Without that discount a renewal would bounce w1 off a
  // perfectly good account every cycle.
  expect(scheduler.pickAccount({ accounts, workerId: "w1" })?.id).toBe("a")
})

test("holders are ranked fewest-first, and a lapsed lease stops counting", () => {
  let at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })
  const accounts = [account("a"), account("b"), account("c")]
  // Flat usage on purpose: with every score equal, holder count is the ONLY thing that can order these.
  scheduler.setUsageCache([
    { id: "a", usage: usage(50) },
    { id: "b", usage: usage(50) },
    { id: "c", usage: usage(50) },
  ])

  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: false })
  scheduler.recordLease({ workerId: "w2", accountId: "a", expiresAt: at + 60_000, pinned: false })
  scheduler.recordLease({ workerId: "w3", accountId: "b", expiresAt: at + 60_000, pinned: false })

  expect(scheduler.holdersOf("a")).toEqual(["w1", "w2"])
  expect(scheduler.holdersOf("c")).toEqual([])

  expect(scheduler.pickAccount({ accounts, workerId: "w4" })?.id).toBe("c")
  scheduler.recordLease({ workerId: "w4", accountId: "c", expiresAt: at + 60_000, pinned: false })
  expect(scheduler.pickAccount({ accounts, workerId: "w5" })?.id).toBe("b")

  // Past every expiry the book is empty again — swept on read, so nothing had to fire a timer. A
  // worker that vanished without a word therefore stops shrinking the pool on its own.
  at += 60_001
  expect(scheduler.holdersOf("a")).toEqual([])
  expect(scheduler.pickAccount({ accounts, workerId: "w5" })?.id).toBe("a")
})

test("re-leasing moves a worker rather than adding a second hold", () => {
  const at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })

  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: false })
  scheduler.recordLease({ workerId: "w1", accountId: "b", expiresAt: at + 60_000, pinned: false })

  // The wire has no release verb, and does not need one: a worker writes its lease into ONE auth.json
  // slot, so booking the new account IS releasing the old.
  expect(scheduler.holdersOf("a")).toEqual([])
  expect(scheduler.holdersOf("b")).toEqual(["w1"])
})

test("holder count still orders the pick when there is no usage data to rank by", () => {
  const at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })
  const accounts = [account("a"), account("b")]

  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: false })

  // No snapshot at all, so ranking is unavailable and selection is round-robin — but the narrowing
  // happens BEFORE that fallback, so rotation runs inside the least-held tier and cannot wander back
  // onto the held account. Reversing those two steps would leave this case answering `a`.
  expect(scheduler.pickAccount({ accounts, workerId: "w2" })?.id).toBe("b")
  expect(scheduler.pickAccount({ accounts, workerId: "w2" })?.id).toBe("b")
})

test("a cooling account is still excluded outright, never merely demoted below held ones", () => {
  const at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })
  const accounts = [account("a"), account("b")]

  // `b` cools, `a` is held by two workers. Ordering alone would put the cooling account first — it has
  // no holders — so this pins that cooling remains a FILTER applied before any of that.
  scheduler.reportRateLimit("b", at + 60_000)
  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: false })
  scheduler.recordLease({ workerId: "w2", accountId: "a", expiresAt: at + 60_000, pinned: false })

  expect(scheduler.pickAccount({ accounts, workerId: "w3" })?.id).toBe("a")
})

test("a pinned holder is avoided only as a TIE-BREAK inside the least-held tier", () => {
  const at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })
  const accounts = [account("a"), account("b")]
  // Flat usage, so neither ranking nor rotation can be what decides this — only the pin flag can.
  scheduler.setUsageCache([
    { id: "a", usage: usage(50) },
    { id: "b", usage: usage(50) },
  ])

  // One holder each, so fewestHolders leaves BOTH in the tier and hands the choice to the pin pass.
  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: true })
  scheduler.recordLease({ workerId: "w2", accountId: "b", expiresAt: at + 60_000, pinned: false })

  expect(scheduler.pinnersOf("a")).toEqual(["w1"])
  expect(scheduler.pinnersOf("b")).toEqual([])
  // …and pinnedBy stays a SUBSET of holders, which is the invariant both renderers rely on.
  expect(scheduler.holdersOf("a")).toEqual(["w1"])

  expect(scheduler.pickAccount({ accounts, workerId: "w3" })?.id).toBe("b")
  // The pinner's OWN renewal still comes back to `a`: its lease is discounted from both passes, so
  // the pin it set cannot be the thing that rotates it away.
  expect(scheduler.pickAccount({ accounts, workerId: "w1" })?.id).toBe("a")
})

test("pin avoidance NEVER outranks holder count, and never denies the pool", () => {
  const at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })
  const accounts = [account("a"), account("b")]
  scheduler.setUsageCache([
    { id: "a", usage: usage(5) },
    { id: "b", usage: usage(95) },
  ])

  // `a` is pinned by ONE worker; `b` is shared by three and nearly spent. Ranking pin-avoidance above
  // holder count would answer `b` here — trading a 5% unshared window for a 95% triple-shared one to
  // protect a reservation. It must answer `a`.
  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: true })
  scheduler.recordLease({ workerId: "w2", accountId: "b", expiresAt: at + 60_000, pinned: false })
  scheduler.recordLease({ workerId: "w3", accountId: "b", expiresAt: at + 60_000, pinned: false })
  scheduler.recordLease({ workerId: "w4", accountId: "b", expiresAt: at + 60_000, pinned: false })

  expect(scheduler.pickAccount({ accounts, workerId: "w5" })?.id).toBe("a")

  // And with EVERY candidate pinned the preference dissolves rather than emptying the pool: a pin may
  // never be the reason a worker gets no account at all.
  scheduler.recordLease({ workerId: "w2", accountId: "b", expiresAt: at + 60_000, pinned: true })
  scheduler.recordLease({ workerId: "w3", accountId: "a", expiresAt: at + 60_000, pinned: true })
  scheduler.recordLease({ workerId: "w4", accountId: "a", expiresAt: at + 60_000, pinned: true })
  expect(scheduler.pickAccount({ accounts, workerId: "w5" })?.id).toBe("b")
})

test("re-leasing the same account overwrites its pin flag in both directions", () => {
  const at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })

  // The un-pin path on the wire: the worker asks for the SAME account with pinned:false, and the book
  // must forget the flag. A book that only ever ADDED pins would leave the dashboard claiming a
  // reservation the operator has already released.
  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: true })
  expect(scheduler.pinnersOf("a")).toEqual(["w1"])
  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: false })
  expect(scheduler.pinnersOf("a")).toEqual([])
  expect(scheduler.holdersOf("a")).toEqual(["w1"])

  // A lapsed lease takes its pin with it — same sweep-on-read as holders, so a worker that vanished
  // cannot reserve an account forever.
  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: true })
  const later = createScheduler({ kv: makeKv().kv, now: () => at + 60_001 })
  later.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: true })
  expect(later.pinnersOf("a")).toEqual([])
})

// Regression for #59. The incident: four OpenCode processes on one machine share a workerId and a
// single auth.json, so one exhausted account raised a 429 in three sessions at once; each blamed
// whichever account a sibling had adopted in the seconds since, and two healthy accounts were cooled.
test("a rate-limit report about an account this worker only just adopted is discarded as misattributed", () => {
  let at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })

  // Given: w1 moves onto `a`
  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 60_000, pinned: false })

  // When: a report about `a` lands inside the grace window
  at += RATELIMIT_ADOPTION_GRACE_MS - 1
  scheduler.reportRateLimit("a", undefined, "w1")

  // Then: nothing cooled — `a` cannot have been spent by a worker that has held it for seconds.
  expect(scheduler.isCoolingDown("a")).toBe(false)
  expect(scheduler.justAdopted("w1", "a")).toBe(true)

  // And: a report from a DIFFERENT worker is believed — the guard is about who moved, not the account.
  scheduler.reportRateLimit("a", undefined, "w2")
  expect(scheduler.isCoolingDown("a")).toBe(true)
})

// The loop-termination half, and the reason `adoptedAt` survives a re-serve: an account that really
// IS spent gets handed straight back once (leaseServer skips the rotation whose report it discarded),
// and if that re-serve restamped the clock the next report would be discarded too — forever.
test("re-serving the same account does not restamp adoption, so a genuinely spent account is believed on the retry", () => {
  let at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })

  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 600_000, pinned: false })
  at += RATELIMIT_ADOPTION_GRACE_MS - 1
  scheduler.reportRateLimit("a", undefined, "w1")
  // The re-serve leaseServer performs after discarding that report.
  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 600_000, pinned: false })

  at += 2
  expect(scheduler.justAdopted("w1", "a")).toBe(false)
  scheduler.reportRateLimit("a", undefined, "w1")
  expect(scheduler.isCoolingDown("a")).toBe(true)
})

test("an expired lease adopts nothing: its token is dead, so whatever the worker hit was not this account", () => {
  let at = 5_000_000
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => at })
  scheduler.recordLease({ workerId: "w1", accountId: "a", expiresAt: at + 1_000, pinned: false })
  at += 1_001
  expect(scheduler.justAdopted("w1", "a")).toBe(false)
  scheduler.reportRateLimit("a", undefined, "w1")
  expect(scheduler.isCoolingDown("a")).toBe(true)
})

test("excludeIds narrows the candidates so a repeated lease can fill several slots", () => {
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => 1_000 })
  const accounts = [account("a"), account("b"), account("c")]
  scheduler.setUsageCache([
    { id: "a", usage: usage(90) },
    { id: "b", usage: usage(12) },
    { id: "c", usage: usage(55) },
  ])

  // The loop a multi-slot worker runs: lease, then re-lease naming everything already held. Without
  // excludeIds every call ranks the same pool and returns "b" three times.
  const held: string[] = []
  for (let slot = 0; slot < 3; slot++) {
    const picked = scheduler.pickAccount({ accounts, workerId: "w1", excludeIds: held })
    if (picked) held.push(picked.id)
  }
  expect(held).toEqual(["b", "c", "a"])

  // Pool exhausted — answered as "nothing available", the same shape the lease route already turns
  // into a 503, so a worker asking for more slots than exist simply stops.
  expect(scheduler.pickAccount({ accounts, workerId: "w1", excludeIds: held })).toBeUndefined()
})

test("excludeIds is a filter, never the rotation anchor", () => {
  const scheduler = createScheduler({ kv: makeKv().kv, now: () => 1_000 })
  const accounts = [account("a"), account("b"), account("c")]

  // No usage cache, so selection falls to round-robin, whose anchor is `exclude` — NOT a member of
  // excludeIds. Anchored on "a" the walk reaches "b"; excluding "b" as held leaves "c". If
  // excludeIds fed the anchor instead, the walk would start from "b" and hand back "c" for the
  // wrong reason, which this asserts apart by pinning the anchor and the filter to different ids.
  expect(scheduler.pickAccount({ accounts, exclude: "a", excludeIds: ["b"] })?.id).toBe("c")
})
