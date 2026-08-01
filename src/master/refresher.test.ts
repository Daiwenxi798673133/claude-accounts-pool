import { expect, test } from "bun:test"
import type { StoredAccount } from "../accounts.ts"
import {
  CLIENT_ID,
  LEASE_RENEW_BUFFER_MS,
  MASTER_MIN_REMAINING_MS,
  MASTER_REFRESH_429_COOLDOWN_MS,
  MASTER_REFRESH_THRESHOLD_MS,
  TOKEN_URL,
} from "../constants.ts"
import { createRefresher, MasterRefreshRevokedError, type RefresherDeps, type RefreshRevokedOutcome } from "./refresher.ts"

// NOT ONE REAL NETWORK CALL LIVES IN THIS FILE, and that is a safety requirement rather than a
// style choice: a real POST to TOKEN_URL CONSUMES a one-time-use refresh token and rotates the
// chain, so a single stray test request could permanently strand one of the owner's paid
// accounts. `fetchImpl` therefore has NO default in RefresherDeps — omitting it is a compile
// error, never a live POST. No global `fetch` is stubbed either (sibling test files install
// process-global stubs that cannot be undone; injection makes that unnecessary here).

const NOW = 1_800_000_000_000 // frozen clock ⇒ every expiry assertion below is exact, not "roughly now"
const OK = { access_token: "fresh-A", refresh_token: "rotated-A", expires_in: 900 }

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const jsonRes = (payload: unknown, status = 200): Response => new Response(JSON.stringify(payload), { status })

// Expiry already in the past ⇒ every helper below takes the refresh path by construction.
const stale = (id: string): StoredAccount => ({ id, label: id, refresh: `r-${id}`, access: `old-${id}`, expires: NOW - 1 })

type PostLog = { url: string; body: string }
type Persisted = [string, { access: string; refresh: string; expires: number }]
type Revoked = [string, string]
type Probe = RefresherDeps & { posts: PostLog[]; persisted: Persisted[]; revoked: Revoked[] }

function makeDeps(opts: {
  accounts: Record<string, StoredAccount>
  reply: (attempt: number, body: string) => Response | Promise<Response>
  now?: () => number
  loadDelayMs?: number
  // The store's verdict on a dead tip. Absent ⇒ "flagged, nothing adopted", which is the outcome
  // every pre-existing case below assumes.
  onRevoked?: (accountId: string, deadRefresh: string) => RefreshRevokedOutcome
}): Probe {
  const posts: PostLog[] = []
  const persisted: Persisted[] = []
  const revoked: Revoked[] = []
  return {
    onRefreshRevoked: async (accountId, deadRefresh) => {
      revoked.push([accountId, deadRefresh])
      return opts.onRevoked?.(accountId, deadRefresh) ?? {}
    },
    revoked,
    fetchImpl: async (input, init) => {
      const body = String(init?.body ?? "")
      posts.push({ url: String(input), body })
      return opts.reply(posts.length, body)
    },
    // Deliberately ASYNC across a real macrotask gap: an implementation that registers its
    // in-flight entry only AFTER awaiting the account load would let all 10 concurrent callers
    // through the freshness check and fire 10 POSTs. This delay is what gives single-flight teeth.
    loadAccount: async (accountId) => {
      await sleep(opts.loadDelayMs ?? 5)
      return opts.accounts[accountId]
    },
    persist: async (accountId, token) => {
      persisted.push([accountId, token])
    },
    now: opts.now,
    posts,
    persisted,
  }
}

const tokenPosts = (deps: Probe): PostLog[] => deps.posts.filter((post) => post.url === TOKEN_URL)

// ---- ACCEPTANCE CRITERION: the whole cloud architecture rests on this one test ----------------
// Anthropic's refresh token is one-time-use and ROTATES on every refresh, so two concurrent
// refreshes of ONE account mean the loser gets invalid_grant and the account can be stranded for
// good. The master is the only refresher in the system precisely so this is guaranteeable here.
test("single-flight: 10 concurrent getFreshAccess for one account produce exactly 1 TOKEN_URL POST and identical tokens", async () => {
  const deps = makeDeps({ accounts: { A: stale("A") }, reply: () => jsonRes(OK), now: () => NOW })
  const refresher = createRefresher(deps)

  // Fire ALL TEN before awaiting ANY — the only call shape that exercises the in-flight map.
  const results = await Promise.all(Array.from({ length: 10 }, () => refresher.getFreshAccess("A")))

  expect(tokenPosts(deps).length).toBe(1)
  expect(results.map((row) => row.access)).toEqual(Array.from({ length: 10 }, () => "fresh-A"))
  expect(results.map((row) => row.expiresAt)).toEqual(Array.from({ length: 10 }, () => NOW + 900_000))
  // Exactly one write-back too: a second persist would mean a second POST happened and one of
  // the two rotated chain tips is already dead.
  expect(deps.persisted.length).toBe(1)
})

test("returns stored access when comfortably fresh", async () => {
  // `now` is intentionally omitted, which also exercises the default clock (deps.now ?? Date.now).
  const expires = Date.now() + MASTER_REFRESH_THRESHOLD_MS * 2
  const deps = makeDeps({
    accounts: { A: { id: "A", label: "A", refresh: "r-A", access: "stored-A", expires } },
    reply: () => {
      throw new Error("fetch must never be called for a comfortably fresh token")
    },
  })

  const out = await createRefresher(deps).getFreshAccess("A")

  expect(out).toEqual({ access: "stored-A", expiresAt: expires })
  expect(deps.posts.length).toBe(0)
  expect(deps.persisted.length).toBe(0)
})

test("propagates refresh failure without corrupting in-flight map", async () => {
  // A 400 that is NOT invalid_grant: terminal (4xx is never retried) so each call makes EXACTLY
  // one POST, which makes the post count an unambiguous witness that a NEW flight was started.
  const deps = makeDeps({
    accounts: { A: stale("A") },
    reply: (attempt) => (attempt === 1 ? jsonRes({ error: "invalid_request" }, 400) : jsonRes(OK)),
    now: () => NOW,
  })
  const refresher = createRefresher(deps)

  await expect(refresher.getFreshAccess("A")).rejects.toThrow()
  expect(tokenPosts(deps).length).toBe(1)

  // Had the rejected promise been left in the map, this call would re-await a dead promise and
  // issue NO new POST — the account would be unrefreshable for the whole life of the process.
  const out = await refresher.getFreshAccess("A")
  expect(tokenPosts(deps).length).toBe(2)
  expect(out.access).toBe("fresh-A")
})

test("persists the rotated refresh with the new access and an absolute expiry", async () => {
  const deps = makeDeps({ accounts: { A: stale("A") }, reply: () => jsonRes(OK), now: () => NOW })

  await createRefresher(deps).getFreshAccess("A")

  // Losing the rotated refresh strands the account permanently, so the write-back is asserted
  // field by field: `expires` must be ABSOLUTE (now + expires_in·1000), never the raw seconds.
  expect(deps.persisted).toEqual([["A", { access: "fresh-A", refresh: "rotated-A", expires: NOW + 900_000 }]])
  expect(tokenPosts(deps)[0].url).toBe(TOKEN_URL)
  expect(JSON.parse(tokenPosts(deps)[0].body) as unknown).toEqual({
    grant_type: "refresh_token",
    refresh_token: "r-A", // the STORED tip, not a literal
    client_id: CLIENT_ID,
  })
})

test("different accounts refresh concurrently and do not block each other", async () => {
  let releaseA = (): void => {}
  const gateA = new Promise<void>((resolve) => {
    releaseA = () => {
      resolve()
    }
  })
  const deps = makeDeps({
    accounts: { A: stale("A"), B: stale("B") },
    now: () => NOW,
    reply: async (_attempt, body) => {
      const tip = (JSON.parse(body) as { refresh_token: string }).refresh_token
      if (tip === "r-A") await gateA // A parks mid-POST so B has to overtake it or deadlock
      return jsonRes({ access_token: `fresh-${tip}`, refresh_token: `rot-${tip}`, expires_in: 900 })
    },
  })
  const refresher = createRefresher(deps)

  const a = refresher.getFreshAccess("A")
  const b = await refresher.getFreshAccess("B") // a single shared lock/flight would hang here

  expect(b.access).toBe("fresh-r-B")
  releaseA()
  expect((await a).access).toBe("fresh-r-A")
  expect(tokenPosts(deps).length).toBe(2)
})

test("400 invalid_grant surfaces as MasterRefreshRevokedError and is never retried", async () => {
  const deps = makeDeps({
    accounts: { A: stale("A") },
    reply: () => jsonRes({ error: "invalid_grant" }, 400),
    now: () => NOW,
  })

  const error = await createRefresher(deps)
    .getFreshAccess("A")
    .catch((err: unknown) => err)

  // A dead chain is a PERMANENT verdict, distinct from a transient failure, so the caller can
  // flag the account for re-login instead of hammering a token that can never work again.
  expect(error).toBeInstanceOf(MasterRefreshRevokedError)
  expect((error as MasterRefreshRevokedError).refresh).toBe("r-A")
  expect((error as MasterRefreshRevokedError).accountId).toBe("A")
  expect(tokenPosts(deps).length).toBe(1)
  expect(deps.persisted.length).toBe(0) // never write anything after a failed refresh
})

test("retries a transient 5xx and returns the eventual success", async () => {
  const deps = makeDeps({
    accounts: { A: stale("A") },
    reply: (attempt) => (attempt === 1 ? jsonRes({ error: "upstream" }, 503) : jsonRes(OK)),
    now: () => NOW,
  })

  const out = await createRefresher(deps).getFreshAccess("A")

  // A 503 means Anthropic never minted a token, so the stored tip is untouched and safe to reuse.
  expect(out.access).toBe("fresh-A")
  expect(tokenPosts(deps).length).toBe(2)
})

test("never retries a 429 — the token endpoint rate-limits by IP", async () => {
  const deps = makeDeps({
    accounts: { A: stale("A") },
    reply: () => jsonRes({ error: "rate_limited" }, 429),
    now: () => NOW,
  })

  await expect(createRefresher(deps).getFreshAccess("A")).rejects.toThrow()

  // Retrying a 429 deepens the block for EVERY account behind this IP, not just this one.
  expect(tokenPosts(deps).length).toBe(1)
})

test("refuses a 200 that omits the rotated refresh instead of persisting a blank chain", async () => {
  const deps = makeDeps({
    accounts: { A: stale("A") },
    reply: () => jsonRes({ access_token: "fresh-A", expires_in: 900 }),
    now: () => NOW,
  })

  await expect(createRefresher(deps).getFreshAccess("A")).rejects.toThrow()

  // The POST succeeded, so the stored tip is already spent — but the replacement is unknown.
  // Persisting anything here (blank, or the spent tip) strands the account; and re-POSTing the
  // spent tip would answer invalid_grant, so this must never be retried either.
  expect(deps.persisted.length).toBe(0)
  expect(tokenPosts(deps).length).toBe(1)
})

test("unknown account rejects without issuing any POST", async () => {
  const deps = makeDeps({ accounts: {}, reply: () => jsonRes(OK), now: () => NOW })

  await expect(createRefresher(deps).getFreshAccess("ghost")).rejects.toThrow()

  expect(deps.posts.length).toBe(0)
})

// ---- ACCEPTANCE CRITERION (issue #37): an unleased account's chain must not die of old age ------
// The whole incident was a chain that went 7h52m without a single refresh ATTEMPT, because the
// trigger was pinned to a floor only a nearly-dead access token could cross.
test("rotates a half-spent token, so an idle account is refreshed many times a day", async () => {
  const halfSpent = (remaining: number): StoredAccount => ({
    id: "A",
    label: "A",
    refresh: "r-A",
    access: "old-A",
    expires: NOW + remaining,
  })

  // Just INSIDE the half-life ⇒ rotate now, hours before the token is unusable.
  const due = makeDeps({ accounts: { A: halfSpent(MASTER_REFRESH_THRESHOLD_MS) }, reply: () => jsonRes(OK), now: () => NOW })
  expect((await createRefresher(due).getFreshAccess("A")).access).toBe("fresh-A")
  expect(tokenPosts(due).length).toBe(1)

  // Just OUTSIDE it ⇒ still cached, so the trigger is a threshold and not "refresh on every call".
  const early = makeDeps({
    accounts: { A: halfSpent(MASTER_REFRESH_THRESHOLD_MS + 60_000) },
    reply: () => jsonRes(OK),
    now: () => NOW,
  })
  expect((await createRefresher(early).getFreshAccess("A")).access).toBe("old-A")
  expect(tokenPosts(early).length).toBe(0)
})

test("an already-expired token is refreshed no matter how long ago it lapsed", async () => {
  // ex-machina's own semantics, and the one case the proactive threshold must not regress: a token
  // a week past expiry is still worth one POST, because the refresh tip may be perfectly alive.
  const weekOld: StoredAccount = { id: "A", label: "A", refresh: "r-A", access: "old-A", expires: NOW - 7 * 86_400_000 }
  const deps = makeDeps({ accounts: { A: weekOld }, reply: () => jsonRes(OK), now: () => NOW })

  expect((await createRefresher(deps).getFreshAccess("A")).access).toBe("fresh-A")
  expect(tokenPosts(deps).length).toBe(1)
})

test("minHorizonMs rotates a token that would not survive the caller's own renewal cycle", async () => {
  // A lease derives its horizon by subtracting the rotation threshold, so a token sitting a minute
  // above that threshold yields a one-minute lease the worker cannot hold for a renewal cycle.
  const account: StoredAccount = {
    id: "A",
    label: "A",
    refresh: "r-A",
    access: "old-A",
    expires: NOW + MASTER_REFRESH_THRESHOLD_MS + 60_000,
  }
  const deps = makeDeps({ accounts: { A: account }, reply: () => jsonRes(OK), now: () => NOW })
  const refresher = createRefresher(deps)

  // The warm loop asks for no headroom and is served the cached token…
  expect((await refresher.getFreshAccess("A")).access).toBe("old-A")
  expect(tokenPosts(deps).length).toBe(0)
  // …while a lease demanding a full renewal buffer forces the rotation.
  expect((await refresher.getFreshAccess("A", LEASE_RENEW_BUFFER_MS)).access).toBe("fresh-A")
  expect(tokenPosts(deps).length).toBe(1)
})

// ---- ACCEPTANCE CRITERION (issue #37): a dead chain must be recorded as dead -------------------
test("invalid_grant hands the dead tip to the store exactly once", async () => {
  const deps = makeDeps({ accounts: { A: stale("A") }, reply: () => jsonRes({ error: "invalid_grant" }, 400), now: () => NOW })

  await expect(createRefresher(deps).getFreshAccess("A")).rejects.toBeInstanceOf(MasterRefreshRevokedError)

  // The tip that DIED, not whatever the record holds now — the store needs it to tell "our POST
  // lost a race" apart from "this chain is genuinely revoked".
  expect(deps.revoked).toEqual([["A", "r-A"]])
  expect(deps.persisted.length).toBe(0)
})

test("a flagged account is never POSTed again", async () => {
  const flagged: StoredAccount = { id: "A", label: "A", refresh: "r-A", access: "old-A", expires: NOW - 1, needsReauth: true }
  const deps = makeDeps({ accounts: { A: flagged }, reply: () => jsonRes(OK), now: () => NOW })

  await expect(createRefresher(deps).getFreshAccess("A")).rejects.toBeInstanceOf(MasterRefreshRevokedError)

  // The warm loop visits every account every five minutes; one dead chain must not become a
  // permanent 400-drip at an endpoint that rate-limits this host's whole pool by IP.
  expect(deps.posts.length).toBe(0)
  expect(deps.revoked.length).toBe(0)
})

test("adopts a foreign rotation instead of treating a live account as dead", async () => {
  const deps = makeDeps({
    accounts: { A: stale("A") },
    reply: () => jsonRes({ error: "invalid_grant" }, 400),
    now: () => NOW,
    // Someone else rotated first: the record already carries a different, healthy tip.
    onRevoked: () => ({ adopted: { access: "winner-access", expires: NOW + MASTER_REFRESH_THRESHOLD_MS * 2 } }),
  })

  const out = await createRefresher(deps).getFreshAccess("A")

  expect(out).toEqual({ access: "winner-access", expiresAt: NOW + MASTER_REFRESH_THRESHOLD_MS * 2 })
  // ONE post: adopting must never re-POST the winner's tip, which would be the double-refresh the
  // single-flight map exists to prevent.
  expect(tokenPosts(deps).length).toBe(1)
  expect(deps.persisted.length).toBe(0)
})

test("an adopted token below the lease floor is refused rather than handed out", async () => {
  const deps = makeDeps({
    accounts: { A: stale("A") },
    reply: () => jsonRes({ error: "invalid_grant" }, 400),
    now: () => NOW,
    onRevoked: () => ({ adopted: { access: "winner-access", expires: NOW + MASTER_MIN_REMAINING_MS } }),
  })

  // Refused, and the account is deliberately left unflagged: the adopted tip is healthy, so the
  // next call refreshes it normally instead of stranding a live account.
  await expect(createRefresher(deps).getFreshAccess("A")).rejects.toBeInstanceOf(MasterRefreshRevokedError)
})

test("a 429 stops refreshes for the WHOLE pool, then lifts", async () => {
  let clock = NOW
  const deps = makeDeps({
    accounts: {
      A: stale("A"),
      // B is well past the rotation threshold but still leasable, i.e. the account a mid-sweep 429
      // would otherwise walk straight into.
      B: { id: "B", label: "B", refresh: "r-B", access: "old-B", expires: NOW + MASTER_REFRESH_THRESHOLD_MS },
    },
    reply: (attempt) => (attempt === 1 ? jsonRes({ error: "rate_limited" }, 429) : jsonRes(OK)),
    now: () => clock,
  })
  const refresher = createRefresher(deps)

  await expect(refresher.getFreshAccess("A")).rejects.toThrow()
  expect(tokenPosts(deps).length).toBe(1)

  // The token endpoint rate-limits by IP and the pool shares one, so B must not be POSTed either —
  // it is served its cached token instead, which is still comfortably above the lease floor.
  expect((await refresher.getFreshAccess("B")).access).toBe("old-B")
  expect(tokenPosts(deps).length).toBe(1)

  clock = NOW + MASTER_REFRESH_429_COOLDOWN_MS + 1
  expect((await refresher.getFreshAccess("B")).access).toBe("fresh-A")
  expect(tokenPosts(deps).length).toBe(2)
})

test("a 429 cooldown refuses an account whose cached token is below the lease floor", async () => {
  const deps = makeDeps({
    accounts: {
      A: stale("A"),
      B: { id: "B", label: "B", refresh: "r-B", access: "old-B", expires: NOW + MASTER_MIN_REMAINING_MS },
    },
    reply: () => jsonRes({ error: "rate_limited" }, 429),
    now: () => NOW,
  })
  const refresher = createRefresher(deps)
  await expect(refresher.getFreshAccess("A")).rejects.toThrow()

  // MASTER_MIN_REMAINING_MS's own job, and the one path where it still decides anything: the master
  // cannot refresh right now, so a token this close to expiry is refused rather than leased out.
  await expect(refresher.getFreshAccess("B")).rejects.toThrow()
  expect(tokenPosts(deps).length).toBe(1)
})
