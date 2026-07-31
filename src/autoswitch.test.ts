import { expect, test, mock } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

type AccountsState = { accounts: Array<Record<string, unknown>>; activeId?: string }
const defaultAccounts = (): AccountsState => ({
  accounts: [
    { id: "acc1", label: "A" },
    { id: "acc2", label: "B" },
  ],
  activeId: "acc1",
})
let accountsOverride: AccountsState | undefined
// accountsOf comes from the REAL module (snapshotted before the stub is registered, the
// lockfile.test.ts pattern) rather than being re-implemented here: a second copy of the
// "absent provider ⇒ anthropic" rule could drift from the real one, and these tests would
// then lock the copy instead of the shipped behaviour.
const { accountsOf } = await import("./accounts.ts")
// This process-global stub is what every later test file links against (see usage.test.ts
// header), so it must expose every accounts.ts export those files' import graphs touch —
// readAuthOpenai is unused here, but omitting it breaks openai-usage.ts at link time.
mock.module("./accounts.ts", () => ({
  loadAccounts: async () => accountsOverride ?? defaultAccounts(),
  readActiveId: async () => (accountsOverride ?? defaultAccounts()).activeId,
  readAuthOpenai: async () => undefined,
  accountsOf,
}))
const switchCalls: string[] = []
const accountLabel = (id: string) => (id === "acc2" ? "B" : id === "acc3" ? "C" : "A")
const collectOptsLog: Array<{ isSessionRunning?: () => boolean } | undefined> = []
mock.module("./usage.ts", () => ({
  switchToAccount: async (id: string) => {
    switchCalls.push(id)
    return { id, label: accountLabel(id) }
  },
  collectAllUsage: async (opts?: { isSessionRunning?: () => boolean }) => {
    collectOptsLog.push(opts)
    return { results: [] }
  },
}))
const dialogCalls = { exhausted: [] as unknown[][] }
mock.module("./dialogs.tsx", () => ({
  openExhaustedAlert: (...a: unknown[]) => {
    dialogCalls.exhausted.push(a)
  },
}))

const { installAutoSwitch } = await import("./autoswitch.ts")
// Real logger (never stubbed in this file). The decision log is the ONLY observable proving
// detection still runs for a provider whose ACTION is dark, so D2 reads it directly.
const { initLogger } = await import("./logger.ts")

type LogEntry = { message?: string; extra?: Record<string, unknown> }

// initLogger's client is a module global and log.debug additionally requires
// CLAUDE_AUTOSWITCH_DEBUG, so both are installed per-test and restored in a finally.
function captureLogs(): { entries: LogEntry[]; decisions: () => Array<Record<string, unknown> | undefined>; restore: () => void } {
  const entries: LogEntry[] = []
  const had = process.env.CLAUDE_AUTOSWITCH_DEBUG
  process.env.CLAUDE_AUTOSWITCH_DEBUG = "1"
  initLogger({
    app: {
      log: (payload: LogEntry) => {
        entries.push(payload)
        return Promise.resolve()
      },
    },
  })
  return {
    entries,
    decisions: () => entries.filter((entry) => entry.message?.includes("-decision")).map((entry) => entry.extra),
    restore: () => {
      initLogger(undefined)
      if (had === undefined) delete process.env.CLAUDE_AUTOSWITCH_DEBUG
      else process.env.CLAUDE_AUTOSWITCH_DEBUG = had
    },
  }
}

type Toast = { variant?: string; message: string }
type Handler = (event: { id: string; properties: Record<string, unknown> }) => void

// `messages` override models sessions whose provider is not a confirmed anthropic one.
// `cooldownKv` seeds the PERSISTED cooldown snapshot, i.e. cooldowns this process inherited
// from an earlier run rather than observed itself.
function setup(
  failedParts: unknown[],
  opts: { messages?: Array<Record<string, unknown>>; cooldownKv?: Record<string, number> } = {},
) {
  const handlers = new Map<string, Handler>()
  const toasts: Toast[] = []
  const calls = { abort: 0, revert: [] as unknown[], promptAsync: [] as unknown[] }
  // Persisted cooldown snapshot (id → until). The recovery-timing observable that replaced the removed popup.
  const kv: { snapshot: Record<string, number> } = { snapshot: {} }
  const messages = opts.messages ?? [
    { id: "u1", role: "user", parentID: undefined },
    { id: "a1", role: "assistant", parentID: "u1", providerID: "anthropic", modelID: "claude-x", agent: "build", error: undefined },
  ]
  const parts: Record<string, unknown[]> = {
    u1: [{ type: "text", text: "hello", synthetic: false, ignored: false }],
    a1: failedParts,
  }

  const api = {
    event: {
      on: (name: string, cb: Handler) => {
        handlers.set(name, cb)
        return () => handlers.delete(name)
      },
    },
    ui: { toast: (t: Toast) => toasts.push(t), dialog: { open: false } },
    client: {
      app: { log: () => Promise.resolve() },
      session: {
        abort: async () => {
          calls.abort++
          return {}
        },
        revert: async (a: unknown) => {
          calls.revert.push(a)
          return { error: undefined }
        },
        promptAsync: async (a: unknown) => {
          calls.promptAsync.push(a)
          return { error: undefined }
        },
      },
    },
    state: {
      session: {
        messages: () => messages,
        status: () => ({ type: "idle" }),
      },
      part: (id: string) => parts[id] ?? [],
    },
    kv: { get: () => opts.cooldownKv ?? {}, set: (_key: string, value: Record<string, number>) => (kv.snapshot = value) },
  } as unknown as TuiPluginApi

  const controller = installAutoSwitch(api)
  return { handlers, toasts, calls, controller, kv }
}

async function flush(pred: () => boolean): Promise<void> {
  for (let i = 0; i < 500; i++) {
    if (pred()) return
    await new Promise((r) => setTimeout(r, 1))
  }
}

const fireRetry = (handlers: Map<string, Handler>, id: string, sessionID = "s1", message = "rate limit reached") =>
  handlers.get("session.status")?.({
    id,
    properties: { sessionID, status: { type: "retry", message } },
  })

const fireIdle = (handlers: Map<string, Handler>, id: string, sessionID = "s1") =>
  handlers.get("session.idle")?.({ id, properties: { sessionID } })

const fireStatus = (handlers: Map<string, Handler>, type: string, sessionID = "s1", id = `st-${Math.random()}`) =>
  handlers.get("session.status")?.({ id, properties: { sessionID, status: { type } } })

// `data` injects the exact statusCode + responseBody Anthropic returns; defaults (429, no body) keep prior callers intact.
const fireError = (
  handlers: Map<string, Handler>,
  headers: Record<string, string>,
  sessionID = "s1",
  id = `err-${Math.random()}`,
  data: { statusCode?: number; responseBody?: string } = {},
) =>
  handlers.get("session.error")?.({
    id,
    properties: {
      sessionID,
      error: {
        name: "APIError",
        data: { statusCode: data.statusCode ?? 429, responseHeaders: headers, responseBody: data.responseBody },
      },
    },
  })

test("无缝续接:有产出回合 → promptAsync(continue),从不 revert,不弹手动重发提示", async () => {
  const { handlers, toasts, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireRetry(handlers, "evt-output")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.revert.length).toBe(0)
  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(toasts.some((t) => t.message.includes("请手动重新发送") || t.message.includes("请手动重发"))).toBe(false)
  controller.dispose()
})

test("无缝续接:已改文件回合(patch) → 同样 promptAsync(continue),从不 revert,无拒绝提示", async () => {
  const { handlers, toasts, calls, controller } = setup([{ type: "patch" }])
  fireRetry(handlers, "evt-patch")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.revert.length).toBe(0)
  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(toasts.some((t) => t.message.includes("请手动重发") || t.message.includes("未自动回退"))).toBe(false)
  controller.dispose()
})

test("无产出回合(失败 assistant 无 parts) → promptAsync 收到原始 prompt parts(resend),从不 revert", async () => {
  const { handlers, calls, controller } = setup([])
  fireRetry(handlers, "evt-noout")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.revert.length).toBe(0)
  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(true)
  expect(arg.parts.some((p) => p.text === "continue")).toBe(false)
  controller.dispose()
})

test("force-limit 钩子:env 未设 → 正常回合 idle 不触发任何切号/注入", async () => {
  delete process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireIdle(handlers, "idle-noop")
  await flush(() => false)

  expect(switchCalls.length).toBe(0)
  expect(calls.revert.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)
  controller.dispose()
})

test("force-limit 钩子:env 设 → idle 一次性注入 → continue/resend(从不 revert),二次 idle 不再触发", async () => {
  process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE = "1"
  switchCalls.length = 0
  try {
    const { handlers, toasts, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireIdle(handlers, "idle-arm")
    await flush(() => calls.promptAsync.length > 0)

    expect(switchCalls).toEqual(["acc2"])
    expect(calls.revert.length).toBe(0)
    expect(calls.promptAsync.length).toBe(1)
    const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
    expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
    expect(toasts.some((t) => t.message.includes("请手动重新发送") || t.message.includes("请手动重发"))).toBe(false)

    const promptedOnce = calls.promptAsync.length
    fireIdle(handlers, "idle-rearm")
    await flush(() => false)
    expect(calls.promptAsync.length).toBe(promptedOnce)
    controller.dispose()
  } finally {
    delete process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE
  }
})

function setupMultiStepParts(a1Parts: unknown[], a2Parts: unknown[]) {
  const handlers = new Map<string, Handler>()
  const toasts: Toast[] = []
  const calls = { abort: 0, revert: [] as unknown[], promptAsync: [] as unknown[] }
  const messages = [
    { id: "u1", role: "user", parentID: undefined },
    { id: "a1", role: "assistant", parentID: "u1", providerID: "anthropic", modelID: "claude-x", agent: "build", error: undefined },
    { id: "a2", role: "assistant", parentID: "u1", providerID: "anthropic", modelID: "claude-x", agent: "build", error: undefined },
  ]
  const parts: Record<string, unknown[]> = {
    u1: [{ type: "text", text: "hello", synthetic: false, ignored: false }],
    a1: a1Parts,
    a2: a2Parts,
  }

  const api = {
    event: {
      on: (name: string, cb: Handler) => {
        handlers.set(name, cb)
        return () => handlers.delete(name)
      },
    },
    ui: { toast: (t: Toast) => toasts.push(t), dialog: { open: false } },
    client: {
      app: { log: () => Promise.resolve() },
      session: {
        abort: async () => {
          calls.abort++
          return {}
        },
        revert: async (a: unknown) => {
          calls.revert.push(a)
          return { error: undefined }
        },
        promptAsync: async (a: unknown) => {
          calls.promptAsync.push(a)
          return { error: undefined }
        },
      },
    },
    state: {
      session: {
        messages: () => messages,
        status: () => ({ type: "idle" }),
      },
      part: (id: string) => parts[id] ?? [],
    },
    kv: { get: () => ({}), set: () => {} },
  } as unknown as TuiPluginApi

  const controller = installAutoSwitch(api)
  return { handlers, toasts, calls, controller }
}

function setupMultiStep(lastAssistantParts: unknown[]) {
  return setupMultiStepParts([{ type: "tool", tool: "read", state: { status: "completed" } }], lastAssistantParts)
}

// `providerID` is optional and defaults to "anthropic", so every pre-existing spec is unchanged;
// P8 needs two sessions under DIFFERENT providers in one controller, which the single shared
// `messages` array of setup() cannot express.
// `omitProviderID` builds an assistant message with NO providerID field at all, which P10 needs and
// no other spec can express: an absent providerID and a foreign one both read as "other" through
// toProviderId, but only the absent case can arrive from OpenCode for a turn of OUR provider, so the
// two must stay separately assertable.
type SessionSpec = { userParts?: unknown[]; assistantSteps: unknown[][]; providerID?: string; omitProviderID?: boolean }
const defaultUserParts = (): unknown[] => [{ type: "text", text: "hello", synthetic: false, ignored: false }]

// Per-session message/part registry so one controller can host several sessionIDs at once (C7),
// arbitrarily many assistant steps per turn (A-real-incident), and post-resume appended steps (C8).
function setupSessions(specs: Record<string, SessionSpec>) {
  const handlers = new Map<string, Handler>()
  const toasts: Toast[] = []
  const calls = { abort: 0, revert: [] as unknown[], promptAsync: [] as unknown[] }
  const sessionMessages = new Map<string, Array<Record<string, unknown>>>()
  const sessionProvider = new Map<string, string>()
  const noProviderID = new Set<string>()
  const parts: Record<string, unknown[]> = {}
  const stepCount: Record<string, number> = {}

  const pushAssistant = (sessionID: string, stepParts: unknown[]): string => {
    const n = (stepCount[sessionID] = (stepCount[sessionID] ?? 0) + 1)
    const id = `${sessionID}-a${n}`
    parts[id] = stepParts
    const message: Record<string, unknown> = {
      id,
      role: "assistant",
      parentID: `${sessionID}-u`,
      modelID: "claude-x",
      agent: "build",
      error: undefined,
    }
    // Omitted, not set to undefined: the code under test reads `assistant.providerID === "anthropic"`,
    // and only a genuinely absent key reproduces what OpenCode delivers for an unattributed turn.
    if (!noProviderID.has(sessionID)) message.providerID = sessionProvider.get(sessionID) ?? "anthropic"
    sessionMessages.get(sessionID)?.push(message)
    return id
  }

  for (const [sessionID, spec] of Object.entries(specs)) {
    const userId = `${sessionID}-u`
    parts[userId] = spec.userParts ?? defaultUserParts()
    sessionMessages.set(sessionID, [{ id: userId, role: "user", parentID: undefined }])
    if (spec.providerID) sessionProvider.set(sessionID, spec.providerID)
    if (spec.omitProviderID) noProviderID.add(sessionID)
    for (const stepParts of spec.assistantSteps) pushAssistant(sessionID, stepParts)
  }

  const api = {
    event: {
      on: (name: string, cb: Handler) => {
        handlers.set(name, cb)
        return () => handlers.delete(name)
      },
    },
    ui: { toast: (t: Toast) => toasts.push(t), dialog: { open: false } },
    client: {
      app: { log: () => Promise.resolve() },
      session: {
        abort: async () => {
          calls.abort++
          return {}
        },
        revert: async (a: unknown) => {
          calls.revert.push(a)
          return { error: undefined }
        },
        promptAsync: async (a: unknown) => {
          calls.promptAsync.push(a)
          return { error: undefined }
        },
      },
    },
    state: {
      session: {
        messages: (sessionID: string) => sessionMessages.get(sessionID) ?? [],
        status: () => ({ type: "idle" }),
      },
      part: (id: string) => parts[id] ?? [],
    },
    kv: { get: () => ({}), set: () => {} },
  } as unknown as TuiPluginApi

  const controller = installAutoSwitch(api)
  return { handlers, toasts, calls, controller, pushAssistant }
}

test("A1 回归锁:多步末步空占位 [u1,a1(tool),a2(空)] 撞限 → 聚合整轮判 continue,不含原始 prompt(hello),从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStep([])
  fireRetry(handlers, "evt-A1-empty-tail")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("A2:多步 [u1,a1(reasoning),a2(空)] → continue,从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStepParts([{ type: "reasoning" }], [])
  fireRetry(handlers, "evt-A2-reasoning")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("A3:多步 [u1,a1(patch),a2(空)] → continue,从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStepParts([{ type: "patch" }], [])
  fireRetry(handlers, "evt-A3-patch")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("A4:多步 [u1,a1(非空text),a2(空)] → continue,从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStepParts([{ type: "text", text: "已经分析了一半" }], [])
  fireRetry(handlers, "evt-A4-text")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("A6:多步全程空 [u1,a1(空),a2(空)] → resend 原始 prompt(hello),从不 revert", async () => {
  const { handlers, calls, controller } = setupMultiStepParts([], [])
  fireRetry(handlers, "evt-A6-allempty")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "hello")).toBe(true)
  expect(arg.parts.some((p) => p.text === "continue")).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("多步回合(一 user 多 assistant)撞限 → 命中最后一条 assistant → promptAsync(continue),从不 revert,无手动重发提示", async () => {
  const { handlers, toasts, calls, controller } = setupMultiStep([{ type: "tool", tool: "edit", state: { status: "completed" } }])
  fireRetry(handlers, "evt-multistep")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(calls.revert.length).toBe(0)
  expect(toasts.some((t) => t.message.includes("请手动重新发送") || t.message.includes("请手动重发"))).toBe(false)
  controller.dispose()
})

test("标记号不参与自动切号:撞限切到未标记号(acc3),跳过 excluded 的 acc2", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
      { id: "acc3", label: "C" },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-skip-excluded")
    await flush(() => switchCalls.length > 0)

    expect(switchCalls).toContain("acc3")
    expect(switchCalls).not.toContain("acc2")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("needsReauth 号不参与自动切号:撞限切到健康号(acc3),跳过 needsReauth 的 acc2", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", needsReauth: true },
      { id: "acc3", label: "C" },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-skip-reauth")
    await flush(() => switchCalls.length > 0)

    expect(switchCalls).toContain("acc3")
    expect(switchCalls).not.toContain("acc2")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("仅剩 needsReauth 号:撞限 → standDown(不切到 needsReauth 号、零 switch)", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", needsReauth: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, toasts, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-all-reauth")
    await flush(() => toasts.some((t) => t.variant === "error"))

    expect(switchCalls.length).toBe(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("仅剩标记号:撞限 → standDown(不切到标记号、零 promptAsync、出现额度上限 toast)", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, toasts, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-all-excluded")
    await flush(() => toasts.some((t) => t.variant === "error"))

    expect(switchCalls.length).toBe(0)
    expect(calls.promptAsync.length).toBe(0)
    expect(toasts.some((t) => t.variant === "error" && t.message.includes("额度上限"))).toBe(true)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("C1:仅剩 excluded → standdown 弹 openExhaustedAlert 一次,零 promptAsync,零 switch", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-C1")
    await flush(() => dialogCalls.exhausted.length > 0)

    expect(dialogCalls.exhausted.length).toBe(1)
    expect(calls.promptAsync.length).toBe(0)
    expect(switchCalls.length).toBe(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("C3:standdown 弹窗携带最近恢复倒计时(soonestMs 为正数)", async () => {
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    // A known reset (cached future resets_at) is required for a countdown; without it the honest
    // behavior is soonestMs === undefined (locked separately by the only-pending standDown test).
    controller.setUsageCache([
      { id: "acc1", label: "A", active: true, usage: { five_hour: { utilization: 100, resets_at: new Date(Date.now() + 60_000).toISOString() } } },
    ])
    fireRetry(handlers, "evt-C3")
    await flush(() => dialogCalls.exhausted.length > 0)

    const args = dialogCalls.exhausted[0] as unknown[]
    expect(typeof args[1]).toBe("number")
    expect(args[1] as number).toBeGreaterThan(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("C4【headline】恢复计时到点 + 有停摆 → switchToAccount(恢复号) + promptAsync(continue)", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireError(handlers, {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String((Date.now() + 60) / 1000),
    })
    await flush(() => calls.promptAsync.length > 0)

    expect(switchCalls).toContain("acc1")
    expect(calls.promptAsync.length).toBe(1)
    const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
    expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("C5:恢复 + 无停摆 → 静默解除冷却,不弹提醒、不触发额外 switch/promptAsync", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String((Date.now() + 80) / 1000),
  })
  await flush(() => switchCalls.length > 0)
  const switchAfterSwitch = switchCalls.length
  const promptAfterSwitch = calls.promptAsync.length
  expect(kv.snapshot.acc1).toBeGreaterThan(Date.now())

  await flush(() => kv.snapshot.acc1 === undefined)
  expect(kv.snapshot.acc1).toBeUndefined()
  expect(switchCalls.length).toBe(switchAfterSwitch)
  expect(calls.promptAsync.length).toBe(promptAfterSwitch)
  controller.dispose()
})

test("C6:防二次续接 — 先停摆,fireIdle 成功移出停摆,恢复时静默解除冷却、不再 promptAsync", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, calls, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireError(handlers, {
      "anthropic-ratelimit-unified-status": "rejected",
      "anthropic-ratelimit-unified-reset": String((Date.now() + 150) / 1000),
    })
    await flush(() => dialogCalls.exhausted.length > 0)

    accountsOverride.activeId = "acc2"
    fireIdle(handlers, "evt-C6-idle")
    await flush(() => kv.snapshot.acc1 === undefined)

    expect(kv.snapshot.acc1).toBeUndefined()
    expect(calls.promptAsync.length).toBe(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("B1-real-429-body:响应体 rate_limit_error(流式 SSE error,status 200)→ 经 fireError 实测触发切号到 acc2", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, {}, "s1", undefined, {
    statusCode: 200,
    responseBody: '{"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."}}',
  })
  await flush(() => switchCalls.length > 0)

  expect(switchCalls).toContain("acc2")
  await flush(() => calls.promptAsync.length > 0)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  controller.dispose()
})

test("B2-real-unified-header:头 anthropic-ratelimit-unified-status=rejected(无 429、无 body)→ 触发切号到 acc2", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected" }, "s1", undefined, { statusCode: 200 })
  await flush(() => switchCalls.length > 0)

  expect(switchCalls).toContain("acc2")
  controller.dispose()
})

test("B3-real-message-text:纯消息文案(retry 路径,无头无体)→ 触发切号到 acc2", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireRetry(handlers, "evt-B3", "s1", "This request would exceed your account's rate limit. Please try again later.")
  await flush(() => switchCalls.length > 0)

  expect(switchCalls).toContain("acc2")
  await flush(() => calls.promptAsync.length > 0)
  expect(calls.abort).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  controller.dispose()
})

test("B4-real-429-status:仅 429 statusCode(无头无体)→ 触发切号到 acc2", async () => {
  switchCalls.length = 0
  const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, {}, "s1", undefined, { statusCode: 429 })
  await flush(() => switchCalls.length > 0)

  expect(switchCalls).toContain("acc2")
  controller.dispose()
})

test("B5-real-529-overloaded:overloaded_error 响应体(529 类)→ 不切号、零 promptAsync、零 standdown", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireError(handlers, {}, "s1", undefined, {
    statusCode: 529,
    responseBody: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
  })
  await flush(() => false)

  expect(switchCalls.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)
  expect(dialogCalls.exhausted.length).toBe(0)
  controller.dispose()
})

test("A-real-incident-shape:忠实复刻 ses_0e8b04 07:38(长 prompt + reasoning/tool/text/patch 多步 + 末步空占位)撞限 → 聚合判 continue,不含原始 prompt,从不 revert", async () => {
  const longPrompt =
    "请看这个飞书文档链接 https://example.feishu.cn/docx/abcd1234efgh5678 帮我把里面的需求整理成结构化清单,并落地到 src 下对应模块,注意保留既有的限流自动切号逻辑不要破坏。"
  const { handlers, calls, controller } = setupSessions({
    s1: {
      userParts: [{ type: "text", text: longPrompt, synthetic: false, ignored: false }],
      assistantSteps: [
        [{ type: "reasoning" }],
        [{ type: "tool", tool: "read", state: { status: "completed" } }],
        [{ type: "text", text: "我已经读完文档,接下来开始编辑对应模块" }],
        [{ type: "tool", tool: "edit", state: { status: "completed" } }, { type: "patch" }],
        [],
      ],
    },
  })
  fireRetry(handlers, "evt-A-incident", "s1")
  await flush(() => calls.promptAsync.length > 0)

  expect(calls.promptAsync.length).toBe(1)
  const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
  expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
  expect(arg.parts.some((p) => p.type === "text" && p.text === longPrompt)).toBe(false)
  expect(calls.revert.length).toBe(0)
  controller.dispose()
})

test("C7:两个 session 都停摆 + 单号恢复 → 逐个续接(对两个 session 各 promptAsync(continue) 一次)", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, calls, controller } = setupSessions({
      sA: { assistantSteps: [[{ type: "tool", tool: "read", state: { status: "completed" } }]] },
      sB: { assistantSteps: [[{ type: "tool", tool: "edit", state: { status: "completed" } }]] },
    })
    const reset = String((Date.now() + 200) / 1000)
    fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": reset }, "sA")
    fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": reset }, "sB")
    await flush(() => dialogCalls.exhausted.length >= 2)

    await flush(() => calls.promptAsync.length >= 2)
    expect(calls.promptAsync.length).toBe(2)
    const sessions = (calls.promptAsync as { sessionID: string; parts: { type: string; text?: string }[] }[]).map((a) => a.sessionID)
    expect(sessions).toContain("sA")
    expect(sessions).toContain("sB")
    for (const a of calls.promptAsync as { parts: { type: string; text?: string }[] }[]) {
      expect(a.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
    }
    expect(switchCalls).toContain("acc1")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("C8:恢复-续接后同 session 再撞限(全员 excluded/cooled)→ 重新停摆 → 二次恢复再次续接(自愈)", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [
      { id: "acc1", label: "A" },
      { id: "acc2", label: "B", excluded: true },
    ],
    activeId: "acc1",
  }
  try {
    const { handlers, calls, controller, pushAssistant } = setupSessions({
      sX: { assistantSteps: [[{ type: "tool", tool: "read", state: { status: "completed" } }]] },
    })
    fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String((Date.now() + 120) / 1000) }, "sX")
    await flush(() => dialogCalls.exhausted.length >= 1)
    await flush(() => calls.promptAsync.length >= 1)
    expect((calls.promptAsync[0] as { parts: { text?: string }[] }).parts.some((p) => p.text === "continue")).toBe(true)

    pushAssistant("sX", [{ type: "tool", tool: "edit", state: { status: "completed" } }])
    fireError(handlers, { "anthropic-ratelimit-unified-status": "rejected", "anthropic-ratelimit-unified-reset": String((Date.now() + 120) / 1000) }, "sX")
    await flush(() => dialogCalls.exhausted.length >= 2)
    expect(dialogCalls.exhausted.length).toBe(2)

    await flush(() => calls.promptAsync.length >= 2)
    expect(calls.promptAsync.length).toBe(2)
    expect((calls.promptAsync[1] as { parts: { text?: string }[] }).parts.some((p) => p.text === "continue")).toBe(true)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

const usageEntry = (id: string, usage: Record<string, unknown>) => ({ id, label: id.toUpperCase(), active: true, usage })
const isoIn = (ms: number) => new Date(Date.now() + ms).toISOString()

test("I28-a:未知冷却(无头无缓存)→ 切到备号、待定账号被排除、不安排恢复、无 Infinity/NaN", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  const { handlers, calls, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  controller.setUsageCache([])
  fireRetry(handlers, "evt-I28-a")
  await flush(() => switchCalls.length > 0)
  expect(switchCalls).toContain("acc2")
  await flush(() => calls.promptAsync.length > 0)
  await new Promise((r) => setTimeout(r, 30))
  expect(kv.snapshot.acc1).toBeUndefined()
  for (const args of dialogCalls.exhausted) {
    const v = args[1] as number | undefined
    expect(v === undefined || (typeof v === "number" && Number.isFinite(v))).toBe(true)
  }
  controller.dispose()
})

test("I28-b:仅剩待定冷却账号 → standDown soonestMs===undefined、无 Infinity", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }], activeId: "acc1" }
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-b")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect((dialogCalls.exhausted[0] as unknown[])[1]).toBe(undefined)
    expect(switchCalls.length).toBe(0)
    expect(calls.promptAsync.length).toBe(0)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-i:onIdle 成功回合清除待定冷却 → 账号重新可选", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-i-cool")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect(switchCalls.length).toBe(0)

    fireIdle(handlers, "evt-I28-i-idle")
    await new Promise((r) => setTimeout(r, 10))

    accountsOverride.activeId = "acc2"
    fireRetry(handlers, "evt-I28-i-reuse", "s2")
    await flush(() => switchCalls.length > 0)
    expect(switchCalls).toContain("acc1")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-c:status 路径用缓存 resets_at → 冷却在真实 reset 解除(非 ~1ms 假恢复)", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 100, resets_at: isoIn(200) } })])
  fireRetry(handlers, "evt-I28-c")
  await flush(() => calls.promptAsync.length > 0)
  expect(switchCalls).toContain("acc2")
  expect(kv.snapshot.acc1).toBeGreaterThan(Date.now() + 100)
  await flush(() => kv.snapshot.acc1 === undefined)
  expect(kv.snapshot.acc1).toBeUndefined()
  controller.dispose()
})

test("I28-d:响应头 reset 优先于缓存 resets_at", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 100, resets_at: isoIn(5_000) } })])
  fireError(handlers, {
    "anthropic-ratelimit-unified-status": "rejected",
    "anthropic-ratelimit-unified-reset": String((Date.now() + 150) / 1000),
  })
  await flush(() => calls.promptAsync.length > 0)
  expect(switchCalls).toContain("acc2")
  expect(kv.snapshot.acc1).toBeGreaterThan(Date.now())
  expect(kv.snapshot.acc1).toBeLessThan(Date.now() + 1_000)
  await flush(() => kv.snapshot.acc1 === undefined)
  expect(kv.snapshot.acc1).toBeUndefined()
  controller.dispose()
})

test("I28-e1:过期缓存 resets_at 被忽略 → 未知(待定)、无恢复", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 100, resets_at: isoIn(-1_000) } })])
    fireRetry(handlers, "evt-I28-e1")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect((dialogCalls.exhausted[0] as unknown[])[1]).toBe(undefined)
    await new Promise((r) => setTimeout(r, 30))
    expect(kv.snapshot.acc1).toBeUndefined()
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-f:多窗口顶格 → 取最晚 resets_at", async () => {
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([
      usageEntry("acc1", {
        five_hour: { utilization: 100, resets_at: isoIn(100) },
        seven_day: { utilization: 100, resets_at: isoIn(300) },
      }),
    ])
    fireRetry(handlers, "evt-I28-f")
    await flush(() => dialogCalls.exhausted.length > 0)
    const v = (dialogCalls.exhausted[0] as unknown[])[1]
    expect(typeof v).toBe("number")
    expect(v as number).toBeGreaterThan(250)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-g:待定冷却经 setUsageCache 回填真实 reset → 升级为精确恢复", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, calls, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-g")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect(switchCalls.length).toBe(0)
    expect(kv.snapshot.acc1).toBeUndefined()

    controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 100, resets_at: isoIn(150) } })])
    await flush(() => switchCalls.length > 0)
    expect(switchCalls).toContain("acc1")
    await flush(() => calls.promptAsync.length > 0)
    const arg = calls.promptAsync[0] as { parts: { type: string; text?: string }[] }
    expect(arg.parts.some((p) => p.type === "text" && p.text === "continue")).toBe(true)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-h:待定冷却经 setUsageCache 发现已恢复(低用量)→ 清除、无恢复、重新可选", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-h")
    await flush(() => dialogCalls.exhausted.length > 0)

    controller.setUsageCache([usageEntry("acc1", { five_hour: { utilization: 20, resets_at: isoIn(5_000) } })])
    await new Promise((r) => setTimeout(r, 30))
    expect(switchCalls.length).toBe(0)
    expect(kv.snapshot.acc1).toBeUndefined()

    accountsOverride.activeId = "acc2"
    fireRetry(handlers, "evt-I28-h-reuse", "s2")
    await flush(() => switchCalls.length > 0)
    expect(switchCalls).toContain("acc1")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-e2:待定冷却 + 全 null 窗口用量 → 清除(无 Infinity/NaN 定时器、无恢复)", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  try {
    const { handlers, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([])
    fireRetry(handlers, "evt-I28-e2")
    await flush(() => dialogCalls.exhausted.length > 0)

    controller.setUsageCache([usageEntry("acc1", { five_hour: null, seven_day: null, seven_day_sonnet: null, seven_day_opus: null })])
    await new Promise((r) => setTimeout(r, 30))
    expect(switchCalls.length).toBe(0)
    expect(kv.snapshot.acc1).toBeUndefined()
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("I28-scoped:scoped(Fable)顶格而 five_hour 未满 → 冷却按 scoped 窗口的 reset 解除(resolveResetMs 纳入 usage.scoped)", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller, kv } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  controller.setUsageCache([
    usageEntry("acc1", { five_hour: { utilization: 50, resets_at: isoIn(100) }, scoped: [{ label: "Fable", utilization: 100, resets_at: isoIn(300) }] }),
  ])
  fireRetry(handlers, "evt-I28-scoped")
  await flush(() => calls.promptAsync.length > 0)
  expect(switchCalls).toContain("acc2")
  // Only Fable is maxed; without scoped in resolveResetMs, five_hour@50<100 ⇒ indefinite ⇒ kv undefined.
  expect(kv.snapshot.acc1).toBeGreaterThan(Date.now() + 100)
  await flush(() => kv.snapshot.acc1 === undefined)
  expect(kv.snapshot.acc1).toBeUndefined()
  controller.dispose()
})

test("I28-scoped-score:score() 纳入 scoped 用量 → 撞限优先切到 scoped 更空的号", async () => {
  switchCalls.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B" }, { id: "acc3", label: "C" }], activeId: "acc1" }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    controller.setUsageCache([
      usageEntry("acc2", { scoped: [{ label: "Fable", utilization: 90, resets_at: isoIn(60_000) }] }),
      usageEntry("acc3", { five_hour: { utilization: 10, resets_at: isoIn(60_000) } }),
    ])
    fireRetry(handlers, "evt-I28-scoped-score")
    await flush(() => switchCalls.length > 0)
    // Without scoped in score(), acc2 scores 0 and is picked first; counting Fable@90 flips it to acc3.
    expect(switchCalls[0]).toBe("acc3")
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("T5-a:session.status busy → isSessionRunning true;idle → false;retry 保持 running(true)", async () => {
  const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireStatus(handlers, "busy", "s1")
  expect(controller.isSessionRunning()).toBe(true)
  fireStatus(handlers, "idle", "s1")
  expect(controller.isSessionRunning()).toBe(false)
  fireStatus(handlers, "retry", "s1")
  expect(controller.isSessionRunning()).toBe(true)
  controller.dispose()
})

test("T5-b:refreshUsageInBackground 把真实 isSessionRunning 谓词传给 collectAllUsage", async () => {
  collectOptsLog.length = 0
  switchCalls.length = 0
  const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireRetry(handlers, "evt-T5-b")
  await flush(() => collectOptsLog.length > 0)
  expect(typeof collectOptsLog[0]?.isSessionRunning).toBe("function")
  controller.dispose()
})

// doSwitch→switchToAccount 的接线继承 T4 的出账号反向同步;此处只断言接线本身切到下一个账号。
// 真正的"出账号 token 反向同步"由 usage.test.ts(T4)断言。
test("T5-c:doSwitch 撞限 → switchToAccount(下一个账号 acc2),接线继承 T4 反向同步", async () => {
  switchCalls.length = 0
  const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  fireRetry(handlers, "evt-T5-c")
  await flush(() => switchCalls.length > 0)
  expect(switchCalls).toContain("acc2")
  controller.dispose()
})

test("T5-d:INV-1 冷启动 — 无任何已观测会话 → isSessionRunning true(未知⇒running,绝不 false)", async () => {
  const { controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
  expect(controller.isSessionRunning()).toBe(true)
  controller.dispose()
})

const userOnlyTurn = () => [{ id: "u1", role: "user", parentID: undefined }]
const openaiTurn = () => [
  { id: "u1", role: "user", parentID: undefined },
  { id: "a1", role: "assistant", parentID: "u1", providerID: "openai", modelID: "gpt-x", agent: "build", error: undefined },
]
// A provider we own NO ops for — must read as "other", which is NOT the same as "unknown".
const foreignTurn = () => [
  { id: "u1", role: "user", parentID: undefined },
  { id: "a1", role: "assistant", parentID: "u1", providerID: "google", modelID: "gemini-x", agent: "build", error: undefined },
]
// The exact ChatGPT quota signature the strict openai detector demands (429 + this body type).
const openaiLimitBody = JSON.stringify({ error: { type: "usage_limit_reached", message: "You've hit your usage limit." } })

test("P1:provider 未知(尚无 assistant 消息)+ retry 限流文案 → 不切号", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([], { messages: userOnlyTurn() })
  fireRetry(handlers, "evt-P1-unknown-retry")
  await flush(() => switchCalls.length > 0)
  expect(switchCalls.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)
  controller.dispose()
})

test("P2:provider 未知(尚无 assistant 消息)+ 裸 429 error → 不切号", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([], { messages: userOnlyTurn() })
  fireError(handlers, {}, "s1", "evt-P2-unknown-429")
  await flush(() => switchCalls.length > 0)
  expect(switchCalls.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)
  controller.dispose()
})

test("P3:回归锁 — assistant 为 openai + 裸 429 → 不切号", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([], { messages: openaiTurn() })
  fireError(handlers, {}, "s1", "evt-P3-openai-429")
  await flush(() => switchCalls.length > 0)
  expect(switchCalls.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)
  controller.dispose()
})

// Guards the running-state bookkeeping against an over-eager fix: the switch gate must
// tighten to "confirmed anthropic" WITHOUT the INV-1 side dropping unknown sessions,
// or the active-token self-refresh could fire mid-turn and race ex-machina.
// A session that already ran a Claude turn keeps that assistant message in history, so a
// history-wide lookup still reads "anthropic" after the user switches models. The gate must
// scope to the CURRENT turn — the same turn repromptFailedTurn would act on.
const claudeTurnThenNewUserTurn = () => [
  { id: "u1", role: "user", parentID: undefined },
  { id: "a1", role: "assistant", parentID: "u1", providerID: "anthropic", modelID: "claude-x", agent: "build", error: undefined },
  { id: "u2", role: "user", parentID: undefined },
]

test("P5:混合会话 — 上一轮 Claude 已完成,本轮尚无 assistant + 裸 429 → 不切号", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([], { messages: claudeTurnThenNewUserTurn() })
  fireError(handlers, {}, "s1", "evt-P5-mixed-429")
  await flush(() => switchCalls.length > 0)
  expect(switchCalls.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)
  controller.dispose()
})

test("P4:INV-1 守卫 — 已知会话转空闲后,provider 未知的新会话转 busy 仍算 running", async () => {
  const { handlers, controller } = setupSessions({
    s1: { assistantSteps: [[{ type: "tool", tool: "read", state: { status: "completed" } }]] },
    s2: { assistantSteps: [] },
  })
  fireStatus(handlers, "busy", "s1")
  fireStatus(handlers, "idle", "s1")
  expect(controller.isSessionRunning()).toBe(false)
  fireStatus(handlers, "busy", "s2")
  expect(controller.isSessionRunning()).toBe(true)
  controller.dispose()
})

test("P6:currentTurnProvider 四值 —— Claude 回合判 anthropic、ChatGPT 回合判 openai、第三方 provider 判 other、尚无 assistant 判 unknown", async () => {
  const cap = captureLogs()
  try {
    const cases: Array<[Array<Record<string, unknown>> | undefined, string]> = [
      [undefined, "anthropic"],
      [openaiTurn(), "openai"],
      [foreignTurn(), "other"],
      [userOnlyTurn(), "unknown"],
    ]
    for (const [messages, expected] of cases) {
      switchCalls.length = 0
      cap.entries.length = 0
      const { handlers, controller } = setup([], messages ? { messages } : {})
      fireError(handlers, {}, "s1", `evt-P6-${expected}`, { statusCode: 429 })
      await flush(() => cap.decisions().length > 0)
      expect(cap.decisions()[0]?.turn).toBe(expected)
      controller.dispose()
    }
  } finally {
    cap.restore()
    switchCalls.length = 0
  }
})

// The merge-guard for the two OPPOSITE unknown-defaults, in ONE test: an unknown-provider session
// must read as running (INV-1 side) AND must refuse to switch (switch side). Unifying the two
// functions in either direction turns exactly one of these two assertions red.
test("P7:反向默认回归锁 —— 同一个 provider 未知的会话:记账侧算 running(true),切号侧拒绝切号(零 switch)", async () => {
  switchCalls.length = 0
  const { handlers, calls, controller } = setup([], { messages: userOnlyTurn() })
  fireStatus(handlers, "busy", "s1")
  expect(controller.isSessionRunning()).toBe(true)

  fireRetry(handlers, "evt-P7-unknown-retry")
  await flush(() => switchCalls.length > 0)
  expect(switchCalls.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)

  // 转 idle 后必须能落回 false —— 这才证明未知会话真的被记进了 anthropic 记账集合,
  // 而不是靠"一个会话都没观测到"的冷启动兜底才返回 true。
  fireStatus(handlers, "idle", "s1")
  expect(controller.isSessionRunning()).toBe(false)
  controller.dispose()
})

test("P8:确认为 openai 的会话不算 anthropic running —— 记账侧的判据是 `=== provider || === unknown`,不是 `!== other`", async () => {
  const { handlers, controller } = setupSessions({
    s1: { assistantSteps: [[{ type: "tool", tool: "read", state: { status: "completed" } }]] },
    s2: { assistantSteps: [[{ type: "text", text: "hi" }]], providerID: "openai" },
  })
  fireStatus(handlers, "busy", "s1")
  fireStatus(handlers, "idle", "s1")
  expect(controller.isSessionRunning()).toBe(false)

  // 与 P4 同一位置:那里 s2 是"未知 provider"⇒ 算 running;这里 s2 已确认是 ChatGPT ⇒ 不算。
  fireStatus(handlers, "busy", "s2")
  expect(controller.isSessionRunning()).toBe(false)
  controller.dispose()
})

// Cools acc1 with acc2 excluded, so acc1's cooldown is the ONLY thing standing between a later
// anthropic limit and a switch back into acc1. That makes "was the cooldown cleared?" observable
// through selection — the same lever I28-i uses, and the only one available here because
// setupSessions has no kv snapshot.
async function coolAcc1ThenIdle(idleSessions: string[], specs: Record<string, SessionSpec>) {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = { accounts: [{ id: "acc1", label: "A" }, { id: "acc2", label: "B", excluded: true }], activeId: "acc1" }
  const { handlers, calls, controller } = setupSessions(specs)
  controller.setUsageCache([])
  fireRetry(handlers, "evt-cool", "sAnth")
  await flush(() => dialogCalls.exhausted.length > 0)
  if (switchCalls.length !== 0) throw new Error("fixture broken: acc1 should have been cooled, not switched away")

  for (const sid of idleSessions) fireIdle(handlers, `evt-idle-${sid}`, sid)
  await new Promise((resolve) => setTimeout(resolve, 20))

  // acc2 becomes active, so the ONLY candidate a fresh limit could switch to is acc1 — reachable if
  // and only if its cooldown was (wrongly) cleared by the idle turns above.
  accountsOverride.activeId = "acc2"
  dialogCalls.exhausted.length = 0
  fireRetry(handlers, "evt-probe", "sProbe")
  await flush(() => switchCalls.length > 0 || dialogCalls.exhausted.length > 0)
  return { switched: [...switchCalls], stoodDown: dialogCalls.exhausted.length > 0, calls, controller }
}

const completedTool = () => [{ type: "tool", tool: "read", state: { status: "completed" } }]

// Regression lock on a shipped bug: onIdle used to clear the cooldown on ANY successful turn, so a
// ChatGPT reply lifted a still-rate-limited Claude account back into selection and burned a switch.
test("P9:onIdle 只有 anthropic 成功回合才清冷却 —— ChatGPT 成功回合绝不清 Claude 号的冷却", async () => {
  try {
    const out = await coolAcc1ThenIdle(["sOpenai"], {
      sAnth: { assistantSteps: [completedTool()] },
      sProbe: { assistantSteps: [completedTool()] },
      sOpenai: { assistantSteps: [[{ type: "text", text: "hi" }]], providerID: "openai" },
    })
    expect(out.switched).not.toContain("acc1")
    expect(out.switched.length).toBe(0)
    expect(out.stoodDown).toBe(true)
    out.controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

test("P10:onIdle 遇到无 providerID 的成功回合同样不清冷却(未知 provider 只能少清,不能早清)", async () => {
  try {
    const out = await coolAcc1ThenIdle(["sNoProv"], {
      sAnth: { assistantSteps: [completedTool()] },
      sProbe: { assistantSteps: [completedTool()] },
      sNoProv: { assistantSteps: [[{ type: "text", text: "hi" }]], omitProviderID: true },
    })
    expect(out.switched).not.toContain("acc1")
    expect(out.switched.length).toBe(0)
    expect(out.stoodDown).toBe(true)
    out.controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

// The counterpart that proves P9/P10 lock the PROVIDER check and not a broken fixture: the very same
// harness, an anthropic success, and the cooldown really does clear.
test("P11:同一套 harness 下 anthropic 成功回合确实清掉了冷却(证明 P9/P10 卡的是 provider 判据)", async () => {
  try {
    const out = await coolAcc1ThenIdle(["sAnth"], {
      sAnth: { assistantSteps: [completedTool()] },
      sProbe: { assistantSteps: [completedTool()] },
    })
    expect(out.switched).toContain("acc1")
    out.controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

// The hook injects a synthetic limit STRAIGHT into handleLimit, bypassing decideLimit and therefore
// the dark-launch gate too, so an unpinned hook would drag a ChatGPT session into the anthropic
// switch/stall bookkeeping. The second half also proves the one-shot was not silently consumed.
test("P12:force-limit 钩子在非 anthropic 会话上不触发,且不被消耗 —— 之后的 anthropic 会话仍能注入一次", async () => {
  process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE = "1"
  switchCalls.length = 0
  try {
    const { handlers, calls, controller } = setupSessions({
      sOpenai: { assistantSteps: [completedTool()], providerID: "openai" },
      sAnth: { assistantSteps: [completedTool()] },
    })
    fireIdle(handlers, "evt-P12-openai-idle", "sOpenai")
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(switchCalls.length).toBe(0)
    expect(calls.promptAsync.length).toBe(0)

    fireIdle(handlers, "evt-P12-anth-idle", "sAnth")
    await flush(() => calls.promptAsync.length > 0)
    expect(switchCalls).toEqual(["acc2"])
    expect(calls.promptAsync.length).toBe(1)
    controller.dispose()
  } finally {
    delete process.env.CLAUDE_AUTOSWITCH_FORCE_LIMIT_ONCE
    switchCalls.length = 0
  }
})

// A ChatGPT record living in the SAME pool file — exactly what the openai capture wave writes.
// The id keeps openai-slot.ts's namespace prefix so a cross-provider pick is unmistakable.
const openaiRec = (accountId: string) => ({ id: `openai:${accountId}`, label: `OA-${accountId}`, provider: "openai", accountId })

test("X1:混合池 + 用量缓存新鲜(按分数选号)→ 只在 anthropic 记录里挑,零用量的 ChatGPT 记录绝不被选中", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [{ id: "acc1", label: "A" }, openaiRec("acct-Z"), { id: "acc2", label: "B" }],
    activeId: "acc1",
  }
  try {
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    // The ChatGPT row is the emptiest by score, so a provider-blind sort puts it first.
    controller.setUsageCache([
      usageEntry("openai:acct-Z", { five_hour: { utilization: 0, resets_at: isoIn(60_000) } }),
      usageEntry("acc2", { five_hour: { utilization: 90, resets_at: isoIn(60_000) } }),
    ])
    fireRetry(handlers, "evt-X1-mixed-score")
    await flush(() => switchCalls.length > 0)
    expect(switchCalls[0]).toBe("acc2")
    expect(switchCalls.some((id) => id.startsWith("openai:"))).toBe(false)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

// End-to-end lock on the shipped bug: it takes BOTH provider-blind sites (candidate filter and
// order) to fail here, because an anthropic-only order already skips the ChatGPT id even when the
// candidate list still contains it. X2b below is the single-site lock for this same branch.
test("X2:混合池 + 无用量缓存(轮询兜底)→ 轮到紧邻当前号的 ChatGPT 记录时跳过,切到下一个 anthropic 号", async () => {
  switchCalls.length = 0
  accountsOverride = {
    accounts: [{ id: "acc1", label: "A" }, openaiRec("acct-Z"), { id: "acc2", label: "B" }],
    activeId: "acc1",
  }
  try {
    // No setUsageCache ⇒ cacheFresh false ⇒ the round-robin branch, and the ChatGPT record sits
    // exactly one step after the active account.
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-X2-mixed-roundrobin")
    await flush(() => switchCalls.length > 0)
    expect(switchCalls[0]).toBe("acc2")
    expect(switchCalls.some((id) => id.startsWith("openai:"))).toBe(false)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

// The round-robin branch's OTHER exit: when the order yields no match, `picked` stays at
// candidates[0]. With a blind candidate list that default IS the ChatGPT record — the one shape
// where an anthropic-only order cannot save us. acc2 is excluded so a real anthropic candidate
// exists for the count gate but none is selectable.
test("X2b:轮询兜底且无可选 anthropic 号 → standDown,绝不退化成 candidates[0] 的 ChatGPT 记录", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [{ id: "acc1", label: "A" }, openaiRec("acct-Z"), { id: "acc2", label: "B", excluded: true }],
    activeId: "acc1",
  }
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireRetry(handlers, "evt-X2b-fallback-default")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect(switchCalls.length).toBe(0)
    expect(calls.promptAsync.length).toBe(0)
    expect(dialogCalls.exhausted.length).toBe(1)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

// The round-robin ORDER and doSwitch's two counts cannot be pinned behaviourally once the
// candidate filter is provider-aware: deleting non-candidates from a cyclic order preserves the
// cyclic order of what remains, and both counts are mere upper bounds on a loop pickNext already
// gates. They stay load-bearing (they decide WHEN the exhausted alert fires and how many retries a
// mixed pool buys), so lock them structurally — house precedent: usage.test.ts's
// "autoCapture (c) body calls only lock-free fns".
test("X3:pickNext / standDown / doSwitch 的候选池、轮询顺序与账号计数都不再直接读 file.accounts", () => {
  const src = readFileSync(join(import.meta.dir, "autoswitch.ts"), "utf8")
  const start = src.indexOf("  function pickNext(")
  const end = src.indexOf("  function toInputParts(", start)
  expect(start).toBeGreaterThan(0)
  expect(end).toBeGreaterThan(start)
  const region = src
    .slice(start, end)
    .split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n")
  expect(region).not.toContain("file.accounts")
  expect((region.match(/accountsOf\(file, "anthropic"\)/g) ?? []).length).toBe(3)
})

test("X4:standDown 的恢复倒计时只看 anthropic 记录的冷却,ChatGPT 记录更早的 reset 不参与", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  accountsOverride = {
    accounts: [{ id: "acc1", label: "A" }, openaiRec("acct-Z"), { id: "acc2", label: "B" }],
    activeId: "acc1",
  }
  try {
    // Cooldowns inherited from an earlier run: the ChatGPT record recovers far sooner, so a
    // provider-blind Math.min would promise the user ITS deadline.
    const { handlers, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }], {
      cooldownKv: { acc2: Date.now() + 3_600_000, "openai:acct-Z": Date.now() + 60_000 },
    })
    fireRetry(handlers, "evt-X4-standdown-count")
    await flush(() => dialogCalls.exhausted.length > 0)
    expect(switchCalls.length).toBe(0)
    expect((dialogCalls.exhausted[0] as unknown[])[1] as number).toBeGreaterThan(30 * 60_000)
    controller.dispose()
  } finally {
    accountsOverride = undefined
  }
})

// ---- OPENAI_AUTOSWITCH_ENABLED = false:检测与决策日志照旧,动作被压制 ----

test("D1:暗开关关闭 —— 完全命中的 ChatGPT 限流(429 + usage_limit_reached + x-codex reset)零切号、零续接、零耗尽弹窗", async () => {
  switchCalls.length = 0
  dialogCalls.exhausted.length = 0
  const { handlers, calls, controller } = setup([{ type: "text", text: "写了一半" }], { messages: openaiTurn() })
  fireError(handlers, { "x-codex-primary-reset-at": "1787903707" }, "s1", "evt-D1-openai-limit", {
    statusCode: 429,
    responseBody: openaiLimitBody,
  })
  await flush(() => switchCalls.length > 0)

  expect(switchCalls.length).toBe(0)
  expect(calls.promptAsync.length).toBe(0)
  expect(calls.abort).toBe(0)
  expect(dialogCalls.exhausted.length).toBe(0)
  controller.dispose()
})

// 压制的是 ACTION,不是 DETECTION。这条日志正是"ChatGPT 限流载荷到底能不能送达 TUI 插件"的确认通道:
// 谁把 enabled 判断提到检测之前当作优化,这条就红。
test("D2:暗开关关闭但检测照旧运行 —— 决策日志仍记下 matched:true / turn:openai / enabled:false", async () => {
  switchCalls.length = 0
  const cap = captureLogs()
  try {
    const { handlers, controller } = setup([{ type: "text", text: "写了一半" }], { messages: openaiTurn() })
    fireError(handlers, {}, "s1", "evt-D2-openai-detect", { statusCode: 429, responseBody: openaiLimitBody })
    await flush(() => cap.decisions().length > 0)

    expect(cap.decisions()[0]).toEqual({ matched: true, turn: "openai", enabled: false })
    expect(switchCalls.length).toBe(0)
    controller.dispose()
  } finally {
    cap.restore()
  }
})

test("D3:暗开关关闭时 Claude 自动切号完全不受影响 —— anthropic 侧照旧切号并续接", async () => {
  switchCalls.length = 0
  const cap = captureLogs()
  try {
    const { handlers, calls, controller } = setup([{ type: "tool", tool: "read", state: { status: "completed" } }])
    fireError(handlers, {}, "s1", "evt-D3-anthropic-limit", { statusCode: 429 })
    await flush(() => calls.promptAsync.length > 0)

    expect(switchCalls).toContain("acc2")
    expect(cap.decisions()[0]).toEqual({ matched: true, turn: "anthropic", enabled: true })
    controller.dispose()
  } finally {
    cap.restore()
  }
})
