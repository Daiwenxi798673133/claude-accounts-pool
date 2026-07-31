// Worker → master usage-snapshot transport. TRANSPORT ONLY and READ-ONLY: it fetches the master's
// already-polled usage view (CLOUD_ROUTES.usage) so a cloud-worker can render /usage WITHOUT ever
// calling Anthropic's /api/oauth/usage itself. That indirection is the whole point: N worker tenants
// hitting the master's cached snapshot cannot provoke that endpoint's minutes-long 429, which is
// charged to the master's egress IP.
//
// NOTHING THROWS ACROSS THIS BOUNDARY — the caller is a /usage command handler that must always end
// in either a dialog or a toast, so every fault becomes a value in UsageFetchFailure.
import { CLOUD_ROUTES, type UsageAccountView, type UsageSnapshotView, type UsageWindowView } from "../cloud/protocol.ts"
import { NETWORK_TIMEOUT_MS } from "../constants.ts"
import { log, redactBody } from "../logger.ts"

export type UsageFetchFailure =
  | { kind: "unreachable"; detail: string } // network / timeout — master may be down
  | { kind: "http"; detail: string } // non-2xx answer from the master
  | { kind: "bad-response"; detail: string } // unparseable or schema-invalid body
  // 429 — the master's own refresh throttle said "not yet". NOT a fault: the guard exists because a
  // forced sweep calls Anthropic once per account and its 429 is charged to the master's egress IP,
  // i.e. to every account at once. `retryAfterMs` is what the master told us, absent if it did not.
  | { kind: "throttled"; retryAfterMs?: number }

export type UsageFetchOutcome = { ok: true; view: UsageSnapshotView } | { ok: false; failure: UsageFetchFailure }

export type UsageClientDeps = {
  // Injected, never defaulted to the global: a client built without an explicit transport would
  // silently talk to the real network in tests.
  fetchImpl: typeof fetch
  masterUrl: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseWindow(raw: unknown): UsageWindowView | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const { label, utilization, resetsAt } = raw as Record<string, unknown>
  if (typeof label !== "string") return undefined
  if (typeof utilization !== "number" || !Number.isFinite(utilization)) return undefined
  if (resetsAt !== undefined && typeof resetsAt !== "string") return undefined
  return { label, utilization, ...(resetsAt === undefined ? {} : { resetsAt }) }
}

function parseAccount(raw: unknown): UsageAccountView | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.idPrefix !== "string" || typeof r.label !== "string") return undefined
  if (typeof r.hasUsage !== "boolean" || typeof r.coolingDown !== "boolean") return undefined
  if (typeof r.excluded !== "boolean" || typeof r.needsReauth !== "boolean") return undefined
  if (!Array.isArray(r.windows)) return undefined
  const windows: UsageWindowView[] = []
  for (const rawWindow of r.windows) {
    const win = parseWindow(rawWindow)
    // One malformed window invalidates the whole account rather than being dropped: a partial row
    // rendered as if complete would understate that account's real utilization.
    if (!win) return undefined
    windows.push(win)
  }
  if (r.expiresAt !== undefined && (typeof r.expiresAt !== "number" || !Number.isFinite(r.expiresAt))) return undefined
  return {
    idPrefix: r.idPrefix,
    label: r.label,
    windows,
    hasUsage: r.hasUsage,
    coolingDown: r.coolingDown,
    excluded: r.excluded,
    needsReauth: r.needsReauth,
    ...(r.expiresAt === undefined ? {} : { expiresAt: r.expiresAt as number }),
  }
}

// Parse-don't-validate at the wire boundary: the dialog downstream trusts these fields, so a body
// that does not match UsageSnapshotView is refused HERE and surfaces as a toast, never rendered.
export function parseUsageSnapshotView(raw: unknown): UsageSnapshotView | undefined {
  if (typeof raw !== "object" || raw === null) return undefined
  const r = raw as Record<string, unknown>
  if (typeof r.at !== "number" || !Number.isFinite(r.at)) return undefined
  if (typeof r.stale !== "boolean") return undefined
  if (!Array.isArray(r.accounts)) return undefined
  const accounts: UsageAccountView[] = []
  for (const rawAccount of r.accounts) {
    const account = parseAccount(rawAccount)
    if (!account) return undefined
    accounts.push(account)
  }
  return { at: r.at, stale: r.stale, accounts }
}

// The master answers a throttled refresh with { error, retryAfterMs } (ThrottledBody). The number is
// read leniently — a throttle we cannot put a countdown on is still a throttle, and refusing the body
// would report "unrecognised data" for the one case where the master is behaving exactly as designed.
function parseRetryAfterMs(body: string): number | undefined {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>
    const value = parsed?.["retryAfterMs"]
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value
  } catch {}
  return undefined
}

export function createUsageClient(deps: UsageClientDeps): {
  fetchSnapshot(): Promise<UsageFetchOutcome>
  refreshSnapshot(): Promise<UsageFetchOutcome>
} {
  // A configured base URL routinely carries a trailing slash; CLOUD_ROUTES paths are absolute.
  const base = deps.masterUrl.replace(/\/+$/, "")

  // Both verbs answer with the SAME payload (a forced sweep just precedes it), so the transport, the
  // status handling and the schema check are shared: two copies would let the refresh path drift into
  // accepting a body the read path rejects, and the dialog trusts these fields.
  async function requestSnapshot(path: string, init?: RequestInit): Promise<UsageFetchOutcome> {
    let res: Response
    try {
      res = await deps.fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
    } catch (error) {
      log.warn("worker:usage-unreachable", { detail: errorMessage(error) })
      return { ok: false, failure: { kind: "unreachable", detail: errorMessage(error) } }
    }
    const text = await res.text().catch(() => "")
    // Checked BEFORE the generic non-2xx branch: a 429 here is the master's refresh throttle, which
    // the caller must present as "not yet, N seconds" rather than as a failure of the pool.
    if (res.status === 429) {
      const retryAfterMs = parseRetryAfterMs(text)
      log.debug("worker:usage-refresh-throttled", { retryAfterMs })
      return { ok: false, failure: { kind: "throttled", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) } }
    }
    if (!res.ok) {
      log.warn("worker:usage-http", { status: res.status })
      return { ok: false, failure: { kind: "http", detail: `HTTP ${res.status}: ${redactBody(text, 200)}` } }
    }
    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch {
      return { ok: false, failure: { kind: "bad-response", detail: `unparseable: ${redactBody(text, 200)}` } }
    }
    const view = parseUsageSnapshotView(raw)
    if (!view) {
      log.warn("worker:usage-schema-invalid", { body: redactBody(text, 200) })
      return { ok: false, failure: { kind: "bad-response", detail: `schema-invalid: ${redactBody(text, 200)}` } }
    }
    return { ok: true, view }
  }

  return {
    async fetchSnapshot(): Promise<UsageFetchOutcome> {
      const outcome = await requestSnapshot(CLOUD_ROUTES.usage)
      if (outcome.ok) log.debug("worker:usage-fetched", { accounts: outcome.view.accounts.length, stale: outcome.view.stale })
      return outcome
    },

    // The `r` key. It asks the MASTER to sweep — the worker still never calls Anthropic itself, so N
    // workers pressing `r` cost at most one real sweep per the master's throttle window rather than N.
    // POST because that is what the route requires: a GET on it must not be able to provoke a sweep.
    async refreshSnapshot(): Promise<UsageFetchOutcome> {
      const outcome = await requestSnapshot(CLOUD_ROUTES.usageRefresh, { method: "POST" })
      if (outcome.ok) log.info("worker:usage-refreshed", { accounts: outcome.view.accounts.length, stale: outcome.view.stale })
      return outcome
    },
  }
}
