import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function pollUntil(cond: () => boolean, deadlineMs: number, intervalMs = 10): Promise<boolean> {
  const dl = Date.now() + deadlineMs
  while (Date.now() < dl) {
    if (cond()) return true
    await sleep(intervalMs)
  }
  return cond()
}

type ChildOutcome = { threw: boolean; name: string; refreshed: boolean }

function readOutcome(path: string): ChildOutcome {
  return JSON.parse(readFileSync(path, "utf8")) as ChildOutcome
}

type SeededRoot = { root: string; dataHome: string; accountsDir: string }

function seedRoot(): SeededRoot {
  const root = mkdtempSync(join(tmpdir(), "cau-incident-"))
  const dataHome = join(root, "data")
  mkdirSync(join(dataHome, "opencode"), { recursive: true })
  const accountsDir = join(root, ".config", "opencode")
  mkdirSync(accountsDir, { recursive: true })
  return { root, dataHome, accountsDir }
}

function seedFiles(accountsDir: string, dataHome: string): void {
  writeFileSync(
    join(accountsDir, "claude-accounts.json"),
    JSON.stringify({
      version: 1,
      activeId: "other",
      accounts: [
        { id: "other", label: "other@x", refresh: "ro", access: "ao", expires: Date.now() + 3_600_000 },
        { id: "tgt", label: "tgt@x", refresh: "r1", access: "a-old", expires: Date.now() - 1_000 },
      ],
    }),
  )
  writeFileSync(
    join(dataHome, "opencode", "auth.json"),
    JSON.stringify({ anthropic: { type: "oauth", access: "ao", refresh: "ro", expires: Date.now() + 3_600_000 } }),
  )
}

type StoredAccountShape = { id: string; refresh: string; access?: string; expires?: number; needsReauth?: boolean }

function readAccounts(accountsDir: string): { accounts: StoredAccountShape[] } {
  return JSON.parse(readFileSync(join(accountsDir, "claude-accounts.json"), "utf8"))
}

async function readStderr(proc: Bun.Subprocess<"ignore", "ignore", "pipe">): Promise<string> {
  return await Bun.readableStreamToText(proc.stderr)
}

const happyRunnerSource = `
import { test, mock } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const SRC = process.env.CAU_SRC
const OUT = process.env.CAU_OUT
const TOKEN_URL = process.env.CAU_TOKEN_URL + "/token"

const realConstants = await import(join(SRC, "constants.ts"))
mock.module(join(SRC, "constants.ts"), () => ({
  ...realConstants,
  TOKEN_URL,
}))

await fetch(process.env.CAU_TOKEN_URL + "/ready")

const { acquireInactiveAccess } = await import(join(SRC, "usage.ts"))

const outcome = { threw: false, name: "", refreshed: false }
try {
  const result = await acquireInactiveAccess("tgt")
  outcome.refreshed = result.refreshed
} catch (err) {
  outcome.threw = true
  outcome.name = err.name
}
writeFileSync(OUT, JSON.stringify(outcome))
test("incident-replica happy-path child executed", () => {})
`

const failRunnerSource = `
import { test, mock } from "bun:test"
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const SRC = process.env.CAU_SRC
const OUT = process.env.CAU_OUT

const realConstants = await import(join(SRC, "constants.ts"))
mock.module(join(SRC, "constants.ts"), () => ({
  ...realConstants,
  LOCK_ACQUIRE_TIMEOUT_MS: 500,
  LOCK_STALE_MS: 45000,
}))

const { acquireInactiveAccess } = await import(join(SRC, "usage.ts"))

const outcome = { threw: false, name: "", refreshed: false }
try {
  const result = await acquireInactiveAccess("tgt")
  outcome.refreshed = result.refreshed
} catch (err) {
  outcome.threw = true
  outcome.name = err.name
}
writeFileSync(OUT, JSON.stringify(outcome))
test("incident-replica failure-path child executed", () => {})
`

test("incident replica: two concurrent processes racing one single-use rotating token → exactly one rotation, zero false flags", async () => {
  const { root, dataHome, accountsDir } = seedRoot()
  seedFiles(accountsDir, dataHome)

  const runnerDir = mkdtempSync(join(tmpdir(), "cau-incident-runner-"))
  const runnerPath = join(runnerDir, "runner.test.ts")
  writeFileSync(runnerPath, happyRunnerSource)
  const out1 = join(runnerDir, "out1.json")
  const out2 = join(runnerDir, "out2.json")

  let readyCount = 0
  let resolveBarrier: () => void = () => {}
  const barrier = new Promise<void>((resolve) => {
    resolveBarrier = resolve
  })
  let used = false
  const posts: string[] = []

  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url)
      if (url.pathname === "/ready") {
        readyCount++
        if (readyCount >= 2) resolveBarrier()
        return new Response("ok")
      }
      if (url.pathname === "/token" && req.method === "POST") {
        await barrier
        await sleep(50)
        const body = (await req.json()) as { refresh_token: string }
        posts.push(body.refresh_token)
        if (body.refresh_token === "r1" && !used) {
          used = true
          return Response.json({ access_token: "a2", refresh_token: "r2", expires_in: 7200 })
        }
        return new Response(
          JSON.stringify({ error: "invalid_grant", error_description: "Refresh token not found or invalid" }),
          { status: 400 },
        )
      }
      return new Response("not found", { status: 404 })
    },
  })

  let proc1: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined
  let proc2: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined
  try {
    const env = {
      ...process.env,
      HOME: root,
      XDG_DATA_HOME: dataHome,
      CAU_SRC: import.meta.dir,
      CAU_TOKEN_URL: `http://127.0.0.1:${server.port}`,
    }
    proc1 = Bun.spawn(["bun", "test", runnerPath], { env: { ...env, CAU_OUT: out1 }, stdout: "ignore", stderr: "pipe" })
    proc2 = Bun.spawn(["bun", "test", runnerPath], { env: { ...env, CAU_OUT: out2 }, stdout: "ignore", stderr: "pipe" })

    const [code1, code2] = await Promise.all([proc1.exited, proc2.exited])
    if (code1 !== 0) throw new Error(`child1 exited ${code1}: ${await readStderr(proc1)}`)
    if (code2 !== 0) throw new Error(`child2 exited ${code2}: ${await readStderr(proc2)}`)

    await pollUntil(() => {
      try {
        readOutcome(out1)
        readOutcome(out2)
        return true
      } catch {
        return false
      }
    }, 2000)

    const r1 = readOutcome(out1)
    const r2 = readOutcome(out2)

    expect(r1.threw).toBe(false)
    expect(r2.threw).toBe(false)
    expect(posts).toEqual(["r1"])

    const finalAccounts = readAccounts(accountsDir)
    const tgt = finalAccounts.accounts.find((a) => a.id === "tgt")
    expect(tgt).toBeDefined()
    expect(tgt!.refresh).toBe("r2")
    expect(tgt!.access).toBe("a2")
    expect(tgt!.needsReauth).toBeUndefined()
    expect(tgt!.expires).toBeGreaterThan(Date.now())
  } finally {
    proc1?.kill()
    proc2?.kill()
    server.stop(true)
  }
})

test("incident replica failure-path: a pre-existing FRESH lock blocks both children with LockTimeoutError, file unchanged (proves the lock is on the hot path)", async () => {
  const { root, dataHome, accountsDir } = seedRoot()
  seedFiles(accountsDir, dataHome)
  const lockPath = join(dataHome, "opencode", "claude-accounts-usage.lock")
  writeFileSync(lockPath, JSON.stringify({ pid: 999999, token: "foreign", at: Date.now() }))

  const runnerDir = mkdtempSync(join(tmpdir(), "cau-incident-fail-runner-"))
  const runnerPath = join(runnerDir, "runner.test.ts")
  writeFileSync(runnerPath, failRunnerSource)
  const out1 = join(runnerDir, "out1.json")
  const out2 = join(runnerDir, "out2.json")

  let proc1: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined
  let proc2: Bun.Subprocess<"ignore", "ignore", "pipe"> | undefined
  try {
    const env = { ...process.env, HOME: root, XDG_DATA_HOME: dataHome, CAU_SRC: import.meta.dir }
    proc1 = Bun.spawn(["bun", "test", runnerPath], { env: { ...env, CAU_OUT: out1 }, stdout: "ignore", stderr: "pipe" })
    proc2 = Bun.spawn(["bun", "test", runnerPath], { env: { ...env, CAU_OUT: out2 }, stdout: "ignore", stderr: "pipe" })

    const [code1, code2] = await Promise.all([proc1.exited, proc2.exited])
    if (code1 !== 0) throw new Error(`child1 exited ${code1}: ${await readStderr(proc1)}`)
    if (code2 !== 0) throw new Error(`child2 exited ${code2}: ${await readStderr(proc2)}`)

    const r1 = readOutcome(out1)
    const r2 = readOutcome(out2)

    expect(r1.threw).toBe(true)
    expect(r1.name).toBe("LockTimeoutError")
    expect(r2.threw).toBe(true)
    expect(r2.name).toBe("LockTimeoutError")

    const finalAccounts = readAccounts(accountsDir)
    const tgt = finalAccounts.accounts.find((a) => a.id === "tgt")
    expect(tgt).toBeDefined()
    expect(tgt!.refresh).toBe("r1")
    expect(tgt!.needsReauth).toBeUndefined()
  } finally {
    proc1?.kill()
    proc2?.kill()
    try {
      unlinkSync(lockPath)
    } catch {}
  }
})
