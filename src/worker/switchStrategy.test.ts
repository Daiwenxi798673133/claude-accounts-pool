import { expect, test, mock } from "bun:test"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { LeaseOutcome } from "./leaseClient.ts"

// The spent account. The master needs this id twice over: to ATTRIBUTE the limit report, and to
// EXCLUDE that account when it picks the replacement — so it is asserted on both calls.
const SPENT_ID = "acct-spent"
const LEASE_ACCESS = "leased-access-for-worker"
// Unix SECONDS, the unit Anthropic uses on this header; parseAnthropicResetMs multiplies by 1000.
const RESET_SECONDS = Math.floor(Date.now() / 1000) + 1_800
// Quota telemetry only the WORKER can observe (these headers arrive on the error path alone), and
// only the MASTER can interpret (a reset instant means nothing without the full roster).
const QUOTA_HEADERS = {
  "anthropic-ratelimit-unified-status": "rejected",
  "anthropic-ratelimit-unified-reset": String(RESET_SECONDS),
}
// Must NEVER reach the master. diagnosticHeaders()' anchored whitelist DROPS every non-quota
// header, which is precisely why the injection point reuses it instead of filtering by hand.
const SECRET_HEADER = { authorization: "Bearer sk-ant-oat01-live-credential" }

// installAutoSwitch learns the spent id through readActiveId(); with a strategy present nothing
// else in accounts.ts / usage.ts / dialogs.tsx is consulted (the master owns selection AND
// cooldown), so this is the only module seam to stub. Spread-then-override, the lockfile.test.ts
// pattern: this registry entry is process-global and un-evictable, so dropping an export would
// break whatever links against it afterwards.
const realAccounts = { ...(await import("../accounts.ts")) }
mock.module("../accounts.ts", () => ({ ...realAccounts, readActiveId: async () => SPENT_ID }))

const { installAutoSwitch } = await import("../autoswitch.ts")
const { createSwitchStrategy } = await import("./switchStrategy.ts")

// ONE ordered log for every observable a cloud switch produces, because the ORDER is the contract:
// the report must reach the master BEFORE the lease request, or the master can hand back the very
// account that just died.
type Effect =
  | { kind: "report"; accountId: string; headers: Record<string, string>; resetsAt?: number }
  | { kind: "lease-request"; reason: string; currentAccountId?: string }
  // Tagged as the accounts.ts TokenWrite variant this seam produces in production —
  // writeAuthAnthropic({ kind: "lease", access, expires }). A worker may never produce
  // {kind:"full"}: that would file a refresh token it must not hold, and the writeLease dep's
  // shape (access + expires, no refresh) makes it unrepresentable.
  | { kind: "lease"; access: string; expires: number }
  | { kind: "resume"; text?: string }

type Toast = { variant?: string; message: string }
type Handler = (event: { id: string; properties: Record<string, unknown> }) => void

function setup(outcome: LeaseOutcome) {
  const effects: Effect[] = []
  const toasts: Toast[] = []
  const handlers = new Map<string, Handler>()
  const messages = [
    { id: "u1", role: "user", parentID: undefined },
    { id: "a1", role: "assistant", parentID: "u1", providerID: "anthropic", modelID: "claude-x", agent: "build", error: undefined },
  ]
  // A completed tool step ⇒ decideRedo returns "continue", i.e. the resume path the caller
  // ALREADY owns and which this change must leave untouched.
  const parts: Record<string, unknown[]> = {
    u1: [{ type: "text", text: "hello", synthetic: false, ignored: false }],
    a1: [{ type: "tool", tool: "read", state: { status: "completed" } }],
  }

  const api = {
    event: {
      on: (name: string, cb: Handler) => {
        handlers.set(name, cb)
        return () => handlers.delete(name)
      },
    },
    ui: { toast: (t: Toast) => toasts.push(t), dialog: { open: false } },
    client: {
      app: { log: () => Promise.resolve() },
      session: {
        abort: async () => ({}),
        promptAsync: async (arg: { parts: { type: string; text?: string }[] }) => {
          effects.push({ kind: "resume", text: arg.parts.find((part) => part.type === "text")?.text })
          return { error: undefined }
        },
      },
    },
    state: {
      session: { messages: () => messages, status: () => ({ type: "idle" }) },
      part: (id: string) => parts[id] ?? [],
    },
    kv: { get: () => ({}), set: () => {} },
  } as unknown as TuiPluginApi

  const strategy = createSwitchStrategy({
    client: {
      lease: async (input) => {
        effects.push({ kind: "lease-request", reason: input.reason, currentAccountId: input.currentAccountId })
        return outcome
      },
      reportRateLimit: async (input) => {
        effects.push({ kind: "report", accountId: input.accountId, headers: input.headers, resetsAt: input.resetsAt })
        return true
      },
    },
    writeLease: async (input) => {
      effects.push({ kind: "lease", access: input.access, expires: input.expires })
    },
    toast: (input) => toasts.push(input),
  })

  const controller = installAutoSwitch(api, strategy)

  // The real limit shape B2 in autoswitch.test.ts pins: Anthropic's unified rejection headers on
  // the session.error path, carrying one credential header the whitelist has to drop.
  const fireLimit = () =>
    handlers.get("session.error")?.({
      id: `evt-${Math.random()}`,
      properties: {
        sessionID: "s1",
        error: {
          name: "APIError",
          data: { statusCode: 429, responseHeaders: { ...QUOTA_HEADERS, ...SECRET_HEADER } },
        },
      },
    })

  // A REVOKED leased token: a BARE 401 — no quota headers, no rate-limit body, no rate-limit
  // wording — so isAnthropicUsageLimit reads it as "not a limit" and the rate-limit path is
  // provably not the one under test here.
  const fireStale = () =>
    handlers.get("session.error")?.({
      id: `evt-${Math.random()}`,
      properties: { sessionID: "s1", error: { name: "APIError", data: { statusCode: 401 } } },
    })

  return { controller, effects, toasts, fireLimit, fireStale }
}

async function flush(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (pred()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
}

test("rate limit triggers report then lease then sentinel write then continue resume", async () => {
  // Given: the master will hand back a DIFFERENT account whose lease is still valid
  const expiresAt = Date.now() + 3_600_000
  const { controller, effects, toasts, fireLimit } = setup({
    ok: true,
    lease: { accountId: "acct-fresh", access: LEASE_ACCESS, expiresAt },
  })

  // When: the leased account's turn fails with Anthropic's unified quota rejection
  fireLimit()
  await flush(() => effects.some((effect) => effect.kind === "resume"))

  // Then: report → lease → credential write → the caller's own continue resume, in THAT order.
  expect(effects.map((effect) => effect.kind)).toEqual(["report", "lease-request", "lease", "resume"])
  // Quota headers verbatim and NOTHING else — the credential header is gone, and resetsAt is the
  // header's Unix seconds promoted to epoch ms.
  expect(effects[0]).toEqual({ kind: "report", accountId: SPENT_ID, headers: QUOTA_HEADERS, resetsAt: RESET_SECONDS * 1000 })
  // reason:"ratelimit" (not "prelease") + the spent id, which is what lets the master exclude it.
  expect(effects[1]).toEqual({ kind: "lease-request", reason: "ratelimit", currentAccountId: SPENT_ID })
  expect(effects[2]).toEqual({ kind: "lease", access: LEASE_ACCESS, expires: expiresAt })
  expect(effects[3]).toEqual({ kind: "resume", text: "continue" })
  expect(toasts.some((toast) => toast.variant === "error")).toBe(false)
  controller.dispose()
})

test("failed lease during rate limit surfaces toast and does not write", async () => {
  // Given: the master has consulted its whole roster and has nothing spare (its 503 answer)
  const { controller, effects, toasts, fireLimit } = setup({ ok: false, failure: { kind: "no-account" } })

  fireLimit()
  await flush(() => toasts.length > 0)

  // Then: the report still went out (the master needs the data point either way), the lease was
  // attempted, and then it STOPPED.
  expect(effects.map((effect) => effect.kind)).toEqual(["report", "lease-request"])
  // No credential write: keeping the spent lease is recoverable, a half-written one is not.
  expect(effects.some((effect) => effect.kind === "lease")).toBe(false)
  // And the caller must NOT resume — the returned false is what stalls the session instead.
  expect(effects.some((effect) => effect.kind === "resume")).toBe(false)
  expect(toasts.some((toast) => toast.variant === "error" && /[\u4e00-\u9fff]/.test(toast.message))).toBe(true)
  controller.dispose()
})

// ---- INV-CLOUD-5: a REVOKED (stale) leased access token ----
// MEASURED against the real Anthropic API: an account's access token returned 200, the master
// refreshed that account (POST the token endpoint with grant_type=refresh_token, which also rotated
// the refresh token) and the new access token returned 200 — after which the PREVIOUS access token
// returned 401. Anthropic REVOKES the prior access token on refresh. The master is the only
// refresher in this architecture and workers hold leased copies of exactly that token, so every
// outstanding lease for an account dies the instant the master refreshes it.
// The account itself is HEALTHY — only the token is gone — which is what makes this a different
// event from a quota limit and forces two differences from onLimit: NO rate-limit report (there is
// no quota fact to report, and reporting one would have the master cool a perfectly good account)
// and reason:"prelease", the one reason leaseServer never turns into an exclusion.
// The very id the readActiveId stub returns, under the name leaseKeeper uses for it (heldAccountId).
// Renamed because in THIS scenario the account is not spent at all — it is healthy.
const HELD_ID = SPENT_ID

test("stale lease 401 triggers immediate re-lease and resume", async () => {
  // Given: the account is fine, so the master re-issues a still-valid token for that SAME account
  const expiresAt = Date.now() + 3_600_000
  const { controller, effects, toasts, fireStale } = setup({
    ok: true,
    lease: { accountId: HELD_ID, access: LEASE_ACCESS, expiresAt },
  })

  // When: the turn fails 401 because the token this worker holds was rotated out from under it
  fireStale()
  await flush(() => effects.some((effect) => effect.kind === "resume"))

  // Then: lease → credential write → the caller's own continue resume. The ABSENT "report" is the
  // headline: a 401 must never be reported as a rate limit.
  expect(effects.map((effect) => effect.kind)).toEqual(["lease-request", "lease", "resume"])
  expect(effects[0]).toEqual({ kind: "lease-request", reason: "prelease", currentAccountId: HELD_ID })
  expect(effects[1]).toEqual({ kind: "lease", access: LEASE_ACCESS, expires: expiresAt })
  expect(effects[2]).toEqual({ kind: "resume", text: "continue" })
  expect(toasts.some((toast) => toast.variant === "error")).toBe(false)
  controller.dispose()
})

test("stale lease re-lease failure surfaces toast and does not write", async () => {
  // Given: the master is unreachable, so the revoked token has no replacement
  const { controller, effects, toasts, fireStale } = setup({ ok: false, failure: { kind: "unreachable", detail: "ECONNREFUSED" } })

  fireStale()
  await flush(() => toasts.length > 0)

  // Then: one lease attempt and NOTHING else — still no report on this path.
  expect(effects.map((effect) => effect.kind)).toEqual(["lease-request"])
  expect(effects.some((effect) => effect.kind === "lease")).toBe(false)
  // No resume either: the token we hold is revoked, so a retry would fail 401 again and the user
  // would pay for the same dead turn twice.
  expect(effects.some((effect) => effect.kind === "resume")).toBe(false)
  expect(toasts.some((toast) => toast.variant === "error" && /[\u4e00-\u9fff]/.test(toast.message))).toBe(true)
  controller.dispose()
})

test("stale lease refuses an already-expired replacement and does not write", async () => {
  // Given: the master answers, but the lease it hands back is already dead on arrival
  const { controller, effects, toasts, fireStale } = setup({
    ok: true,
    lease: { accountId: HELD_ID, access: LEASE_ACCESS, expiresAt: Date.now() - 1_000 },
  })

  fireStale()
  await flush(() => toasts.length > 0)

  // Then: refused before the write. An expired `expires` in auth.json is the ONE state that turns
  // the local auth provider into a second refresher of the master's one-time-use chain.
  expect(effects.map((effect) => effect.kind)).toEqual(["lease-request"])
  expect(effects.some((effect) => effect.kind === "resume")).toBe(false)
  expect(toasts.some((toast) => toast.variant === "error" && /[\u4e00-\u9fff]/.test(toast.message))).toBe(true)
  controller.dispose()
})
