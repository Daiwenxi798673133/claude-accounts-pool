// E2E — 云模式租借链路的端到端验收证据(S5 鉴权三连 + S1 worker 写盘)。
//
// 这不是单元测试,是【验收证据】:每一条断言都必须来自真实进程、真实端口、真实 curl、真实文件。
//   · master 跑在独立子进程里,用的是真的 startLeaseServer(port=0,只绑 127.0.0.1)。
//   · S5 的三次请求走 /usr/bin/curl,不是 Bun 的 fetch —— 状态码由真实 HTTP 客户端观测。
//   · S1 的写盘由第二个子进程完成,跑的是真的 leaseClient + leaseKeeper + writeAuthAnthropic。
//
// 两条不可逾越的安全边界:
//   1) 绝不打 Anthropic。refresher 是桩,返回的 access 带 FAKE_ACCESS_PREFIX 前缀,一眼可辨。
//   2) 绝不碰真实的 ~/.local/share/opencode/auth.json。src/accounts.ts 在【模块加载时】就用
//      homedir() 定死了路径,所以在本进程里改 process.env.HOME 是【无效】的 —— 只有给子进程
//      单独指定 env(HOME + XDG_DATA_HOME)才能真正沙箱化,这也是 worker 必须是子进程的原因。
//
//   bun scripts/e2e-lease.ts     # 全部通过则打印 E2E PASS 并 exit 0;任一断言失败 exit 1

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CLOUD_ROUTES } from "../src/cloud/protocol.ts"
import { SENTINEL_REFRESH } from "../src/constants.ts"
import { redactBody } from "../src/logger.ts"

const POOL_KEY = "e2e-pool-key-0123456789"
const WRONG_KEY = "wrong-key"
const WORKER_ID = "e2e-worker-1"
const ACCOUNT_ID = "e2e-account-a"
// 前缀而非完整 token:master 桩把它拼上 accountId 返回,读输出的人一眼就知道这不是真凭据。
const FAKE_ACCESS_PREFIX = "e2e-fake-access-"
const LEASE_TTL_MS = 3_600_000
const BOOT_DEADLINE_MS = 15_000
const HEALTH_DEADLINE_MS = 10_000
const WORKER_DEADLINE_MS = 60_000
const HR = "═".repeat(78)

const src = (...parts: string[]): string => join(import.meta.dir, "..", "src", ...parts)

const failures: string[] = []

function checkThat(label: string, ok: boolean, detail: string): void {
  console.log(`     ${ok ? "✔" : "✘"} ${label} — ${detail}`)
  if (!ok) failures.push(`${label} — ${detail}`)
}

function checkEqual(label: string, expected: string, actual: string): void {
  checkThat(label, expected === actual, `expected ${expected}, actual ${actual}`)
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

function rejectAfter(ms: number, message: string): Promise<never> {
  return new Promise((_resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    timer.unref?.()
  })
}

// 同 gate0 脚本:token 永远不整个打印,只留前 8 位 + 长度,输出可以直接贴进验收记录。
const redactToken = (value: string): string => `${value.slice(0, 8)}…(len=${value.length})`
const showAccess = (value: unknown): string => (typeof value === "string" ? redactToken(value) : JSON.stringify(value))
const isNonEmpty = (value: unknown): value is string => typeof value === "string" && value.length > 0
const isFuture = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value > Date.now()

// 失败时必须同时给出「期望」和「实到」,还要把 epoch 翻成人能读的 ISO —— 否则一串毫秒数说明不了任何事。
function futureDetail(value: unknown): string {
  const iso = typeof value === "number" && Number.isFinite(value) ? ` (${new Date(value).toISOString()})` : ""
  return `expected number > ${Date.now()}, actual ${JSON.stringify(value)}${iso}`
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

type CurlResult = { exitCode: number; status: number; body: string; stderr: string }

// 真 curl,不是 fetch。body 走 -o 落文件、stdout 只留 %{http_code},所以状态码与响应体的切分是
// 无歧义的(响应体里带换行也不会串味)。连不上时 curl 打印 000,正好当作「还没起来」。
async function curl(args: readonly string[], bodyPath: string): Promise<CurlResult> {
  rmSync(bodyPath, { force: true })
  const argv = ["curl", "-sS", "--max-time", "15", "-o", bodyPath, "-w", "%{http_code}", ...args]
  const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
  const [out, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  const status = Number.parseInt(out.trim(), 10)
  const body = existsSync(bodyPath) ? readFileSync(bodyPath, "utf8") : ""
  return { exitCode, status: Number.isFinite(status) ? status : 0, body, stderr }
}

// releaseLock 而不是 break/return 出 for-await:后者会 cancel 整条流、提前关掉子进程的 stdout 管道。
async function scanForPort(stream: ReadableStream<Uint8Array>): Promise<number> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const match = /E2E_PORT=(\d+)/.exec(buffered)
    if (match) {
      reader.releaseLock()
      return Number.parseInt(match[1], 10)
    }
  }
  reader.releaseLock()
  throw new Error(`master 子进程在打印 E2E_PORT 之前就关闭了 stdout;已读到: ${buffered.trim() || "(空)"}`)
}

const MASTER_SCRIPT = `
const { startLeaseServer } = await import(process.env.E2E_SERVER_MODULE)
const ttl = Number(process.env.E2E_LEASE_TTL_MS)
const id = process.env.E2E_ACCOUNT_ID
const controller = new AbortController()
const server = startLeaseServer({
  scheduler: { pickAccount: ({ accounts, exclude }) => accounts.find((a) => a.id !== exclude), reportRateLimit: () => {} },
  refresher: { getFreshAccess: async (accountId) => ({ access: process.env.E2E_FAKE_ACCESS_PREFIX + accountId, expiresAt: Date.now() + ttl }) },
  registry: { verify: (header) => (header === "Bearer " + process.env.E2E_POOL_KEY ? process.env.E2E_WORKER_ID : undefined) },
  loadAccounts: async () => [{ id, label: id + "@e2e.invalid", refresh: "e2e-master-only-refresh" }],
  hostname: "127.0.0.1",
  port: 0,
  signal: controller.signal,
})
console.log("E2E_PORT=" + server.port)
`

const WORKER_SCRIPT = `
const { createLeaseClient } = await import(process.env.E2E_CLIENT_MODULE)
const { installLeaseKeeper } = await import(process.env.E2E_KEEPER_MODULE)
const { getAuthJsonPath, readAuthAnthropic, writeAuthAnthropic } = await import(process.env.E2E_ACCOUNTS_MODULE)
// 成功路径一次都不会 sleep(首次请求就拿到 200);这个封顶只在失败路径生效,让 harness 快速失败,
// 而不是被 leaseClient 的 5s→300s 退避拖住十分钟。
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.min(ms, 250)))
const client = createLeaseClient({
  fetchImpl: fetch, sleep,
  masterUrl: process.env.E2E_MASTER_URL, poolKey: process.env.E2E_POOL_KEY, workerId: process.env.E2E_WORKER_ID,
})
const keeper = installLeaseKeeper({
  client, sleep,
  readAuth: () => readAuthAnthropic(),
  writeLease: ({ access, expires }) => writeAuthAnthropic({ kind: "lease", access, expires }),
  toast: ({ variant, message }) => console.log("E2E_TOAST " + variant + " " + message),
})
try {
  await keeper.tickOnce()
} finally {
  keeper.dispose()
}
console.log("E2E_AUTH_PATH=" + (await getAuthJsonPath()))
`

// 就绪判据是真实探针,不是固定 sleep:端口打印出来之后,还要 /v1/health 真的答 200 才算能收流量。
async function waitForHealth(base: string, bodyPath: string): Promise<CurlResult> {
  const deadline = Date.now() + HEALTH_DEADLINE_MS
  let last: CurlResult = { exitCode: -1, status: 0, body: "", stderr: "从未发起" }
  while (Date.now() < deadline) {
    last = await curl(["-X", "GET", `${base}${CLOUD_ROUTES.health}`], bodyPath)
    if (last.status === 200) return last
    await sleep(100)
  }
  throw new Error(
    `master 在 ${HEALTH_DEADLINE_MS}ms 内没有在 ${CLOUD_ROUTES.health} 上答 200(last status=${last.status}, curl exit=${last.exitCode}, stderr=${last.stderr.trim()})`,
  )
}

function leaseArgs(base: string, authorization?: string): string[] {
  const auth = authorization === undefined ? [] : ["-H", `Authorization: ${authorization}`]
  const body = JSON.stringify({ workerId: WORKER_ID, reason: "prelease" })
  return ["-X", "POST", "-H", "Content-Type: application/json", ...auth, "-d", body, `${base}${CLOUD_ROUTES.lease}`]
}

function reportCurl(title: string, result: CurlResult): void {
  console.log(`  ${title}`)
  // redactBody 是本仓库自己的脱敏器,会把 "access":"…" 打成 "access":"***"。这里的 access 本来就是
  // 假的,但输出是要贴进验收记录的,所以照样按 token 处理;真实取值另行以「前 8 位 + 长度」单列。
  console.log(`     status=${result.status}  body=${redactBody(result.body, 400) || "(空)"}`)
}

async function runCurlTrio(base: string, bodyPath: string): Promise<void> {
  console.log(`\n[2/3] S5 证据:三次真实 curl POST ${CLOUD_ROUTES.lease}`)

  const anonymous = await curl(leaseArgs(base), bodyPath)
  reportCurl("① 不带 Authorization 头", anonymous)
  checkEqual("无凭据必须被拒", "401", String(anonymous.status))

  const wrong = await curl(leaseArgs(base, `Bearer ${WRONG_KEY}`), bodyPath)
  reportCurl(`② Authorization: Bearer ${WRONG_KEY}`, wrong)
  checkEqual("错误 pool key 必须被拒", "401", String(wrong.status))

  const granted = await curl(leaseArgs(base, `Bearer ${POOL_KEY}`), bodyPath)
  reportCurl("③ Authorization: Bearer <已注册的 pool key>", granted)
  checkEqual("合法 pool key 必须放行", "200", String(granted.status))

  const lease = asRecord(parseJson(granted.body))
  const [accountId, access, expiresAt] = [lease?.["accountId"], lease?.["access"], lease?.["expiresAt"]]
  checkThat("200 响应体带非空 accountId", isNonEmpty(accountId), `expected 非空 string, actual ${JSON.stringify(accountId)}`)
  checkThat("200 响应体带非空 access", isNonEmpty(access), `expected 非空 string, actual ${showAccess(access)}`)
  checkThat("200 响应体带未来的 expiresAt", isFuture(expiresAt), futureDetail(expiresAt))
}

type WorkerRun = { exitCode: number; stdout: string; stderr: string }

async function runWorkerChild(base: string, home: string, data: string): Promise<WorkerRun> {
  const proc = Bun.spawn(["bun", "-e", WORKER_SCRIPT], {
    env: {
      ...process.env,
      // 必须由子进程的 env 指定:accounts.ts 在模块加载时就冻结了 homedir(),进程内改 env 无效。
      HOME: home,
      XDG_DATA_HOME: data,
      E2E_CLIENT_MODULE: src("worker", "leaseClient.ts"), E2E_KEEPER_MODULE: src("worker", "leaseKeeper.ts"),
      E2E_ACCOUNTS_MODULE: src("accounts.ts"), E2E_MASTER_URL: base, E2E_POOL_KEY: POOL_KEY, E2E_WORKER_ID: WORKER_ID,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  // 硬上限:worker 子进程无论如何都不许挂死在这里。
  const timer = setTimeout(() => proc.kill(), WORKER_DEADLINE_MS)
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  clearTimeout(timer)
  return { exitCode, stdout, stderr }
}

function assertAuthFile(run: WorkerRun, sandbox: string): void {
  const authPath = /E2E_AUTH_PATH=(.+)/.exec(run.stdout)?.[1]?.trim() ?? ""
  console.log(`  worker 自报的 auth.json 路径: ${authPath || "(未打印)"}`)
  const shownPath = authPath || "(未打印)"
  checkThat("写入路径必须落在临时沙箱内(证明没碰真实 auth.json)", authPath.startsWith(sandbox), `expected 前缀 ${sandbox}, actual ${shownPath}`)
  const exists = authPath !== "" && existsSync(authPath)
  checkThat("auth.json 必须真的存在", exists, `expected 文件存在, actual ${shownPath}`)
  if (!exists) return

  const file = asRecord(parseJson(readFileSync(authPath, "utf8")))
  const entry = asRecord(file?.["anthropic"])
  const [access, refresh, expires] = [entry?.["access"], entry?.["refresh"], entry?.["expires"]]

  console.log("  auth.json 内容(access 已脱敏;refresh 完整打印 —— 它是哨兵常量而非密钥,看见它本身就是本项检查的意义):")
  const shown = { ...file, anthropic: { ...entry, access: showAccess(access) } }
  for (const line of JSON.stringify(shown, null, 2).split("\n")) console.log(`    ${line}`)

  checkThat("anthropic.access 是非空字符串", isNonEmpty(access), `expected 非空 string, actual ${showAccess(access)}`)
  checkThat("anthropic.expires 晚于当前时刻", isFuture(expires), futureDetail(expires))
  // INV-CLOUD-1:opencode 1.18.9 会静默丢弃没有 refresh 字段的 anthropic 条目,所以租约必须带一个
  // refresh —— 且必须是这个可辨识的哨兵,而不是真 token。这一条就是整个云模式的文件级不变量。
  checkEqual("anthropic.refresh 必须是哨兵常量", SENTINEL_REFRESH, isNonEmpty(refresh) ? refresh : JSON.stringify(refresh))
}

async function main(): Promise<number> {
  const sandbox = mkdtempSync(join(tmpdir(), "cau-e2e-"))
  const workerHome = join(sandbox, "worker-home")
  const workerData = join(workerHome, ".local", "share")
  const curlBody = join(sandbox, "curl-body")
  mkdirSync(workerData, { recursive: true })

  console.log(`${HR}\n E2E:云模式租借链路(真实 lease server + 真实 curl + 真实 worker 写盘)\n${HR}`)
  console.log(`临时沙箱:              ${sandbox}`)
  console.log(`worker HOME:           ${workerHome}`)
  console.log(`worker XDG_DATA_HOME:  ${workerData}`)
  console.log("网络范围:              仅 127.0.0.1;refresher 是桩,全程不访问 Anthropic")

  let master: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined
  try {
    console.log("\n[1/3] 启动 master 子进程(真实 startLeaseServer, port=0)")
    master = Bun.spawn(["bun", "-e", MASTER_SCRIPT], {
      env: {
        ...process.env,
        E2E_SERVER_MODULE: src("master", "leaseServer.ts"), E2E_POOL_KEY: POOL_KEY, E2E_WORKER_ID: WORKER_ID,
        E2E_ACCOUNT_ID: ACCOUNT_ID, E2E_FAKE_ACCESS_PREFIX: FAKE_ACCESS_PREFIX, E2E_LEASE_TTL_MS: String(LEASE_TTL_MS),
      },
      stdout: "pipe",
      stderr: "pipe",
    })
    const boot = rejectAfter(BOOT_DEADLINE_MS, `master 子进程在 ${BOOT_DEADLINE_MS}ms 内没有打印端口`)
    const port = await Promise.race([scanForPort(master.stdout), boot])
    const base = `http://127.0.0.1:${port}`
    console.log(`  master pid=${master.pid} port=${port} base=${base}`)

    const health = await waitForHealth(base, curlBody)
    console.log(`  健康探针 GET ${CLOUD_ROUTES.health} → status=${health.status} body=${health.body.trim()}`)
    checkEqual("健康探针必须 200", "200", String(health.status))

    await runCurlTrio(base, curlBody)

    console.log("\n[3/3] S1 证据:真实 worker 子进程走完 lease → 写盘(HOME / XDG_DATA_HOME 已沙箱化)")
    const run = await runWorkerChild(base, workerHome, workerData)
    console.log(`  worker 子进程 exit=${run.exitCode}`)
    if (run.stderr.trim()) console.log(`  worker stderr: ${redactBody(run.stderr, 600)}`)
    checkEqual("worker 子进程必须正常退出", "0", String(run.exitCode))
    assertAuthFile(run, sandbox)
  } finally {
    master?.kill()
    if (master) await master.exited
    rmSync(sandbox, { recursive: true, force: true })
  }

  console.log(`\n${HR}`)
  if (failures.length === 0) {
    console.log(` E2E PASS\n${HR}`)
    return 0
  }
  console.log(` E2E FAIL —— ${failures.length} 项断言未通过\n${HR}`)
  for (const failure of failures) console.log(`  ✘ ${failure}`)
  return 1
}

try {
  process.exitCode = await main()
} catch (error) {
  // 与 Bun 自带的非零退出不重复:未捕获的异常只会打一堆栈、不会打裁决行,而验收记录绝不能有歧义。
  console.error(`\n运行失败: ${redactBody(error instanceof Error ? error.message : String(error), 600)}`)
  console.error("\nE2E FAIL —— harness 未跑完(操作性失败),上面的证据不完整。")
  process.exitCode = 1
}
