// Turns "a tick is already running" from a SKIP into a JOIN.
//
// installLeaseKeeper.tickOnce() returns immediately while another tick is in flight. That is right
// for the interval driving it — stacked ticks would multiply load on the master exactly when it is
// least able to take it — and wrong for a turn, whose caller needs a token to EXIST before it
// proceeds. Given the resolved no-op, senpi's provider finds no CLAUDE_CODE_OAUTH_TOKEN, falls to
// its `ambient` branch, and the turn is served by the machine's own credential instead of the
// pool's: a turn charged to an account nobody leased, reported as a success.
//
// So the second caller gets the SAME promise rather than a fresh no-op, and waits for the lease
// already on its way.
export function createLeaseJoiner(tick: () => Promise<void>): () => Promise<void> {
  let inFlight: Promise<void> | undefined
  return () => {
    // Cleared in `finally` rather than `then`: a rejected tick must not pin every later caller to
    // the same failure forever — the next one is entitled to its own attempt.
    inFlight ??= tick().finally(() => {
      inFlight = undefined
    })
    return inFlight
  }
}
