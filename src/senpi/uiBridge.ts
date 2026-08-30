// Whether this process holds senpi's RPC-bridged `ctx.ui` rather than a live TUI one — the single
// fact that decides whether `/usage` may open a dialog at all.
//
// omo runs an interactive session as TWO processes: a thin TUI client (`cli.js`) and a shared host
// daemon (`cli-main.js --mode rpc --multi-session`). Extensions load in BOTH, but senpi dispatches an
// extension slash command through `session.prompt`, so the command handler always runs in the DAEMON,
// whose `ctx.ui` is the RPC bridge in `modes/rpc/connection-handler.ts`.
//
// On that bridge `select` / `confirm` / `input` emit an `extension_ui_request` and then BLOCK on a
// reply — and senpi's own TUI client never sends one: `extension_ui_request` appears nowhere in
// `modes/rpc/rpc-client.ts`, `modes/interactive/interactive-host-runtime.ts` or `interactive-mode.ts`,
// so the request is forwarded to the session's event listeners and dropped. `notify`, `setStatus` and
// `setWidget` ride the same message and vanish the same way; they merely fail silently instead of
// hanging. Measured on omo-ai 5.0.0-0.beta.26 / senpi 2026.8.19: `/usage` logged usage-dispatched,
// the panel never drew, and the request was still pending when the session closed
// ("Extension UI request cancelled: session closed").
//
// `ctx.hasUI` cannot answer this — it is TRUE on that bridge, because from the daemon's point of view
// a UI does exist; what is missing is anyone at the other end willing to answer it.
//
// ARGV, not an env var: `--mode rpc` is the flag senpi itself branches on when choosing which ui
// implementation to build, so reading it cannot disagree with the surface we are actually holding.
// A client that DOES answer extension UI requests (senpi's own rpc-extension-ui example, omo's
// task-runner) is misjudged here — it loses a dialog it could have shown and gets the printed roster
// instead. That trade is deliberate: the failure of guessing wrong in this direction is a panel that
// reads instead of one that switches, and in the other direction it is a command that hangs.
export function uiIsRpcBridged(argv: readonly string[]): boolean {
  return argv.some((arg, index) => arg === "--mode=rpc" || (arg === "--mode" && argv[index + 1] === "rpc"))
}
