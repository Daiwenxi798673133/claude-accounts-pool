import { NETWORK_TIMEOUT_MS, OPENAI_CLIENT_ID, OPENAI_TOKEN_URL } from "./constants.ts"
import { log } from "./logger.ts"

// ChatGPT sibling of usage.ts's RefreshRevokedError: thrown ONLY when the server says the
// stored refresh token can NEVER succeed again, so callers flag the account for re-login
// instead of hammering a dead chain. `refresh` rides along so a caller can check the dead
// token is still the one on record (another process may have rotated it meanwhile).
export class OpenaiRefreshRevokedError extends Error {
  readonly revoked = true as const
  constructor(
    readonly refresh: string,
    readonly code: string,
  ) {
    super(`openai refresh token revoked (${code})`)
    this.name = "OpenaiRefreshRevokedError"
  }
}

// Transient (still-retryable) refresh failure. `status` rides along so a caller can apply a
// per-status backoff — the openai twin of usage.ts's REFRESH_429_COOLDOWN_MS — without pattern
// matching on a human-readable message. Message text is unchanged from the plain Error it
// replaces, because the only thing that must never happen here is being mistaken for
// OpenaiRefreshRevokedError: that would brand a healthy account as needing re-login.
export class OpenaiRefreshFailedError extends Error {
  constructor(readonly status: number) {
    super(`openai token refresh failed (${status})`)
    this.name = "OpenaiRefreshFailedError"
  }
}

// OpenAI rotates the refresh token on every use, so these are the only terminal verdicts —
// everything else (429/5xx/network) is transient and MUST stay retryable, or a passing
// outage would permanently brand healthy accounts as needing re-login.
// `refresh_token_reused` revokes the whole token family: never retry it.
const REVOKED_CODES = new Set(["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"])

const DEFAULT_EXPIRES_IN_S = 3600

type ErrorBody = { error?: { code?: unknown } | string | null; code?: unknown }

type TokenResponse = { id_token?: unknown; access_token?: unknown; refresh_token?: unknown; expires_in?: unknown }

type IdTokenClaims = {
  "https://api.openai.com/auth"?: { chatgpt_account_id?: unknown } | null
  chatgpt_account_id?: unknown
  organizations?: unknown
}

function parseObject(text: string): Record<string, unknown> | undefined {
  try {
    const json: unknown = JSON.parse(text)
    return typeof json === "object" && json !== null && !Array.isArray(json) ? (json as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

// The machine-readable code arrives at `error.code` on some paths and at a top-level `code`
// on others, so both are collected rather than guessing which shape this response used.
// Bodies are frequently empty or an HTML error page — this must never throw.
function errorCodes(body: string): string[] {
  const parsed = parseObject(body) as ErrorBody | undefined
  if (!parsed) return []
  const codes: string[] = []
  const error = parsed.error
  if (typeof error === "string") codes.push(error)
  else if (typeof error === "object" && error !== null && typeof error.code === "string") codes.push(error.code)
  if (typeof parsed.code === "string") codes.push(parsed.code)
  return codes
}

function permanentFailureCode(status: number, body: string): string | undefined {
  const codes = errorCodes(body)
  const revoked = codes.find((code) => REVOKED_CODES.has(code))
  if (revoked) return revoked
  if ((status === 400 || status === 401) && codes.includes("invalid_grant")) return "invalid_grant"
  return undefined
}

export function isPermanentRefreshFailure(status: number, body: string): boolean {
  return permanentFailureCode(status, body) !== undefined
}

// Reads claims out of OUR OWN id_token: middle segment only, base64url, NO signature
// verification (we are not authenticating anybody, and no key is available here). Any
// malformation yields undefined — a missing accountId merely degrades the caller, whereas
// throwing would fail an otherwise successful refresh.
function decodeIdTokenClaims(idToken: unknown): IdTokenClaims | undefined {
  if (typeof idToken !== "string") return undefined
  const payload = idToken.split(".")[1]
  if (!payload) return undefined
  try {
    return parseObject(Buffer.from(payload, "base64url").toString("utf8")) as IdTokenClaims | undefined
  } catch {
    return undefined
  }
}

function chatgptAccountId(claims: IdTokenClaims | undefined): string | undefined {
  if (!claims) return undefined
  const auth = claims["https://api.openai.com/auth"]
  const namespaced = typeof auth === "object" && auth !== null ? auth.chatgpt_account_id : undefined
  const orgs = claims.organizations
  const firstOrg = Array.isArray(orgs) ? (orgs[0] as { id?: unknown } | undefined) : undefined
  for (const candidate of [namespaced, claims.chatgpt_account_id, firstOrg?.id]) {
    if (typeof candidate === "string" && candidate.length > 0) return candidate
  }
  return undefined
}

export async function refreshOpenaiToken(
  refresh: string,
): Promise<{ access: string; refresh: string; expires: number; accountId?: string }> {
  // PRIVACY: never log the request body — it carries the refresh token verbatim.
  log.debug("openai-token:refresh-start")
  const res = await fetch(OPENAI_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: OPENAI_CLIENT_ID }),
    signal: AbortSignal.timeout(NETWORK_TIMEOUT_MS),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    const code = permanentFailureCode(res.status, body)
    if (code) {
      log.warn("openai-token:revoked", { status: res.status, code })
      throw new OpenaiRefreshRevokedError(refresh, code)
    }
    log.warn("openai-token:refresh-failed", { status: res.status })
    throw new OpenaiRefreshFailedError(res.status)
  }

  const json = (await res.json().catch(() => undefined)) as TokenResponse | undefined
  // A 200 without both tokens leaves the rotated chain tip unknown. Refuse it: storing a
  // blank (or the pre-rotation) refresh would strand the account permanently.
  if (typeof json?.access_token !== "string" || typeof json.refresh_token !== "string") {
    log.warn("openai-token:refresh-malformed", { status: res.status })
    throw new Error(`openai token refresh returned no token (${res.status})`)
  }

  const expiresIn = typeof json.expires_in === "number" && Number.isFinite(json.expires_in) ? json.expires_in : DEFAULT_EXPIRES_IN_S
  const accountId = chatgptAccountId(decodeIdTokenClaims(json.id_token))
  log.info("openai-token:refresh-ok", { status: res.status, expiresIn, hasAccountId: Boolean(accountId) })
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + expiresIn * 1000,
    accountId,
  }
}
