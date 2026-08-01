// Worker registry for the cloud-master: mints one pool key per worker machine and verifies
// the `Authorization: Bearer <poolKey>` header on incoming lease requests. Dependency-injected
// (no module-level mutable state) so the master's real `api.kv` and this file's tests can share
// the exact same code path.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto"
import { POOLKEY_SLIDE_MIN_INTERVAL_MS, POOLKEY_TTL_MS } from "../constants.ts"
import { log } from "../logger.ts"

const POOL_KEYS_KV_KEY = "claude-accounts-usage.master.poolkeys"

// Label given to entries materialised out of the pre-record kv shape. Those keys were minted
// before anyone recorded WHICH machine got them, so there is nothing truer to write here.
const LEGACY_LABEL = "legacy"

export type PoolKeyRecord = {
  digest: string
  label: string
  issuedAt: number
  expiresAt: number
}

// What a kv READ can contain. A bare string is a LEGACY entry: before keys carried records the
// map was `workerId -> digest`, and the deployed master's kv still holds one such entry belonging
// to a worker that is leasing right now. This union is the back-compat contract, not a
// hypothetical — everything read out of the store passes through materialise() below.
type StoredEntry = string | PoolKeyRecord

export type RegistryDeps = {
  kv: {
    get: <V>(key: string, fallback?: V) => V
    set: (key: string, value: unknown) => void
  }
  // Injectable clock so tests can drive expiry and sliding without sleeping.
  now?: () => number
}

export type RegisteredWorker = {
  workerId: string
  key: string
  expiresAt: number
}

export type PoolKeySummary = {
  workerId: string
  label: string
  issuedAt: number
  expiresAt: number
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
//
// EXPIRY NARROWS WHAT THIS PROMISES, and the narrower thing is what must be written down.
// WITHIN one register() the numbering still reads the map as it looked BEFORE that call's own
// prune, so a prune can never lower the next id onto an id still sitting in the map. ACROSS calls
// it is different: once verify() has pruned the highest-numbered record, the next register() sees
// a lower ceiling and hands that number out again. That is deliberate and safe, but it means the
// id is NOT a durable name, and conflating the two is how someone builds on the wrong guarantee:
//   - SAFE, because a pruned record is one verify() had already refused; its digest is gone from
//     the map, so re-minting its number overwrites nothing that could still authenticate. The harm
//     this invariant exists to prevent — silently killing a LIVE worker's key — stays impossible.
//   - NOT A DURABLE NAME, so never read `worker-N` as a stable audit identity across time. The
//     record's `label` is what says WHICH machine; the number only says which slot it holds now.
function nextWorkerNumber(records: Record<string, PoolKeyRecord>): number {
  let highest = 0
  for (const workerId of Object.keys(records)) {
    const parsed = Number(/^worker-(\d+)$/.exec(workerId)?.[1])
    if (Number.isInteger(parsed) && parsed > highest) highest = parsed
  }
  return highest + 1
}

export function createRegistry(deps: RegistryDeps): {
  register(label: string): RegisteredWorker
  verify(authorizationHeader: string | null | undefined): string | undefined
  list(): PoolKeySummary[]
} {
  const clock = deps.now ?? Date.now
  let migrated = false

  // The single seam where the legacy shape becomes the current one. A bare digest is adopted
  // VERBATIM and given a full window starting NOW rather than backdated: nothing on disk says when
  // it was issued, and backdating a guess would expire a live worker's key the instant this ships.
  function loadRecords(): Record<string, PoolKeyRecord> {
    const now = clock()
    const stored = deps.kv.get<Record<string, StoredEntry>>(POOL_KEYS_KV_KEY, {})
    const records: Record<string, PoolKeyRecord> = {}
    for (const [workerId, entry] of Object.entries(stored)) {
      records[workerId] =
        typeof entry === "string"
          ? { digest: entry, label: LEGACY_LABEL, issuedAt: now, expiresAt: now + POOLKEY_TTL_MS }
          : entry
    }
    return records
  }

  function pruneExpired(records: Record<string, PoolKeyRecord>, now: number): Record<string, PoolKeyRecord> {
    const kept: Record<string, PoolKeyRecord> = {}
    for (const [workerId, record] of Object.entries(records)) {
      if (now < record.expiresAt) kept[workerId] = record
    }
    return kept
  }

  // Rewrites the WHOLE map once per instance, the first time any entry point is called.
  //
  // Not at construction time: createRegistry also runs in processes that never act as master, and
  // an eager write would pollute their kv for nothing. Not per-entry-on-verify either: an entry
  // that is never verified again would never receive an expiresAt, and so would never expire —
  // exactly the immortal credential this whole change exists to remove.
  //
  // No locking is needed. The kv interface is SYNCHRONOUS, so the read-materialise-write below
  // cannot be interleaved by the event loop: it is atomic with respect to every other caller.
  function ensureMigrated(): void {
    if (migrated) return
    const stored = deps.kv.get<Record<string, StoredEntry>>(POOL_KEYS_KV_KEY, {})
    if (Object.values(stored).some((entry) => typeof entry === "string")) {
      deps.kv.set(POOL_KEYS_KV_KEY, loadRecords())
    }
    migrated = true
  }

  function register(label: string): RegisteredWorker {
    ensureMigrated()
    const now = clock()
    const records = loadRecords()
    // Numbered off the PRE-prune snapshot — see INV-CLOUD-3 above.
    const workerId = `worker-${nextWorkerNumber(records)}`
    const kept = pruneExpired(records, now)
    // 32 cryptographically random bytes, base64url-encoded (URL/header-safe, no padding to
    // strip). Returned in plaintext exactly HERE, exactly once — the registry persists only
    // the digest below, so this value is never recoverable again, not even by us: a dump of
    // the kv store leaks zero usable pool keys.
    const key = randomBytes(32).toString("base64url")
    const expiresAt = now + POOLKEY_TTL_MS
    kept[workerId] = { digest: sha256Hex(key), label, issuedAt: now, expiresAt }
    deps.kv.set(POOL_KEYS_KV_KEY, kept)
    log.info("master.registry.register", { workerId, label })
    return { workerId, key, expiresAt }
  }

  function verify(authorizationHeader: string | null | undefined): string | undefined {
    ensureMigrated()
    if (!authorizationHeader) return undefined
    // Scheme is case-insensitive per RFC 7235; the key itself is not.
    const match = /^bearer\s+(\S+)$/i.exec(authorizationHeader.trim())
    if (!match) return undefined
    const presentedDigest = sha256Hex(match[1])
    const now = clock()
    const records = loadRecords()
    for (const [workerId, record] of Object.entries(records)) {
      if (!digestsMatch(presentedDigest, record.digest)) continue
      if (now >= record.expiresAt) {
        // Refuse FIRST, then drop the entry. The kv has no delete, so removal is a set() of the
        // filtered map; pruning by expiry also sweeps any sibling that timed out unnoticed.
        deps.kv.set(POOL_KEYS_KV_KEY, pruneExpired(records, now))
        log.info("master.registry.expired", { workerId })
        return undefined
      }
      // Slide the window, but persist at most once per POOLKEY_SLIDE_MIN_INTERVAL_MS, so that
      // checking a credential never implies a disk write (the floor's full rationale, including
      // why it is defensive rather than a response to a measured write rate, is on the constant).
      // The last-slide instant is DERIVED (`expiresAt - TTL`) rather than stored, so
      // the record stays the four fields the http route is built against. When the write is
      // skipped the slid value is simply discarded — every call re-reads the kv, so there is no
      // in-memory copy that could drift away from what is on disk.
      const lastSlideAt = record.expiresAt - POOLKEY_TTL_MS
      if (now - lastSlideAt >= POOLKEY_SLIDE_MIN_INTERVAL_MS) {
        records[workerId] = { ...record, expiresAt: now + POOLKEY_TTL_MS }
        deps.kv.set(POOL_KEYS_KV_KEY, records)
      }
      return workerId
    }
    return undefined
  }

  // Read-only on purpose: the master logs `list().length` on every install, and pruning here
  // would make a plain status read write to the kv on every start.
  function list(): PoolKeySummary[] {
    ensureMigrated()
    const now = clock()
    const summaries: PoolKeySummary[] = []
    for (const [workerId, record] of Object.entries(loadRecords())) {
      if (now >= record.expiresAt) continue
      summaries.push({ workerId, label: record.label, issuedAt: record.issuedAt, expiresAt: record.expiresAt })
    }
    return summaries
  }

  return { register, verify, list }
}
