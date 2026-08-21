import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import {
  readWorkerConfig,
  resolveWorkerConfig,
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
  // This file is written from OUTSIDE omo (by hand, or by whatever sets a machine up) and read from
  // INSIDE senpi, so the path must not depend on anything omo's launcher exports.
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

// THE COLON RULE, now enforced only at READ time. The master refuses anything outside
// /^[A-Za-z0-9._-]{1,64}$/, and a colon is the separator a person reaches for first when naming a
// harness — it cost one real debugging round. A CLI used to reject it before writing the file; with
// that CLI gone, resolveWorkerConfig declining to resolve it IS the whole guard, so the rule is
// pinned here instead of losing its only coverage along with the command.
test("a workerId the master would reject does not resolve", () => {
  const box = sandbox()
  try {
    // Written by hand, which is the only way this file gets created now.
    writeFileSync(
      workerConfigPath(box.env),
      JSON.stringify({ version: 1, masterUrl: MASTER, workerId: "vince-local:senpi" }),
    )
    expect(resolveWorkerConfig(box.env)).toBeUndefined()
    // An environment override is refused by the same rule, so neither route can smuggle one in.
    expect(resolveWorkerConfig({ ...box.env, CAP_WORKER_ID: "vince-local:senpi", CAP_MASTER_URL: MASTER })).toBeUndefined()
  } finally {
    box.cleanup()
  }
})

// A bare `host:port` parses as a URL whose protocol is `host:`, which is exactly the shape that used
// to sail through and fail much later as an unreachable master.
test("a masterUrl that is not http(s) does not resolve", () => {
  const box = sandbox()
  try {
    for (const masterUrl of ["", "not a url", "ftp://host", "100.64.0.36:8787"]) {
      expect(resolveWorkerConfig({ ...box.env, CAP_MASTER_URL: masterUrl, CAP_WORKER_ID: "w" })).toBeUndefined()
    }
    expect(resolveWorkerConfig({ ...box.env, CAP_MASTER_URL: "https://master.internal:8443", CAP_WORKER_ID: "w" })).toEqual(
      { masterUrl: "https://master.internal:8443", workerId: "w" },
    )
  } finally {
    box.cleanup()
  }
})
