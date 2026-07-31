import { expect, test } from "bun:test"
import { latestMaxedReset, PROVIDER_IDS, PROVIDERS, scoreWindows, toProviderId, type NormalizedWindow, type RetryErrorLike } from "./providers.ts"
import type { OpenaiUsage } from "./openai-usage.ts"
import type { UsageResponse } from "./usage.ts"

// providers.ts imports ONLY types (verbatimModuleSyntax erases them), so it links no runtime
// module and is immune to the process-global mock.module stubs autoswitch.test.ts installs
// (see usage.test.ts's header). Fixtures below therefore import types only, too.

const NOW = Date.parse("2026-07-30T00:00:00.000Z")
const at = (ms: number) => new Date(NOW + ms).toISOString()

// ============================================================================================
// FROZEN PRE-REFACTOR ORACLE. Copied VERBATIM from autoswitch.ts at commit d6ec99d — the last
// commit before the NormalizedWindow refactor — and deliberately NOT shared with the shipped
// implementation. Its whole value is being a second, independent witness: if it is ever "kept in
// sync" with providers.ts the equivalence claim in V1/V2 becomes a tautology and is void.
// Only adaptation: the inline block read `const now = Date.now()` once at its top, so `now` is
// passed in instead — same value, same single read.
// ============================================================================================
function legacyScore(usage?: UsageResponse): number {
  if (!usage) return Number.POSITIVE_INFINITY
  return Math.max(
    usage.five_hour?.utilization ?? 0,
    usage.seven_day?.utilization ?? 0,
    usage.seven_day_sonnet?.utilization ?? 0,
    usage.seven_day_opus?.utilization ?? 0,
    ...(usage.scoped?.map((win) => win.utilization) ?? []),
  )
}

function legacyResolve(usage: UsageResponse, now: number): number | undefined {
  const candidates: { util: number; at: number }[] = []
  for (const win of [usage.five_hour, usage.seven_day, usage.seven_day_sonnet, usage.seven_day_opus, ...(usage.scoped ?? [])]) {
    if (!win || win.resets_at === undefined) continue
    const at = Date.parse(win.resets_at)
    if (!Number.isFinite(at) || at <= now) continue
    candidates.push({ util: win.utilization, at })
  }
  if (candidates.length === 0) return undefined
  const maxUtil = Math.max(...candidates.map((c) => c.util))
  if (maxUtil < 100) return undefined
  const tied = candidates.filter((c) => c.util >= maxUtil - 0.5)
  return Math.max(...tied.map((c) => c.at))
}

// Every anthropic usage shape the shipped suite already exercises, plus the null/absent cases the
// merged null-window fix introduced. Keys mirror the test that originally pinned each shape.
const ANTHROPIC_SHAPES: Record<string, UsageResponse> = {
  empty: {},
  "I28-c-five_hour-maxed": { five_hour: { utilization: 100, resets_at: at(200) } },
  "I28-e2-all-null": { five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null },
  "I28-e1-past-reset": { five_hour: { utilization: 100, resets_at: at(-1_000) } },
  "I28-f-two-maxed": { five_hour: { utilization: 100, resets_at: at(100) }, seven_day: { utilization: 100, resets_at: at(300) } },
  "I28-scoped-only-scoped-maxed": {
    five_hour: { utilization: 50, resets_at: at(100) },
    scoped: [{ label: "Fable", utilization: 100, resets_at: at(300) }],
  },
  "I28-scoped-score-scoped-only": { scoped: [{ label: "Fable", utilization: 90, resets_at: at(60_000) }] },
  "I28-h-low-util": { five_hour: { utilization: 20, resets_at: at(5_000) } },
  "X1-zero-util": { five_hour: { utilization: 0, resets_at: at(60_000) } },
  "X1-ninety-util": { five_hour: { utilization: 90, resets_at: at(60_000) } },
  "all-four-plus-scoped": {
    five_hour: { utilization: 10, resets_at: at(1_000) },
    seven_day: { utilization: 20, resets_at: at(2_000) },
    seven_day_sonnet: { utilization: 30, resets_at: at(3_000) },
    seven_day_opus: { utilization: 100, resets_at: at(4_000) },
    scoped: [{ label: "Fable", utilization: 40, resets_at: at(5_000) }],
  },
  "maxed-without-reset": { five_hour: { utilization: 100 }, seven_day: { utilization: 50, resets_at: at(900) } },
  "unparseable-reset": { five_hour: { utilization: 100, resets_at: "not-a-date" } },
  "empty-scoped-array": { five_hour: { utilization: 33, resets_at: at(700) }, scoped: [] },
  "tie-within-half-point": { five_hour: { utilization: 100, resets_at: at(100) }, seven_day: { utilization: 99.7, resets_at: at(500) } },
  "opus-only": { seven_day_opus: { utilization: 100, resets_at: at(800) } },
  "null-mixed-with-maxed-scoped": {
    five_hour: null,
    seven_day: null,
    scoped: [{ label: "Fable", utilization: 100, resets_at: at(1_500) }],
  },
}

test("V1:anthropic 归一化等价 — 每个既有用量形状的 score 与冻结的旧实现逐一相等", () => {
  for (const [name, usage] of Object.entries(ANTHROPIC_SHAPES)) {
    const actual = scoreWindows(PROVIDERS.anthropic.normalize(usage))
    expect(`${name}=${actual}`).toBe(`${name}=${legacyScore(usage)}`)
  }
  // Absent snapshot is the only "unknown" channel, on both sides.
  expect(scoreWindows(undefined)).toBe(legacyScore(undefined))
  expect(scoreWindows(undefined)).toBe(Number.POSITIVE_INFINITY)
  // Spot values, so the pair cannot drift together into being uniformly wrong.
  expect(scoreWindows(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["I28-e2-all-null"]))).toBe(0)
  expect(scoreWindows(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["I28-scoped-score-scoped-only"]))).toBe(90)
  expect(scoreWindows(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["all-four-plus-scoped"]))).toBe(100)
})

test("V2:anthropic 归一化等价 — 每个形状解析出的冷却 reset 与冻结的旧实现逐一相等(含 scoped 与 null 窗口)", () => {
  for (const [name, usage] of Object.entries(ANTHROPIC_SHAPES)) {
    const actual = latestMaxedReset(PROVIDERS.anthropic.normalize(usage), NOW)
    expect(`${name}=${actual}`).toBe(`${name}=${legacyResolve(usage, NOW)}`)
  }
  // Spot values: 顶格取最晚、未顶格诚实返回 undefined。
  expect(latestMaxedReset(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["I28-f-two-maxed"]), NOW)).toBe(NOW + 300)
  expect(latestMaxedReset(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["I28-scoped-only-scoped-maxed"]), NOW)).toBe(NOW + 300)
  expect(latestMaxedReset(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["I28-h-low-util"]), NOW)).toBeUndefined()
  expect(latestMaxedReset(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["I28-e2-all-null"]), NOW)).toBeUndefined()
})

test("V3:null / 缺失窗口被丢弃而非变成 0 用量条目 —— 否则会把 maxUtil 压到 100 以下、把真实 reset 变成未知", () => {
  const labels = PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["all-four-plus-scoped"]).map((win) => win.label)
  expect(labels).toEqual(["five_hour", "seven_day", "seven_day_sonnet", "seven_day_opus", "Fable"])
  // 只有 scoped 顶格、其余为 null:若 null 变成 {utilization:0} 占位,candidates 里就会多出 0 分条目 ——
  // maxUtil 仍是 100(Math.max 不受影响),但 0 分条目没有 resets_at 所以本就不会入选;真正的破坏在
  // 于占位若带上任意 resets_at,tied 过滤会把它算进来。这里锁定"根本不产出占位"。
  expect(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["null-mixed-with-maxed-scoped"])).toEqual([
    { label: "Fable", utilization: 100, resets_at: at(1_500) },
  ])
  expect(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["I28-e2-all-null"])).toEqual([])
  expect(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES.empty)).toEqual([])
})

test("V4:顶格但拿不到 resets_at 的窗口不参与 maxUtil —— 未顶格窗口不会被它拖成一个假 reset", () => {
  const windows = PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["maxed-without-reset"])
  expect(windows).toHaveLength(2)
  // five_hour@100 无 reset ⇒ 被排除;剩下 seven_day@50 < 100 ⇒ 诚实未知。
  expect(latestMaxedReset(windows, NOW)).toBeUndefined()
  expect(latestMaxedReset(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["unparseable-reset"]), NOW)).toBeUndefined()
  expect(latestMaxedReset(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["I28-e1-past-reset"]), NOW)).toBeUndefined()
})

test("V5:0.5 个百分点内并列视为同时顶格 → 取其中最晚的 reset", () => {
  expect(latestMaxedReset(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["tie-within-half-point"]), NOW)).toBe(NOW + 500)
})

// ---- openai 严格检测器 ----

const limitBody = JSON.stringify({ error: { type: "usage_limit_reached", message: "You've hit your usage limit." } })

test("V6:openai isUsageLimit — 裸 429 一律拒绝(可能只是普通瞬时限流,误切会白烧一个号)", () => {
  expect(PROVIDERS.openai.isUsageLimit({ statusCode: 429 })).toBe(false)
  expect(PROVIDERS.openai.isUsageLimit({ statusCode: 429, responseBody: "" })).toBe(false)
  expect(PROVIDERS.openai.isUsageLimit({ statusCode: 429, responseBody: "not json" })).toBe(false)
  // 连限流文案也不认 —— 文本路径是 anthropic 专属,绝不继承。
  expect(PROVIDERS.openai.isUsageLimit({ statusCode: 429, message: "rate limit reached, too many requests" })).toBe(false)
  expect(PROVIDERS.openai.isUsageLimit(undefined)).toBe(false)
})

test("V7:openai isUsageLimit — 429 且 error.type === usage_limit_reached 才命中", () => {
  expect(PROVIDERS.openai.isUsageLimit({ statusCode: 429, responseBody: limitBody })).toBe(true)
})

test("V8:openai isUsageLimit — 429 配其他 error.type 拒绝;该 type 配非 429 也拒绝(两个条件都必需)", () => {
  expect(PROVIDERS.openai.isUsageLimit({ statusCode: 429, responseBody: JSON.stringify({ error: { type: "rate_limit_error" } }) })).toBe(false)
  expect(PROVIDERS.openai.isUsageLimit({ statusCode: 429, responseBody: JSON.stringify({ error: { type: "server_error" } }) })).toBe(false)
  for (const statusCode of [200, 403, 500, 529, undefined]) {
    expect(PROVIDERS.openai.isUsageLimit({ statusCode, responseBody: limitBody })).toBe(false)
  }
})

// 回归锁:两个检测器的严格度必须保持相反。谁把它们合并成一个"共用的 429 判断",这条就红。
test("V9:检测器不对称性 — 同一个裸 429:anthropic 命中,openai 拒绝", () => {
  const bare429: RetryErrorLike = { statusCode: 429 }
  expect(PROVIDERS.anthropic.isUsageLimit(bare429)).toBe(true)
  expect(PROVIDERS.openai.isUsageLimit(bare429)).toBe(false)
})

test("V10:openai parseResetMs — 响应体 error.resets_at 按 Unix 秒换算(×1000)", () => {
  const body = JSON.stringify({ error: { type: "usage_limit_reached", resets_at: 1787903707 } })
  expect(PROVIDERS.openai.parseResetMs({ statusCode: 429, responseBody: body })).toBe(1787903707 * 1000)
})

test("V11:openai parseResetMs — 无响应体时退到 x-codex-*-reset-at 头,两个都在则取最晚", () => {
  expect(PROVIDERS.openai.parseResetMs({ statusCode: 429, responseHeaders: { "x-codex-primary-reset-at": "1787903707" } })).toBe(1787903707 * 1000)
  expect(PROVIDERS.openai.parseResetMs({ statusCode: 429, responseHeaders: { "X-Codex-Secondary-Reset-At": "1788003707" } })).toBe(1788003707 * 1000)
  expect(
    PROVIDERS.openai.parseResetMs({
      statusCode: 429,
      responseHeaders: { "x-codex-primary-reset-at": "1787903707", "x-codex-secondary-reset-at": "1788003707" },
    }),
  ).toBe(1788003707 * 1000)
  // 响应体优先于头。
  expect(
    PROVIDERS.openai.parseResetMs({
      statusCode: 429,
      responseBody: JSON.stringify({ error: { resets_at: 1700000000 } }),
      responseHeaders: { "x-codex-primary-reset-at": "1788003707" },
    }),
  ).toBe(1700000000 * 1000)
})

test("V12:openai parseResetMs — 两个来源都没有 → undefined,绝不编造倒计时(也不认 Retry-After)", () => {
  expect(PROVIDERS.openai.parseResetMs({ statusCode: 429 })).toBeUndefined()
  expect(PROVIDERS.openai.parseResetMs({ statusCode: 429, responseBody: limitBody })).toBeUndefined()
  // ChatGPT 不用标准 Retry-After;认下来就等于凭一个无关头编出一个恢复时刻。
  expect(PROVIDERS.openai.parseResetMs({ statusCode: 429, responseHeaders: { "retry-after": "60" } })).toBeUndefined()
  // 0 / 负数 / 非数字都不是可用时刻。
  for (const value of ["0", "-1", "soon", ""]) {
    expect(PROVIDERS.openai.parseResetMs({ statusCode: 429, responseHeaders: { "x-codex-primary-reset-at": value } })).toBeUndefined()
  }
})

// ---- openai 归一化(动态窗口数) ----

const goPlanUsage: OpenaiUsage = { planType: "go", windows: [{ label: "30d", utilization: 42, resets_at: at(90_000) }] }

test("V13:go 计划只有一个 30d 窗口 → score 就是该窗口用量,reset 也取它(绝不假设有两个窗口)", () => {
  const windows = PROVIDERS.openai.normalize(goPlanUsage)
  expect(windows).toHaveLength(1)
  expect(scoreWindows(windows)).toBe(42)
  expect(latestMaxedReset(windows, NOW)).toBeUndefined()
  const maxed: OpenaiUsage = { planType: "go", windows: [{ label: "30d", utilization: 100, resets_at: at(90_000) }] }
  expect(latestMaxedReset(PROVIDERS.openai.normalize(maxed), NOW)).toBe(NOW + 90_000)
})

test("V14:windows 为空数组 → score 为 0 且有限(不是 NaN、不是 -Infinity);唯一的\"未知\"是压根没有用量快照", () => {
  const empty: OpenaiUsage = { windows: [] }
  const score = scoreWindows(PROVIDERS.openai.normalize(empty))
  expect(Number.isNaN(score)).toBe(false)
  expect(Number.isFinite(score)).toBe(true)
  expect(score).toBe(0)
  // 与 anthropic 全 null 窗口完全同构 —— 两边"有快照但无窗口"都读作 0。
  expect(score).toBe(scoreWindows(PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["I28-e2-all-null"])))
  // 真正的未知走另一条通道:没有快照 ⇒ +Infinity ⇒ 排在所有真实账号之后。
  expect(scoreWindows(undefined)).toBe(Number.POSITIVE_INFINITY)
  expect(latestMaxedReset(PROVIDERS.openai.normalize(empty), NOW)).toBeUndefined()
})

test("V15:provider 表键从表本身派生;toProviderId 只认真实 provider,不认原型链上的属性名", () => {
  expect(PROVIDER_IDS).toEqual(["anthropic", "openai"])
  expect(toProviderId("anthropic")).toBe("anthropic")
  expect(toProviderId("openai")).toBe("openai")
  // `value in PROVIDERS` 会把 toString/constructor 当成合法 provider —— 这里锁定没走那条路。
  for (const junk of ["toString", "constructor", "hasOwnProperty", "__proto__", "Anthropic", "openai ", "", undefined, null, 0]) {
    expect(toProviderId(junk)).toBeUndefined()
  }
})

test("V16:两个 provider 的 ops 都齐全,归一化产物都是 NormalizedWindow 形状", () => {
  for (const id of PROVIDER_IDS) {
    expect(typeof PROVIDERS[id].isUsageLimit).toBe("function")
    expect(typeof PROVIDERS[id].parseResetMs).toBe("function")
    expect(typeof PROVIDERS[id].normalize).toBe("function")
  }
  const all: NormalizedWindow[] = [
    ...PROVIDERS.anthropic.normalize(ANTHROPIC_SHAPES["all-four-plus-scoped"]),
    ...PROVIDERS.openai.normalize(goPlanUsage),
  ]
  for (const win of all) {
    expect(typeof win.label).toBe("string")
    expect(typeof win.utilization).toBe("number")
  }
  expect(all).toHaveLength(6)
})
