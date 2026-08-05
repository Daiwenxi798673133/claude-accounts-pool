import { expect, test } from "bun:test"
import type { StoredAccount } from "./accounts.ts"
import type { OpenaiUsage } from "./openai-usage.ts"
import {
  clampSelection,
  heldStateFor,
  pinnedStateFor,
  initialPageSelection,
  initialWorkerSelection,
  moveSelection,
  openaiRows,
  panelPages,
  displayWidth,
  holderChips,
  poolColumns,
  poolLayout,
  poolStepColumn,
  POOL_COLUMN_GAP,
  selectedIndex,
  unattributedOpenaiUsage,
} from "./panel-model.ts"
import { placeholderOpenaiLabel } from "./openai-slot.ts"

function gpt(id: string, extra: Partial<StoredAccount> = {}): StoredAccount {
  return { id: `openai:${id}`, label: `ChatGPT ${id}`, refresh: `r-${id}`, provider: "openai", accountId: id, ...extra }
}

function claude(id: string): StoredAccount {
  return { id, label: `Claude ${id}`, refresh: `r-${id}` }
}

const plus: OpenaiUsage = {
  email: "a@example.com",
  planType: "plus",
  windows: [
    { label: "5h", utilization: 42 },
    { label: "7d", utilization: 8 },
  ],
}

test("U1:只有占着 slot 的账号显示真实额度,其余一律额度未知", () => {
  const rows = openaiRows({
    accounts: [gpt("a"), gpt("b"), gpt("c")],
    activeId: "openai:b",
    usage: plus,
    loading: false,
  })
  expect(rows.map((row) => row.active)).toEqual([false, true, false])
  expect(rows[1].state).toEqual({ kind: "windows", windows: plus.windows })
  expect(rows[0].state).toEqual({ kind: "unknown", reason: "not-in-slot" })
  expect(rows[2].state).toEqual({ kind: "unknown", reason: "not-in-slot" })
})

// windows 是动态长度:go 套餐只回一个 30 天窗口,不能按 Anthropic 的 5h/7d 补齐成两行。
test("U2:go 套餐只有一个 30d 窗口 → 只出一个窗口,不补第二个", () => {
  const go: OpenaiUsage = { planType: "go", windows: [{ label: "30d", utilization: 12 }] }
  const [row] = openaiRows({ accounts: [gpt("a")], activeId: "openai:a", usage: go, loading: false })
  expect(row.state).toEqual({ kind: "windows", windows: [{ label: "30d", utilization: 12 }] })
})

// D1 的底线:没有数字就是没有数字,空数组不许被当成"用了 0%"。
test("U3:windows 为空数组 → 零个窗口,绝不渲染成 0%", () => {
  const [row] = openaiRows({ accounts: [gpt("a")], activeId: "openai:a", usage: { windows: [] }, loading: false })
  expect(row.state).toEqual({ kind: "windows", windows: [] })
})

test("U4:非活跃账号被标记 needsReauth → 显示需重新登录,而不是额度未知", () => {
  const rows = openaiRows({
    accounts: [gpt("a", { needsReauth: true }), gpt("b")],
    activeId: "openai:b",
    usage: plus,
    loading: false,
  })
  expect(rows[0].state).toEqual({ kind: "needs-reauth" })
})

test("U5:活跃账号 401/403 → needs-reauth;活跃账号报错 → 原样带出错误文案", () => {
  const reauth = openaiRows({
    accounts: [gpt("a")],
    activeId: "openai:a",
    usage: { windows: [], needsReauth: true },
    loading: false,
  })
  expect(reauth[0].state).toEqual({ kind: "needs-reauth" })
  const failed = openaiRows({
    accounts: [gpt("a")],
    activeId: "openai:a",
    usage: { windows: [], error: "用量请求失败 (500)" },
    loading: false,
  })
  expect(failed[0].state).toEqual({ kind: "error", message: "用量请求失败 (500)" })
})

// 未知要按成因分开:正在拉取是"加载中",拉完仍然没有才是"额度未知",
// 而且此时提示语不能说"切换到该账号后可见"——用户已经在这个账号上了。
test("U6:活跃账号拉取中 → loading;拉完仍无数据 → unknown/no-live-data", () => {
  const loading = openaiRows({ accounts: [gpt("a")], activeId: "openai:a", usage: undefined, loading: true })
  expect(loading[0].state).toEqual({ kind: "loading" })
  const settled = openaiRows({ accounts: [gpt("a")], activeId: "openai:a", usage: undefined, loading: false })
  expect(settled[0].state).toEqual({ kind: "unknown", reason: "no-live-data" })
})

test("U7:openaiActiveId 被清空 → 没有任何一行是 In Use,全部额度未知", () => {
  const rows = openaiRows({ accounts: [gpt("a"), gpt("b")], activeId: undefined, usage: plus, loading: false })
  expect(rows.every((row) => !row.active)).toBe(true)
  expect(rows.map((row) => row.state)).toEqual([
    { kind: "unknown", reason: "not-in-slot" },
    { kind: "unknown", reason: "not-in-slot" },
  ])
})

test("U8:slot 里是无法归属的 ChatGPT 凭据 → 保留只读实时额度块", () => {
  expect(unattributedOpenaiUsage({ accounts: [gpt("a")], activeId: undefined, usage: plus })).toBe(plus)
  expect(unattributedOpenaiUsage({ accounts: [], activeId: undefined, usage: plus })).toBe(plus)
})

test("U9:slot 占用者已被收录 → 不再额外渲染只读块;没有实时数据也不渲染", () => {
  expect(unattributedOpenaiUsage({ accounts: [gpt("a")], activeId: "openai:a", usage: plus })).toBeUndefined()
  expect(unattributedOpenaiUsage({ accounts: [], activeId: undefined, usage: undefined })).toBeUndefined()
})

test("U10:页签列表 —— 只有 Claude / 只有 ChatGPT / 两者都有", () => {
  expect(panelPages({ claude: 2, chatgpt: 0 })).toEqual(["claude"])
  expect(panelPages({ claude: 0, chatgpt: 3 })).toEqual(["chatgpt"])
  expect(panelPages({ claude: 1, chatgpt: 1 })).toEqual(["claude", "chatgpt"])
})

// 初始页恒为 pages[0],所以"只有 ChatGPT 账号"的用户不能被丢在空的 Claude 页上。
test("U11:初始页永远落在有内容的一页", () => {
  expect(panelPages({ claude: 0, chatgpt: 3 })[0]).toBe("chatgpt")
  expect(panelPages({ claude: 2, chatgpt: 3 })[0]).toBe("claude")
  expect(panelPages({ claude: 0, chatgpt: 0 })).toHaveLength(1)
})

test("U12:两页选中项相互独立,动一页不动另一页", () => {
  const start = initialPageSelection({ claude: [claude("c1"), claude("c2")], chatgpt: [gpt("a"), gpt("b"), gpt("c")] })
  const moved = moveSelection(start, "chatgpt", 2, 3)
  expect(selectedIndex(moved, "chatgpt", 3)).toBe(2)
  expect(selectedIndex(moved, "claude", 2)).toBe(0)
  const back = moveSelection(moved, "claude", 1, 2)
  expect(selectedIndex(back, "claude", 2)).toBe(1)
  expect(selectedIndex(back, "chatgpt", 3)).toBe(2)
})

test("U13:列表变短后选中项被夹住,空列表夹成 0", () => {
  expect(clampSelection(5, 3)).toBe(2)
  expect(clampSelection(-1, 3)).toBe(0)
  expect(clampSelection(4, 0)).toBe(0)
  const selection = moveSelection(initialPageSelection({ claude: [], chatgpt: [gpt("a"), gpt("b"), gpt("c")] }), "chatgpt", 2, 3)
  expect(selectedIndex(selection, "chatgpt", 1)).toBe(0)
  expect(selectedIndex(selection, "chatgpt", 0)).toBe(0)
})

// 删空一页不能顺手把另一页的光标带走:另一页的行还在,选中项必须原地不动。
test("U14:删掉 ChatGPT 页最后一行 → Claude 页的选中项不受影响", () => {
  const start = initialPageSelection({ claude: [claude("c1"), claude("c2"), claude("c3")], chatgpt: [gpt("a")] })
  const onThird = moveSelection(start, "claude", 2, 3)
  const afterDelete = moveSelection(onThird, "chatgpt", 0, 0)
  expect(selectedIndex(afterDelete, "claude", 3)).toBe(2)
  expect(selectedIndex(afterDelete, "chatgpt", 0)).toBe(0)
})

test("U15:各页初始选中项落在各自的当前账号上,没有当前账号则落在第 0 行", () => {
  const selection = initialPageSelection({
    claude: [claude("c1"), claude("c2")],
    claudeActiveId: "c2",
    chatgpt: [gpt("a"), gpt("b"), gpt("c")],
    chatgptActiveId: "openai:c",
  })
  expect(selectedIndex(selection, "claude", 2)).toBe(1)
  expect(selectedIndex(selection, "chatgpt", 3)).toBe(2)
  const noActive = initialPageSelection({ claude: [claude("c1")], chatgpt: [gpt("a"), gpt("b")] })
  expect(selectedIndex(noActive, "chatgpt", 2)).toBe(0)
})

const ACCT = "78bbaee7-552a-4dce-947e-b733bb24aac9"
const OTHER = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"

function stored(accountId: string, label: string): StoredAccount {
  return { id: `openai:${accountId}`, label, refresh: `r-${accountId}`, provider: "openai", accountId }
}

const liveOf = (accountId: string, extra: Partial<OpenaiUsage> = {}): OpenaiUsage => ({
  email: "guborong12345@gmail.com",
  planType: "plus",
  accountId,
  windows: [{ label: "5h", utilization: 42 }],
  ...extra,
})

// Pinned to the record actually on the user's machine: id=openai:78bbaee7-552a-4dce-947e-b733bb24aac9
// carries label "ChatGPT 78bbaee7". Writer and recogniser share this one constructor, so re-spelling
// the shape by hand on either side breaks here.
test("U16:占位符构造函数与线上真实记录逐字一致", () => {
  expect(placeholderOpenaiLabel(ACCT)).toBe("ChatGPT 78bbaee7")
})

test("U17:仍是占位符的占位者行 → 当场显示实时邮箱与套餐,不必等下次打开", () => {
  const account = stored(ACCT, placeholderOpenaiLabel(ACCT))
  const [row] = openaiRows({ accounts: [account], activeId: account.id, usage: liveOf(ACCT), loading: false })
  expect(row.label).toBe("guborong12345@gmail.com")
  expect(row.plan).toBe("plus")
})

// The README promises auto-capture never overwrites a hand-edited label; the DISPLAY side has to
// keep that promise as strictly as the persisted side does.
test("U18:用户改过名的账号 → 实时邮箱不顶掉它,套餐照常显示", () => {
  const account = stored(ACCT, "我的工作号")
  const [row] = openaiRows({ accounts: [account], activeId: account.id, usage: liveOf(ACCT), loading: false })
  expect(row.label).toBe("我的工作号")
  expect(row.plan).toBe("plus")
})

test("U19:非占位者行 → 用存储的 label,不蹭占位者的邮箱,也没有套餐", () => {
  const occupant = stored(ACCT, placeholderOpenaiLabel(ACCT))
  const other = stored(OTHER, placeholderOpenaiLabel(OTHER))
  const rows = openaiRows({ accounts: [occupant, other], activeId: occupant.id, usage: liveOf(ACCT), loading: false })
  expect(rows.map((row) => row.label)).toEqual(["guborong12345@gmail.com", placeholderOpenaiLabel(OTHER)])
  expect(rows.map((row) => row.plan)).toEqual(["plus", undefined])
})

// The worst failure available here: the pointer names A while the request authenticated as B. The
// email belongs to B, and "A is the active row" must never be enough to stamp it onto A — that is
// the panel asserting a false identity, the exact class of bug this feature exists to remove.
test("U20:活跃指针与请求认证的 accountId 不一致 → 邮箱不落到活跃行上", () => {
  const account = stored(OTHER, placeholderOpenaiLabel(OTHER))
  const [row] = openaiRows({ accounts: [account], activeId: account.id, usage: liveOf(ACCT), loading: false })
  expect(row.label).toBe(placeholderOpenaiLabel(OTHER))
  expect(row.label).not.toBe("guborong12345@gmail.com")
  expect(row.plan).toBeUndefined()
})

test("U21:拿不到邮箱(needsReauth / 报错 / 字段缺失) → label 与套餐一律不动", () => {
  const account = stored(ACCT, placeholderOpenaiLabel(ACCT))
  const cases: OpenaiUsage[] = [
    { windows: [], needsReauth: true, accountId: ACCT },
    { windows: [], error: "用量请求失败 (503)", accountId: ACCT },
    { windows: [], accountId: ACCT },
    liveOf(ACCT, { email: undefined }),
  ]
  for (const usage of cases) {
    const [row] = openaiRows({ accounts: [account], activeId: account.id, usage, loading: false })
    expect(row.label).toBe(placeholderOpenaiLabel(ACCT))
  }
})

// No accountId on the response means no ChatGPT-Account-Id header was sent, so attribution is
// simply unknown — and no row may claim it on a guess.
test("U22:响应不带 accountId → 无法归属,谁都不认领这份邮箱", () => {
  const account = stored(ACCT, placeholderOpenaiLabel(ACCT))
  const [row] = openaiRows({ accounts: [account], activeId: account.id, usage: liveOf(ACCT, { accountId: undefined }), loading: false })
  expect(row.label).toBe(placeholderOpenaiLabel(ACCT))
  expect(row.plan).toBeUndefined()
})

// ── worker 面板(账号池用量) ────────────────────────────────────────────────────────────────
// 快照只带 id 前缀,租约带完整 id,所以"这一行是不是我持有的那个号"永远是前缀判定。
const HELD = "3f9c1a20-77bd-4c11-8e0e-2a55d9f0c4b1"
const pooled = (idPrefix: string) => ({ idPrefix })

// 三态必须原样保留:undefined 是"这台机器还没租过号,不知道",渲染成空白标记;
// 一旦被压成 false,每一行都会被扣上一个笃定的 ○("我不持有这个"),那是在替它撒谎。
test("U23:持有判定三态 —— 不知道保持 undefined,前缀命中为 true,不命中为 false", () => {
  expect(heldStateFor("3f9c1a20", undefined)).toBeUndefined()
  expect(heldStateFor("3f9c1a20", HELD)).toBe(true)
  expect(heldStateFor("0f1e2d3c", HELD)).toBe(false)
})

// 和 heldStateFor 相反:pin 只有两态。pin 只存在于本机的 kv 里,读它永远读得出结论,
// 所以这里没有"还不知道"这一档 —— 补一档就等于凭空造出一个 UI 画不出来的状态。
// 存的是前缀还是完整 id 都能命中(worker 存前缀,面板拿到的行也是前缀),这一条把两种都钉住。
test("U23b:钉住判定只有两态 —— 未钉住为 false,前缀命中为 true", () => {
  expect(pinnedStateFor("3f9c1a20", undefined)).toBe(false)
  expect(pinnedStateFor("3f9c1a20", HELD)).toBe(true)
  expect(pinnedStateFor("3f9c1a20", "3f9c1a20")).toBe(true)
  expect(pinnedStateFor("0f1e2d3c", HELD)).toBe(false)
})

// issue #29:箭头恒停在第一行。初始选中必须由 ● 那一行(持有行)决定,和标记同一条判定。
test("U24:worker 面板初始选中落在持有的那一行", () => {
  const accounts = [pooled("0f1e2d3c"), pooled("78bbaee7"), pooled("3f9c1a20")]
  expect(initialWorkerSelection(accounts, HELD)).toBe(2)
  expect(heldStateFor(accounts[initialWorkerSelection(accounts, HELD)].idPrefix, HELD)).toBe(true)
})

test("U25:没有持有的号 / 持有的号不在快照里 → 退回第一行", () => {
  const accounts = [pooled("0f1e2d3c"), pooled("78bbaee7")]
  expect(initialWorkerSelection(accounts, undefined)).toBe(0)
  expect(initialWorkerSelection(accounts, HELD)).toBe(0)
  expect(initialWorkerSelection([], HELD)).toBe(0)
})

const WIDE = 200

test("U26:账号数不超过阈值 → 单列 medium,超过才换成双列 xlarge", () => {
  expect(poolLayout(6, WIDE)).toMatchObject({ columns: 1, size: "medium" })
  expect(poolLayout(7, WIDE)).toMatchObject({ columns: 2, size: "xlarge" })
  expect(poolLayout(0, WIDE)).toMatchObject({ columns: 1, size: "medium" })
})

// 终端不够宽时 host 会把弹窗压到 terminalWidth − 2,第二列会被裁掉半截 —— 宁可退回单列。
test("U27:窄终端即使账号很多也退回单列", () => {
  expect(poolLayout(9, 80)).toMatchObject({ columns: 1, size: "medium" })
  expect(poolLayout(9, 100)).toMatchObject({ columns: 2, size: "xlarge" })
})

// 内容宽度是分隔线的长度,必须跟着弹窗实际拿到的宽度走,不能按标称尺寸写死。
test("U28:内容宽度取标称尺寸与终端上限的较小者", () => {
  expect(poolLayout(3, WIDE).contentWidth).toBe(56)
  expect(poolLayout(9, WIDE).contentWidth).toBe(112)
  expect(poolLayout(3, 40).contentWidth).toBe(34)
})

// 列宽必须把内容宽吃满 —— 之前写死 45,双列只用到 94/112,右边 18 格白扔,标题行也就没地方放持有者。
test("U28b:列宽吃满内容宽,不留尾部死空间", () => {
  const two = poolLayout(9, WIDE)
  expect(two.columnWidth).toBe(54)
  expect(two.columnWidth * two.columns + POOL_COLUMN_GAP * (two.columns - 1)).toBe(two.contentWidth)
  expect(poolLayout(3, WIDE).columnWidth).toBe(56)
})

// 列主序:↑↓ 走的是扁平列表,所以第一列必须是前 ceil(n/cols) 个,光标才是往下走而不是左右横跳。
test("U29:分列按列主序切分,余数落在最后一列", () => {
  expect(poolColumns([1, 2, 3, 4, 5, 6, 7, 8, 9], 2)).toEqual([
    [1, 2, 3, 4, 5],
    [6, 7, 8, 9],
  ])
  expect(poolColumns([1, 2, 3], 1)).toEqual([[1, 2, 3]])
  expect(poolColumns([], 2)).toEqual([])
})

// 空列还是会吃掉一个 gap,把网格顶歪,所以列数按 rows 反推而不是照单全收。
test("U30:账号数撑不满请求的列数时不产生空列", () => {
  expect(poolColumns([1, 2, 3, 4], 3)).toEqual([
    [1, 2],
    [3, 4],
  ])
})

// 9 个号分两列 → 每列 5 行,所以左列第 i 行和右列第 i 行在扁平列表里差 5。
test("U31:←→ 跨一整列,左右对位", () => {
  expect(poolStepColumn(0, 1, 9, 2)).toBe(5)
  expect(poolStepColumn(5, -1, 9, 2)).toBe(0)
  expect(poolStepColumn(2, 1, 9, 2)).toBe(7)
})

// 真机上发现的:边界必须是"原地不动",不能是把扁平下标夹到 0。夹取会让最左列按 ← 跳到第 0 行 ——
// 一个水平键产生了垂直位移,既不是"往左"也不是"没动"。
test("U32:最外侧列按向外方向 = 原地不动,不产生垂直位移", () => {
  expect(poolStepColumn(1, -1, 9, 2)).toBe(1)
  expect(poolStepColumn(4, -1, 9, 2)).toBe(4)
  expect(poolStepColumn(6, 1, 9, 2)).toBe(6)
})

// 右列只有 4 行,左列第 5 行按 → 没有对位行,落到右列末行而不是越界。
test("U33:短列按 → 落到该列末行", () => {
  expect(poolStepColumn(4, 1, 9, 2)).toBe(8)
  expect(poolStepColumn(8, -1, 9, 2)).toBe(3)
})

// 单列时 ±rows 就是 ±length,不加这道闸门,→ 会把光标从任意位置直接甩到最后一个账号。
test("U34:单列时 ←→ 是空操作", () => {
  expect(poolStepColumn(2, 1, 5, 1)).toBe(2)
  expect(poolStepColumn(2, -1, 5, 1)).toBe(2)
})

// 4 个号请求 3 列时 poolColumns 只画 2 列,步进必须按实画列数判界,否则光标会走进一个不存在的列。
test("U35:请求列数多于实画列数时不越到空列", () => {
  expect(poolColumns([1, 2, 3, 4], 3)).toHaveLength(2)
  expect(poolStepColumn(2, 1, 4, 3)).toBe(2)
  expect(poolStepColumn(0, 1, 4, 3)).toBe(2)
})

// 按 .length 量会把 `冷却中` 算成 3 而不是 6,标题行预算就会多出 3 格,持有者名被列的 overflow 裁掉。
// 而 ●○▶░█─ 这些"歧义宽度"字符在终端里是 1 格,一旦被算成 2,进度条和分隔线全部错位。
test("U36:宽度按终端格数算 —— 中文双宽,方块与箭头单宽", () => {
  expect(displayWidth("冷却中")).toBe(6)
  expect(displayWidth("需重新登录")).toBe(10)
  expect(displayWidth("9 个账号")).toBe(8)
  expect(displayWidth("vince-local")).toBe(11)
  expect(displayWidth("●○▶░█─")).toBe(6)
})

test("U37:持有者放得下就全列出,名字之间各占一格间隔", () => {
  expect(holderChips(["vince-local"], 20)).toEqual({ names: ["vince-local"], overflow: 0 })
  expect(holderChips(["vince-local", "mac-mini"], 20)).toEqual({
    names: ["vince-local", "mac-mini"],
    overflow: 0,
  })
  expect(holderChips([], 20)).toEqual({ names: [], overflow: 0 })
})

// 从尾部往下丢,且每丢一个都要重新量 —— `+N` 后缀是丢了名字才出现的,它自己也占宽度。
test("U38:放不下时从尾部丢名字并补 +N", () => {
  expect(holderChips(["vince-local", "mac-mini", "ci-01"], 20)).toEqual({
    names: ["vince-local"],
    overflow: 2,
  })
  // `aaa bbb ccc` 正好 11 格,所以 11 全放得下;10 才逼出 `aaa bbb +1`(3+1+3+1+2 = 10)。
  expect(holderChips(["aaa", "bbb", "ccc"], 11)).toEqual({ names: ["aaa", "bbb", "ccc"], overflow: 0 })
  expect(holderChips(["aaa", "bbb", "ccc"], 10)).toEqual({ names: ["aaa", "bbb"], overflow: 1 })
})

// 一个名字都放不下也要让运维知道这个号被占着 —— 光秃秃的 +N 比什么都不显示诚实。
test("U39:一个名字都放不下时退化成裸 +N,再不够才彻底不显示", () => {
  expect(holderChips(["a-very-long-worker-id", "b"], 4)).toEqual({ names: [], overflow: 2 })
  expect(holderChips(["a-very-long-worker-id", "b"], 1)).toEqual({ names: [], overflow: 0 })
  expect(holderChips(["vince-local"], 0)).toEqual({ names: [], overflow: 0 })
})
