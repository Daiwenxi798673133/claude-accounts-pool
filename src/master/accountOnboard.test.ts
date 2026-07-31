import { expect, test } from "bun:test"
import { ONBOARD_ADD_MIN_INTERVAL_MS, ONBOARD_MAX_ATTEMPTS, ONBOARD_MAX_PENDING, ONBOARD_PENDING_TTL_MS } from "../constants.ts"
import type { AuthToken } from "../accounts.ts"
import { createAccountOnboard, type AccountOnboardDeps, type OnboardProfile } from "./accountOnboard.ts"

// Every collaborator is faked and the clock is injected, so nothing here touches the network, the
// disk or a real timer. That is not merely convenient: the real `exchange` redeems a one-time-use
// authorization code against a paid Anthropic account, and the real `absorb` writes the operator's
// account library — a suite that reached either would be destructive to run.
//
// The clock starts at a REALISTIC instant rather than 0 because the add throttle compares against a
// last-attempt stamp seeded at 0, exactly as the usage-refresh throttle does; a near-zero clock would
// make the very first attempt look like a rapid second one.

const GOOD_CODE = "the-code#the-state"
const STATE = "the-state"
const REDIRECT = "https://platform.claude.com/oauth/code/callback"
const VERIFIER = "verifier-under-test"
const PROFILE: OnboardProfile = { uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", email: "new@example.test" }

type Recorded = {
  exchanges: Array<{ input: string; verifier: string; redirectUri: string; expectedState: string }>
  absorbed: Array<{ profile: OnboardProfile; token: AuthToken }>
  authorizeCalls: number
  advance: (ms: number) => void
  now: () => number
}

function makeOnboard(options?: {
  existing?: boolean
  profileThrows?: boolean
  goodCode?: string
}): { onboard: ReturnType<typeof createAccountOnboard>; recorded: Recorded } {
  let nowMs = 1_900_000_000_000
  const goodCode = options?.goodCode ?? GOOD_CODE
  const exchanges: Recorded["exchanges"] = []
  const absorbed: Recorded["absorbed"] = []
  let authorizeCalls = 0
  let pendingSeq = 0

  const deps: AccountOnboardDeps = {
    authorize: async () => {
      authorizeCalls += 1
      return { url: `https://claude.ai/oauth/authorize?state=${STATE}`, redirectUri: REDIRECT, state: STATE, verifier: VERIFIER }
    },
    exchange: async (input, verifier, redirectUri, expectedState) => {
      exchanges.push({ input, verifier, redirectUri, expectedState })
      return input === goodCode ? { type: "success", refresh: "refresh-new", access: "access-new", expires: nowMs + 8 * 3600_000 } : { type: "failed" }
    },
    fetchProfile: async () => {
      if (options?.profileThrows) throw new Error("profile endpoint said no")
      return PROFILE
    },
    absorb: async (input) => {
      absorbed.push(input)
      return { existing: options?.existing ?? false }
    },
    newId: () => `pending-${++pendingSeq}`,
    now: () => nowMs,
  }

  return {
    onboard: createAccountOnboard(deps),
    recorded: {
      exchanges,
      absorbed,
      get authorizeCalls() {
        return authorizeCalls
      },
      advance: (ms) => {
        nowMs += ms
      },
      now: () => nowMs,
    },
  }
}

// Every attempt after the first has to clear the server-wide rate floor, so cases that make several
// attempts step the clock between them. Expressed as a helper rather than repeated literals so the
// intent ("wait out the throttle", not "advance 3 seconds") survives a change to the constant.
function pastThrottle(recorded: Recorded): void {
  recorded.advance(ONBOARD_ADD_MIN_INTERVAL_MS)
}

test("start hands the browser a link and an opaque handle, never the PKCE secrets", async () => {
  // Given: a master with no onboarding in progress
  const { onboard, recorded } = makeOnboard()

  // When
  const started = await onboard.start()

  // Then: the operator gets something to click and something to quote back
  expect(started.url).toContain("claude.ai/oauth/authorize")
  expect(started.pendingId).toBe("pending-1")
  expect(started.expiresAt).toBe(recorded.now() + ONBOARD_PENDING_TTL_MS)

  // And: the VERIFIER is nowhere in the payload. This one assertion is the property that keeps the
  // master the only party able to complete the exchange: the authorize URL carries only the
  // CHALLENGE (a SHA-256 of the verifier), and the token endpoint will not redeem a code without the
  // preimage — so a browser, or anyone reading over its shoulder, cannot turn the code it is holding
  // into a refresh token the pool would never see.
  //
  // The STATE is deliberately not asserted against: it is a CSRF nonce that OAuth requires to travel
  // through the browser inside the authorize URL, so demanding its absence would be demanding a
  // broken flow. It is not the secret here — the verifier is.
  const leaked = JSON.stringify(started)
  expect(leaked).not.toContain(VERIFIER)
  expect(started.url).toContain(STATE)
  expect(onboard.pendingCount()).toBe(1)
})

test("a good paste is exchanged with the session's own verifier and state, then filed", async () => {
  // Given: a live session
  const { onboard, recorded } = makeOnboard()
  const started = await onboard.start()

  // When
  const outcome = await onboard.add(started.pendingId, GOOD_CODE)

  // Then: the exchange was CSRF-checked against the state this session minted, not against nothing.
  // Passing the expected state is what stops a code phished from a different authorization from
  // being redeemed here.
  expect(recorded.exchanges).toEqual([{ input: GOOD_CODE, verifier: VERIFIER, redirectUri: REDIRECT, expectedState: STATE }])

  // And: the chain reached the account library intact
  expect(recorded.absorbed).toHaveLength(1)
  expect(recorded.absorbed[0].profile).toEqual(PROFILE)
  expect(recorded.absorbed[0].token).toEqual({ refresh: "refresh-new", access: "access-new", expires: recorded.now() + 8 * 3600_000 })

  // And: the caller is told who was added, by PREFIX — never the uuid a lease names
  expect(outcome).toEqual({ ok: true, idPrefix: "aaaaaaaa", label: "new@example.test", existing: false })
  expect(outcome.ok && outcome.idPrefix.length).toBe(8)
})

test("re-authorising an account already in the pool reports existing rather than a new arrival", async () => {
  // Given: the uuid behind this login is already on file
  const { onboard } = makeOnboard({ existing: true })
  const started = await onboard.start()

  // When
  const outcome = await onboard.add(started.pendingId, GOOD_CODE)

  // Then: success, but honestly labelled. Collapsing this into a plain success is how an operator
  // ends up believing the pool grew when all that happened was a credential refresh.
  expect(outcome).toEqual({ ok: true, idPrefix: "aaaaaaaa", label: "new@example.test", existing: true })
})

test("a bad paste is refused but leaves the session usable", async () => {
  // Given: a live session and an operator who truncated the code
  const { onboard, recorded } = makeOnboard()
  const started = await onboard.start()

  // When
  const refused = await onboard.add(started.pendingId, "truncated")

  // Then: refused, with the remaining budget named so the dialog can keep the field on screen
  expect(refused).toEqual({ ok: false, reason: "rejected", attemptsLeft: ONBOARD_MAX_ATTEMPTS - 1 })
  expect(onboard.pendingCount()).toBe(1)

  // And: the very same session then accepts the correct paste — no new browser round trip needed
  pastThrottle(recorded)
  const outcome = await onboard.add(started.pendingId, GOOD_CODE)
  expect(outcome.ok).toBe(true)
})

test("the attempt cap retires the session, and it is the last POST that session can provoke", async () => {
  // Given: a live session
  const { onboard, recorded } = makeOnboard()
  const started = await onboard.start()

  // When: every allowed attempt is spent on a wrong code
  const outcomes = []
  for (let attempt = 0; attempt < ONBOARD_MAX_ATTEMPTS; attempt++) {
    outcomes.push(await onboard.add(started.pendingId, "wrong"))
    pastThrottle(recorded)
  }

  // Then: the final refusal is `exhausted`, not another `rejected` — the difference the dialog uses
  // to stop inviting a re-paste and send the operator back for a new link
  expect(outcomes.slice(0, -1).every((o) => !o.ok && o.reason === "rejected")).toBe(true)
  expect(outcomes[outcomes.length - 1]).toEqual({ ok: false, reason: "exhausted" })

  // And: the session is GONE, so it can never reach Anthropic again
  expect(onboard.pendingCount()).toBe(0)
  expect(recorded.exchanges).toHaveLength(ONBOARD_MAX_ATTEMPTS)

  // And: a further attempt is refused WITHOUT another exchange. This is the bound that matters when
  // the route is keyless — the outbound POST count a single session can buy is capped, full stop.
  const after = await onboard.add(started.pendingId, GOOD_CODE)
  expect(after).toEqual({ ok: false, reason: "unknown-pending" })
  expect(recorded.exchanges).toHaveLength(ONBOARD_MAX_ATTEMPTS)
})

test("a successful exchange spends the session, so the code cannot be replayed", async () => {
  // Given: a session that has already been redeemed
  const { onboard, recorded } = makeOnboard()
  const started = await onboard.start()
  await onboard.add(started.pendingId, GOOD_CODE)
  pastThrottle(recorded)

  // When: the same paste arrives again (a double-clicked button, a resubmitted form)
  const replay = await onboard.add(started.pendingId, GOOD_CODE)

  // Then: refused locally. An authorization code is single-use UPSTREAM too, so forwarding it would
  // buy a guaranteed 400 from Anthropic and file the account twice on the way.
  expect(replay).toEqual({ ok: false, reason: "unknown-pending" })
  expect(recorded.exchanges).toHaveLength(1)
  expect(recorded.absorbed).toHaveLength(1)
})

test("a session past its TTL is expired, and says so rather than pretending it never existed", async () => {
  // Given: an operator who opened the dialog and wandered off
  const { onboard, recorded } = makeOnboard()
  const started = await onboard.start()

  // When
  recorded.advance(ONBOARD_PENDING_TTL_MS + 1)
  const outcome = await onboard.add(started.pendingId, GOOD_CODE)

  // Then: `expired`, kept DISTINCT from `unknown-pending` so the page can blame the clock instead of
  // implying the operator mistyped something
  expect(outcome).toEqual({ ok: false, reason: "expired" })
  expect(recorded.exchanges).toEqual([])
  expect(onboard.pendingCount()).toBe(0)
})

test("the pending store is capped, so an anonymous flood costs a constant amount of memory", async () => {
  // Given/When: far more sessions are opened than the cap allows
  const { onboard } = makeOnboard()
  const all = []
  for (let index = 0; index < ONBOARD_MAX_PENDING * 3; index++) all.push(await onboard.start())

  // Then: the store never grew past the cap. This — not a rate limit — is what makes the memory cost
  // of hammering the keyless authorize route a constant.
  expect(onboard.pendingCount()).toBe(ONBOARD_MAX_PENDING)

  // And: it is the OLDEST that were evicted, so the most recent operator to open the dialog is the
  // one still able to finish
  const oldest = await onboard.add(all[0].pendingId, GOOD_CODE)
  expect(oldest).toEqual({ ok: false, reason: "unknown-pending" })
  const newest = await onboard.add(all[all.length - 1].pendingId, GOOD_CODE)
  expect(newest.ok).toBe(true)
})

test("expired sessions are pruned by ordinary traffic, not left to accumulate", async () => {
  // Given: a store holding sessions that have all aged out
  const { onboard, recorded } = makeOnboard()
  await onboard.start()
  await onboard.start()
  expect(onboard.pendingCount()).toBe(2)

  // When: time passes and any route is touched
  recorded.advance(ONBOARD_PENDING_TTL_MS + 1)
  await onboard.start()

  // Then: only the fresh one remains — the TTL is enforced by the prune on every call rather than by
  // a timer this module would then have to own and dispose
  expect(onboard.pendingCount()).toBe(1)
})

test("the throttle refuses before reaching Anthropic, and does not cost the operator an attempt", async () => {
  // Given: a session whose first attempt has just been made
  const { onboard, recorded } = makeOnboard()
  const started = await onboard.start()
  await onboard.add(started.pendingId, "wrong")
  expect(recorded.exchanges).toHaveLength(1)

  // When: a second attempt arrives immediately
  const throttled = await onboard.add(started.pendingId, GOOD_CODE)

  // Then: refused with the wait named, and NO outbound POST. The rate floor exists to protect the
  // master's single egress IP at the token endpoint, whose 429 is charged to every account at once.
  expect(throttled.ok).toBe(false)
  expect(throttled).toMatchObject({ reason: "throttled" })
  expect(!throttled.ok && throttled.reason === "throttled" && throttled.retryAfterMs).toBeGreaterThan(0)
  expect(recorded.exchanges).toHaveLength(1)

  // And: being throttled did not consume a retry — the operator still has the full remaining budget,
  // so a rate limit can never be the reason a legitimate login runs out of attempts
  pastThrottle(recorded)
  const accepted = await onboard.add(started.pendingId, GOOD_CODE)
  expect(accepted.ok).toBe(true)
})

test("an unknown handle is refused without reaching Anthropic", async () => {
  // Given: a master that has issued nothing
  const { onboard, recorded } = makeOnboard()

  // When: a fabricated handle is presented
  const outcome = await onboard.add("pending-does-not-exist", GOOD_CODE)

  // Then: refused locally, so guessing handles is not a way to drive this master's egress
  expect(outcome).toEqual({ ok: false, reason: "unknown-pending" })
  expect(recorded.exchanges).toEqual([])
})

test("a profile failure after a successful exchange is reported, and burns the session", async () => {
  // Given: an exchange that will succeed and a profile endpoint that will not
  const { onboard, recorded } = makeOnboard({ profileThrows: true })
  const started = await onboard.start()

  // When
  const outcome = await onboard.add(started.pendingId, GOOD_CODE)

  // Then: distinct from `rejected`, because the authorization code was NOT the problem and is now
  // spent upstream — re-pasting it can never work, so the operator must be sent back for a new link
  expect(outcome).toEqual({ ok: false, reason: "profile-failed" })
  expect(recorded.absorbed).toEqual([])
  expect(onboard.pendingCount()).toBe(0)
})

test("each start mints a fresh session rather than reusing the last one", async () => {
  // Given/When: the dialog is opened twice
  const { onboard } = makeOnboard()
  const first = await onboard.start()
  const second = await onboard.start()

  // Then: two independent handles and two authorize calls. Reusing a session across opens would hand
  // back a handle the server may already have evicted, failing at the worst possible moment — after
  // the operator had gone and authorized in the browser.
  expect(first.pendingId).not.toBe(second.pendingId)
  expect(onboard.pendingCount()).toBe(2)
})
