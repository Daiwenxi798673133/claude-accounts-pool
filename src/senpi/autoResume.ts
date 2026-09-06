// Resume a session senpi stopped because THIS worker's pool slot was blocked.
//
// WHY IT EXISTS. The opencode lane has done this since day one (src/autoswitch.ts): a turn that hits
// a limit switches account and is re-prompted with "continue", so the operator never has to notice.
// The senpi lane could not, because the only hook it took was turn_start — recovery therefore waited
// for the operator to type something. The account swap itself already worked (auditSlotBlocks hands
// the blocked slot back, the lease that follows moves it), so what was missing was purely the second
// half: re-issuing the turn that died. This module is that half.
//
// WHAT KEEPS IT FROM BECOMING A LOOP, in the order the checks are applied:
//   * the run must have ended BADLY and not by the operator's own abort — an ESC is never undone;
//   * senpi must have blocked one of OUR slots, which is the only evidence that the pool is what
//     stopped the turn rather than the model, a tool, or another provider entirely;
//   * the recovery lease must have MOVED the slot to a different account, because resuming onto the
//     same throttled one spends the operator's turns re-hitting the wall it just hit;
//   * and at most MAX_CONSECUTIVE_RESUMES may be injected before a human is asked to look.
import { log } from "../logger.ts"

// Three, matching the shape of the failure rather than a taste in numbers: each resume costs one
// lease round trip and one account, so this walks at most three accounts deep into a pool that is
// having a bad day before it stops and says so. A limit hitting four accounts in a row is not a
// blip this should keep papering over.
export const MAX_CONSECUTIVE_RESUMES = 3

// What this module needs to know about the run that just ended. A projection of senpi's agent_end,
// not the event itself: everything else on it is either about content we must not read or about
// bookkeeping we have no business in.
export type RunEnd = {
  // The last assistant message's stopReason. "error" and "aborted" are the two that end a run badly.
  stopReason?: string
  // senpi's own attribution. "user" is the ESC key, and undoing that would be the rudest possible
  // behaviour from an extension.
  abortSource?: "user" | "system" | "provider"
  // senpi still owns the run and will retry or fall back itself. agent_settled is documented to fire
  // only once that is exhausted, so this is a guard against that ordering changing upstream, not a
  // case seen in practice.
  willRetry?: boolean
}

export type AutoResumeDeps = {
  // auditSlotBlocks, invalidation included: the slot names senpi has blocked AND whose occupant this
  // worker must replace. An empty answer means the wall was not ours.
  recoverBlockedSlots: () => Promise<readonly string[]>
  // The account each slot holds, in slot order. Read either side of the lease because identity is
  // the only evidence a swap actually happened — a lease that returned the same account leaves the
  // block standing, and senpi will not select the slot no matter how often we resume.
  heldAccounts: () => readonly (string | undefined)[]
  // ensureLeased: publish a fresh lease into every slot that needs one.
  lease: () => Promise<void>
  // Inject the "continue" turn. Fire-and-forget by design — senpi owns the turn from here.
  resume: () => void
  maxConsecutive?: number
}

// Passed per settle rather than held in the deps above: it is backed by the live ctx senpi hands the
// handler, and this extension may never keep one of those past the call it arrived on.
export type ResumeNotify = (message: string, type: "info" | "warning") => void

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

const ABORT_SOURCES = new Set(["user", "system", "provider"])

/**
 * The RunEnd inside a senpi agent_end event.
 *
 * PARSED, NOT CAST. This is the one place senpi's own event shape meets this extension, and the
 * extension deliberately takes no dependency on senpi — so a field that changes shape upstream must
 * degrade to "absent" here, never throw into the host's event loop. An empty RunEnd is read as "no
 * evidence of failure" by the caller, which is the fail-safe direction: it resumes nothing.
 */
export function readRunEnd(event: unknown): RunEnd {
  if (!isRecord(event)) return {}
  const messages = Array.isArray(event.messages) ? event.messages : []
  let stopReason: string | undefined
  // The LAST assistant message, because a run that failed mid-way still carries every earlier,
  // perfectly successful step ahead of it.
  for (let index = messages.length - 1; index >= 0; index--) {
    const message: unknown = messages[index]
    if (!isRecord(message) || message.role !== "assistant") continue
    if (typeof message.stopReason === "string") stopReason = message.stopReason
    break
  }
  const abortSource = event.abortSource
  return {
    ...(stopReason === undefined ? {} : { stopReason }),
    ...(typeof abortSource === "string" && ABORT_SOURCES.has(abortSource)
      ? { abortSource: abortSource as RunEnd["abortSource"] }
      : {}),
    ...(typeof event.willRetry === "boolean" ? { willRetry: event.willRetry } : {}),
    // `aborted: true` with no stopReason is how an abort that never reached the model arrives.
    ...(stopReason === undefined && event.aborted === true ? { stopReason: "aborted" } : {}),
  }
}

/** Whether the run ended in a way a fresh account could plausibly fix. */
export function endedBadly(end: RunEnd): boolean {
  return end.stopReason === "error" || end.stopReason === "aborted"
}

/**
 * The account a slot moved ONTO, or undefined when no slot moved.
 *
 * Compared position by position because the two readings are the same slot list either side of one
 * lease. A slot that went from holding nothing to holding an account counts: that is a cold slot
 * being filled, which is exactly as good a reason to resume as a swap.
 */
export function movedAccount(
  before: readonly (string | undefined)[],
  after: readonly (string | undefined)[],
): string | undefined {
  for (let index = 0; index < after.length; index++) {
    const next = after[index]
    if (next !== undefined && next !== before[index]) return next
  }
  return undefined
}

// Eight hex characters, the same width the panel's id column and every log line use, so the operator
// can match this sentence against the row they were looking at.
function short(accountId: string): string {
  return accountId.slice(0, 8)
}

export function createAutoResume(deps: AutoResumeDeps): {
  noteRunEnd: (end: RunEnd) => void
  settle: (notify: ResumeNotify) => Promise<void>
} {
  const max = deps.maxConsecutive ?? MAX_CONSECUTIVE_RESUMES
  // The run that is currently settling. agent_end lands first and carries the verdict; agent_settled
  // lands once nothing else will run and is the only safe moment to inject a turn.
  let pending: RunEnd | undefined
  // Resumes injected with no healthy turn in between. Reset by any settle that was not ours to act
  // on, so a session that recovers re-arms the full ladder for the next bad day.
  let consecutive = 0

  return {
    noteRunEnd(end) {
      pending = end
    },

    async settle(notify) {
      const end = pending
      pending = undefined
      if (end === undefined) return
      // The operator stopped it. Resuming here would take the keyboard away from them.
      if (end.abortSource === "user") {
        consecutive = 0
        return
      }
      if (end.willRetry === true) return
      if (!endedBadly(end)) {
        consecutive = 0
        return
      }
      // THE GATE. Every check above is about the run; this one is about whether the POOL is why it
      // ended. Nothing below runs for a failure that belongs to a tool, a model, or another provider.
      const stranded = await deps.recoverBlockedSlots()
      if (stranded.length === 0) {
        consecutive = 0
        return
      }
      if (consecutive >= max) {
        log.warn("senpi:auto-resume-exhausted", { stranded, consecutive })
        notify(`账号池：连续 ${max} 次自动换号仍然撞墙，已停止自动继续，请手动处理`, "warning")
        consecutive = 0
        return
      }
      const before = deps.heldAccounts()
      await deps.lease()
      const moved = movedAccount(before, deps.heldAccounts())
      if (moved === undefined) {
        // The block stands over the same account, so senpi will not select this slot and a resumed
        // turn would die exactly where the last one did. Say so instead of spending it.
        log.warn("senpi:auto-resume-no-swap", { stranded })
        notify("账号池：上一轮撞到账号阻塞，但池里没有可换的账号，本轮到此为止", "warning")
        consecutive = 0
        return
      }
      consecutive += 1
      log.info("senpi:auto-resume", { stranded, accountId: moved, consecutive })
      notify(`账号池：上一轮撞到账号阻塞，已换到「${short(moved)}」并自动继续`, "info")
      deps.resume()
    },
  }
}
