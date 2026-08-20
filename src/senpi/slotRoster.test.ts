import { expect, test } from "bun:test"
import { createSlotRoster } from "./slotRoster.ts"

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

test("a slot sees what the others hold, and not its own account", async () => {
  const roster = createSlotRoster()
  await roster.withSlot("env", async (ctx) => {
    expect(ctx.excludeAccountIds).toEqual([])
    ctx.claim("acct-a")
  })
  await roster.withSlot("env-2", async (ctx) => {
    expect(ctx.excludeAccountIds).toEqual(["acct-a"])
    ctx.claim("acct-b")
  })

  // A RENEWAL of the first slot must not exclude its own account: keeping what you already hold is
  // the expected outcome, and excluding it would rotate every slot once per renewal window.
  await roster.withSlot("env", async (ctx) => {
    expect(ctx.excludeAccountIds).toEqual(["acct-b"])
  })
  expect(roster.heldAccountIds().sort()).toEqual(["acct-a", "acct-b"])
})

// THE REGRESSION THIS FILE EXISTS FOR. K keepers install K intervals that fire at nearly the same
// instant. Without serialisation both sections read the roster before either claimed, both excluded
// the same set, and both would be served the same account — one subscription feeding two slots.
test("concurrent sections are serialised, so the second sees the first's claim", async () => {
  const roster = createSlotRoster()
  const gate = deferred()
  const seen: Array<readonly string[]> = []

  const first = roster.withSlot("env", async (ctx) => {
    seen.push(ctx.excludeAccountIds)
    await gate.promise
    ctx.claim("acct-a")
  })
  const second = roster.withSlot("env-2", async (ctx) => {
    seen.push(ctx.excludeAccountIds)
    ctx.claim("acct-b")
  })

  // The second section has not run at all yet — it is queued behind a section that has not claimed.
  await Promise.resolve()
  expect(seen).toEqual([[]])

  gate.resolve()
  await Promise.all([first, second])
  expect(seen).toEqual([[], ["acct-a"]])
})

// A queue that breaks on one rejection would strand every slot behind it on a single transport fault.
test("a rejected section does not break the queue for the slots behind it", async () => {
  const roster = createSlotRoster()
  const failing = roster.withSlot("env", () => Promise.reject(new Error("master unreachable")))
  const following = roster.withSlot("env-2", async (ctx) => {
    ctx.claim("acct-b")
    return "ran"
  })

  await expect(failing).rejects.toThrow("master unreachable")
  expect(await following).toBe("ran")
  expect(roster.heldAccountIds()).toEqual(["acct-b"])
})

test("a failed lease leaves the previous claim standing", async () => {
  const roster = createSlotRoster()
  await roster.withSlot("env", async (ctx) => ctx.claim("acct-a"))
  // The section runs, decides it has nothing to write, and claims nothing. The slot keeps the token
  // it already published rather than being blanked — a still-valid credential beats none.
  await roster.withSlot("env", async () => undefined)
  expect(roster.heldAccountIds()).toEqual(["acct-a"])
})
