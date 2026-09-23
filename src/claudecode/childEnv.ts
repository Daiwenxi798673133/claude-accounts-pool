// The credential seam for the Claude Code lane: what environment a pooled `claude` child gets.
//
// WHY A GUARD AND NOT JUST AN ASSIGNMENT — this module exists for the refusal, not the injection.
// Claude Code resolves credentials by a fixed precedence (measured against a local capture endpoint,
// see issue #83), and FOUR classes of thing outrank the variable we inject:
//
//   1. CLAUDE_CODE_USE_BEDROCK / _VERTEX / _FOUNDRY  → a cloud provider's own credentials
//   2. ANTHROPIC_AUTH_TOKEN                          → Authorization: Bearer, gateway lane
//   3. ANTHROPIC_API_KEY                             → X-Api-Key lane
//   4. apiKeyHelper (a settings key, not an env var — see settingsBlockers)
//   ────────────────────────────────────────────────── our lease lands here (rank 5)
//
// A session that starts with any of them present runs on a credential the pool never leased, while
// reporting success and raising nothing. That is the same failure senpi-extension.ts:676 records for
// the ambient fallback — "the turn succeeded, raised no error, and was charged to an account the pool
// never leased" — arriving through a different door. It is unobservable from inside, so it has to be
// refused BEFORE the child starts rather than detected after.
//
// ANTHROPIC_BASE_URL IS OURS NOW, which is exactly why an operator's own value is still refused: the
// child's base URL points at this machine's relay (src/claudecode/relay.ts), and the relay is what
// swaps the frozen startup token for the machine's CURRENT lease on every request. An inherited value
// would be silently overwritten — and an operator who set one meant their traffic to go somewhere,
// which is a decision to surface, not to discard. It was refused for the opposite reason before the
// relay existed (a leased token sent to someone else's gateway), and that reason still holds.
//
// WE DO NOT TOUCH THE OPERATOR'S LOGIN. Injection is per-child-process, so ~/.claude/.credentials.json
// (and the macOS Keychain entry) is never read, written, or shadowed on disk: drop the variables and
// the next hand-typed `claude` is back on their own account. Writing that file instead would make this
// machine a second refresher of a chain the master owns (INV-CLOUD-1) — the one shape this lane must
// never take. The relay is what makes mid-session renewal possible WITHOUT that file.
import type { ProviderId } from "../accounts.ts"

/** The variable Claude Code reads for a subscription OAuth credential (precedence rank 5). */
export const CLAUDE_CODE_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN"

// Set on every child we start, and refused when already present on the way in. Operators WILL alias
// `claude` to this launcher — that is the whole point of it — and PATH resolution would then make the
// launcher spawn itself forever, each generation holding a lease it never uses. One booked account per
// fork, until the machine runs out of processes. The sentinel is what turns that into one sentence.
export const POOL_SESSION_SENTINEL = "CLAUDE_ACCOUNTS_POOL_SESSION"

/** Where the child sends every API request: this machine's relay, never Anthropic directly. */
export const RELAY_URL_VAR = "ANTHROPIC_BASE_URL"

// RESTORES A DEFAULT THE RELAY WOULD OTHERWISE COST. Claude Code switches optimistic tool search OFF
// whenever ANTHROPIC_BASE_URL is not api.anthropic.com (claude-code src/utils/toolSearch.ts: a gateway
// "typically" rejects tool_reference blocks) — which would load every MCP tool into context on every
// turn. The relay forwards to api.anthropic.com byte for byte, so the gate's premise does not hold here.
// `true` is the same mode an unset value resolves to on first-party (getToolSearchMode → 'tst'), so this
// puts the child back where it would have been. Only when the operator left it unset: a value they
// chose is theirs.
export const TOOL_SEARCH_VAR = "ENABLE_TOOL_SEARCH"

export type Blocker = {
  varName: string
  // Shown to the operator verbatim, so it names the FIX rather than the rule: they are standing at a
  // prompt that refused to start, and "unset this" is the only sentence that helps.
  remedy: string
}

// A table rather than a chain of ifs, for the reason every per-variant table in this repo is one: a
// new precedence entry in a future Claude Code release is a line added HERE, next to the others, and
// the omission is visible in one screen instead of hidden in control flow.
//
// The VALUE is the remedy, never the rank — an operator cannot act on "outranks you at position 2".
const ENV_BLOCKERS: Record<string, string> = {
  CLAUDE_CODE_USE_BEDROCK: "这台机器配了 Bedrock,它的凭证优先级高于池子租约。跑 `unset CLAUDE_CODE_USE_BEDROCK` 再试。",
  CLAUDE_CODE_USE_VERTEX: "这台机器配了 Vertex,它的凭证优先级高于池子租约。跑 `unset CLAUDE_CODE_USE_VERTEX` 再试。",
  CLAUDE_CODE_USE_FOUNDRY: "这台机器配了 Foundry,它的凭证优先级高于池子租约。跑 `unset CLAUDE_CODE_USE_FOUNDRY` 再试。",
  ANTHROPIC_AUTH_TOKEN: "环境里有 ANTHROPIC_AUTH_TOKEN,它会盖过池子租约。跑 `unset ANTHROPIC_AUTH_TOKEN` 再试。",
  ANTHROPIC_API_KEY: "环境里有 ANTHROPIC_API_KEY,它会盖过池子租约。跑 `unset ANTHROPIC_API_KEY` 再试。",
  ANTHROPIC_BASE_URL: "环境里有 ANTHROPIC_BASE_URL,租来的订阅凭证会被发往那个地址。跑 `unset ANTHROPIC_BASE_URL` 再试。",
}

// EMPTY STRING IS ABSENT. `export ANTHROPIC_API_KEY=` leaves the name defined with an empty value,
// which Claude Code does not treat as a credential — refusing on it would block a launch for a
// variable that changes nothing, and operators do leave these lying around in shell profiles.
//
// OUR OWN RELAY IS NOT A BLOCKER. Under the full takeover (make setup) the launcher runs for every
// process Claude Code spawns, nested ones included, and those inherit the base URL the outer launcher
// set — the relay's. Refusing it would make every nested self-spawn fail.
export function envBlockers(env: NodeJS.ProcessEnv, ownRelayUrl?: string): Blocker[] {
  const found: Blocker[] = []
  for (const [varName, remedy] of Object.entries(ENV_BLOCKERS)) {
    const value = env[varName]
    if (varName === RELAY_URL_VAR && ownRelayUrl !== undefined && value === ownRelayUrl) continue
    if (typeof value === "string" && value.length > 0) found.push({ varName, remedy })
  }
  return found
}

// apiKeyHelper is a SETTINGS key, so it cannot be seen in the environment — and it outranks us. It is
// also, per issue #83, structurally unable to carry a subscription token at all: Claude Code drops the
// `oauth-2025-04-20` beta flag on that lane and the server answers 401. So a machine configured with
// one is not merely out-prioritised, it is configured for a lane our credential cannot work on.
//
// Takes the PARSED settings object, not a path: reading and locating settings files is IO the caller
// owns, and this module stays a pure function of what it was handed.
export function settingsBlockers(settings: unknown): Blocker[] {
  if (typeof settings !== "object" || settings === null) return []
  const helper = (settings as Record<string, unknown>).apiKeyHelper
  if (typeof helper !== "string" || helper.length === 0) return []
  return [
    {
      varName: "apiKeyHelper",
      remedy:
        "settings.json 里配了 apiKeyHelper,它的优先级高于池子租约,而且那条车道不带 oauth-2025-04-20、服务端会 401。" +
        "把它从 settings.json 里去掉再试。",
    },
  ]
}

export type ChildEnvInput = {
  env: NodeJS.ProcessEnv
  // 启动时的共享租约。它在子进程里会冻结(issue #83),但无所谓:发往 relay 的每个请求都会被换成
  // 当前那枚。它仍然必须是真凭证 —— claude 有一批请求不走 base URL、直连 api.anthropic.com
  // (profile、usage、bootstrap 之类),给假值会让它们从第一秒起全部 401。空串用于启动前那次空跑。
  access: string
  // 本机 relay 的地址。环境里已有的同一个地址不算"操作者自己设的"(见 envBlockers)。
  relayUrl?: string
  // 是否置自我调用哨兵。claude-pool 启动器置(防别名递归);make setup 装的进程启动器不置 ——
  // 它按契约会被 Claude Code 嵌套调用,嵌套正是它的常态。
  sentinel?: boolean
  // Parsed contents of the settings file that applies to the child, or undefined when the caller
  // could not read one. UNDEFINED IS NOT "CLEAN": it means unknown, and the caller says so — this
  // module only reports what it was shown.
  settings?: unknown
}

export type ChildEnvOutcome =
  | { ok: true; env: NodeJS.ProcessEnv }
  | { ok: false; blockers: Blocker[] }

// The child's environment is the parent's PLUS the lease and the relay — not a curated allowlist. A `claude` started
// with a scrubbed environment loses the operator's PATH, editor, proxy and terminal settings, and every
// hand-written hook and MCP server that reads them. The pool's business is the credential; everything
// else on that command line is theirs.
export function buildChildEnv(input: ChildEnvInput): ChildEnvOutcome {
  const blockers = [...envBlockers(input.env, input.relayUrl), ...settingsBlockers(input.settings)]
  if (blockers.length > 0) return { ok: false, blockers }
  return {
    ok: true,
    env: {
      ...input.env,
      [CLAUDE_CODE_TOKEN_VAR]: input.access,
      ...(input.sentinel === false ? {} : { [POOL_SESSION_SENTINEL]: "1" }),
      ...(input.relayUrl === undefined ? {} : { [RELAY_URL_VAR]: input.relayUrl }),
      ...(input.env[TOOL_SEARCH_VAR] ? {} : { [TOOL_SEARCH_VAR]: "true" }),
    },
  }
}

// Which provider's credentials this lane can carry. Stated as a typed constant rather than left
// implicit because the pool holds ChatGPT accounts too, and `claude` cannot use one: a lease request
// that ever reached the OpenAI half of the pool would hand this launcher a token the child would 401 on.
export const CLAUDE_CODE_PROVIDER: ProviderId = "anthropic"
