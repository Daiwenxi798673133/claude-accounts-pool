import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearEnvSlotBlock, senpiAuthPath, withoutSlotBlock } from "./authBlockClear.ts"

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
