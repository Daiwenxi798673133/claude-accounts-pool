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

// THE HOLE THE DRIFT CHECK CANNOT COVER. Anthropic revokes the previously issued access token the
// instant the master refreshes, which leaves this slot remembering a credential every request 401s on:
// identical bytes, so the drift check passes, and an expiry still in the future, so renewalDue() parks
// the keeper for the whole window. senpi's auth_error block is the only local evidence, and this is
// how the path that reads it gets the keeper to lease again.
test("invalidate reads as no credential while the token stays published", async () => {
  const environment = env()
  const slot = createEnvSlot({ env: environment })
  await slot.writeLease({ access: "access-1", expires: 1_800_000_000_000, accountId: "acct-a" })

  slot.invalidate()

  expect(await slot.readAuth()).toBeUndefined()
  // STILL PUBLISHED, and this assertion is the guard rail: senpi synthesises an env slot only while the
  // variable is present, so clearing it would drop the slot out of the candidate table and cost the
  // whole turn ("No API key found") in exchange for a renewal about to happen anyway.
  expect(environment[SENPI_OAUTH_TOKEN_VAR]).toBe("access-1")
})

test("invalidate before any lease leaves a foreign token alone", async () => {
  const environment = env()
  environment[SENPI_OAUTH_TOKEN_VAR] = "somebody-elses-token"
  const slot = createEnvSlot({ env: environment })

  slot.invalidate()

  expect(environment[SENPI_OAUTH_TOKEN_VAR]).toBe("somebody-elses-token")
  expect(await slot.readAuth()).toBeUndefined()
})

// The recovery is invalidate-then-renew, so a publish after an invalidate has to land normally —
// otherwise the path would drop the remembered lease and have no way to replace it.
test("a lease after invalidate republishes and reads back", async () => {
  const environment = env()
  const slot = createEnvSlot({ env: environment })
  await slot.writeLease({ access: "access-1", expires: 1_800_000_000_000, accountId: "acct-a" })
  slot.invalidate()
  await slot.writeLease({ access: "access-2", expires: 1_800_000_900_000, accountId: "acct-a" })

  expect(environment[SENPI_OAUTH_TOKEN_VAR]).toBe("access-2")
  expect(await slot.readAuth()).toEqual({ access: "access-2", expires: 1_800_000_900_000 })
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

// adoptedAt 回答的是"这个账号在槽里待了多久",不是"上次写入是什么时候"。区别是硬的:续租同一个号
// 如果推进它,一个真的被打爆的号每次续租都会给自己续一段宽限,永远熬不到\"该信这个封锁\"的年龄 ——
// 误判守卫就从防活锁变成造活锁。镜像 master 的 adoptedAt(src/master/scheduler.ts)。
test("adoptedAt 记录账号搬进来的时刻，续租同一个号不推进它", async () => {
  let nowMs = 1_000
  const slot = createEnvSlot({ env: env(), now: () => nowMs })

  expect(slot.adoptedAt()).toBeUndefined()

  await slot.writeLease({ access: "t1", expires: 9_000_000, accountId: "a" })
  expect(slot.adoptedAt()).toBe(1_000)

  // 同一个号换了一枚令牌,仍然是同一次入住。
  nowMs = 60_000
  await slot.writeLease({ access: "t2", expires: 9_000_000, accountId: "a" })
  expect(slot.adoptedAt()).toBe(1_000)

  // 换号才是新的入住。
  nowMs = 90_000
  await slot.writeLease({ access: "t3", expires: 9_000_000, accountId: "b" })
  expect(slot.adoptedAt()).toBe(90_000)
})

// 作废只丢凭证,不丢占用者:env 变量里仍然是这个号的令牌,它确实还占着这个槽。而恢复路径每一轮都先
// invalidate 再重新发布,所以忘掉占用者就等于把"重新发布同一个号"当成一次新入住 —— 宽限窗口每轮自我
// 续期,真正被打爆的号永远熬不到"该信这个封锁"的年龄。2026-09-10 实测:同一个号一小时内被作废并重新
// 发布 40 次,期间 29 次把真实的限流封锁当成误判清掉。
test("作废槽位不忘记占用者，重新发布同一个号不推进 adoptedAt", async () => {
  let nowMs = 1_000
  const slot = createEnvSlot({ env: env(), now: () => nowMs })
  await slot.writeLease({ access: "t1", expires: 9_000_000, accountId: "a" })
  expect(slot.adoptedAt()).toBe(1_000)

  slot.invalidate()
  expect(slot.adoptedAt()).toBe(1_000)

  // 恢复路径又拿回同一个号:还是那一次入住。
  nowMs = 20_000
  await slot.writeLease({ access: "t2", expires: 9_000_000, accountId: "a" })
  expect(slot.adoptedAt()).toBe(1_000)

  // 作废之后换成别的号,才是新入住。
  nowMs = 30_000
  await slot.writeLease({ access: "t3", expires: 9_000_000, accountId: "b" })
  expect(slot.adoptedAt()).toBe(30_000)
})
