import { writeFile, stat, rename, unlink, readFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { randomUUID } from "node:crypto"
import { LOCK_STALE_MS, LOCK_ACQUIRE_TIMEOUT_MS, LOCK_POLL_MS } from "./constants.ts"
import { log } from "./logger.ts"

export class LockTimeoutError extends Error {
  constructor() {
    super("锁等待超时(其他 OpenCode 实例正在操作)")
    this.name = "LockTimeoutError"
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

// Cross-process advisory lock via an O_EXCL create (writeFile flag "wx"): exactly one racer can
// create the file, so mutual exclusion never depends on staleness or rename. Staleness reads the
// lockfile's mtime and assumes a LOCAL data dir (monotonic wall clock; network-FS clock skew is
// out of scope). The returned release is token-verified, so a lock stolen out from under us is
// never removed by our (now-evicted) handle.
export async function acquireFileLock(lockPath: string): Promise<{ release: () => Promise<void> }> {
  const token = randomUUID()
  const payload = JSON.stringify({ pid: process.pid, token, at: Date.now() })
  const deadline = Date.now() + LOCK_ACQUIRE_TIMEOUT_MS
  let contended = false

  for (;;) {
    try {
      await writeFile(lockPath, payload, { flag: "wx", mode: 0o600 })
      log.debug("lock:acquired")
      return { release: () => releaseFileLock(lockPath, token) }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === "EEXIST") {
        // A holder is present. Decide steal (stale) vs wait (live) from the lockfile's mtime.
        const st = await stat(lockPath).catch((statErr: NodeJS.ErrnoException) => {
          if (statErr.code === "ENOENT") return undefined // holder released between create-fail and stat
          throw statErr
        })
        if (!st) continue // gone — retry immediately
        if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
          // STEAL. The atomic rename guarantees exactly one racer wins the move; every loser
          // (incl. ENOENT = another stealer already won) just falls through and retries, never throws.
          const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`
          try {
            await rename(lockPath, stalePath)
            await unlink(stalePath).catch(() => {})
            log.warn("lock:stolen-stale")
          } catch {
            // lost the steal race — someone else moved/removed it first
          }
          continue
        }
        if (Date.now() >= deadline) {
          log.warn("lock:timeout")
          throw new LockTimeoutError()
        }
        if (!contended) {
          log.debug("lock:contended")
          contended = true
        }
        await sleep(LOCK_POLL_MS + Math.random() * 50)
        continue
      }
      if (code === "ENOENT") {
        // Parent dir does not exist yet — create it and retry.
        await mkdir(dirname(lockPath), { recursive: true })
        continue
      }
      throw err
    }
  }
}

// Verify-then-unlink. The TOCTOU window between reading our token and unlinking is ACCEPTED:
// a legitimate holder releases in <=15s, far below the 45s staleness threshold, so nobody can
// legitimately steal a still-live lock — and a token mismatch (we were stolen) skips the unlink
// entirely. Any residual failure self-heals via staleness within 45s.
async function releaseFileLock(lockPath: string, token: string): Promise<void> {
  let ours = false
  try {
    ours = (JSON.parse(await readFile(lockPath, "utf8")) as { token?: string }).token === token
  } catch {
    log.warn("lock:release-lost") // read/parse failed — not provably ours, leave it
    return
  }
  if (!ours) {
    log.warn("lock:release-lost")
    return
  }
  try {
    await unlink(lockPath)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return // already gone
    log.warn("lock:release-failed") // swallow: staleness self-heals within LOCK_STALE_MS
  }
}

export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const { release } = await acquireFileLock(lockPath)
  try {
    return await fn()
  } finally {
    await release()
  }
}
