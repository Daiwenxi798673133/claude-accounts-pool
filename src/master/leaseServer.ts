// The master's HTTP face: the ONLY door through which a worker machine can obtain an Anthropic
// access token. It owns no policy of its own — scheduling and refreshing are injected — so what is
// actually implemented here is the WIRE CONTRACT: which route answers which status, and in what
// order the checks run.
//
// THERE IS NO APPLICATION-LAYER CREDENTIAL ON THIS SERVER. Every route below is reachable by anyone
// who can reach the port, so THE BIND ADDRESS IS THE ENTIRE ACCESS CONTROL: the operator points
// `hostname` at a private interface (a Tailscale address, a VPN, loopback) and the network decides
// who may lease. A bearer token in front of `lease` would be theatre unless the route that issues it
// is itself gated — and gating that route is the same problem again, one layer up.
//
// SO: never add a route here on the assumption that something upstream authenticates the caller, and
// never widen the bind address to reach one more machine. Nothing else is standing behind it.
//
// Everything below is dependency-injected for one reason: the real refresher POSTs a live,
// one-time-use refresh token at Anthropic. A default-constructed collaborator in a test would
// rotate a real chain on a paid account, so there are no defaults anywhere in LeaseServerDeps.

import type { StoredAccount } from "../accounts.ts"
import type {
  AccountAddRequest,
  AccountAddResponse,
  AccountDeleteRefusal,
  AccountDeleteRefusedBody,
  AccountDeleteRequest,
  AccountDeleteResponse,
  AuthorizeStartResponse,
  ErrorBody,
  LeaseReason,
  LeaseRefusal,
  LeaseRefusedBody,
  LeaseRequest,
  LeaseResponse,
  RateLimitReport,
  ThrottledBody,
  UsageSnapshotView,
} from "../cloud/protocol.ts"
import { CLOUD_ROUTES } from "../cloud/protocol.ts"
import { LEASE_CHECK_INTERVAL_MS, LEASE_RENEW_BUFFER_MS, MASTER_REFRESH_THRESHOLD_MS } from "../constants.ts"
import { log, redactHeaders } from "../logger.ts"
import type { AccountOnboard } from "./accountOnboard.ts"
import type { AccountRemove } from "./accountRemove.ts"
import { dashboardHtml } from "./dashboardHtml.ts"
import type { PreferredInput, PreferredPick, UsageSnapshot } from "./scheduler.ts"
import { buildUsageView } from "./usageView.ts"

export type LeaseServerDeps = {
  scheduler: {
    pickAccount(input: { accounts: StoredAccount[]; exclude?: string }): StoredAccount | undefined
    // Selection for a lease that NAMES its account, kept a separate verb from pickAccount so the
    // ranked path cannot accidentally inherit "excluded is servable" and vice versa.
    pickPreferred(input: PreferredInput): PreferredPick
    reportRateLimit(accountId: string, resetsAt?: number): void
    // The two READ-ONLY halves of the dashboard's payload. Required, not optional: a master serving
    // leases without a usage view would answer the dashboard route with an empty page and look like
    // a pool with no accounts.
    getUsageSnapshot(): UsageSnapshot
    isCoolingDown(accountId: string): boolean
  }
  refresher: { getFreshAccess(accountId: string, minHorizonMs?: number): Promise<{ access: string; expiresAt: number }> }
  loadAccounts: () => Promise<StoredAccount[]>
  // Runs ONE usage sweep and resolves when the snapshot has been handed to the scheduler — the usage
  // poller's own tickOnce. Injected as a bare thunk so this server never learns what a poller is, and
  // so a test can prove the route triggers a sweep without any network at all.
  refreshUsage: () => Promise<void>
  // The dashboard's "添加账号" flow. Owns the PKCE sessions, the exchange and the write into the
  // account library; this server owns only the mapping from its outcomes onto HTTP statuses.
  accountOnboard: AccountOnboard
  // The dashboard's "删除账号" flow, and the mirror image of the field above: it owns prefix
  // resolution, the label confirmation and the backup-before-delete ordering, and this server again
  // owns only the statuses.
  accountRemove: AccountRemove
  // Injected so a test can drive the refresh throttle deterministically. EVERY time read in this
  // module goes through it; a stray Date.now() would silently escape the injected clock.
  now?: () => number
  // No default, and never `0.0.0.0`: this port hands out live credentials, so the interface it
  // binds is the caller's explicit decision (a loopback/VPN address), never something inferred.
  hostname: string
  port: number
  // The opencode plugin lifecycle signal. A lease server that outlived its plugin would keep
  // answering with credentials nobody is supervising any more.
  signal: AbortSignal
}

type Route = (typeof CLOUD_ROUTES)[keyof typeof CLOUD_ROUTES]
type RouteHandler = (req: Request) => Promise<Response>

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function json(
  status: number,
  body:
    | ErrorBody
    | LeaseResponse
    | UsageSnapshotView
    | ThrottledBody
    | LeaseRefusedBody
    | AuthorizeStartResponse
    | AccountAddResponse
    | AccountDeleteRefusedBody
    | AccountDeleteResponse
    | { ok: true },
): Response {
  return Response.json(body, { status })
}

// `nosniff` because this is the ONE route answering with a document rather than JSON, and `no-store`
// so an operator who upgrades the plugin is not left staring at the previous version's shell.
function html(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" },
  })
}

// A table keyed by LeaseReason rather than an `||` chain: adding a reason to the protocol becomes
// a COMPILE error here instead of silently 400-ing every worker that starts sending it.
const LEASE_REASONS: Record<LeaseReason, true> = { prelease: true, ratelimit: true }

function isLeaseReason(value: unknown): value is LeaseReason {
  return typeof value === "string" && Object.hasOwn(LEASE_REASONS, value)
}

// `undefined` means "these bytes were not JSON at all". A literal `null` body parses fine and is
// then refused by the shape check in each parser, so collapsing both cases loses nothing.
async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json()
  } catch {
    return undefined
  }
}

function parseLeaseRequest(raw: unknown): LeaseRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { workerId, reason, currentAccountId, preferredAccountIdPrefix } = raw as Record<string, unknown>
  if (!isWorkerLabel(workerId)) return undefined
  // Strict, because this field decides whether an account is excluded from the pick. An unknown
  // reason silently defaulting to `prelease` would re-issue the spent account to a worker that
  // just hit its limit — the one outcome the ratelimit path exists to prevent.
  if (!isLeaseReason(reason)) return undefined
  if (currentAccountId !== undefined && typeof currentAccountId !== "string") return undefined
  // An EMPTY prefix is malformed, not a match-anything wildcard: it would resolve to `ambiguous` on
  // a multi-account pool but succeed by luck on a single-account one, so a request that names nothing
  // must be refused at the boundary rather than behave differently per pool size.
  if (preferredAccountIdPrefix !== undefined && (typeof preferredAccountIdPrefix !== "string" || preferredAccountIdPrefix.length === 0)) {
    return undefined
  }
  return {
    workerId,
    reason,
    ...(currentAccountId === undefined ? {} : { currentAccountId }),
    ...(preferredAccountIdPrefix === undefined ? {} : { preferredAccountIdPrefix }),
  }
}

// English, like every other `error` string on this wire: the worker branches on `refused` and renders
// its own Chinese, so these exist for whoever is reading the route with curl.
const LEASE_REFUSAL_DETAIL: Record<LeaseRefusal, string> = {
  unknown: "no such account in the pool",
  ambiguous: "account prefix matches more than one account",
  cooling: "account is rate-limited",
  "needs-reauth": "account needs re-authentication",
}

// Copies string entries only. The headers are quota telemetry the master logs by KEY, so a
// non-string value is dropped rather than made a reason to reject the whole report.
function parseHeaderMap(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value === null) return {}
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === "string") out[key] = entry
  }
  return out
}

function parseRateLimitReport(raw: unknown): RateLimitReport | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { workerId, accountId, headers, resetsAt } = raw as Record<string, unknown>
  if (!isWorkerLabel(workerId)) return undefined
  // The ONE field the cooldown cannot be applied without.
  if (typeof accountId !== "string" || accountId.length === 0) return undefined
  return {
    workerId,
    accountId,
    // LENIENT on the two optional fields on purpose. This report arrives on the worker's RECOVERY
    // path: refusing it means the account is never cooled and the worker immediately re-leases
    // the same spent account. A garbled `resetsAt` therefore degrades to an unknown-deadline
    // cooldown (which the scheduler resolves from its next usage poll) instead of taking the
    // whole report — and the user's session — down with it.
    headers: parseHeaderMap(headers),
    ...(typeof resetsAt === "number" && Number.isFinite(resetsAt) ? { resetsAt } : {}),
  }
}

function parseAccountAddRequest(raw: unknown): AccountAddRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { pendingId, code } = raw as Record<string, unknown>
  if (typeof pendingId !== "string" || pendingId.length === 0) return undefined
  // Trimmed HERE rather than in the onboard module, because whitespace is an artefact of how the
  // operator moved the value (a copied line often carries a trailing newline) and not something the
  // PKCE contract has an opinion about. An all-whitespace paste is an empty paste.
  if (typeof code !== "string") return undefined
  const trimmed = code.trim()
  if (trimmed.length === 0) return undefined
  return { pendingId, code: trimmed }
}

// BOTH fields are required and BOTH must be non-empty, which is stricter than it looks: an empty
// prefix would match every account (and so resolve to `ambiguous` on a real pool but succeed by luck
// on a single-account one), and an empty label would turn the confirmation into a field the caller
// can satisfy by omitting it. Only the surrounding whitespace of the label is forgiven — that is an
// artefact of copying an address off the page, not something the operator meant.
function parseAccountDeleteRequest(raw: unknown): AccountDeleteRequest | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { idPrefix, label } = raw as Record<string, unknown>
  if (typeof idPrefix !== "string" || idPrefix.length === 0) return undefined
  if (typeof label !== "string") return undefined
  const trimmed = label.trim()
  if (trimmed.length === 0) return undefined
  return { idPrefix, label: trimmed }
}

// English, like every other `error` string on this wire: the page branches on `refused` and renders
// its own Chinese, so these exist for whoever is reading the route with curl.
const DELETE_REFUSAL_DETAIL: Record<AccountDeleteRefusal, string> = {
  unknown: "no such account in the pool",
  ambiguous: "account prefix matches more than one account",
  "label-mismatch": "confirmation does not match the account label",
}

// `workerId` is a SELF-DECLARED label — nothing authenticates it, so it names the machine only as
// well as that machine cares to be named honestly. It is narrowed here because it is the one field
// on this wire that reaches the LOG FILE: a control character would forge a line break and let a
// caller write arbitrary fake entries into the operator's log, and an unbounded string would let one
// request fill the disk. The character class is deliberately wider than a hostname's (case is kept)
// so an existing worker's configured id is not refused by a narrowing it never agreed to.
const WORKER_LABEL_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

function isWorkerLabel(value: unknown): value is string {
  return typeof value === "string" && WORKER_LABEL_PATTERN.test(value)
}

// One forced sweep per this window, server-wide. NOT per caller: what it protects is the master's
// single egress IP, and `/api/oauth/usage` answers a burst with a 429 that lasts minutes and applies
// to every account behind that IP — so one person's press must throttle everyone. Chosen an order of
// magnitude below the scheduled interval so the button is genuinely useful, while still turning an
// unbounded anonymous lever into at most two sweeps a minute.
export const USAGE_REFRESH_MIN_INTERVAL_MS = 30_000

export function startLeaseServer(deps: LeaseServerDeps): { port: number; stop: () => void } {
  const now = deps.now ?? Date.now
  // Seeded at 0, not at startup: the first press after a master boots is the one most worth serving —
  // the scheduled poller has not swept yet, so the dashboard is empty until it does.
  let lastForcedSweepAt = 0

  function badRequest(detail: string): Response {
    return json(400, { error: detail })
  }

  async function handleLease(req: Request): Promise<Response> {
    // Parsed BEFORE the roster is loaded: a malformed body is the caller's fault and must cost
    // the master nothing. A parse fault is answered 400 and never allowed to escape as a 500,
    // which the worker client would treat as a transient fault and retry verbatim, forever.
    const request = parseLeaseRequest(await readJson(req))
    if (!request) return badRequest("malformed lease request")
    const { workerId } = request
    const accounts = await deps.loadAccounts()
    // A NAMED account short-circuits selection completely. `reason` still says why the worker is
    // asking, but it no longer influences WHICH account is served — the operator pressed a row.
    // Naming the account a `ratelimit` report just cooled therefore comes back as a `cooling`
    // refusal rather than re-issuing a spent account, because the report lands before this request.
    if (request.preferredAccountIdPrefix !== undefined) {
      const preferred = deps.scheduler.pickPreferred({ accounts, prefix: request.preferredAccountIdPrefix })
      if (!preferred.ok) {
        // 409, deliberately none of the statuses above: 503 would tell the worker's client "the pool
        // is momentarily spent, retry", when the truth is that THIS account is unservable and
        // retrying the same request cannot change that. The worker turns `refused` into the one
        // Chinese sentence that names the operator's actual remedy.
        log.warn("master:lease-refused", { workerId, prefix: request.preferredAccountIdPrefix, refused: preferred.refusal })
        return json(409, { error: LEASE_REFUSAL_DETAIL[preferred.refusal], refused: preferred.refusal })
      }
      log.info("master:lease-preferred", { workerId, accountId: preferred.account.id })
      return serveLease(workerId, preferred.account)
    }
    // `ratelimit` names an account that is SPENT, so it is excluded from this pick. `prelease` is
    // the routine renewal path with nothing to avoid — handing back the same account is the
    // expected answer there, and excluding it would rotate the pool for no reason.
    const exclude = request.reason === "ratelimit" ? request.currentAccountId : undefined
    const account = deps.scheduler.pickAccount({ accounts, exclude })
    if (!account) {
      // 503, kept DISTINCT from the 401 above: both refuse, but the worker acts on them
      // differently. A 401 says "this key will never work, stop"; a 503 says "the pool is
      // momentarily spent, come back". Collapsing them either strands a healthy worker or makes
      // a rejected one hammer the master.
      log.warn("master:lease-unavailable", { workerId, reason: request.reason, exclude })
      return json(503, { error: "no account available" })
    }
    return serveLease(workerId, account)
  }

  // The tail BOTH lease paths share: mint a fresh access token, bound its horizon, answer. Extracted
  // rather than duplicated because the arithmetic below is INV-CLOUD-4 — two copies of it would let
  // the named-account path drift into serving a lease that outlives the master's own refresh point.
  async function serveLease(workerId: string, account: StoredAccount): Promise<Response> {
    let fresh: { access: string; expiresAt: number }
    try {
      // The refresher is TOLD how much horizon this lease needs rather than asked for whatever is
      // cached: a token a second above the rotation threshold would otherwise become a lease the
      // worker cannot hold for even one renewal cycle.
      fresh = await deps.refresher.getFreshAccess(account.id, LEASE_RENEW_BUFFER_MS)
    } catch (error) {
      // 503, and the try/catch exists ONLY to make it so. An escaping throw is answered by Bun with
      // a 500, which the worker's client classifies as a transient server fault and retries with
      // backoff for ~10 minutes before giving up as "unreachable" — so ONE dead account used to
      // surface on every worker as 连不上云端账号池, naming the network and the master as suspects
      // when both were fine. 503 is the honest answer: the pool has nothing to give right now.
      log.warn("master:lease-refresh-failed", { workerId, accountId: account.id, error: errorMessage(error) })
      return json(503, { error: "no account available" })
    }
    // INV-CLOUD-4 — A LEASE MAY NEVER OUTLIVE THE MASTER'S OWN REFRESH POINT. Anthropic REVOKES the previously
    // issued access token the instant a refresh succeeds — MEASURED against the live API, not inferred, and
    // contrary to ordinary OAuth 2.0 semantics: an access token answered 200 on /api/oauth/usage, the account was
    // then refreshed (the refresh tip rotated), the NEW access answered 200, and the SAME OLD access token
    // answered 401. So the master's own rotation — due at `expires - MASTER_REFRESH_THRESHOLD_MS` — is what kills
    // every lease already in flight, and serving the raw account expiry was the DEFECT: the master rotated while
    // the worker, which renews only at `expires - LEASE_RENEW_BUFFER_MS`, held a REVOKED token for the rest of
    // the window. THE SUBTRAHEND MUST BE THE REFRESHER'S OWN TRIGGER AND NOTHING ELSE — any smaller value
    // advertises a horizon that reaches past the rotation which revokes it, and the worker, seeing an expiry
    // still comfortably ahead, sits on a dead token until its own renewal finally falls due.
    const expiresAt = fresh.expiresAt - MASTER_REFRESH_THRESHOLD_MS
    // DEAD ON ARRIVAL — refused, never served. Only reachable if the refresher handed back a token already
    // inside that floor, so this is defence in depth; but the worker writes `expiresAt` into auth.json, where
    // the local provider refreshes on `expires < Date.now()` with ZERO buffer and only INV-CLOUD-1's sentinel to
    // refresh against — a spent horizon therefore dooms it twice: revoked token now, failed self-refresh next.
    // The floor is one worker check interval, because a lease is inspected only that often. Deliberately the
    // SAME 503 as an empty pool: the worker's back-off-and-retry is already the right recovery here.
    if (expiresAt - now() < LEASE_CHECK_INTERVAL_MS) {
      log.warn("master:lease-horizon-spent", { workerId, accountId: account.id, expiresAt })
      return json(503, { error: "no account available" })
    }
    // PRIVACY: `fresh.access` is a live credential and must NEVER reach the log file; the account
    // id and the expiry carry the entire diagnostic value anyway.
    log.info("master:lease-served", { workerId, accountId: account.id, expiresAt })
    return json(200, { accountId: account.id, access: fresh.access, expiresAt })
  }

  async function handleRateLimit(req: Request): Promise<Response> {
    const report = parseRateLimitReport(await readJson(req))
    if (!report) return badRequest("malformed ratelimit report")
    const { workerId } = report
    deps.scheduler.reportRateLimit(report.accountId, report.resetsAt)
    // Header KEYS only, via redactHeaders: the worker forwards the limit response's headers
    // verbatim, and echoing values into a shared log file is how a credential-bearing header
    // ends up on disk.
    log.info("master:ratelimit-reported", {
      workerId,
      accountId: report.accountId,
      resetsAt: report.resetsAt,
      headerKeys: redactHeaders(report.headers),
    })
    // 204 with no body: the caller is a best-effort telemetry path that reads only `res.ok`, so
    // there is no state the master owes it in return.
    return new Response(null, { status: 204 })
  }

  // READ-ONLY AND UNAUTHENTICATED — see the decision recorded on CLOUD_ROUTES.usage. Two properties
  // are what make that safe enough to be a choice rather than a bug, and BOTH must survive any edit
  // here:
  //   1. NO CREDENTIAL IS REACHABLE FROM THIS PAYLOAD. Enforced by the view's type (usageView.ts),
  //      not by care taken in this function. Never build a row by spreading a StoredAccount.
  //   2. IT CANNOT BE USED TO DRIVE THE POOL. It reads the usage poller's existing snapshot and
  //      issues no request of its own, so an anonymous caller hammering this route cannot provoke
  //      `/api/oauth/usage` (whose 429 lasts minutes and is charged to this master's egress IP),
  //      cannot mint a token, and cannot move an account.
  async function usageView(): Promise<UsageSnapshotView> {
    return buildUsageView({
      accounts: await deps.loadAccounts(),
      snapshot: deps.scheduler.getUsageSnapshot(),
      // Wrapped rather than passed by reference: the scheduler is an injected object here, and a
      // detached method would break on any implementation that is not closure-based.
      isCoolingDown: (accountId) => deps.scheduler.isCoolingDown(accountId),
    })
  }

  async function handleUsage(): Promise<Response> {
    const view = await usageView()
    log.debug("master:usage-served", { accounts: view.accounts.length, stale: view.stale })
    return json(200, view)
  }

  // The dashboard's 刷新 button. The ONE public route that reaches outside this machine, so it is the
  // one place the two guards below are load-bearing rather than ceremonial.
  async function handleUsageRefresh(req: Request): Promise<Response> {
    // METHOD ENFORCED, unlike every other route here — a GET on this path must not sweep, or a
    // speculative fetch of a pasted link would. 405 names the actual fault instead of 404, which
    // would read as "this master is too old to have the button".
    if (req.method !== "POST") {
      return json(405, { error: "use POST" })
    }
    const elapsed = now() - lastForcedSweepAt
    if (elapsed < USAGE_REFRESH_MIN_INTERVAL_MS) {
      const retryAfterMs = USAGE_REFRESH_MIN_INTERVAL_MS - elapsed
      log.debug("master:usage-refresh-throttled", { retryAfterMs })
      // Retry-After (seconds, per RFC 9110) for anything speaking plain HTTP, and the exact
      // millisecond figure in the body for the page's own countdown.
      return new Response(JSON.stringify({ error: "refresh throttled", retryAfterMs } satisfies ThrottledBody), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(retryAfterMs / 1000)) },
      })
    }
    // Stamped BEFORE the sweep, not after: a sweep serialises behind the poller's own re-entrancy
    // guard and can take seconds, and stamping afterwards would let a double-click queue a second
    // sweep that the window was supposed to refuse.
    lastForcedSweepAt = now()
    await deps.refreshUsage()
    const view = await usageView()
    log.info("master:usage-refresh-served", { accounts: view.accounts.length, stale: view.stale })
    return json(200, view)
  }

  // POST-only for the same reason handleUsageRefresh is, and it is NOT redundant here just because
  // this one issues no upstream request: it mutates the pending-session store, so a speculative GET
  // from a link unfurler could evict the session an operator is halfway through using.
  async function handleAccountAuthorize(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "use POST" })
    const started = await deps.accountOnboard.start()
    // The URL is safe to log — it is the same public value the page displays, carrying a challenge
    // rather than the verifier — but it is long and appears verbatim on screen anyway, so only the
    // handle and the deadline are recorded.
    log.info("master:account-authorize-served", { pendingId: started.pendingId, expiresAt: started.expiresAt })
    return json(200, started)
  }

  // Maps AddOutcome onto statuses. The split that matters to the page is 400 vs 410: a 400 is
  // RECOVERABLE (re-paste into the field that is still on screen), a 410 means the session is gone and
  // the operator must fetch a new link. Collapsing them would either strand someone on a dead session
  // or throw away a good one over a typo.
  async function handleAccountAdd(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "use POST" })
    const request = parseAccountAddRequest(await readJson(req))
    if (!request) return badRequest("malformed account add request")
    const outcome = await deps.accountOnboard.add(request.pendingId, request.code)
    if (outcome.ok) {
      // PRIVACY: `outcome` carries an id PREFIX and the account email, never the chain that was just
      // minted — AccountAddResponse has no field either token could be assigned to.
      log.info("master:account-added", { idPrefix: outcome.idPrefix, existing: outcome.existing })
      return json(200, { idPrefix: outcome.idPrefix, label: outcome.label, existing: outcome.existing })
    }
    if (outcome.reason === "throttled") {
      // Same two-channel shape as the refresh throttle: Retry-After in seconds for anything speaking
      // plain HTTP, the exact millisecond figure in the body for the dialog's own countdown.
      return new Response(JSON.stringify({ error: "add throttled", retryAfterMs: outcome.retryAfterMs } satisfies ThrottledBody), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(Math.ceil(outcome.retryAfterMs / 1000)) },
      })
    }
    if (outcome.reason === "rejected") return badRequest("authorization code rejected")
    // 502, not 500: the failure is upstream's (the profile endpoint), and it lands AFTER a successful
    // exchange — the one arm where a real credential was minted and could not be filed.
    if (outcome.reason === "profile-failed") return json(502, { error: "profile lookup failed" })
    // The three terminal session states. Distinct strings, one status: all three mean "start over".
    return json(410, { error: outcome.reason })
  }

  // THE ONE DESTRUCTIVE ROUTE ON THIS SERVER. POST-enforced like the two above it, and for a sharper
  // reason: the others cost an upstream request or a pending session, this one costs an account.
  //
  // 409 for all three refusals, deliberately NOT 404 for `unknown`: they share one remedy shape (look
  // at the page again and re-issue) and the page branches on `refused`, not on the status. A 404
  // would additionally read as "this master is too old to have the route", which is the one thing
  // that is not wrong here.
  async function handleAccountDelete(req: Request): Promise<Response> {
    if (req.method !== "POST") return json(405, { error: "use POST" })
    const request = parseAccountDeleteRequest(await readJson(req))
    if (!request) return badRequest("malformed account delete request")
    const outcome = await deps.accountRemove.remove(request.idPrefix, request.label)
    if (!outcome.ok) {
      log.warn("master:account-delete-refused", { idPrefix: request.idPrefix, refused: outcome.refusal })
      return json(409, { error: DELETE_REFUSAL_DETAIL[outcome.refusal], refused: outcome.refusal })
    }
    // The deletion itself is logged by accountRemove, which is where the record was still in hand.
    return json(200, { idPrefix: outcome.idPrefix, label: outcome.label })
  }

  // The STRING is built once (the shell is a constant), but each request gets a FRESH Response: a
  // Response body is a single-use stream, so sharing one object would serve the first browser and
  // then fail every reload after it.
  const dashboardShell = dashboardHtml({
    usageRoute: CLOUD_ROUTES.usage,
    refreshRoute: CLOUD_ROUTES.usageRefresh,
    throttleMs: USAGE_REFRESH_MIN_INTERVAL_MS,
    authorizeRoute: CLOUD_ROUTES.accountAuthorize,
    addRoute: CLOUD_ROUTES.accountAdd,
    deleteRoute: CLOUD_ROUTES.accountDelete,
  })

  const routes: Record<Route, RouteHandler> = {
    // A worker probes this BEFORE it trusts a master URL, and an ops liveness check calls it forever.
    // The price of that is that it may leak NOTHING: no account ids, no worker roster, no pool
    // counts. A fixed `{ ok: true }` is the whole payload.
    [CLOUD_ROUTES.health]: async () => json(200, { ok: true }),
    // THE TWO ROUTES THAT MOVE POOL STATE, and the reason the bind address matters. `lease` hands
    // back a live Anthropic access token; `ratelimit` can cool an account out of selection for
    // everyone. Neither is gated by anything in this process — see the header of this file.
    [CLOUD_ROUTES.lease]: (req) => handleLease(req),
    [CLOUD_ROUTES.ratelimit]: (req) => handleRateLimit(req),
    [CLOUD_ROUTES.usage]: () => handleUsage(),
    [CLOUD_ROUTES.dashboard]: async () => html(dashboardShell),
    [CLOUD_ROUTES.usageRefresh]: (req) => handleUsageRefresh(req),
    // The onboarding pair WRITES — the second one adds a record to the account library — so the
    // bounded session store and the throttle inside accountOnboard are what keep an unattended
    // caller from filling memory or provoking unbounded upstream traffic. That is the whole of the
    // defence, and this table is where a reviewer should notice it.
    [CLOUD_ROUTES.accountAuthorize]: (req) => handleAccountAuthorize(req),
    [CLOUD_ROUTES.accountAdd]: (req) => handleAccountAdd(req),
    // AND THE ONE THAT TAKES AN ACCOUNT OUT. Nothing in this process gates it either, so what stands
    // between an anonymous caller and a deleted subscription is: the bind address, having to name the
    // account's own label, and the copy accountRemove files before the write. A reviewer should
    // notice all three here, and should not add a fourth in this table — the header of this file
    // explains why an application-layer one would be theatre.
    [CLOUD_ROUTES.accountDelete]: (req) => handleAccountDelete(req),
  }

  // A table lookup, not an if/else chain over paths: the chain's fallthrough silently answers an
  // unknown path with whatever the last branch happened to be.
  function isRoute(path: string): path is Route {
    return Object.hasOwn(routes, path)
  }

  const server = Bun.serve({
    hostname: deps.hostname,
    port: deps.port,
    // Explicitly OFF. Bun's development mode answers an unhandled throw with a stack-trace page,
    // and this port is reachable by every worker on the internal network — a 500 here must say
    // nothing about the master's internals.
    development: false,
    fetch: async (req: Request): Promise<Response> => {
      const path = new URL(req.url).pathname
      if (!isRoute(path)) return json(404, { error: "not found" })
      return routes[path](req)
    },
  })

  // Force-close (`true`), not graceful: an aborted lifecycle signal means the plugin is being
  // disposed, so a parked keep-alive socket would keep this process — and its lease authority —
  // alive past the moment it was supposed to end.
  const stop = (): void => {
    server.stop(true)
  }

  // Bun types `port` as optional because a UNIX-SOCKET server has none, and this one is always
  // TCP (LeaseServerDeps offers no unix option) — so `undefined` is unreachable here. It is
  // refused rather than coerced anyway: with `port: 0` the assigned port is knowable ONLY from
  // this field, and every caller turns it into the URL it hands to workers, so substituting
  // `deps.port` would advertise a master that is not listening.
  const { port } = server
  if (port === undefined) {
    stop()
    throw new Error("lease server bound no TCP port")
  }

  deps.signal.addEventListener("abort", stop, { once: true })
  // A signal that was ALREADY aborted never fires the listener above (the plugin was disposed
  // while we were starting), and that silent no-op is exactly how a server outlives its owner.
  if (deps.signal.aborted) stop()

  log.info("master:lease-server-started", { hostname: deps.hostname, port })
  return { port, stop }
}
