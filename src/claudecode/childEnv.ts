// The credential seam for the Claude Code lane: what environment a leased `claude` child gets.
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
// ANTHROPIC_BASE_URL is refused for a different reason: it does not outrank us, it REDIRECTS us. A
// leased subscription token sent to a third-party gateway is a credential handed to whoever runs that
// gateway — worse than billing to the wrong account, and equally silent.
//
// WE DO NOT TOUCH THE OPERATOR'S LOGIN. Injection is per-child-process, so ~/.claude/.credentials.json
// (and the macOS Keychain entry) is never read, written, or shadowed on disk: drop the variable and
// the next hand-typed `claude` is back on their own account. Writing that file instead would make this
// machine a second refresher of a chain the master owns (INV-CLOUD-1) — the one shape this lane must
// never take, however convenient a mid-session renewal would be.
import type { ProviderId } from "../accounts.ts"

/** The variable Claude Code reads for a subscription OAuth credential (precedence rank 5). */
export const CLAUDE_CODE_TOKEN_VAR = "CLAUDE_CODE_OAUTH_TOKEN"

// Set on every child we start, and refused when already present on the way in. Operators WILL alias
// `claude` to this launcher — that is the whole point of it — and PATH resolution would then make the
// launcher spawn itself forever, each generation holding a lease it never uses. One booked account per
// fork, until the machine runs out of processes. The sentinel is what turns that into one sentence.
export const POOL_SESSION_SENTINEL = "CLAUDE_ACCOUNTS_POOL_SESSION"

// 本次会话租到的账号 id,交给 StopFailure 钩子用。必须走环境,因为钩子报文里【没有】账号信息
// (官方 schema 只有 session_id / error_type / error_message),而钩子是另一个进程,拿不到启动器的内存。
export const POOL_ACCOUNT_VAR = "CLAUDE_ACCOUNTS_POOL_ACCOUNT"

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
export function envBlockers(env: NodeJS.ProcessEnv): Blocker[] {
  const found: Blocker[] = []
  for (const [varName, remedy] of Object.entries(ENV_BLOCKERS)) {
    const value = env[varName]
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
  access: string
  // 本次租约的账号 id。空串用于启动前那次不带凭证的空跑(守卫检查),此时不写这个变量。
  accountId?: string
  // Parsed contents of the settings file that applies to the child, or undefined when the caller
  // could not read one. UNDEFINED IS NOT "CLEAN": it means unknown, and the caller says so — this
  // module only reports what it was shown.
  settings?: unknown
}

export type ChildEnvOutcome =
  | { ok: true; env: NodeJS.ProcessEnv }
  | { ok: false; blockers: Blocker[] }

// The child's environment is the parent's PLUS the lease — not a curated allowlist. A `claude` started
// with a scrubbed environment loses the operator's PATH, editor, proxy and terminal settings, and every
// hand-written hook and MCP server that reads them. The pool's business is the credential; everything
// else on that command line is theirs.
export function buildChildEnv(input: ChildEnvInput): ChildEnvOutcome {
  const blockers = [...envBlockers(input.env), ...settingsBlockers(input.settings)]
  if (blockers.length > 0) return { ok: false, blockers }
  return {
    ok: true,
    env: {
      ...input.env,
      [CLAUDE_CODE_TOKEN_VAR]: input.access,
      [POOL_SESSION_SENTINEL]: "1",
      ...(input.accountId === undefined || input.accountId.length === 0 ? {} : { [POOL_ACCOUNT_VAR]: input.accountId }),
    },
  }
}

// Which provider's credentials this lane can carry. Stated as a typed constant rather than left
// implicit because the pool holds ChatGPT accounts too, and `claude` cannot use one: a lease request
// that ever reached the OpenAI half of the pool would hand this launcher a token the child would 401 on.
export const CLAUDE_CODE_PROVIDER: ProviderId = "anthropic"
