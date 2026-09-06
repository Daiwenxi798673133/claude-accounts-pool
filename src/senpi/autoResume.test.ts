import { expect, test } from "bun:test"
import { createAutoResume, endedBadly, movedAccount, readRunEnd } from "./autoResume.ts"

type Notice = { message: string; type: string }

function harness(input: { stranded?: readonly string[]; swap?: boolean; max?: number }) {
  const calls = { audits: 0, leases: 0, resumes: 0, notices: [] as Notice[] }
  let held: (string | undefined)[] = ["acct-old-0000"]
  const auto = createAutoResume({
    recoverBlockedSlots: () => {
      calls.audits += 1
      return Promise.resolve(input.stranded ?? [])
    },
    heldAccounts: () => held,
    lease: () => {
      calls.leases += 1
      if (input.swap !== false) held = [`acct-new-${calls.leases}${"0".repeat(6)}`]
      return Promise.resolve()
    },
    resume: () => {
      calls.resumes += 1
    },
    ...(input.max === undefined ? {} : { maxConsecutive: input.max }),
  })
  const notify = (message: string, type: "info" | "warning"): void => {
    calls.notices.push({ message, type })
  }
  return { auto, calls, settle: () => auto.settle(notify) }
}

const failed = { stopReason: "error" } as const

// THE WHOLE POINT. This is what the opencode lane has always done and the senpi lane could not: the
// wall is hit, the slot moves to another account, and the turn continues without the operator having
// to notice, let alone retype anything.
test("a failed run whose slot moved onto a new account is resumed", async () => {
  const { auto, calls, settle } = harness({ stranded: ["env"] })

  auto.noteRunEnd(failed)
  await settle()

  expect(calls.resumes).toBe(1)
  expect(calls.notices).toHaveLength(1)
  expect(calls.notices[0]?.type).toBe("info")
  expect(calls.notices[0]?.message).toContain("acct-new")
})

// THE RUDENESS LOCK. ESC is an instruction, and an extension that re-issues the turn the operator
// just killed is worse than one that does nothing at all.
test("a run the operator aborted is never resumed and never touches the pool", async () => {
  const { auto, calls, settle } = harness({ stranded: ["env"] })

  auto.noteRunEnd({ stopReason: "aborted", abortSource: "user" })
  await settle()

  expect(calls).toMatchObject({ audits: 0, leases: 0, resumes: 0 })
})

// A settle after a healthy turn is the common case by far, so it must cost nothing: no auth.json
// read, no lease, no message.
test("a run that ended normally is left alone", async () => {
  const { auto, calls, settle } = harness({ stranded: ["env"] })

  auto.noteRunEnd({ stopReason: "stop" })
  await settle()

  expect(calls).toMatchObject({ audits: 0, leases: 0, resumes: 0, notices: [] })
})

// THE ATTRIBUTION GATE. A failure with no block on our slots belongs to a tool, the model, or another
// provider entirely — switching accounts under it would be superstition, and resuming would loop on
// a fault a fresh token cannot fix.
test("a failure senpi did not blame on our slot is not resumed", async () => {
  const { auto, calls, settle } = harness({ stranded: [] })

  auto.noteRunEnd(failed)
  await settle()

  expect(calls).toMatchObject({ audits: 1, leases: 0, resumes: 0, notices: [] })
})

// The master had nothing better to hand out, so the block still describes the account in the slot.
// senpi will not select it, so a resumed turn would die exactly where the last one did.
test("a lease that returns the same account stops and says so", async () => {
  const { auto, calls, settle } = harness({ stranded: ["env"], swap: false })

  auto.noteRunEnd(failed)
  await settle()

  expect(calls).toMatchObject({ leases: 1, resumes: 0 })
  expect(calls.notices[0]?.type).toBe("warning")
})

// agent_settled is documented to fire only once senpi's own retry and fallback are exhausted, but a
// run senpi still owns must never have a second turn injected underneath it.
test("a run senpi will retry itself is left to senpi", async () => {
  const { auto, calls, settle } = harness({ stranded: ["env"] })

  auto.noteRunEnd({ stopReason: "error", willRetry: true })
  await settle()

  expect(calls).toMatchObject({ audits: 0, resumes: 0 })
})

// agent_settled also fires for runs that never produced an agent_end this extension saw (a session
// replacement, a /reload mid-run). With no verdict there is nothing to act on.
test("a settle with no recorded run end does nothing", async () => {
  const { auto, calls, settle } = harness({ stranded: ["env"] })

  await settle()

  expect(calls).toMatchObject({ audits: 0, resumes: 0 })
})

// A pool having a genuinely bad day must eventually reach a human instead of walking the whole
// roster one injected turn at a time.
test("consecutive resumes stop at the cap and hand back to the operator", async () => {
  const { auto, calls, settle } = harness({ stranded: ["env"], max: 2 })

  for (let attempt = 0; attempt < 3; attempt++) {
    auto.noteRunEnd(failed)
    await settle()
  }

  expect(calls.resumes).toBe(2)
  expect(calls.notices.at(-1)).toMatchObject({ type: "warning" })
  expect(calls.notices.at(-1)?.message).toContain("2")
})

// The cap counts CONSECUTIVE failures. One healthy turn means the pool recovered, and the next bad
// day deserves the full ladder again rather than a counter left over from hours ago.
test("a healthy turn re-arms the ladder", async () => {
  const { auto, calls, settle } = harness({ stranded: ["env"], max: 1 })

  auto.noteRunEnd(failed)
  await settle()
  auto.noteRunEnd({ stopReason: "stop" })
  await settle()
  auto.noteRunEnd(failed)
  await settle()

  expect(calls.resumes).toBe(2)
})

// A run that failed mid-way still carries every successful step ahead of the failure, so the verdict
// is the LAST assistant message and never the first one found.
test("readRunEnd takes the last assistant message's stopReason", () => {
  expect(
    readRunEnd({
      messages: [
        { role: "assistant", stopReason: "toolUse" },
        { role: "toolResult" },
        { role: "assistant", stopReason: "error" },
      ],
      abortSource: "provider",
      willRetry: false,
    }),
  ).toEqual({ stopReason: "error", abortSource: "provider", willRetry: false })
})

// An abort that never reached the model leaves no assistant message to read a stopReason off.
test("readRunEnd reads a bare abort as an aborted run", () => {
  expect(readRunEnd({ messages: [], aborted: true, abortSource: "user" })).toEqual({
    stopReason: "aborted",
    abortSource: "user",
  })
})

// FAIL SAFE ON A SHAPE CHANGE. This extension takes no dependency on senpi, so an event whose fields
// moved must read as "no evidence of failure" — which resumes nothing — rather than throw into the
// host's event loop.
test("readRunEnd degrades an unrecognised event to no evidence", () => {
  expect(readRunEnd(undefined)).toEqual({})
  expect(readRunEnd({ messages: "nonsense", abortSource: 7, willRetry: "yes" })).toEqual({})
  expect(endedBadly(readRunEnd({}))).toBe(false)
})

test("movedAccount reports the account a slot moved onto, and nothing when none did", () => {
  expect(movedAccount(["acct-a"], ["acct-b"])).toBe("acct-b")
  expect(movedAccount(["acct-a"], ["acct-a"])).toBeUndefined()
  // A cold slot being filled is as good a reason to resume as a swap.
  expect(movedAccount([undefined], ["acct-b"])).toBe("acct-b")
  // Losing an account is not gaining one: there is nothing new for senpi to select.
  expect(movedAccount(["acct-a"], [undefined])).toBeUndefined()
  // With K slots, one that moved is enough — that is the slot selection will land on.
  expect(movedAccount(["acct-a", "acct-b"], ["acct-a", "acct-c"])).toBe("acct-c")
})
