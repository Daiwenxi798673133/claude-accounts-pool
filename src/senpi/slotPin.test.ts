import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { writeLeaseCache, type CachedLease } from "./leaseCache.ts"
import { readSlotPin, slotPinPath, writeSlotPin } from "./slotPin.ts"

function sandbox(): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cap-slot-pin-"))
  return { env: { CAP_LEASE_CACHE_DIR: dir }, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("the pin file sits in the same pool-owned directory the lease cache resolves to", () => {
  expect(slotPinPath({ CAP_LEASE_CACHE_DIR: "/a" })).toBe("/a/senpi-slot-pins.json")
  expect(slotPinPath({})).toBe(join(homedir(), ".claude-accounts-pool", "senpi-slot-pins.json"))
})

test("an unpinned slot is the ordinary state, not a fault", () => {
  const box = sandbox()
  try {
    expect(readSlotPin("env", box.env)).toBeUndefined()
  } finally {
    box.cleanup()
  }
})

// THE WHOLE POINT OF THE FILE: a host that never saw the keypress must still read the pin, which is
// what stops it from taking the master's ranked pick under the same workerId.
test("a pin written by one host is visible to every other host on the machine", () => {
  const box = sandbox()
  try {
    writeSlotPin("env", "af008f89", box.env)
    expect(readSlotPin("env", box.env)).toBe("af008f89")
  } finally {
    box.cleanup()
  }
})

test("clearing a pin leaves the other slots' pins alone", () => {
  const box = sandbox()
  try {
    writeSlotPin("env", "af008f89", box.env)
    writeSlotPin("env-2", "eaaa1a79", box.env)
    writeSlotPin("env", undefined, box.env)
    expect(readSlotPin("env", box.env)).toBeUndefined()
    expect(readSlotPin("env-2", box.env)).toBe("eaaa1a79")
  } finally {
    box.cleanup()
  }
})

// WHY THIS LIVES IN ITS OWN FILE. senpi-lease-cache.json is whole-file rewritten on every publish, so
// a pin stored there would be read-modify-written from two unrelated triggers and one would lose.
test("publishing a lease cannot erase a pin", async () => {
  const box = sandbox()
  try {
    writeSlotPin("env", "af008f89", box.env)
    const entry: CachedLease = { accountId: "af008f89-a523", access: "sk-x", expires: Date.now() + 3_600_000 }
    await writeLeaseCache(new Map([["env", entry]]), box.env)
    expect(readSlotPin("env", box.env)).toBe("af008f89")
  } finally {
    box.cleanup()
  }
})

test("junk, a wrong version and malformed members all read as no pin", () => {
  const box = sandbox()
  const path = join(box.dir, "senpi-slot-pins.json")
  try {
    writeFileSync(path, "not json at all")
    expect(readSlotPin("env", box.env)).toBeUndefined()

    writeFileSync(path, JSON.stringify({ version: 99, pins: { env: "af008f89" } }))
    expect(readSlotPin("env", box.env)).toBeUndefined()

    writeFileSync(path, JSON.stringify({ version: 1, pins: { env: "", "env-2": "eaaa1a79" } }))
    expect(readSlotPin("env", box.env)).toBeUndefined()
    expect(readSlotPin("env-2", box.env)).toBe("eaaa1a79")
  } finally {
    box.cleanup()
  }
})

// An unwritable pool directory degrades the pin to what it was before this file existed. Failing the
// switch the operator asked for would be the worse answer.
test("an unwritable directory does not fail the caller", () => {
  expect(() => writeSlotPin("env", "af008f89", { CAP_LEASE_CACHE_DIR: "/dev/null/nope" })).not.toThrow()
  expect(readSlotPin("env", { CAP_LEASE_CACHE_DIR: "/dev/null/nope" })).toBeUndefined()
})
