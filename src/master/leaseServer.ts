// The master's HTTP face: the ONLY door through which a worker machine can obtain an Anthropic
// access token. It owns no policy of its own — scheduling, refreshing and key verification are
// injected — so what is actually implemented here is the WIRE CONTRACT: which route answers
// which status, and in what order the checks run.
//
// Everything below is dependency-injected for one reason: the real refresher POSTs a live,
// one-time-use refresh token at Anthropic. A default-constructed collaborator in a test would
// rotate a real chain on a paid account, so there are no defaults anywhere in LeaseServerDeps.

import type { StoredAccount } from "../accounts.ts"
import type { ErrorBody, LeaseReason, LeaseRequest, LeaseResponse, RateLimitReport, UsageSnapshotView } from "../cloud/protocol.ts"
import { CLOUD_ROUTES } from "../cloud/protocol.ts"
import { LEASE_CHECK_INTERVAL_MS, MASTER_MIN_REMAINING_MS } from "../constants.ts"
import { log, redactHeaders } from "../logger.ts"
import { dashboardHtml } from "./dashboardHtml.ts"
import type { UsageSnapshot } from "./scheduler.ts"
import { buildUsageView } from "./usageView.ts"

export type LeaseServerDeps = {
  scheduler: {
    pickAccount(input: { accounts: StoredAccount[]; exclude?: string }): StoredAccount | undefined
    reportRateLimit(accountId: string, resetsAt?: number): void
    // The two READ-ONLY halves of the dashboard's payload. Required, not optional: a master serving
    // leases without a usage view would answer the dashboard route with an empty page and look like
    // a pool with no accounts.
    getUsageSnapshot(): UsageSnapshot
    isCoolingDown(accountId: string): boolean
  }
  refresher: { getFreshAccess(accountId: string): Promise<{ access: string; expiresAt: number }> }
  registry: { verify(authorizationHeader: string | null | undefined): string | undefined }
  loadAccounts: () => Promise<StoredAccount[]>
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
// Auth happens before the body is touched, so an authenticated handler is handed the workerId the
// KEY resolved to — it never has to (and never can) look for identity in the payload.
type AuthedHandler = (req: Request, workerId: string) => Promise<Response>

function json(status: number, body: ErrorBody | LeaseResponse | UsageSnapshotView | { ok: true }): Response {
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
  const { workerId, reason, currentAccountId } = raw as Record<string, unknown>
  // `workerId` is validated to keep the wire contract honest (a client omitting it is
  // mismatched, and failing loudly at the boundary beats accepting a half-formed request) and is
  // then DELIBERATELY never read again: see handleLease.
  if (typeof workerId !== "string") return undefined
  // Strict, because this field decides whether an account is excluded from the pick. An unknown
  // reason silently defaulting to `prelease` would re-issue the spent account to a worker that
  // just hit its limit — the one outcome the ratelimit path exists to prevent.
  if (!isLeaseReason(reason)) return undefined
  if (currentAccountId !== undefined && typeof currentAccountId !== "string") return undefined
  return { workerId, reason, ...(currentAccountId === undefined ? {} : { currentAccountId }) }
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
  if (typeof workerId !== "string") return undefined
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

export function startLeaseServer(deps: LeaseServerDeps): { port: number; stop: () => void } {
  function badRequest(detail: string): Response {
    return json(400, { error: detail })
  }

  async function authed(req: Request, next: AuthedHandler): Promise<Response> {
    const workerId = deps.registry.verify(req.headers.get("authorization"))
    if (workerId === undefined) {
      // Never log the presented credential — not even a prefix — and never distinguish "absent"
      // from "wrong" in the response: one uniform refusal keeps this network-reachable endpoint
      // from becoming an oracle that confirms a guessed key.
      log.warn("master:lease-denied", { path: new URL(req.url).pathname })
      return json(401, { error: "invalid pool key" })
    }
    return next(req, workerId)
  }

  async function handleLease(req: Request, workerId: string): Promise<Response> {
    // Parsed BEFORE the roster is loaded: a malformed body is the caller's fault and must cost
    // the master nothing. A parse fault is answered 400 and never allowed to escape as a 500,
    // which the worker client would treat as a transient fault and retry verbatim, forever.
    const request = parseLeaseRequest(await readJson(req))
    if (!request) return badRequest("malformed lease request")
    // `ratelimit` names an account that is SPENT, so it is excluded from this pick. `prelease` is
    // the routine renewal path with nothing to avoid — handing back the same account is the
    // expected answer there, and excluding it would rotate the pool for no reason.
    const exclude = request.reason === "ratelimit" ? request.currentAccountId : undefined
    const account = deps.scheduler.pickAccount({ accounts: await deps.loadAccounts(), exclude })
    if (!account) {
      // 503, kept DISTINCT from the 401 above: both refuse, but the worker acts on them
      // differently. A 401 says "this key will never work, stop"; a 503 says "the pool is
      // momentarily spent, come back". Collapsing them either strands a healthy worker or makes
      // a rejected one hammer the master.
      log.warn("master:lease-unavailable", { workerId, reason: request.reason, exclude })
      return json(503, { error: "no account available" })
    }
    const fresh = await deps.refresher.getFreshAccess(account.id)
    // INV-CLOUD-4 — A LEASE MAY NEVER OUTLIVE THE MASTER'S OWN REFRESH POINT. Anthropic REVOKES the previously
    // issued access token the instant a refresh succeeds — MEASURED against the live API, not inferred, and
    // contrary to ordinary OAuth 2.0 semantics: an access token answered 200 on /api/oauth/usage, the account was
    // then refreshed (the refresh tip rotated), the NEW access answered 200, and the SAME OLD access token
    // answered 401. So the master's own rotation — due at `expires - MASTER_MIN_REMAINING_MS` — is what kills
    // every lease already in flight, and serving the raw account expiry was the DEFECT: the master rotated at
    // T-10min while the worker, which renews only at `expires - LEASE_RENEW_BUFFER_MS`, held a REVOKED token
    // until T-5min. Subtracting the floor here (the refresher owns the account's real expiry; the horizon is
    // this server's policy) moves the worker's renewal to T-15min, always a full LEASE_RENEW_BUFFER_MS ahead of
    // the rotation that would revoke it.
    const expiresAt = fresh.expiresAt - MASTER_MIN_REMAINING_MS
    // DEAD ON ARRIVAL — refused, never served. Only reachable if the refresher handed back a token already
    // inside that floor, so this is defence in depth; but the worker writes `expiresAt` into auth.json, where
    // the local provider refreshes on `expires < Date.now()` with ZERO buffer and only INV-CLOUD-1's sentinel to
    // refresh against — a spent horizon therefore dooms it twice: revoked token now, failed self-refresh next.
    // The floor is one worker check interval, because a lease is inspected only that often. Deliberately the
    // SAME 503 as an empty pool: the worker's back-off-and-retry is already the right recovery here.
    if (expiresAt - Date.now() < LEASE_CHECK_INTERVAL_MS) {
      log.warn("master:lease-horizon-spent", { workerId, accountId: account.id, expiresAt })
      return json(503, { error: "no account available" })
    }
    // IDENTITY COMES FROM THE KEY. `request.workerId` is a client-supplied string that anyone
    // holding any valid key could forge, so the authenticated `workerId` is what gets logged and
    // the body's copy is never consulted for anything.
    // PRIVACY: `fresh.access` is a live credential and must NEVER reach the log file; the account
    // id and the expiry carry the entire diagnostic value anyway.
    log.info("master:lease-served", { workerId, accountId: account.id, expiresAt })
    return json(200, { accountId: account.id, access: fresh.access, expiresAt })
  }

  async function handleRateLimit(req: Request, workerId: string): Promise<Response> {
    const report = parseRateLimitReport(await readJson(req))
    if (!report) return badRequest("malformed ratelimit report")
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

  // READ-ONLY, and deliberately behind the SAME pool key as the two POSTs. The payload names every
  // account in the pool and how much of each subscription is left — precisely the reconnaissance a
  // stolen key wants — so it may not be public. It carries no token of any kind (enforced by the
  // view's type, see usageView.ts), so what the key gates here is the ROSTER, not a credential.
  // Serving it costs the upstream API nothing: this reads the usage poller's existing snapshot and
  // never issues a request of its own, so refreshing the page cannot provoke `/api/oauth/usage`.
  async function handleUsage(_req: Request, workerId: string): Promise<Response> {
    const view = buildUsageView({
      accounts: await deps.loadAccounts(),
      snapshot: deps.scheduler.getUsageSnapshot(),
      // Wrapped rather than passed by reference: the scheduler is an injected object here, and a
      // detached method would break on any implementation that is not closure-based.
      isCoolingDown: (accountId) => deps.scheduler.isCoolingDown(accountId),
    })
    log.debug("master:usage-served", { workerId, accounts: view.accounts.length, stale: view.stale })
    return json(200, view)
  }

  // The STRING is built once (the shell is a constant), but each request gets a FRESH Response: a
  // Response body is a single-use stream, so sharing one object would serve the first browser and
  // then fail every reload after it.
  const dashboardShell = dashboardHtml(CLOUD_ROUTES.usage)

  const routes: Record<Route, RouteHandler> = {
    // UNAUTHENTICATED BY DESIGN, and the only route that is. A worker probes this BEFORE it
    // trusts a master URL — possibly before it has been issued a pool key at all — and an ops
    // liveness check calls it forever. The price of that is that it may leak NOTHING: no account
    // ids, no worker roster, no pool counts. A fixed `{ ok: true }` is the whole payload.
    [CLOUD_ROUTES.health]: async () => json(200, { ok: true }),
    // Auth is declared per-route in this table rather than hidden in a middleware condition, so
    // "which routes require a key" is readable in one place and a new route cannot inherit
    // "public" by forgetting to opt in.
    [CLOUD_ROUTES.lease]: (req) => authed(req, handleLease),
    [CLOUD_ROUTES.ratelimit]: (req) => authed(req, handleRateLimit),
    [CLOUD_ROUTES.usage]: (req) => authed(req, handleUsage),
    // The SECOND unauthenticated route, and the reason it is allowed to be one is the same as
    // health's: it discloses nothing. The document is inert — no account, no number, no key — and
    // the data it goes on to fetch is gated above. See the header on dashboardHtml.ts.
    [CLOUD_ROUTES.dashboard]: async () => html(dashboardShell),
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
