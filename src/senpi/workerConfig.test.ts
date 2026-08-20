import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  readWorkerConfig,
  resolveWorkerConfig,
  validateWorkerConfig,
  workerConfigPath,
  writeWorkerConfig,
} from "./workerConfig.ts"

const MASTER = "http://100.64.0.36:8787"

function sandbox(): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cap-worker-config-"))
  return { env: { CAP_LEASE_CACHE_DIR: dir }, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("the config sits beside the lease cache, in the pool's own directory", () => {
  expect(workerConfigPath({ CAP_LEASE_CACHE_DIR: "/a" })).toBe("/a/senpi-worker.json")
  // The CLI writes this file from OUTSIDE omo and the extension reads it from INSIDE senpi, so the
  // path must not depend on anything omo's launcher exports.
  expect(workerConfigPath({ SENPI_CODING_AGENT_DIR: "/b" })).toBe(join(homedir(), ".claude-accounts-pool", "senpi-worker.json"))
})

test("a written config round-trips", async () => {
  const box = sandbox()
  try {
    await writeWorkerConfig({ masterUrl: MASTER, workerId: "vince-local.senpi", slots: 4 }, box.env)
    expect(readWorkerConfig(box.env)).toEqual({ masterUrl: MASTER, workerId: "vince-local.senpi", slots: 4 })
  } finally {
    box.cleanup()
  }
})

test("no config is a laptop that is not a worker, not a fault", () => {
  const box = sandbox()
  try {
    expect(readWorkerConfig(box.env)).toBeUndefined()
    expect(resolveWorkerConfig(box.env)).toBeUndefined()
  } finally {
    box.cleanup()
  }
})

// THE POINT OF THE FILE: a bare `omo` carries no CAP_* variables, so without this the extension
// returns early and the warm lease on disk is never published.
test("resolve falls back to the file when the environment says nothing", async () => {
  const box = sandbox()
  try {
    await writeWorkerConfig({ masterUrl: MASTER, workerId: "vince-local.senpi" }, box.env)
    expect(resolveWorkerConfig(box.env)).toEqual({ masterUrl: MASTER, workerId: "vince-local.senpi" })
  } finally {
    box.cleanup()
  }
})

// Env wins so a machine already configured through environment variables keeps behaving exactly as
// it did before this file existed.
test("the environment overrides the file, field by field", async () => {
  const box = sandbox()
  try {
    await writeWorkerConfig({ masterUrl: MASTER, workerId: "from-file", slots: 2 }, box.env)
    const resolved = resolveWorkerConfig({
      ...box.env,
      CAP_WORKER_ID: "from-env",
      CAP_SENPI_SLOTS: "5",
    })
    expect(resolved).toEqual({ masterUrl: MASTER, workerId: "from-env", slots: 5 })
  } finally {
    box.cleanup()
  }
})

test("a malformed or wrong-version file reads as no config", () => {
  const box = sandbox()
  const path = join(box.dir, "senpi-worker.json")
  try {
    writeFileSync(path, "not json")
    expect(readWorkerConfig(box.env)).toBeUndefined()

    writeFileSync(path, JSON.stringify({ version: 99, masterUrl: MASTER, workerId: "w" }))
    expect(readWorkerConfig(box.env)).toBeUndefined()

    // A config missing half of what a worker needs is not a partial worker — leasing needs both.
    writeFileSync(path, JSON.stringify({ version: 1, masterUrl: MASTER }))
    expect(readWorkerConfig(box.env)).toBeUndefined()
  } finally {
    box.cleanup()
  }
})

// CAUGHT AT CONFIGURE TIME, NOT BY A 400. The master refuses anything outside
// /^[A-Za-z0-9._-]{1,64}$/, and a colon is the separator a person reaches for first when naming a
// harness — it cost one real debugging round before this check existed.
test("validate refuses a workerId the master would reject", () => {
  const bad = validateWorkerConfig({ masterUrl: MASTER, workerId: "vince-local:senpi" })
  expect(bad.ok).toBe(false)
  if (!bad.ok) expect(bad.error).toContain("workerId")

  const good = validateWorkerConfig({ masterUrl: MASTER, workerId: "vince-local.senpi" })
  expect(good.ok).toBe(true)
  if (good.ok) expect(good.config.workerId).toBe("vince-local.senpi")
})

test("validate refuses a masterUrl that is not http(s)", () => {
  for (const masterUrl of ["", "not a url", "ftp://host", "100.64.0.36:8787"]) {
    const outcome = validateWorkerConfig({ masterUrl, workerId: "w" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.error).toContain("masterUrl")
  }
  expect(validateWorkerConfig({ masterUrl: "https://master.internal:8443", workerId: "w" }).ok).toBe(true)
})

test("validate clamps slots to senpi's ceiling and defaults to one", () => {
  const one = validateWorkerConfig({ masterUrl: MASTER, workerId: "w" })
  expect(one.ok && one.config.slots).toBe(1)

  const clamped = validateWorkerConfig({ masterUrl: MASTER, workerId: "w", slots: "99" })
  expect(clamped.ok && clamped.config.slots).toBe(16)

  const junk = validateWorkerConfig({ masterUrl: MASTER, workerId: "w", slots: "abc" })
  expect(junk.ok).toBe(false)
  if (!junk.ok) expect(junk.error).toContain("slots")
})
