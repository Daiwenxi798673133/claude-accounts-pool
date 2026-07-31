import { expect, test, mock } from "bun:test"
import { mkdtempSync, writeFileSync, readFileSync, existsSync, utimesSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Mock constants BEFORE importing lockfile.ts (house pattern: usage.test.ts:120-121 does
// top-level mock.module + dynamic import so the mock is registered before the graph loads).
// Spread the real module rather than re-listing it: a hand-written enumeration silently
// omits every constant added later, and the omission surfaces as a link error in whichever
// unrelated test file imports the new export next.
const realConstants = await import("./constants.ts")
mock.module("./constants.ts", () => ({
  ...realConstants,
  // Fast overrides so the timing-sensitive tests run in ~sub-second wall time.
  LOCK_STALE_MS: 60_000,
  LOCK_ACQUIRE_TIMEOUT_MS: 300,
  LOCK_POLL_MS: 20,
}))

const { acquireFileLock, withFileLock, LockTimeoutError } = await import("./lockfile.ts")

const tmp = () => mkdtempSync(join(tmpdir(), "cau-lock-"))
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const ageBy = (path: string, ms: number) => {
  const t = new Date(Date.now() - ms)
  utimesSync(path, t, t)
}
// Poll a condition to a deadline (never a bare fixed sleep as the correctness mechanism).
async function pollUntil(cond: () => boolean, deadlineMs: number, intervalMs = 10): Promise<boolean> {
  const dl = Date.now() + deadlineMs
  while (Date.now() < dl) {
    if (cond()) return true
    await sleep(intervalMs)
  }
  return cond()
}

// 1. roundtrip: acquire creates a parseable lock file (pid === ours), release removes it.
test("acquire creates the lock file then release removes it", async () => {
  const lockPath = join(tmp(), "auth.lock")
  const handle = await acquireFileLock(lockPath)
  expect(existsSync(lockPath)).toBe(true)
  const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string; at: number }
  expect(parsed.pid).toBe(process.pid)
  expect(typeof parsed.token).toBe("string")
  expect(parsed.token.length).toBeGreaterThan(0)
  await handle.release()
  expect(existsSync(lockPath)).toBe(false)
})

// 2. withFileLock: lock EXISTS while fn runs, GONE after; a rejecting fn propagates AND releases.
test("withFileLock holds during fn, releases after, and releases on rejection", async () => {
  const lockPath = join(tmp(), "auth.lock")
  let heldDuringFn = false
  const result = await withFileLock(lockPath, async () => {
    heldDuringFn = existsSync(lockPath)
    return 42
  })
  expect(heldDuringFn).toBe(true)
  expect(result).toBe(42)
  expect(existsSync(lockPath)).toBe(false)

  const boom = new Error("boom")
  await expect(
    withFileLock(lockPath, async () => {
      throw boom
    }),
  ).rejects.toBe(boom)
  expect(existsSync(lockPath)).toBe(false)
})

// 3. contention timeout: a live lock is NOT stolen; the waiter throws LockTimeoutError inside
//    the bounded window. Also covers the staleness BOUNDARY: a lock aged just UNDER
//    LOCK_STALE_MS is still "live" and must NOT be stolen (it times out too).
test("acquire times out with LockTimeoutError against a live lock", async () => {
  const lockPath = join(tmp(), "auth.lock")
  const a = await acquireFileLock(lockPath) // fresh mtime => live
  const start = Date.now()
  let err: unknown
  try {
    await acquireFileLock(lockPath)
  } catch (e) {
    err = e
  }
  const elapsed = Date.now() - start
  expect(err).toBeInstanceOf(LockTimeoutError)
  expect((err as Error).name).toBe("LockTimeoutError")
  expect((err as Error).message).toBe("锁等待超时(其他 OpenCode 实例正在操作)")
  expect(elapsed).toBeGreaterThanOrEqual(300)
  expect(elapsed).toBeLessThanOrEqual(1000)
  await a.release()

  // Boundary: aged to 55s < 60s LOCK_STALE_MS => still live => timeout, not steal.
  const nearPath = join(tmp(), "auth.lock")
  writeFileSync(nearPath, JSON.stringify({ pid: 999999, token: "near", at: Date.now() }), { mode: 0o600 })
  ageBy(nearPath, 55_000)
  let nearErr: unknown
  try {
    await acquireFileLock(nearPath)
  } catch (e) {
    nearErr = e
  }
  expect(nearErr).toBeInstanceOf(LockTimeoutError)
  // Not stolen: the planted token is untouched.
  expect((JSON.parse(readFileSync(nearPath, "utf8")) as { token: string }).token).toBe("near")
})

// 4. queueing: A holds then releases after 150ms; B blocks then acquires; B's wait >= 100ms.
test("a waiter acquires once the holder releases", async () => {
  const lockPath = join(tmp(), "auth.lock")
  const a = await acquireFileLock(lockPath)
  setTimeout(() => {
    void a.release()
  }, 150) // fixed HOLD duration (not a correctness wait), then release
  const start = Date.now()
  const b = await acquireFileLock(lockPath)
  const elapsed = Date.now() - start
  expect(elapsed).toBeGreaterThanOrEqual(100)
  expect(existsSync(lockPath)).toBe(true) // B now holds it
  await b.release()
  expect(existsSync(lockPath)).toBe(false)
})

// 5. stale steal: a lock aged past LOCK_STALE_MS is stolen quickly; the new payload token differs.
test("acquire steals a stale lock", async () => {
  const lockPath = join(tmp(), "auth.lock")
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "planted", at: Date.now() - 120_000 }), { mode: 0o600 })
  ageBy(lockPath, 120_000) // mtime 120s in the past => stale (> 60s)
  const start = Date.now()
  const handle = await acquireFileLock(lockPath)
  const elapsed = Date.now() - start
  expect(elapsed).toBeLessThan(300) // well under the 300ms acquire timeout
  const parsed = JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number; token: string }
  expect(parsed.token).not.toBe("planted")
  expect(parsed.pid).toBe(process.pid)
  await handle.release()
})

// 6. steal-race safety: two concurrent acquirers of a stale lock must run SEQUENTIALLY; a
//    critical-section counter never exceeds 1 and neither acquirer throws.
test("two concurrent acquirers of a stale lock never overlap", async () => {
  const lockPath = join(tmp(), "auth.lock")
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "planted", at: Date.now() - 120_000 }), { mode: 0o600 })
  ageBy(lockPath, 120_000)

  let active = 0
  let maxActive = 0
  const critical = async () => {
    const handle = await acquireFileLock(lockPath)
    active += 1
    maxActive = Math.max(maxActive, active)
    expect(active).toBe(1)
    await sleep(30) // hold the section
    active -= 1
    await handle.release()
  }
  await Promise.all([critical(), critical()])
  expect(maxActive).toBe(1)
  expect(existsSync(lockPath)).toBe(false)
})

// 7. release-after-steal: A is stolen by B; A.release() must NOT remove B's lock (token
//    mismatch protection); only B.release() removes it.
test("a stolen holder's release does not remove the new holder's lock", async () => {
  const lockPath = join(tmp(), "auth.lock")
  const a = await acquireFileLock(lockPath)
  ageBy(lockPath, 120_000) // age A's own lock so B can steal it
  const b = await acquireFileLock(lockPath)
  const bToken = (JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }).token
  await a.release() // token mismatch => no unlink
  expect(existsSync(lockPath)).toBe(true)
  expect((JSON.parse(readFileSync(lockPath, "utf8")) as { token: string }).token).toBe(bToken)
  await b.release() // token matches => removed
  expect(existsSync(lockPath)).toBe(false)
})

// 8. ENOENT dir: a lockPath under a not-yet-existing nested dir => acquire mkdirs and succeeds.
test("acquire creates missing parent directories", async () => {
  const lockPath = join(tmp(), "nested", "deep", "auth.lock")
  const handle = await acquireFileLock(lockPath)
  expect(existsSync(lockPath)).toBe(true)
  await handle.release()
  expect(existsSync(lockPath)).toBe(false)
})

// 9. malformed lock: a FRESH non-JSON lock is never stolen (waiter times out, no crash);
//    releasing a real handle whose file has become garbage does not throw; once the garbage
//    is aged past staleness, acquire steals it cleanly.
test("malformed lock: fresh times out, foreign release is safe, aged steal works", async () => {
  const lockPath = join(tmp(), "auth.lock")
  writeFileSync(lockPath, "this is not json {{{", { mode: 0o600 }) // fresh mtime

  const start = Date.now()
  let err: unknown
  try {
    await acquireFileLock(lockPath)
  } catch (e) {
    err = e
  }
  expect(err).toBeInstanceOf(LockTimeoutError)
  expect(Date.now() - start).toBeGreaterThanOrEqual(300)

  // A real handle whose file has become garbage: release must parse-fail gracefully (no throw,
  // no unlink of a file we can no longer prove is ours).
  const lp2 = join(tmp(), "auth.lock")
  const handle = await acquireFileLock(lp2)
  writeFileSync(lp2, "corrupted {{{", { mode: 0o600 })
  await handle.release() // must not throw
  expect(existsSync(lp2)).toBe(true) // left intact (not provably ours)

  // Age the garbage past staleness => now stealable.
  ageBy(lockPath, 120_000)
  const stolen = await acquireFileLock(lockPath)
  expect((JSON.parse(readFileSync(lockPath, "utf8")) as { pid: number }).pid).toBe(process.pid)
  await stolen.release()
})

// 10. REAL cross-process: a child (real 30s constants) acquires the SAME lockPath, marks
//     `held`, holds, releases, marks `released`, exits 0. The parent polls for `held`, then
//     times its own acquire — which must resolve only at/after the child's release.
test("cross-process: parent acquire blocks until the child releases", async () => {
  const dir = tmp()
  const lockPath = join(dir, "auth.lock")
  const heldPath = join(dir, "held")
  const releasedPath = join(dir, "released")
  const lockfileAbs = join(import.meta.dir, "lockfile.ts")

  // Child hold = 220ms: safely between the >=150ms assertion floor and the parent's MOCKED
  // 300ms acquire timeout (the parent shares this process's fast constants), so the parent
  // reliably waits through the hold without a timeout race. The child imports the REAL
  // constants (no mock in a fresh process => prod 30s timeout).
  const script = `
    const { acquireFileLock } = await import(process.env.CAU_LOCKFILE)
    const { writeFileSync } = await import("node:fs")
    const handle = await acquireFileLock(process.env.CAU_LOCK)
    writeFileSync(process.env.CAU_HELD, "1")
    await new Promise((r) => setTimeout(r, 220))
    await handle.release()
    writeFileSync(process.env.CAU_RELEASED, "1")
  `
  const child = Bun.spawn(["bun", "-e", script], {
    env: {
      ...process.env,
      CAU_LOCKFILE: lockfileAbs,
      CAU_LOCK: lockPath,
      CAU_HELD: heldPath,
      CAU_RELEASED: releasedPath,
    },
    stdout: "pipe",
    stderr: "pipe",
  })

  expect(await pollUntil(() => existsSync(heldPath), 5000)).toBe(true)

  const start = Date.now()
  const handle = await acquireFileLock(lockPath)
  const elapsed = Date.now() - start
  expect(elapsed).toBeGreaterThanOrEqual(150)
  expect(existsSync(releasedPath)).toBe(true)
  await handle.release()

  const code = await child.exited
  if (code !== 0) throw new Error(`child exited ${code}: ${await new Response(child.stderr).text()}`)
  expect(code).toBe(0)
})
