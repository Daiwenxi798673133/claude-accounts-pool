import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { type CachedLease, leaseCachePath, readLeaseCache, writeLeaseCache } from "./leaseCache.ts"

const NOW = 1_800_000_000_000

function sandbox(): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cap-lease-cache-"))
  return { env: { CAP_LEASE_CACHE_DIR: dir }, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

function lease(accountId: string, expires: number): CachedLease {
  return { accountId, access: `access-${accountId}`, expires }
}

// senpi's agent dir is NOT consulted, and that is the point: omo's launcher exports it only into
// senpi's own environment, so honouring it would resolve one directory inside the extension and a
// different one in the CLI — which is exactly how "configure once" came to silently do nothing.
test("one pool-owned directory, resolved identically from inside and outside omo", () => {
  expect(leaseCachePath({ CAP_LEASE_CACHE_DIR: "/a", SENPI_CODING_AGENT_DIR: "/b" })).toBe("/a/senpi-lease-cache.json")
  expect(leaseCachePath({ SENPI_CODING_AGENT_DIR: "/b" })).toBe(join(homedir(), ".claude-accounts-pool", "senpi-lease-cache.json"))
  expect(leaseCachePath({ OMO_CODING_AGENT_DIR: "/c" })).toBe(join(homedir(), ".claude-accounts-pool", "senpi-lease-cache.json"))
})

test("a missing file is a cold start, not a fault", () => {
  const box = sandbox()
  try {
    expect(readLeaseCache(box.env, NOW).size).toBe(0)
  } finally {
    box.cleanup()
  }
})

test("a round trip returns every still-usable slot", async () => {
  const box = sandbox()
  try {
    const slots = new Map([
      ["env", lease("acct-a", NOW + 600_000)],
      ["env-2", lease("acct-b", NOW + 600_000)],
    ])
    await writeLeaseCache(slots, box.env)

    const read = readLeaseCache(box.env, NOW)
    expect([...read.keys()].sort()).toEqual(["env", "env-2"])
    expect(read.get("env")).toEqual(lease("acct-a", NOW + 600_000))
  } finally {
    box.cleanup()
  }
})

// THE ENTRY THAT MUST NEVER BE PUBLISHED. senpi does not refresh an env slot, so a spent token would
// be sent upstream verbatim and answered 401 — and because senpi scores an auth failure as a
// completed turn, that 401 would not even take the account out of rotation.
test("an expired slot is dropped rather than published", async () => {
  const box = sandbox()
  try {
    await writeLeaseCache(
      new Map([
        ["env", lease("acct-a", NOW - 1)],
        ["env-2", lease("acct-b", NOW)],
        ["env-3", lease("acct-c", NOW + 1)],
      ]),
      box.env,
    )

    // `NOW` exactly is already spent, matching the keeper's own strictly-greater test.
    expect([...readLeaseCache(box.env, NOW).keys()]).toEqual(["env-3"])
  } finally {
    box.cleanup()
  }
})

test("junk, a wrong version and malformed members all read as nothing cached", () => {
  const box = sandbox()
  const path = join(box.dir, "senpi-lease-cache.json")
  try {
    writeFileSync(path, "not json at all")
    expect(readLeaseCache(box.env, NOW).size).toBe(0)

    // A future writer's shape must not be guessed at: publishing a token read under the wrong
    // contract is worse than starting cold.
    writeFileSync(path, JSON.stringify({ version: 99, slots: { env: lease("acct-a", NOW + 1) } }))
    expect(readLeaseCache(box.env, NOW).size).toBe(0)

    // Per-member, not all-or-nothing: one corrupt slot must not deny the others their warm start.
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        slots: { env: { accountId: "acct-a", access: "", expires: NOW + 1 }, "env-2": lease("acct-b", NOW + 1) },
      }),
    )
    expect([...readLeaseCache(box.env, NOW).keys()]).toEqual(["env-2"])
  } finally {
    box.cleanup()
  }
})
