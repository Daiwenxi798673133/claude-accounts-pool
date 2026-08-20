import { expect, test } from "bun:test"
import {
  createEnvSlot,
  parseSlotCount,
  SENPI_MAX_ENV_SLOTS,
  SENPI_OAUTH_TOKEN_VAR,
  senpiEnvSlot,
} from "./envSlot.ts"

// A plain object, never process.env: writing a token into the runner's own environment would leak
// it into every later test file in the same process.
function env(): NodeJS.ProcessEnv {
  return {}
}

test("nothing written yet reads as no credential", async () => {
  // Not `{}` — the keeper's renewalDue() treats a missing access as "lease NOW", and only
  // `undefined` gets it there. A blank snapshot would be indistinguishable from a live lease
  // whose expiry happened to be absent.
  expect(await createEnvSlot({ env: env() }).readAuth()).toBeUndefined()
})

test("a written lease is published to the environment and read back", async () => {
  const environment = env()
  const slot = createEnvSlot({ env: environment })
  await slot.writeLease({ access: "access-1", expires: 1_800_000_000_000, accountId: "acct-a" })

  // The variable senpi's envSlots() actually reads — the whole point of this module.
  expect(environment[SENPI_OAUTH_TOKEN_VAR]).toBe("access-1")
  expect(await slot.readAuth()).toEqual({ access: "access-1", expires: 1_800_000_000_000 })
})

test("a lease replaces its predecessor rather than accumulating", async () => {
  const environment = env()
  const slot = createEnvSlot({ env: environment })
  await slot.writeLease({ access: "access-1", expires: 1_800_000_000_000, accountId: "acct-a" })
  await slot.writeLease({ access: "access-2", expires: 1_800_000_900_000, accountId: "acct-b" })

  expect(environment[SENPI_OAUTH_TOKEN_VAR]).toBe("access-2")
  expect(await slot.readAuth()).toEqual({ access: "access-2", expires: 1_800_000_900_000 })
})

// THE REASON readAuth CROSS-CHECKS. The expiry lives in the closure while the token lives in the
// environment, so a foreign writer can leave the two describing different credentials. Reporting
// the remembered expiry for a token we no longer own would park the keeper for a whole renewal
// window on behalf of a credential senpi will never send.
test("a token replaced under us reads as no credential", async () => {
  const environment = env()
  const slot = createEnvSlot({ env: environment })
  await slot.writeLease({ access: "access-1", expires: 1_800_000_000_000, accountId: "acct-a" })

  environment[SENPI_OAUTH_TOKEN_VAR] = "someone-elses-token"
  expect(await slot.readAuth()).toBeUndefined()
})

test("a cleared token reads as no credential", async () => {
  const environment = env()
  const slot = createEnvSlot({ env: environment })
  await slot.writeLease({ access: "access-1", expires: 1_800_000_000_000, accountId: "acct-a" })

  delete environment[SENPI_OAUTH_TOKEN_VAR]
  expect(await slot.readAuth()).toBeUndefined()
})

test("a custom variable name is honoured and the default is left alone", async () => {
  // senpi's numbered slots (CLAUDE_CODE_OAUTH_TOKEN_2 … _16) are what a later multi-account lease
  // will target, so the name has to be a parameter rather than a constant baked into the writer.
  const environment = env()
  const slot = createEnvSlot({ env: environment, varName: "CLAUDE_CODE_OAUTH_TOKEN_2" })
  await slot.writeLease({ access: "access-2", expires: 1_800_000_000_000, accountId: "acct-b" })

  expect(environment["CLAUDE_CODE_OAUTH_TOKEN_2"]).toBe("access-2")
  expect(environment[SENPI_OAUTH_TOKEN_VAR]).toBeUndefined()
})

// The naming senpi's own envSlots() synthesises. Pinned here because the roster keys its claims by
// slotName while the writer publishes by varName: if these two ever disagreed, an account would be
// booked under a slot whose token lives in a different variable.
test("senpiEnvSlot mirrors senpi's own slot naming", () => {
  expect(senpiEnvSlot(0)).toEqual({ slotName: "env", varName: "CLAUDE_CODE_OAUTH_TOKEN" })
  expect(senpiEnvSlot(1)).toEqual({ slotName: "env-2", varName: "CLAUDE_CODE_OAUTH_TOKEN_2" })
  expect(senpiEnvSlot(SENPI_MAX_ENV_SLOTS - 1)).toEqual({
    slotName: "env-16",
    varName: "CLAUDE_CODE_OAUTH_TOKEN_16",
  })
})

// Throws rather than clamping HERE, unlike parseSlotCount: a caller asking for slot 16 has already
// lost count, and silently handing back slot 15 would publish two slots into one variable.
test("senpiEnvSlot refuses an index senpi would not read", () => {
  expect(() => senpiEnvSlot(SENPI_MAX_ENV_SLOTS)).toThrow()
  expect(() => senpiEnvSlot(-1)).toThrow()
  expect(() => senpiEnvSlot(1.5)).toThrow()
})

test("parseSlotCount defaults to one slot and clamps to senpi's ceiling", () => {
  expect(parseSlotCount(undefined)).toBe(1)
  expect(parseSlotCount("4")).toBe(4)
  // Above senpi's ceiling: clamped, because slots past it hold leases nothing selects.
  expect(parseSlotCount("99")).toBe(SENPI_MAX_ENV_SLOTS)
  // Junk, a negative and a fraction all read as the single-slot default rather than aborting the
  // worker — an unreadable count must not stop a machine from leasing at all.
  for (const raw of ["", "abc", "0", "-3", "2.5"]) expect(parseSlotCount(raw)).toBe(1)
})
