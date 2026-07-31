// Shared Anthropic OAuth client_id used by the official Claude Pro/Max flow
// (same value as @ex-machina/opencode-anthropic-auth), so refresh tokens stored
// by that plugin are accepted by the refresh endpoint below.
export const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e"

export const TOKEN_URL = "https://platform.claude.com/v1/oauth/token"

export const USAGE_ENDPOINT = "https://api.anthropic.com/api/oauth/usage"

export const PROFILE_ENDPOINT = "https://api.anthropic.com/api/oauth/profile"

export const OAUTH_BETA = "oauth-2025-04-20"

// ChatGPT subscription quota, same backend the official Codex CLI queries. UNDOCUMENTED
// and unversioned, so every consumer must degrade gracefully rather than assume a shape.
// The sibling `/codex/usage` path answers 403 for OAuth subscription tokens — use this one.
export const OPENAI_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage"

// ChatGPT OAuth client_id + refresh endpoint, identical to the ones OpenCode's own
// built-in codex plugin uses, so a chain minted by its login flow is refreshable here.
// The refresh POST must stay form-urlencoded to match that plugin; the Rust Codex CLI
// posts JSON to the same URL, and copying the CLI instead would diverge from the client
// that actually owns the `openai` auth.json entry.
export const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"

export const OPENAI_TOKEN_URL = "https://auth.openai.com/oauth/token"

// Refresh slightly before real expiry so neither ex-machina nor the usage call
// receives an already-stale access token.
export const TOKEN_EXPIRY_BUFFER_MS = 60_000

// Proactively refresh accounts whose access token expires within this window: INACTIVE
// accounts on every /usage + keeper tick, and the ACTIVE chain only while idle (no
// anthropic session running) — ex-machina refreshes only at request time, so an idle
// refresh cannot race it.
export const INACTIVE_REFRESH_THRESHOLD_MS = 30 * 60_000

// Token keeper: background keep-alive pass over INACTIVE accounts every tick (refresh only those
// inside INACTIVE_REFRESH_THRESHOLD_MS of expiry). Declared HERE, ahead of the openai constants,
// rather than beside WATCH_DEBOUNCE_MS where it used to live, because OPENAI_QUARANTINE_MS is now
// DERIVED from it — see the derivation immediately below.
export const KEEPALIVE_TICK_MS = 5 * 60_000

// Quarantine window after an `openai` slot handover: an account that has left the slot — or that
// merely MIGHT have, see captureInLock's broad quarantine — is off-limits to any refresh of OURS
// for this long (INV-O1), because codex may still have a request in flight that rotates the tip we
// just captured, and a replayed refresh token answers `refresh_token_reused`, which revokes the
// whole family.
//
// DERIVATION: codex refreshes at fetch-wrapper ENTRY, so the real overlap is one token POST
// round-trip (seconds); everything past that is deliberate headroom. The floor is expressed in
// KEEPER TICKS rather than as a bare literal because the coupling is load-bearing and used to be
// written down nowhere: we only observe the slot once per tick, so an occupant's stamp can already
// be one full tick stale the moment it is evicted, and a quarantine shorter than a couple of ticks
// would let a just-evicted account become refreshable before we ever look again. Raising
// KEEPALIVE_TICK_MS now raises this window with it instead of silently opening that hole. The
// literal keeps today's headroom if the tick is ever LOWERED, so the effective value stays 10 min.
//
// UPPER BOUND, enforced by test rather than clamped here (clamping would silently trade the
// exclusion away): the worst-case delay before an evicted account is refreshed is
// OPENAI_QUARANTINE_MS + one tick, so OPENAI_QUARANTINE_MS + KEEPALIVE_TICK_MS must stay strictly
// below INACTIVE_REFRESH_THRESHOLD_MS or the quarantine could STARVE a token instead of merely
// delaying it. Today: 10 + 5 < 30, so a delayed account is still refreshed with 15+ minutes of
// validity in hand.
export const OPENAI_QUARANTINE_MS = Math.max(10 * 60_000, 2 * KEEPALIVE_TICK_MS)

// Keep-alive refresh of INACTIVE ChatGPT accounts ships DARK, and the reason is COVERAGE, not
// doubt about the design: the maintainer has exactly ONE ChatGPT account, which therefore always
// occupies the auth.json `openai` slot and is therefore always excluded by INV-O1 — so on the only
// machine this code has ever run on, the refresh branch is UNREACHABLE and has zero real-machine
// coverage. Its failure mode is not a degraded panel: a replayed refresh token answers
// `refresh_token_reused`, which revokes the whole token family, so the account is PERMANENTLY DEAD
// and the user must re-login. src/openai-keepalive.test.ts is the only defence that has ever
// actually run, so this stays false until someone with TWO ChatGPT accounts can exercise the path.
// Deliberately NOT env-overridable: an escape hatch is just a way to enable this by accident.
// While false the whole feature is inert — no POST, no store read, no lock (see keeper.ts).
export const OPENAI_KEEPALIVE_ENABLED = false

// OpenAI auto-switch ships DARK. It stays false until the `autoswitch:foreign-limit-probe`
// diagnostic confirms that a ChatGPT limit payload (429 + body error.type=usage_limit_reached,
// or the x-codex-* reset headers) actually REACHES a TUI plugin: `session.status` delivers only a
// bare message string, so the signature documented in openai/codex may be unreachable from here
// and the whole feature would be dead code built on a guess.
// While false, DETECTION and its decision logging still run (autoswitch.ts decideLimit) — that is
// precisely how the confirmation will arrive — and only the switch/continue ACTION is suppressed.
// DO NOT flip this to true on its own: handleLimit's tail (doSwitch → switchToAccount, the
// cooldown book, stalledSessions, announceRecovery) is still ANTHROPIC-only, so a true here would
// cool and switch the WRONG account. Wire that tail per-provider first.
// Anthropic auto-switch is unaffected by this flag and remains always-on.
export const OPENAI_AUTOSWITCH_ENABLED = false

// Active account is expired + an anthropic session is running: instead of racing
// ex-machina to refresh, poll auth.json every ACTIVE_WAIT_POLL_MS until ex-machina
// writes a fresh token, giving up after ACTIVE_WAIT_TIMEOUT_MS (then show cached).
// Mirrors autoswitch IDLE_WAIT_TIMEOUT_MS/IDLE_POLL_MS.
export const ACTIVE_WAIT_TIMEOUT_MS = 8_000
export const ACTIVE_WAIT_POLL_MS = 200

// Hard ceiling on any Anthropic network call. Several of these (token refresh, profile
// capture) run while holding the auth lock, so an un-bounded hang would starve every
// account switch / usage collect queued behind it — the timeout bounds that blast radius.
export const NETWORK_TIMEOUT_MS = 15_000

// auth.json watcher: re-captures the active chain tip on every ex-machina rotation so the tip is
// never lost across an out-of-band switch (`opencode auth login`, restart). KEEPALIVE_TICK_MS is
// declared further up, beside the quarantine window it now derives.
export const WATCH_DEBOUNCE_MS = 500

// Cross-process auth lock (src/lockfile.ts). Max legitimate hold = one network call bounded by
// NETWORK_TIMEOUT_MS (15s) + file I/O, so 3× that margin before a lock is presumed abandoned and stolen.
export const LOCK_STALE_MS = 45_000
// Worst realistic wait = one other instance's full 15s critical section; on expiry THROW (never
// silently proceed unlocked, which would re-open the token-clobber race this lock exists to close).
export const LOCK_ACQUIRE_TIMEOUT_MS = 30_000
// Poll interval while another instance holds a still-live lock (jittered at the call site).
export const LOCK_POLL_MS = 100

// INV-CLOUD-1 — a worker's auth.json entry MUST carry a refresh string, and it must NOT be a
// real one. Both halves are load-bearing.
// VERIFIED BY EXPERIMENT (opencode 1.18.9): an `anthropic` auth.json entry whose `refresh`
// field is MISSING is SILENTLY DISCARDED — `opencode auth list` then reports 0 credentials,
// exit code 0, no error printed. The same entry WITH a fake refresh string reports 1
// credential. So omitting the field is not an option: the lease would vanish without a trace.
// The value therefore has to be a string, and this one is deliberately, recognizably NOT a
// token, so that every capture path can refuse it on sight instead of archiving it as if it
// were a real chain. That refusal is what keeps the MASTER the only holder of real refresh
// tokens: a worker machine can never leak, replay, or revoke a chain it does not have.
export const SENTINEL_REFRESH = "claude-accounts-usage/cloud-lease/not-a-refresh-token"

// Renew a lease this long BEFORE its access token expires. ex-machina's refresh trigger is
// `auth.expires < Date.now()` with ZERO buffer, so the only lever we have on a worker is to
// keep `expires` in the future — once it slips into the past, ex-machina tries to refresh
// against the sentinel and the request fails. This buffer must therefore ALWAYS exceed
// LEASE_CHECK_INTERVAL_MS: we only get to notice an approaching expiry once per check, so a
// buffer narrower than one interval could let a lease expire between two looks.
export const LEASE_RENEW_BUFFER_MS = 5 * 60_000

// How often a worker inspects its own lease. Cheap (no network unless renewal is due), and
// well inside LEASE_RENEW_BUFFER_MS so several checks fall within every renewal window.
export const LEASE_CHECK_INTERVAL_MS = 30_000

// Lease request retry: exponential backoff starting here. First retry lands fast enough to
// ride out a master restart without the worker noticing.
export const LEASE_BACKOFF_BASE_MS = 5_000

// Backoff ceiling. A master that has been down for a while is usually down deliberately, so
// stop doubling at 5 minutes: that still recovers promptly once it returns, without leaving a
// crowd of workers hammering a box that is being worked on.
export const LEASE_BACKOFF_CAP_MS = 300_000

// Floor on the remaining validity of an access token the master is willing to hand out. Below
// this the master refreshes FIRST rather than leasing a soon-to-expire token — a worker that
// receives one would immediately have to come back, and in the gap its requests fail.
export const MASTER_MIN_REMAINING_MS = 10 * 60_000

// Spacing between accounts while the master warms the pool, matching the existing keeper's
// inter-account spacing: the token endpoint rate-limits by IP, so refreshing the whole roster
// back-to-back earns a 429 that has nothing to do with any single account's subscription.
export const MASTER_WARM_SPACING_MS = 500

// Master-side usage polling. `/api/oauth/usage` has known PERSISTENT-429 behaviour (it stays
// angry well past the request that upset it), so polling stays deliberately coarse — the data
// is only used to rank accounts, and a 5-minute-old ranking is still a good ranking.
export const MASTER_USAGE_POLL_INTERVAL_MS = 5 * 60_000
