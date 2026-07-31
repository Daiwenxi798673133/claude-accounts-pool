import { readAuthOpenai, type OpenaiOauth } from "./accounts.ts"
import { NETWORK_TIMEOUT_MS, OPENAI_USAGE_ENDPOINT } from "./constants.ts"
import { log } from "./logger.ts"

export type OpenaiWindow = { label: string; utilization: number; resets_at?: string }

export type OpenaiUsage = {
  email?: string
  planType?: string
  windows: OpenaiWindow[]
  error?: string
  needsReauth?: boolean
  // WHICH ACCOUNT THIS RESULT DESCRIBES: the accountId sent as the ChatGPT-Account-Id header, so
  // consumers can attribute `email` / `planType` to a specific record instead of guessing from
  // whichever pointer happens to be current. Absent exactly when no header was sent — the entry
  // carried no accountId, so the response cannot be attributed to anyone and must not be.
  accountId?: string
}

type RawWindow = { used_percent?: unknown; limit_window_seconds?: unknown; reset_at?: unknown }

type UsagePayload = {
  email?: unknown
  plan_type?: unknown
  rate_limit?: { primary_window?: RawWindow | null; secondary_window?: RawWindow | null } | null
}

// Unlike Anthropic's fixed 5h/7d pair, ChatGPT window lengths are per-plan and arrive as
// `limit_window_seconds` (a "go" plan reports a single 30d window), so the label has to be
// derived rather than hardcoded.
function windowLabel(seconds: unknown): string {
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds <= 0) return "额度"
  const hours = seconds / 3600
  if (hours < 1) return `${Math.round(seconds / 60)}m`
  if (hours < 24) return `${Math.round(hours)}h`
  return `${Math.round(hours / 24)}d`
}

function toWindow(raw: RawWindow | null | undefined): OpenaiWindow | undefined {
  if (!raw || typeof raw.used_percent !== "number" || !Number.isFinite(raw.used_percent)) return undefined
  const resetAt = raw.reset_at
  return {
    label: windowLabel(raw.limit_window_seconds),
    utilization: raw.used_percent,
    resets_at:
      typeof resetAt === "number" && Number.isFinite(resetAt) && resetAt > 0
        ? new Date(resetAt * 1000).toISOString()
        : undefined,
  }
}

export function normalizeOpenaiUsage(payload: unknown): OpenaiUsage {
  const data = (typeof payload === "object" && payload !== null ? payload : {}) as UsagePayload
  const limit = data.rate_limit ?? undefined
  const windows: OpenaiWindow[] = []
  for (const raw of [limit?.primary_window, limit?.secondary_window]) {
    const win = toWindow(raw)
    if (win) windows.push(win)
  }
  return {
    email: typeof data.email === "string" ? data.email : undefined,
    planType: typeof data.plan_type === "string" ? data.plan_type : undefined,
    windows,
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

// Resolves to undefined when no ChatGPT account is logged in, so the panel can omit the
// section entirely instead of rendering an empty one. `readAuth` is injected rather than
// mocked: bun's process-global mock.module for accounts.ts leaks across test files (see
// usage.test.ts header), and a partial stub would break this module's import binding.
export async function fetchOpenaiUsage(
  readAuth: () => Promise<OpenaiOauth | undefined> = readAuthOpenai,
): Promise<OpenaiUsage | undefined> {
  const auth = await readAuth()
  if (!auth?.access) return undefined

  const headers: Record<string, string> = {
    Authorization: `Bearer ${auth.access}`,
    Accept: "application/json",
  }
  if (auth.accountId) headers["ChatGPT-Account-Id"] = auth.accountId
  // Read off the HEADER decision above, never off auth.accountId directly, so the reported id can
  // only ever be one we actually authenticated as.
  const accountId = headers["ChatGPT-Account-Id"]

  try {
    const res = await fetch(OPENAI_USAGE_ENDPOINT, { headers, signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS) })
    // SCORING HAZARD, recorded here for whoever wires ChatGPT into candidate selection: the two
    // degraded returns below carry `windows: []`, and an EMPTY array is NOT a missing snapshot.
    // scoreWindows (providers.ts) scores `[]` as 0 — i.e. "least used, best candidate" — whereas a
    // genuinely unknown usage is encoded as an ABSENT snapshot and scores +Infinity. So an `error`
    // / `needsReauth` result MUST be mapped to a MISSING snapshot before it reaches any scoring or
    // selection path, or an account we could not even reach would win every selection. Nothing
    // scores these today (autoswitch's pool is anthropic-only, and the keepalive pass does not
    // fetch usage at all), which is exactly why the trap is documented rather than "fixed" at a
    // call site that does not yet exist.
    if (res.status === 401 || res.status === 403) {
      log.info("openai-usage:needs-reauth", { status: res.status })
      return { windows: [], needsReauth: true, accountId }
    }
    if (!res.ok) {
      log.warn("openai-usage:fetch-failed", { status: res.status })
      return { windows: [], error: `用量请求失败 (${res.status})`, accountId }
    }
    const usage = { ...normalizeOpenaiUsage(await res.json()), accountId }
    log.info("openai-usage:fetch-ok", { windows: usage.windows.length, planType: usage.planType })
    return usage
  } catch (error) {
    log.warn("openai-usage:fetch-error", { error: errorMessage(error) })
    return { windows: [], error: errorMessage(error), accountId }
  }
}
