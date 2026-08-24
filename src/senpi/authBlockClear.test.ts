import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { clearEnvSlotAuthBlock, senpiAuthPath, withoutAuthBlock } from "./authBlockClear.ts"

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

// ── withoutAuthBlock (pure) ──────────────────────────────────────────────────────────────────────

test("withoutAuthBlock clears a sticky auth_error and preserves everything else", () => {
  const raw = authFile({ env: { blockReason: "auth_error" }, "env-2": { blockReason: "auth_error" } })
  const out = withoutAuthBlock(raw, "env")
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
test("withoutAuthBlock drops an emptied slotState entirely", () => {
  const parsed = JSON.parse(withoutAuthBlock(authFile({ env: { blockReason: "auth_error" } }), "env") as string)
  expect("slotState" in parsed[PROVIDER]).toBe(false)
})

// A real rate-limit block self-expires via senpi's clearExpiredBlocks — we must NOT strip it, or a
// genuinely throttled account would be hammered.
test("withoutAuthBlock leaves a rate-limit block intact", () => {
  const raw = authFile({ env: { blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 } })
  expect(withoutAuthBlock(raw, "env")).toBeUndefined()
})

test("withoutAuthBlock returns undefined when there is nothing to clear", () => {
  expect(withoutAuthBlock(authFile({}), "env")).toBeUndefined()
  expect(withoutAuthBlock(authFile(undefined), "env")).toBeUndefined()
  expect(withoutAuthBlock(JSON.stringify({}), "env")).toBeUndefined()
  expect(withoutAuthBlock(JSON.stringify({ [PROVIDER]: "not-an-object" }), "env")).toBeUndefined()
})

// ── clearEnvSlotAuthBlock (integration: real fs + proper-lockfile) ────────────────────────────────

test("clearEnvSlotAuthBlock removes the persisted env-slot auth_error and keeps credentials", async () => {
  const box = sandbox()
  try {
    const path = join(box.dir, "auth.json")
    writeFileSync(path, authFile({ env: { blockReason: "auth_error" }, "env-2": { blockReason: "auth_error" } }))
    await clearEnvSlotAuthBlock("env", box.env)
    const parsed = JSON.parse(readFileSync(path, "utf-8"))
    expect(parsed[PROVIDER].slotState).toEqual({ "env-2": { blockReason: "auth_error" } })
    expect(parsed[PROVIDER].accounts[0].refresh).toBe("r")
    expect(parsed.openai.access).toBe("o")
  } finally {
    box.cleanup()
  }
})

test("clearEnvSlotAuthBlock leaves a rate-limit block untouched", async () => {
  const box = sandbox()
  try {
    const path = join(box.dir, "auth.json")
    const original = authFile({ env: { blockReason: "rate_limit", blockedUntil: 1_800_000_100_000 } })
    writeFileSync(path, original)
    await clearEnvSlotAuthBlock("env", box.env)
    expect(readFileSync(path, "utf-8")).toBe(original)
  } finally {
    box.cleanup()
  }
})

test("clearEnvSlotAuthBlock is a no-op with no agent dir and with a missing file", async () => {
  await clearEnvSlotAuthBlock("env", {})
  const box = sandbox()
  try {
    await clearEnvSlotAuthBlock("env", box.env)
    expect(() => readFileSync(join(box.dir, "auth.json"), "utf-8")).toThrow()
  } finally {
    box.cleanup()
  }
})

test("clearEnvSlotAuthBlock leaves malformed auth.json untouched", async () => {
  const box = sandbox()
  try {
    const path = join(box.dir, "auth.json")
    writeFileSync(path, "not json at all")
    await clearEnvSlotAuthBlock("env", box.env)
    expect(readFileSync(path, "utf-8")).toBe("not json at all")
  } finally {
    box.cleanup()
  }
})
