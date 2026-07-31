export const SERVICE = "claude-accounts-usage"

type LogLevel = "debug" | "info" | "warn" | "error"

type LogClient = {
  app: {
    log: (p: {
      service?: string
      level?: LogLevel
      message?: string
      extra?: Record<string, unknown>
    }) => unknown
  }
}

let client: LogClient | undefined

export function initLogger(c: unknown): void {
  const candidate = c as LogClient | undefined
  if (typeof candidate?.app?.log === "function") {
    client = candidate
  } else {
    client = undefined
  }
}

function forward(level: LogLevel, tag: string, extra?: Record<string, unknown>): void {
  if (!client) return
  try {
    Promise.resolve(
      client.app.log({
        service: SERVICE,
        level,
        message: `${SERVICE} ${tag}`,
        extra,
      }),
    ).catch(() => {})
  } catch {}
}

export const log = {
  debug(tag: string, extra?: Record<string, unknown>): void {
    if (!process.env.CLAUDE_AUTOSWITCH_DEBUG) return
    forward("debug", tag, extra)
  },
  info(tag: string, extra?: Record<string, unknown>): void {
    forward("info", tag, extra)
  },
  warn(tag: string, extra?: Record<string, unknown>): void {
    forward("warn", tag, extra)
  },
  error(tag: string, extra?: Record<string, unknown>): void {
    forward("error", tag, extra)
  },
}

/** Return only header KEYS (lowercased) — never values. */
export function redactHeaders(headers?: Record<string, string>): string[] {
  if (!headers) return []
  return Object.keys(headers).map((k) => k.toLowerCase())
}

/** Anchored whitelist: non-matching headers are DROPPED, not masked, so no credential leaks. */
const RATE_LIMIT_HEADER_RE = /^(?:x-codex-|x-ratelimit-|ratelimit-|anthropic-ratelimit-)|^retry-after$/

/** Quota-telemetry headers WITH values — unlike redactHeaders, whose contract is keys only. */
export function diagnosticHeaders(headers?: Record<string, string>): Record<string, string> {
  if (!headers) return {}
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (RATE_LIMIT_HEADER_RE.test(lower)) out[lower] = value
  }
  return out
}

/** Mask token-like substrings, then truncate. Masking happens BEFORE truncation. */
export function redactBody(body?: string, max = 300): string {
  if (!body) return ""
  let masked = body
    .replace(/sk-[A-Za-z0-9_-]+/g, "***")
    .replace(/Bearer\s+[A-Za-z0-9._-]+/g, "Bearer ***")
    .replace(/eyJ[A-Za-z0-9._-]{10,}/g, "***")
    .replace(
      /("(?:refresh_token|access_token|refresh|access)"\s*:\s*")[^"]*(")/g,
      "$1***$2",
    )
  if (masked.length > max) masked = masked.slice(0, max)
  return masked
}
