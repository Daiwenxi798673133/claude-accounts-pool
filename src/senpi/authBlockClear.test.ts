import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { initLogger } from "../logger.ts"
import {
  auditSlotBlocks,
  blockClearScope,
  clearEnvSlotBlock,
  describeCandidates,
  senpiAuthPath,
  withoutSlotBlock,
} from "./authBlockClear.ts"

const PROVIDER = "claude-sdk-oauth"

// A realistic auth.json: the pool's env slot lives in `slotState`, senpi's own login accounts in
// `accounts[]`, and a sibling provider (openai) must survive any mutation untouched.
function authFile(slotState: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}): string {
  const cred: Record<string, unknown> = {
    type: "oauth",
    access: "access-default",
    refresh: "refresh-default",
    expires: 1_800_000_000_000,
    accounts: [{ name: "default", source: "login", access: "a", refresh: "r", expires: 1_800_000_000_000 }],
    ...extra,
  }
  if (slotState !== undefined) cred.slotState = slotState
  return JSON.stringify({ [PROVIDER]: cred, openai: { type: "oauth", access: "o", refresh: "or", expires: 1 } }, null, 2)
}

function sandbox(): { dir: string; env: NodeJS.ProcessEnv; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "cap-auth-block-"))
  return { dir, env: { SENPI_CODING_AGENT_DIR: dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

// ── senpiAuthPath ──────────────────────────────────────────────────────────────────────────────

// The env dir wins unconditionally in senpi's resolveAgentDir, and omo exports it into the
// extension's own environment; SENPI_ over OMO_ mirrors leaseCache's own precedence.
test("senpiAuthPath prefers SENPI over OMO, and is undefined outside omo", () => {
  expect(senpiAuthPath({ SENPI_CODING_AGENT_DIR: "/a", OMO_CODING_AGENT_DIR: "/b" })).toBe(join("/a", "auth.json"))
  expect(senpiAuthPath({ OMO_CODING_AGENT_DIR: "/b" })).toBe(join("/b", "auth.json"))
  expect(senpiAuthPath({})).toBeUndefined()
})

// ── withoutSlotBlock (pure) ──────────────────────────────────────────────────────────────────────

test("withoutSlotBlock clears a sticky auth_error and preserves everything else", () => {
  const raw = authFile({ env: { blockReason: "auth_error" }, "env-2": { blockReason: "auth_error" } })
  const out = withoutSlotBlock(raw, "env", "auth-only")
  expect(out).toBeDefined()
  const parsed = JSON.parse(out as string)
  expect(parsed[PROVIDER].slotState).toEqual({ "env-2": { blockReason: "auth_error" } })
  expect(parsed[PROVIDER].accounts).toEqual([
    { name: "default", source: "login", access: "a", refresh: "r", expires: 1_800_000_000_000 },
  ])
  expect(parsed[PROVIDER].access).toBe("access-default")
  expect(parsed[PROVIDER].refresh).toBe("refresh-default")
  expect(parsed.openai).toEqual({ type: "oauth", access: "o", refresh: "or", expires: 1 })
})

// An emptied slotState is deleted rather than left as `"slotState":{}` noise.
test("withoutSlotBlock drops an emptied slotState entirely", () => {
  const parsed = JSON.parse(withoutSlotBlock(authFile({ env: { blockReason: "auth_error" } }), "env", "auth-only") as string)
  expect("slotState" in parsed[PROVIDER]).toBe(false)
})

// A real rate-limit block self-expires via senpi's clearExpiredBlocks — we must NOT strip it, or a
// genuinely throttled account would be hammered.
test("withoutSlotBlock leaves a rate-limit block intact while the account is unchanged", () => {
  const raw = authFile({ env: { blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 } })
  expect(withoutSlotBlock(raw, "env", "auth-only")).toBeUndefined()
})

test("withoutSlotBlock returns undefined when there is nothing to clear", () => {
  expect(withoutSlotBlock(authFile({}), "env", "auth-only")).toBeUndefined()
  expect(withoutSlotBlock(authFile(undefined), "env", "auth-only")).toBeUndefined()
  expect(withoutSlotBlock(JSON.stringify({}), "env", "auth-only")).toBeUndefined()
  expect(withoutSlotBlock(JSON.stringify({ [PROVIDER]: "not-an-object" }), "env", "auth-only")).toBeUndefined()
})

// ── clearEnvSlotBlock (integration: real fs + proper-lockfile) ────────────────────────────────

test("clearEnvSlotBlock removes the persisted env-slot auth_error and keeps credentials", async () => {
  const box = sandbox()
  try {
    const path = join(box.dir, "auth.json")
    writeFileSync(path, authFile({ env: { blockReason: "auth_error" }, "env-2": { blockReason: "auth_error" } }))
    await clearEnvSlotBlock("env", "auth-only", box.env)
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    expect(parsed[PROVIDER].slotState).toEqual({ "env-2": { blockReason: "auth_error" } })
    expect(parsed[PROVIDER].accounts[0].refresh).toBe("r")
    expect(parsed.openai.access).toBe("o")
  } finally {
    box.cleanup()
  }
})

test("clearEnvSlotBlock leaves a rate-limit block untouched", async () => {
  const box = sandbox()
  try {
    const path = join(box.dir, "auth.json")
    const original = authFile({ env: { blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 } })
    writeFileSync(path, original)
    await clearEnvSlotBlock("env", "auth-only", box.env)
    expect(readFileSync(path, "utf-8")).toBe(original)
  } finally {
    box.cleanup()
  }
})

test("clearEnvSlotBlock is a no-op with no agent dir and with a missing file", async () => {
  await clearEnvSlotBlock("env", "auth-only", {})
  const box = sandbox()
  try {
    await clearEnvSlotBlock("env", "auth-only", box.env)
    expect(() => readFileSync(join(box.dir, "auth.json"), "utf-8")).toThrow()
  } finally {
    box.cleanup()
  }
})

test("clearEnvSlotBlock leaves malformed auth.json untouched", async () => {
  const box = sandbox()
  try {
    const path = join(box.dir, "auth.json")
    writeFileSync(path, "not json at all")
    await clearEnvSlotBlock("env", "auth-only", box.env)
    expect(readFileSync(path, "utf-8")).toBe("not json at all")
  } finally {
    box.cleanup()
  }
})

// ── the other half: a rate-limit block that belonged to a REPLACED account ───────────────────────

// THE CASE THIS MODULE ORIGINALLY MISSED, reported from a live session: the operator hit a limit,
// switched account in /usage, and senpi still refused every turn with "All Claude accounts are
// currently blocked" until the block expired. senpi keys the block by SLOT NAME ("env" — see
// accounts.js, where an env slot's account name is that literal string), never by the account behind
// the token, so the pool swapping a fresh account into the slot leaves the dead account's rate-limit
// block sitting on top of it. With `accounts: []` on the provider, one blocked slot IS "all accounts
// blocked" — 11 healthy pool accounts, worker stopped, for up to MAX_RATE_LIMIT_BLOCK_MS (48h).
//
// The account having CHANGED is exactly what makes stripping it safe: the block describes an occupant
// that is no longer there, so clearing it cannot hammer the throttled account.
test("withoutSlotBlock clears a rate-limit block once the account has changed", () => {
  const raw = authFile({ env: { blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 } })
  const cleared = withoutSlotBlock(raw, "env", "account-changed")
  expect(cleared).toBeDefined()
  const parsed = JSON.parse(cleared as string)
  expect("slotState" in parsed[PROVIDER]).toBe(false)
  // Credentials and siblings are untouched — this only ever drops block bookkeeping.
  expect(parsed[PROVIDER].access).toBe("access-default")
  expect(parsed[PROVIDER].accounts[0].refresh).toBe("r")
  expect(parsed.openai.access).toBe("o")
})

// Only OUR slot. A block on a sibling slot describes a different token and is none of this call's
// business, even when the account behind this one changed.
test("withoutSlotBlock touches only the named slot", () => {
  const raw = authFile({
    env: { blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 },
    "env-2": { blockReason: "rate_limit", blockedUntil: 1_800_000_200_000 },
  })
  const parsed = JSON.parse(withoutSlotBlock(raw, "env", "account-changed") as string)
  expect(parsed[PROVIDER].slotState).toEqual({ "env-2": { blockReason: "rate_limit", blockedUntil: 1_800_000_200_000 } })
})

// A slot with no block at all still writes nothing, so the steady-state publish never contends the
// lock on a file a live senpi is also writing.
test("withoutSlotBlock writes nothing when the changed account inherited no block", () => {
  expect(withoutSlotBlock(authFile({}), "env", "account-changed")).toBeUndefined()
  expect(withoutSlotBlock(authFile(undefined), "env", "account-changed")).toBeUndefined()
})

test("clearEnvSlotBlock clears a replaced account's rate-limit block on disk", async () => {
  const box = sandbox()
  try {
    const path = join(box.dir, "auth.json")
    writeFileSync(path, authFile({ env: { blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 } }))
    await clearEnvSlotBlock("env", "account-changed", box.env)
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    expect("slotState" in parsed[PROVIDER]).toBe(false)
    expect(parsed[PROVIDER].refresh).toBe("refresh-default")
  } finally {
    box.cleanup()
  }
})

// ── blockClearScope: which scope a publish has earned ────────────────────────────────────────────

// A renewal in place. The account did not move, so a rate-limit block on the slot is that account's
// and still REAL — clearing it would hammer a throttled account once per turn.
test("blockClearScope holds a renewal in place at auth-only", () => {
  expect(blockClearScope("acct-a", "acct-a")).toBe("auth-only")
})

// THE REGRESSION THIS FUNCTION EXISTS FOR, and the reason the previous account is passed in rather
// than looked up. Following another host's switch republishes an account read straight out of the
// shared lease cache, so a decision that compared against that cache found it "unchanged" and
// degraded to auth-only — leaving the throttled previous occupant's block standing over the healthy
// account just adopted, which with `accounts: []` is senpi's "All Claude accounts are currently
// blocked" for every session on the machine. Only what THIS process published can answer it.
test("blockClearScope reports a swap when the published account is replaced", () => {
  expect(blockClearScope("acct-throttled", "acct-healthy")).toBe("account-changed")
})

// A cold start with no warm cache: nothing was published here, so there is no evidence any persisted
// block describes what was just leased.
test("blockClearScope treats no previous publish as a swap", () => {
  expect(blockClearScope(undefined, "acct-a")).toBe("account-changed")
})

// ── describeCandidates ───────────────────────────────────────────────────────────────────────────

// senpi's own order, because a reader comparing this record against its selectAccount must not have
// to reconcile two orderings: stored accounts first, then env slots (listAccounts).
test("describeCandidates reports both halves of the table with their block state", () => {
  const raw = authFile({ env: { blockReason: "auth_error" } })
  expect(describeCandidates(raw, ["env", "env-2"])).toEqual([
    { name: "default", source: "stored" },
    { name: "env", source: "env", blockReason: "auth_error" },
    { name: "env-2", source: "env" },
  ])
})

// The accounts[] shape, which is where senpi's persistBlock puts a NON-env account's block. Reported
// so a stored login failure is legible, never so it can be cleared.
test("describeCandidates reports a stored account's own block", () => {
  const raw = authFile(undefined, {
    accounts: [
      { name: "default", source: "login", blockReason: "auth_error" },
      { name: "second", source: "login", blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 },
    ],
  })
  expect(describeCandidates(raw, [])).toEqual([
    { name: "default", source: "stored", blockReason: "auth_error" },
    { name: "second", source: "stored", blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 },
  ])
})

test("describeCandidates reports an empty table rather than throwing on an unusable file", () => {
  expect(describeCandidates(JSON.stringify({}), ["env"])).toEqual([])
  expect(describeCandidates(JSON.stringify({ [PROVIDER]: "not-an-object" }), ["env"])).toEqual([])
  expect(describeCandidates(authFile(undefined, { accounts: "not-an-array" }), [])).toEqual([])
})

// ── auditSlotBlocks ──────────────────────────────────────────────────────────────────────────────

// THE STALL THIS EXISTS TO BOUND. A publish clears the slot's sticky auth_error, but a publish only
// happens on renewal — hours away. Landing mid-session, the block sidelines the slot until then, and
// with no stored account one sidelined slot IS "all accounts blocked".
test("auditSlotBlocks clears our slot's sticky auth_error and records the table", async () => {
  const box = sandbox()
  type Entry = { message: string; extra?: Record<string, unknown> }
  const entries: Entry[] = []
  try {
    initLogger({ app: { log: (payload: Entry) => entries.push(payload) } })
    const path = join(box.dir, "auth.json")
    writeFileSync(path, authFile({ env: { blockReason: "auth_error" } }))

    await auditSlotBlocks(["env"], box.env)

    expect("slotState" in JSON.parse(readFileSync(path, "utf-8"))[PROVIDER]).toBe(false)
    const record = entries.find((entry) => entry.message.includes("senpi:candidates-blocked"))
    expect(record?.extra?.candidates).toEqual([
      { name: "default", source: "stored" },
      { name: "env", source: "env", blockReason: "auth_error" },
    ])
  } finally {
    initLogger(undefined)
    box.cleanup()
  }
})

// A rate limit is REAL while the same account holds the slot, and clearing it would hammer a throttled
// account once per turn. Only the publish path, which knows an account changed, may drop one.
test("auditSlotBlocks leaves a rate-limit block standing", async () => {
  const box = sandbox()
  try {
    const path = join(box.dir, "auth.json")
    const original = authFile({ env: { blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 } })
    writeFileSync(path, original)
    await auditSlotBlocks(["env"], box.env)
    expect(readFileSync(path, "utf-8")).toBe(original)
  } finally {
    box.cleanup()
  }
})

// A stored account's auth_error is a real login failure only `/login` resolves. senpi's persistBlock
// keys on `source`, so this block lives on the accounts[] entry — and stripping it would send every
// turn at a dead account. Reported, never touched.
test("auditSlotBlocks never touches a stored account's block", async () => {
  const box = sandbox()
  try {
    const path = join(box.dir, "auth.json")
    const original = authFile(undefined, { accounts: [{ name: "default", source: "login", blockReason: "auth_error" }] })
    writeFileSync(path, original)
    await auditSlotBlocks(["env"], box.env)
    expect(readFileSync(path, "utf-8")).toBe(original)
  } finally {
    box.cleanup()
  }
})

// The steady state, which is every turn on a healthy worker: nothing blocked, so nothing is written
// and nothing is logged — a per-turn call must not become per-turn noise or per-turn lock contention.
test("auditSlotBlocks is silent when nothing is blocked", async () => {
  const box = sandbox()
  const entries: { message: string }[] = []
  try {
    initLogger({ app: { log: (payload: { message: string }) => entries.push(payload) } })
    const path = join(box.dir, "auth.json")
    const original = authFile({})
    writeFileSync(path, original)
    await auditSlotBlocks(["env"], box.env)
    expect(readFileSync(path, "utf-8")).toBe(original)
    expect(entries).toEqual([])
  } finally {
    initLogger(undefined)
    box.cleanup()
  }
})

test("auditSlotBlocks is a no-op outside omo and with a missing file", async () => {
  expect(await auditSlotBlocks(["env"], {})).toEqual([])
  const box = sandbox()
  try {
    expect(await auditSlotBlocks(["env"], box.env)).toEqual([])
    expect(() => readFileSync(join(box.dir, "auth.json"), "utf-8")).toThrow()
  } finally {
    box.cleanup()
  }
})

// THE LIVELOCK THIS RETURN VALUE BREAKS. An auth_error is senpi reporting a 401, i.e. the ONLY evidence
// this machine gets that a published token is dead — a revoked token has the same bytes and a lease
// horizon still in the future, so nothing else here can tell. Clearing the block alone puts that dead
// token straight back into selection, senpi re-blocks it on the next request, and the pair oscillates
// for the rest of the session. The caller needs these names to invalidate the slots and re-lease.
test("auditSlotBlocks reports the env slots senpi auth-blocked", async () => {
  const box = sandbox()
  try {
    const blocks = { env: { blockReason: "auth_error" }, "env-2": { blockReason: "auth_error" } }
    writeFileSync(join(box.dir, "auth.json"), authFile(blocks))
    expect(await auditSlotBlocks(["env", "env-2"], box.env)).toEqual(["env", "env-2"])
  } finally {
    box.cleanup()
  }
})

// A rate-limit block describes a token that WORKS, so it must not trigger a re-lease: the account is
// throttled rather than revoked, and rotating off it would spend a lease to solve nothing.
test("auditSlotBlocks reports no slot for a rate-limit block", async () => {
  const box = sandbox()
  try {
    const blocks = { env: { blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 } }
    writeFileSync(join(box.dir, "auth.json"), authFile(blocks))
    expect(await auditSlotBlocks(["env"], box.env)).toEqual([])
  } finally {
    box.cleanup()
  }
})

// A stored account's auth_error is a real login failure only `/login` can fix. Reporting it would have
// this worker invalidate and re-lease its OWN healthy slot on behalf of somebody else's broken account.
test("auditSlotBlocks reports no slot for a stored account's auth_error", async () => {
  const box = sandbox()
  try {
    const stored = { accounts: [{ name: "default", source: "login", blockReason: "auth_error" }] }
    writeFileSync(join(box.dir, "auth.json"), authFile(undefined, stored))
    expect(await auditSlotBlocks(["env"], box.env)).toEqual([])
  } finally {
    box.cleanup()
  }
})

// senpi 把 429 的报文全丢了,只留 blockReason。探针是这台机器唯一能拿回 unified 头的地方——
// 没有它,"配额打满"和"请求被限流器挡下"在日志里长得一模一样。
// 阻塞期间每轮 turn_start 都会走到这里,所以同一次阻塞必须只探一枪,否则就是对着限流中的账号连打。
test("auditSlotBlocks 对 rate_limit 块取证一次,同一次阻塞不重复探", async () => {
  const box = sandbox()
  box.env.CLAUDE_CODE_OAUTH_TOKEN = "leased-token"
  type Entry = { message: string; extra?: Record<string, unknown> }
  const calls: string[] = []
  const fetchImpl = ((_url: string, init: RequestInit) => {
    calls.push(String(init.body))
    return Promise.resolve(new Response("{}", { status: 429, headers: { "anthropic-ratelimit-unified-status": "rejected" } }))
  }) as unknown as typeof fetch
  let resolveProbe: (entry: Entry) => void
  const probed = new Promise<Entry>((resolve) => {
    resolveProbe = resolve
  })
  try {
    initLogger({
      app: {
        log: (payload: Entry) => {
          if (payload.message.includes("senpi:ratelimit-probe")) resolveProbe(payload)
        },
      },
    })
    const blocks = { env: { blockReason: "rate_limit", blockedUntil: 1_800_000_777_000 } }
    writeFileSync(join(box.dir, "auth.json"), authFile(blocks))

    await auditSlotBlocks(["env"], box.env, fetchImpl)
    await auditSlotBlocks(["env"], box.env, fetchImpl)

    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("You are Claude Code")
    const entry = await probed
    expect(entry.extra).toMatchObject({
      slotName: "env",
      status: 429,
      headers: { "anthropic-ratelimit-unified-status": "rejected" },
    })
  } finally {
    initLogger(undefined)
    box.cleanup()
  }
})
