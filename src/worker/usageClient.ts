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

export function createUsageClient(deps: UsageClientDeps): { fetchSnapshot(): Promise<UsageFetchOutcome> } {
  // A configured base URL routinely carries a trailing slash; CLOUD_ROUTES paths are absolute.
  const base = deps.masterUrl.replace(/\/+$/, "")

  return {
    async fetchSnapshot(): Promise<UsageFetchOutcome> {
      let res: Response
      try {
        res = await deps.fetchImpl(`${base}${CLOUD_ROUTES.usage}`, { signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
      } catch (error) {
        log.warn("worker:usage-unreachable", { detail: errorMessage(error) })
        return { ok: false, failure: { kind: "unreachable", detail: errorMessage(error) } }
      }
      const text = await res.text().catch(() => "")
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
      log.debug("worker:usage-fetched", { accounts: view.accounts.length, stale: view.stale })
      return { ok: true, view }
    },
  }
}
