import { expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withSlotLock } from "./slotLock.ts"

function sandbox(): { env: NodeJS.ProcessEnv; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cap-slot-lock-"))
  return { env: { CAP_LEASE_CACHE_DIR: dir }, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

test("the section runs and the call reports that it held the lock", async () => {
  const box = sandbox()
  try {
    let ran = 0
    expect(await withSlotLock("env", async () => void ran++, box.env)).toBe(true)
    expect(ran).toBe(1)
  } finally {
    box.cleanup()
  }
})

// THE DECISION THIS MODULE EXISTS TO MAKE. One lease call can legitimately run ~10 minutes
// (leaseClient retries 8 times over a 5s→300s backoff), so a contender that QUEUED would sit out a
// master outage and then lease anyway — turning one slow renewal into N, which is the defect. It
// declines instead, and the caller's next tick reads whatever the winner published.
test("a contender declines instead of queueing behind the holder", async () => {
  const box = sandbox()
  try {
    let contender: boolean | undefined
    let contenderRan = false
    const held = await withSlotLock(
      "env",
      async () => {
        contender = await withSlotLock("env", async () => void (contenderRan = true), box.env)
      },
      box.env,
    )

    expect(held).toBe(true)
    expect(contender).toBe(false)
    // NOT MERELY "returned false": the whole point is that the body never ran, because running it is
    // what would put two hosts on two accounts under one workerId.
    expect(contenderRan).toBe(false)
  } finally {
    box.cleanup()
  }
})

// One lock file per SLOT, not one per machine: two slots renewing at once are not in conflict, and a
// single lock would serialise them for nothing.
test("two slots do not contend with each other", async () => {
  const box = sandbox()
  try {
    let other: boolean | undefined
    await withSlotLock(
      "env",
      async () => {
        other = await withSlotLock("env-2", async () => {}, box.env)
      },
      box.env,
    )
    expect(other).toBe(true)
  } finally {
    box.cleanup()
  }
})

// A section that throws must still release. Otherwise one rejected renewal would leave the slot locked
// until `stale` elapsed, and every host on the machine would skip its ticks for that whole window.
test("the lock is released when the section throws", async () => {
  const box = sandbox()
  try {
    await expect(
      withSlotLock(
        "env",
        () => {
          throw new Error("boom")
        },
        box.env,
      ),
    ).rejects.toThrow("boom")

    expect(await withSlotLock("env", async () => {}, box.env)).toBe(true)
  } finally {
    box.cleanup()
  }
})

// A lock we cannot even create must NOT fall through to running the section unprotected — that is the
// one outcome this module exists to prevent, and the caller retries on its next tick anyway.
test("an unusable lock directory declines rather than running unprotected", async () => {
  let ran = false
  const held = await withSlotLock("env", async () => void (ran = true), { CAP_LEASE_CACHE_DIR: "/dev/null/nope" })
  expect(held).toBe(false)
  expect(ran).toBe(false)
})
