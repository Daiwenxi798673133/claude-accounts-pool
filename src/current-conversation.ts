import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

// What the CURRENT conversation is actually routed to, which the account rows cannot show:
// their "In Use" marker only tracks which Claude token sits in the anthropic auth slot, so
// on a ChatGPT turn the panel would otherwise still read as if Claude were in play.
// Lives outside dialogs.tsx so it is reachable from tests without a TUI/JSX runtime.
export function currentConversation(api: TuiPluginApi): string | undefined {
  const route = api.route?.current
  if (!route || route.name !== "session") return undefined
  const sessionID = (route.params as { sessionID?: string } | undefined)?.sessionID
  if (!sessionID) return undefined
  try {
    const messages = api.state.session.messages(sessionID)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "assistant") {
        if (!message.providerID || !message.modelID) return undefined
        return `${message.providerID} / ${message.modelID}`
      }
    }
  } catch {
    // Rendered inline, so a state lookup that throws would take the whole panel down;
    // this line is a nicety and an omitted one beats a dialog that will not open.
  }
  return undefined
}
