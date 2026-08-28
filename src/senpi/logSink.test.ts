import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { initLogger, log } from "../logger.ts"
import { createFileLogClient, senpiLogPath } from "./logSink.ts"

function sandbox(): { env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cap-log-sink-"))
  return { env: { CAP_LEASE_CACHE_DIR: dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("the sink lands beside the lease cache, not in senpi's agent dir", () => {
  expect(senpiLogPath({ CAP_LEASE_CACHE_DIR: "/a", SENPI_CODING_AGENT_DIR: "/b" })).toBe("/a/senpi-extension.log")
  expect(senpiLogPath({})).toBe(join(homedir(), ".claude-accounts-pool", "senpi-extension.log"))
})

test("each record is one parseable line carrying its level and tag", () => {
  const box = sandbox()
  try {
    const client = createFileLogClient(box.env)
    client.app.log({ service: "svc", level: "warn", message: "first", extra: { slot: "env" } })
    client.app.log({ service: "svc", level: "error", message: "second" })

    const lines = readFileSync(senpiLogPath(box.env), "utf-8").trimEnd().split("\n")
    expect(lines).toHaveLength(2)
    const [first, second] = lines.map((line) => JSON.parse(line) as Record<string, unknown>)
    expect(first).toMatchObject({ level: "warn", message: "first", extra: { slot: "env" } })
    expect(second).toMatchObject({ level: "error", message: "second" })
    expect(typeof first?.ts).toBe("string")
  } finally {
    box.cleanup()
  }
})

// The file sits next to one that holds access tokens, so it inherits that directory's discipline.
test("the file is created 0600", () => {
  const box = sandbox()
  try {
    createFileLogClient(box.env).app.log({ message: "x" })
    expect(statSync(senpiLogPath(box.env)).mode & 0o777).toBe(0o600)
  } finally {
    box.cleanup()
  }
})

// The regression this whole file exists for: the senpi entry never called initLogger, so guard()'s
// report reached a logger with no client and vanished. initLogger's client is a MODULE GLOBAL, so it
// is installed per-test and torn down in a finally.
test("a guard-style report reaches disk once the client is installed", () => {
  const box = sandbox()
  try {
    initLogger(createFileLogClient(box.env))
    log.warn("senpi:usage-command", { error: "boom" })

    const record = JSON.parse(readFileSync(senpiLogPath(box.env), "utf-8").trimEnd()) as Record<string, unknown>
    expect(record).toMatchObject({ level: "warn", extra: { error: "boom" } })
    expect(String(record.message)).toContain("senpi:usage-command")
  } finally {
    initLogger(undefined)
    box.cleanup()
  }
})
