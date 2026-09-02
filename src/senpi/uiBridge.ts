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
// TWO INPUTS, because argv alone answers the neighbouring question rather than this one. `--mode rpc`
// is the flag senpi itself branches on when choosing which ui implementation to build, so reading it
// cannot disagree about the surface we are HOLDING. But what decides the dialog is whether anyone at
// the other end of that bridge will ANSWER an `extension_ui_request`, and the argv a host is spawned
// with is a fixed string that says nothing about that. Judging on argv alone is therefore a measurable
// quantity standing in for an unmeasurable one, and a host that does answer (senpi's own
// rpc-extension-ui example, omo's task-runner) loses a dialog it could have shown.
//
// So a host that answers declares it, and `CAP_UI_ANSWERS` is that declaration — the direct evidence
// the argv proxy never had. It is ONE-WAY: it can only take `bridged` from true back to false, never
// the reverse, so it cannot be used to force a dialog onto a surface that would hang on one. An unset,
// misspelled or unrecognised value is NOT a declaration and lands on the recoverable side: a panel
// that reads instead of one that switches, never a command that hangs. The comparison is against the
// exact string `"1"` and not a truthy test, because `"0"` is truthy and a loose test would flip
// precisely into the direction that hangs.
export const UI_ANSWERS_ENV = "CAP_UI_ANSWERS"

// Returned together rather than as a bare boolean because the decision is logged as well as taken,
// and the log has to separate "the variable never arrived" from "it arrived and we still degraded" —
// the distinction that cost an afternoon of grepping when this path left no trace at all. Recomputing
// either input at the log site would put the `"1"` comparison in two places.
export type UiSurface = {
  bridged: boolean
  argvRpc: boolean
  declared: boolean
}

export function uiSurface(argv: readonly string[], env: Record<string, string | undefined>): UiSurface {
  const argvRpc = argv.some((arg, index) => arg === "--mode=rpc" || (arg === "--mode" && argv[index + 1] === "rpc"))
  const declared = env[UI_ANSWERS_ENV] === "1"
  return { bridged: argvRpc && !declared, argvRpc, declared }
}
