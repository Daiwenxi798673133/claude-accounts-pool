export type TurnMessage = { id: string; role: string; parentID?: string }

// Latest turn = last user message + the LAST assistant after it. Multi-step turns (one user →
// several assistant messages from tool steps) MUST resolve to the final assistant, not bail.
// No revert anymore (abort + continue/resend only), so the old "no newer turn" guard is dropped.
// `assistants` = every assistant step after that user (in order); callers aggregate the whole
// turn's parts so an empty step-boundary placeholder tail is never mistaken for "no output".
export function latestTurn<T extends TurnMessage>(
  messages: readonly T[],
): { user: T; failed: T; assistants: T[] } | undefined {
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "user") {
      lastUserIdx = i
      break
    }
  }
  if (lastUserIdx < 0) return undefined
  const user = messages[lastUserIdx]
  const assistants: T[] = []
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    if (messages[i].role === "assistant") assistants.push(messages[i])
  }
  if (assistants.length === 0) return undefined
  const failed = assistants[assistants.length - 1]
  return { user, failed, assistants }
}
