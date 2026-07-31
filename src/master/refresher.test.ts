import { expect, test } from "bun:test"
import type { StoredAccount } from "../accounts.ts"
import { CLIENT_ID, MASTER_MIN_REMAINING_MS, TOKEN_URL } from "../constants.ts"
import { createRefresher, MasterRefreshRevokedError, type RefresherDeps } from "./refresher.ts"

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
type Probe = RefresherDeps & { posts: PostLog[]; persisted: Persisted[] }

function makeDeps(opts: {
  accounts: Record<string, StoredAccount>
  reply: (attempt: number, body: string) => Response | Promise<Response>
  now?: () => number
  loadDelayMs?: number
}): Probe {
  const posts: PostLog[] = []
  const persisted: Persisted[] = []
  return {
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
  const expires = Date.now() + MASTER_MIN_REMAINING_MS * 6
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
