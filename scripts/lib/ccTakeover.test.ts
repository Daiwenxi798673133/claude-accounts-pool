import { expect, test } from "bun:test"
import {
  addShellBlock,
  addWrapper,
  mergeWorker,
  normalizeMasterUrl,
  parseClaudeVersion,
  parseManifest,
  proxyEnv,
  removeShellBlock,
  removeWrapper,
  renderClaudeShim,
  renderLauncher,
  renderPlist,
  revertWorker,
  senpiLabelFor,
  shellBlock,
  SHELL_BLOCK_BEGIN,
  validateWorkerId,
  versionAtLeast,
  wrapperValue,
  WRAPPER_VAR,
} from "./ccTakeover.ts"

test("master 地址:ip:port 补上 http://,已有的协议保留,末尾斜杠去掉", () => {
  expect(normalizeMasterUrl("100.64.0.36:8787")).toEqual({ ok: true, url: "http://100.64.0.36:8787" })
  expect(normalizeMasterUrl(" https://pool.example:443/ ")).toEqual({ ok: true, url: "https://pool.example" })
  expect(normalizeMasterUrl("http://10.0.0.5:8787")).toEqual({ ok: true, url: "http://10.0.0.5:8787" })
})

test("master 地址:空、非 http、带路径都拒绝,并说清楚要什么", () => {
  expect(normalizeMasterUrl("").ok).toBe(false)
  expect(normalizeMasterUrl("ftp://x:21").ok).toBe(false)
  const withPath = normalizeMasterUrl("10.0.0.5:8787/v1/health")
  expect(withPath.ok).toBe(false)
  expect(!withPath.ok && withPath.reason).toContain("不要路径")
})

test("WorkerID 按 master 认的标签格式校验", () => {
  expect(validateWorkerId(" vince-mbp ")).toEqual({ ok: true, id: "vince-mbp" })
  expect(validateWorkerId("has space").ok).toBe(false)
  expect(validateWorkerId("").ok).toBe(false)
  expect(validateWorkerId("x".repeat(65)).ok).toBe(false)
})

test("claude 版本号解析与比较", () => {
  expect(parseClaudeVersion("2.1.280 (Claude Code)")).toBe("2.1.280")
  expect(versionAtLeast("2.1.280", "2.1.208")).toBe(true)
  expect(versionAtLeast("2.1.208", "2.1.208")).toBe(true)
  expect(versionAtLeast("2.1.207", "2.1.208")).toBe(false)
  expect(versionAtLeast("2.2.0", "2.1.208")).toBe(true)
})

// Claude Code 把这个值当参数列表解析:空白分词,不做 shell 展开。
test("启动器路径带空格时用 JSON 数组形式,否则是裸路径", () => {
  expect(wrapperValue("/Users/a/.claude-accounts-pool/bin/claude-pool-launch")).toBe("/Users/a/.claude-accounts-pool/bin/claude-pool-launch")
  expect(wrapperValue("/Users/a b/x")).toBe('["/Users/a b/x"]')
})

test("settings:加上我们的键,别人的设置一个不动", () => {
  const before = { theme: "dark", env: { FOO: "bar" }, permissions: { allow: ["Bash(ls)"] } }
  const plan = addWrapper(before, "/l")
  expect(plan.ok).toBe(true)
  if (!plan.ok) return
  expect(plan.config).toEqual({ theme: "dark", env: { FOO: "bar", [WRAPPER_VAR]: "/l" }, permissions: { allow: ["Bash(ls)"] } })
  expect(plan.createdEnv).toBe(false)
  expect(before.env).toEqual({ FOO: "bar" }) // 不改入参
})

test("settings:没有 env 块时新建,并记下是我们建的", () => {
  const plan = addWrapper({}, "/l")
  expect(plan.ok && plan.createdEnv).toBe(true)
})

test("settings:已经是我们的值 → 不改;是别人的启动器 → 拒绝,不叠加", () => {
  const same = addWrapper({ env: { [WRAPPER_VAR]: "/l" } }, "/l")
  expect(same.ok && same.changed).toBe(false)
  expect(addWrapper({ env: { [WRAPPER_VAR]: "/corp/launcher" } }, "/l").ok).toBe(false)
  expect(addWrapper({ processWrapper: "/corp/launcher" }, "/l").ok).toBe(false)
  expect(addWrapper({ env: "oops" }, "/l").ok).toBe(false)
})

test("settings 撤回:只删我们的值;我们建的 env 空了就一起删", () => {
  expect(removeWrapper({ env: { FOO: "bar", [WRAPPER_VAR]: "/l" } }, "/l", false).config).toEqual({ env: { FOO: "bar" } })
  expect(removeWrapper({ theme: "x", env: { [WRAPPER_VAR]: "/l" } }, "/l", true).config).toEqual({ theme: "x" })
  // 原本就有 env(哪怕现在空了)不删 env 本身。
  expect(removeWrapper({ env: { [WRAPPER_VAR]: "/l" } }, "/l", false).config).toEqual({ env: {} })
})

test("settings 撤回:值被人改成了别的启动器 → 不动", () => {
  const out = removeWrapper({ env: { [WRAPPER_VAR]: "/corp" } }, "/l", false)
  expect(out.changed).toBe(false)
})

test("shell rc:追加在最末尾;重跑原位替换,不重复", () => {
  const original = "export PATH=\"$HOME/.local/bin:$PATH\"\nalias ll='ls -l'\n"
  const once = addShellBlock(original, shellBlock("/Users/a/.claude-accounts-pool/bin"))
  expect(once.text.startsWith(original)).toBe(true)
  expect(once.text.trimEnd().endsWith("# <<< claude-accounts-pool (make setup) <<<")).toBe(true)
  const twice = addShellBlock(once.text, shellBlock("/Users/a/.claude-accounts-pool/bin"))
  expect(twice.changed).toBe(false)
  expect(twice.text.split(SHELL_BLOCK_BEGIN)).toHaveLength(2)
})

test("shell rc:撤回后与原文逐字节相同", () => {
  for (const original of ["", "a\n", "a\n\n", "export X=1\n# end\n"]) {
    const added = addShellBlock(original, shellBlock("/b")).text
    expect(removeShellBlock(added).text).toBe(original)
  }
})

// 唯一的例外:原文末尾没有换行。追加时记不住"原来有没有",撤回后多一个结尾换行 —— 对 shell rc 无害。
test("shell rc:原文末尾没有换行时,撤回后补上一个", () => {
  expect(removeShellBlock(addShellBlock("a", shellBlock("/b")).text).text).toBe("a\n")
})

test("shell rc:PATH 段里的路径被正确转义", () => {
  expect(shellBlock('/Users/a"b/$x/bin')).toContain('export PATH="/Users/a\\"b/\\$x/bin:$PATH"')
})

// 两条链共用一个标签,master 会给同一个号记重账;omo 装上之后还会自动用它租号。
test("池子配置:新机器上 senpi 标签与看板名字不同", () => {
  const out = mergeWorker(undefined, "http://m:8787", "vince-mbp")
  expect(out.next).toEqual({ version: 1, masterUrl: "http://m:8787", workerId: "vince-mbp.senpi", ccWorkerId: "vince-mbp" })
})

test("senpi 标签:加后缀会超长时截短,结果仍是合法标签", () => {
  expect(senpiLabelFor("a")).toBe("a.senpi")
  const long = senpiLabelFor("x".repeat(64))
  expect(long.length).toBe(64)
  expect(long.endsWith(".senpi")).toBe(true)
})

// 这个文件与 senpi 共用:它的 workerId 是 senpi 那条链的身份,不能被 Claude Code 的接管改掉。
test("池子配置:已有 senpi 标签时保留它,只设 ccWorkerId 与 master", () => {
  const existing = { version: 1, masterUrl: "http://old:8787", workerId: "vince-local.senpi", slots: 1 }
  const out = mergeWorker(existing, "http://m:8787", "vince-mbp")
  expect(out.next).toEqual({ version: 1, masterUrl: "http://m:8787", workerId: "vince-local.senpi", slots: 1, ccWorkerId: "vince-mbp" })
  expect(mergeWorker(out.next, "http://m:8787", "vince-mbp").changed).toBe(false)
})

test("池子配置撤回:setup 建的删掉,setup 改的改回去;之后被人改过就保留", () => {
  const after = { version: 1, masterUrl: "http://m", workerId: "w", ccWorkerId: "w" }
  expect(revertWorker(after, { path: "p", created: true, after })).toEqual({ action: "delete" })
  const before = { version: 1, masterUrl: "http://old", workerId: "s" }
  expect(revertWorker(after, { path: "p", created: false, before, after })).toEqual({ action: "write", next: before })
  expect(revertWorker({ ...after, masterUrl: "http://other" }, { path: "p", created: true, after }).action).toBe("keep")
})

test("启动器:清单或仓库不在就原样 exec;否则先注入再 exec", () => {
  const text = renderLauncher({ bun: "/b/bun", repo: "/r", manifest: "/h/.claude-accounts-pool/cc-takeover.json" })
  expect(text.startsWith("#!/bin/sh\n")).toBe(true)
  expect(text).toContain("if [ -f '/h/.claude-accounts-pool/cc-takeover.json' ] && [ -f '/r/claude-pool-env.ts' ]; then")
  expect(text).toContain(`pool_env=$('/b/bun' '/r/claude-pool-env.ts' "$$") || exit $?`)
  expect(text.trimEnd().endsWith('exec "$@"')).toBe(true)
})

test("路径里的单引号被转义,不会把生成的脚本拆开", () => {
  const shim = renderClaudeShim({ launcher: "/h/it's/launch", realClaude: "/usr/local/bin/claude" })
  expect(shim).toContain(`exec '/h/it'\\''s/launch' '/usr/local/bin/claude' "$@"`)
})

test("launchd 任务:常驻、崩溃重启、不闲置退出,带上代理变量,路径做 XML 转义", () => {
  const plist = renderPlist({
    bun: "/b/bun",
    repo: "/r&d",
    home: "/h",
    logPath: "/h/.claude-accounts-pool/cc-relay.log",
    path: "/b:/usr/bin",
    extraEnv: proxyEnv({ HTTPS_PROXY: "http://proxy:3128", UNRELATED: "x" }),
  })
  expect(plist).toContain("<key>KeepAlive</key><true/>")
  expect(plist).toContain("<key>CAP_CC_RELAY_RESIDENT</key><string>1</string>")
  expect(plist).toContain("<key>HTTPS_PROXY</key><string>http://proxy:3128</string>")
  expect(plist).not.toContain("UNRELATED")
  expect(plist).toContain("<string>/r&amp;d/claude-pool-relay.ts</string>")
})

test("清单:认得出自己的形状,认不出的一律不当清单", () => {
  expect(parseManifest({ version: 1, repo: "/r", generated: [], installedAt: "", updatedAt: "" })).toBeDefined()
  expect(parseManifest({ version: 2, repo: "/r", generated: [] })).toBeUndefined()
  expect(parseManifest("x")).toBeUndefined()
})
