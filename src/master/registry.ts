// Worker registry for the cloud-master: mints one pool key per worker machine and verifies
// the `Authorization: Bearer <poolKey>` header on incoming lease requests. Dependency-injected
// (no module-level mutable state) so the master's real `api.kv` and this file's tests can share
// the exact same code path.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { log } from "../logger.ts"

const POOL_KEYS_KV_KEY = "claude-accounts-usage.master.poolkeys"

export type RegistryDeps = {
  kv: {
    get: <V>(key: string, fallback?: V) => V
    set: (key: string, value: unknown) => void
  }
}

export type RegisteredWorker = {
  workerId: string
  poolKey: string
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex")
}

// Constant-time digest compare: the lease endpoint this key gates is reachable over the
// network, so comparing SHA-256 hex digests with a naive `===` would let a request-timing
// side channel confirm each byte of a guessed key one at a time. Length is checked FIRST
// because timingSafeEqual throws (rather than returning false) on a length mismatch, and
// leaking the length here is safe: every digest is a fixed 64-hex-char SHA-256 output, so
// length carries no information about which key is being tested.
function digestsMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8")
  const bufB = Buffer.from(b, "utf8")
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

// INV-CLOUD-3: the next id comes from the HIGHEST number ever issued, never from the entry
// count. Per-worker keys exist so a single worker can be revoked, and revoking one leaves a gap
// (`{worker-1, worker-3}`); a count-derived id would then re-mint `worker-3` and overwrite a
// live worker's digest, silently killing that worker's key with no error raised anywhere.
// Ids that do not match the minted shape are ignored rather than trusted as counters.
function nextWorkerNumber(digests: Record<string, string>): number {
  let highest = 0
  for (const workerId of Object.keys(digests)) {
    const parsed = Number(/^worker-(\d+)$/.exec(workerId)?.[1])
    if (Number.isInteger(parsed) && parsed > highest) highest = parsed
  }
  return highest + 1
}

export function createRegistry(deps: RegistryDeps): {
  register(): RegisteredWorker
  verify(authorizationHeader: string | null | undefined): string | undefined
  list(): string[]
} {
  function loadDigests(): Record<string, string> {
    return deps.kv.get<Record<string, string>>(POOL_KEYS_KV_KEY, {})
  }

  function register(): RegisteredWorker {
    const digests = loadDigests()
    const workerId = `worker-${nextWorkerNumber(digests)}`
    // 32 cryptographically random bytes, base64url-encoded (URL/header-safe, no padding to
    // strip). Returned in plaintext exactly HERE, exactly once — the registry persists only
    // the digest below, so this value is never recoverable again, not even by us: a dump of
    // the kv store leaks zero usable pool keys.
    const poolKey = randomBytes(32).toString("base64url")
    digests[workerId] = sha256Hex(poolKey)
    deps.kv.set(POOL_KEYS_KV_KEY, digests)
    log.info("master.registry.register", { workerId })
    return { workerId, poolKey }
  }

  function verify(authorizationHeader: string | null | undefined): string | undefined {
    if (!authorizationHeader) return undefined
    // Scheme is case-insensitive per RFC 7235; the key itself is not.
    const match = /^bearer\s+(\S+)$/i.exec(authorizationHeader.trim())
    if (!match) return undefined
    const presentedDigest = sha256Hex(match[1])
    const digests = loadDigests()
    for (const [workerId, storedDigest] of Object.entries(digests)) {
      if (digestsMatch(presentedDigest, storedDigest)) return workerId
    }
    return undefined
  }

  function list(): string[] {
    return Object.keys(loadDigests())
  }

  return { register, verify, list }
}
