import { expect, test, afterAll } from "bun:test"
import { fetchProfile, planLabel } from "./profile.ts"

const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})
const stubJson = (body: unknown, status = 200) => {
  globalThis.fetch = (async () => ({ ok: status === 200, status, json: async () => body })) as unknown as typeof fetch
}

// Captured verbatim from a live GET of api.anthropic.com/api/oauth/profile on a Claude Team
// account (uuids stripped). This is the payload the whole mapping was derived from.
const teamPayload = {
  account: {
    uuid: "acct-uuid",
    full_name: "Vince3",
    display_name: "Vince3",
    email: "someone@example.com",
    has_claude_max: false,
    has_claude_pro: false,
  },
  organization: {
    uuid: "org-uuid",
    name: "Example Org",
    organization_type: "claude_team",
    billing_type: "stripe_subscription",
    rate_limit_tier: "default_claude_max_5x",
    seat_tier: "team_tier_1",
    subscription_status: "active",
  },
}

test("P1:真实 Team 抓包 → Team.Premium,且 uuid/email 解析不受影响", () => {
  expect(planLabel({ organizationType: "claude_team", seatTier: "team_tier_1", rateLimitTier: "default_claude_max_5x" })).toBe(
    "Team.Premium",
  )
  expect(planLabel({ organizationType: "claude_team", seatTier: "team_standard" })).toBe("Team.Standard")
})

// THE load-bearing regression test. A Team org and a personal Max account were both observed
// reporting rate_limit_tier=default_claude_max_5x, so deriving a Team's tier from that field
// would print "Team.5x" (or worse, "Team.Premium.5x") for a Premium seat. Team reads seat_tier,
// and ONLY seat_tier.
test("P2:Team 的 rate_limit_tier 绝不泄漏成倍率后缀 —— 该字段与 plan 正交", () => {
  const teamOn5x = { organizationType: "claude_team", seatTier: "team_tier_1", rateLimitTier: "default_claude_max_5x" }
  expect(planLabel(teamOn5x)).toBe("Team.Premium")
  expect(planLabel(teamOn5x)).not.toContain("5x")
  // Same field, same value, DIFFERENT org type ⇒ the suffix is legitimate here and only here.
  expect(planLabel({ organizationType: "claude_max", rateLimitTier: "default_claude_max_5x" })).toBe("Max.5x")
})

test("P3:真实 Max 抓包(5x)与官方 CLI 判定的 20x 都带倍率后缀", () => {
  expect(planLabel({ organizationType: "claude_max", rateLimitTier: "default_claude_max_5x" })).toBe("Max.5x")
  expect(planLabel({ organizationType: "claude_max", rateLimitTier: "default_claude_max_20x" })).toBe("Max.20x")
  // No parseable multiplier ⇒ bare plan, never a fabricated default.
  expect(planLabel({ organizationType: "claude_max" })).toBe("Max")
  expect(planLabel({ organizationType: "claude_max", rateLimitTier: "something_else" })).toBe("Max")
})

test("P4:Pro / Enterprise 只显示计划名,不附加任何倍率", () => {
  expect(planLabel({ organizationType: "claude_pro" })).toBe("Pro")
  // Pro is the one INFERRED org_type value, so it must not acquire a suffix from a field whose
  // Pro-side value nobody has ever captured.
  expect(planLabel({ organizationType: "claude_pro", rateLimitTier: "default_claude_pro_1x" })).toBe("Pro")
  expect(planLabel({ organizationType: "claude_enterprise", rateLimitTier: "default_claude_max_20x" })).toBe("Enterprise")
})

// The honesty guarantee: this endpoint is undocumented, so an unrecognised value must surface
// AS ITSELF rather than be bent into the nearest known plan. That is also how we find out a new
// value exists at all.
test("P5:未知 organization_type 原样透传,绝不编造映射", () => {
  expect(planLabel({ organizationType: "claude_galaxy_brain" })).toBe("claude_galaxy_brain")
  expect(planLabel({ organizationType: "claude_galaxy_brain", rateLimitTier: "default_claude_max_20x" })).toBe(
    "claude_galaxy_brain",
  )
})

// team_tier_2 has no real-world evidence — exactly one OSS project mentions it, labelled with a
// literal restatement rather than a brand name. It must NOT be guessed as "Standard"/"Premium".
test("P6:未知 seat_tier 原样透传在 Team 之后,不猜品牌名", () => {
  expect(planLabel({ organizationType: "claude_team", seatTier: "team_tier_2" })).toBe("Team.team_tier_2")
  // Team with no seat at all is still honestly a Team.
  expect(planLabel({ organizationType: "claude_team" })).toBe("Team")
})

test("P7:无 subscription / 空对象 / 无 organizationType → 无 badge(undefined)", () => {
  expect(planLabel(undefined)).toBeUndefined()
  expect(planLabel({})).toBeUndefined()
  expect(planLabel({ seatTier: "team_tier_1", rateLimitTier: "default_claude_max_5x" })).toBeUndefined()
})

test("P8:fetchProfile 从真实 payload 抽出 subscription,并保持既有 uuid/email 行为", async () => {
  stubJson(teamPayload)
  const profile = await fetchProfile("tok")
  expect(profile.uuid).toBe("acct-uuid")
  expect(profile.email).toBe("someone@example.com")
  expect(profile.subscription).toEqual({
    organizationType: "claude_team",
    seatTier: "team_tier_1",
    rateLimitTier: "default_claude_max_5x",
  })
  expect(planLabel(profile.subscription)).toBe("Team.Premium")
})

// `{}` is a DISTINCT state from absent (see StoredAccount.subscription): it records that the
// lookup happened and found nothing, which is what stops the backfill from retrying forever.
test("P9:organization 缺失 / 非对象 → subscription 为 {} 而非抛错,fetchProfile 仍成功", async () => {
  stubJson({ account: { uuid: "u", email: "e@x.com" } })
  const noOrg = await fetchProfile("tok")
  expect(noOrg.subscription).toEqual({})
  expect(planLabel(noOrg.subscription)).toBeUndefined()

  stubJson({ account: { uuid: "u", email: "e@x.com" }, organization: "not-an-object" })
  expect((await fetchProfile("tok")).subscription).toEqual({})

  stubJson({ account: { uuid: "u", email: "e@x.com" }, organization: null })
  expect((await fetchProfile("tok")).subscription).toEqual({})
})

test("P10:organization 字段类型不对(数字/空串)→ 该字段视为缺失,不写入垃圾值", async () => {
  stubJson({ account: { uuid: "u", email: "e@x.com" }, organization: { organization_type: 42, seat_tier: "" } })
  const profile = await fetchProfile("tok")
  expect(profile.subscription).toEqual({})
  expect(planLabel(profile.subscription)).toBeUndefined()
})
