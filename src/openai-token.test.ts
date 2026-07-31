import { expect, test, afterAll } from "bun:test"
import { isPermanentRefreshFailure, refreshOpenaiToken, OpenaiRefreshRevokedError } from "./openai-token.ts"

// No mock.module here on purpose: earlier test files install process-global partial stubs
// that cannot be undone (see usage.test.ts header), so this file only stubs fetch.
const realFetch = globalThis.fetch
afterAll(() => {
  globalThis.fetch = realFetch
})

type SeenRequest = { url: string; headers: Record<string, string>; body: string }
let seen: SeenRequest | undefined

const stubFetch = (respond: () => Response): void => {
  seen = undefined
  globalThis.fetch = (async (url: string, init: { headers: Record<string, string>; body: BodyInit }) => {
    seen = { url: String(url), headers: init.headers, body: String(init.body) }
    return respond()
  }) as unknown as typeof fetch
}

const jsonRes = (payload: unknown, status = 200) => new Response(JSON.stringify(payload), { status })
const okBody = { id_token: "", access_token: "a2", refresh_token: "r2", expires_in: 900 }
const jwt = (claims: Record<string, unknown>) => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`
const REVOKED_CODES = ["refresh_token_expired", "refresh_token_reused", "refresh_token_invalidated"]

const accountIdOf = async (idToken: unknown): Promise<string | undefined> => {
  stubFetch(() => jsonRes({ ...okBody, id_token: idToken }))
  return (await refreshOpenaiToken("r1")).accountId
}

// OpenCode's built-in codex plugin posts form-urlencoded to this endpoint; the Rust Codex
// CLI posts JSON. Sending JSON would diverge from the client that owns the auth entry, so
// the wire format is asserted rather than assumed.
test("K1:刷新请求以 form-urlencoded 提交(绝不是 JSON),带 grant_type / refresh_token / client_id", async () => {
  stubFetch(() => jsonRes(okBody))
  await refreshOpenaiToken("r1")
  expect(seen?.url).toBe("https://auth.openai.com/oauth/token")
  expect(seen?.headers["Content-Type"]).toBe("application/x-www-form-urlencoded")
  const form = new URLSearchParams(seen!.body)
  expect([...form.keys()].sort()).toEqual(["client_id", "grant_type", "refresh_token"])
  expect(form.get("grant_type")).toBe("refresh_token")
  expect(form.get("refresh_token")).toBe("r1")
  expect(form.get("client_id")).toBe("app_EMoamEEZ73f0CkXaXp7hrann")
  expect(() => JSON.parse(seen!.body) as unknown).toThrow()
})

test("K2:expires_in 给出时按其换算 expires,并原样返回轮换后的 access / refresh", async () => {
  stubFetch(() => jsonRes(okBody))
  const before = Date.now()
  const out = await refreshOpenaiToken("r1")
  expect(out.access).toBe("a2")
  expect(out.refresh).toBe("r2")
  expect(out.expires).toBeGreaterThanOrEqual(before + 900_000)
  expect(out.expires).toBeLessThanOrEqual(Date.now() + 900_000)
})

test("K3:expires_in 缺失 → 回退 3600 秒,不产出 NaN", async () => {
  stubFetch(() => jsonRes({ access_token: "a2", refresh_token: "r2" }))
  const before = Date.now()
  const out = await refreshOpenaiToken("r1")
  expect(Number.isFinite(out.expires)).toBe(true)
  expect(out.expires).toBeGreaterThanOrEqual(before + 3_600_000)
  expect(out.expires).toBeLessThanOrEqual(Date.now() + 3_600_000)
})

test("K4:三个吊销码出现在 error.code → OpenaiRefreshRevokedError,带上码与原 refresh", async () => {
  for (const code of REVOKED_CODES) {
    stubFetch(() => jsonRes({ error: { code, message: "nope" } }, 400))
    const error = await refreshOpenaiToken("r1").catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OpenaiRefreshRevokedError)
    expect((error as OpenaiRefreshRevokedError).code).toBe(code)
    expect((error as OpenaiRefreshRevokedError).refresh).toBe("r1")
  }
})

test("K5:三个吊销码出现在顶层 code → 同样判定为永久吊销", async () => {
  for (const code of REVOKED_CODES) {
    stubFetch(() => jsonRes({ code, message: "nope" }, 400))
    const error = await refreshOpenaiToken("r1").catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OpenaiRefreshRevokedError)
    expect((error as OpenaiRefreshRevokedError).code).toBe(code)
  }
})

test("K6:400 / 401 + invalid_grant → 永久吊销", async () => {
  for (const status of [400, 401]) {
    stubFetch(() => jsonRes({ error: "invalid_grant" }, status))
    const error = await refreshOpenaiToken("r1").catch((err: unknown) => err)
    expect(error).toBeInstanceOf(OpenaiRefreshRevokedError)
    expect((error as OpenaiRefreshRevokedError).code).toBe("invalid_grant")
  }
})

// The whole point of the classifier: an outage must stay retryable. Misreading a 5xx as
// permanent would brand a healthy account "需重新登录" and drop it from the pool forever.
test("K7:500 + HTML 错误页 → 普通 Error(绝不是 OpenaiRefreshRevokedError)", async () => {
  stubFetch(() => new Response("<html><body>502 Bad Gateway</body></html>", { status: 500 }))
  const error = await refreshOpenaiToken("r1").catch((err: unknown) => err)
  expect(error).toBeInstanceOf(Error)
  expect(error).not.toBeInstanceOf(OpenaiRefreshRevokedError)
  expect((error as Error).message).toContain("500")
})

test("K8:429 与空体 / 非 JSON / 数组体一律判为可重试,解析器绝不抛错", () => {
  expect(isPermanentRefreshFailure(429, "")).toBe(false)
  expect(isPermanentRefreshFailure(500, "<html>nope</html>")).toBe(false)
  expect(isPermanentRefreshFailure(400, "not json at all")).toBe(false)
  expect(isPermanentRefreshFailure(400, "[]")).toBe(false)
  expect(isPermanentRefreshFailure(400, "null")).toBe(false)
  // invalid_grant is terminal ONLY on 400/401; the same body on a 5xx is an outage.
  expect(isPermanentRefreshFailure(503, JSON.stringify({ error: "invalid_grant" }))).toBe(false)
  expect(isPermanentRefreshFailure(400, JSON.stringify({ error: "invalid_grant" }))).toBe(true)
  // A rotation verdict stands regardless of the status it arrived with.
  expect(isPermanentRefreshFailure(403, JSON.stringify({ code: "refresh_token_reused" }))).toBe(true)
})

test("K9:accountId 取自命名空间 claim,并优先于扁平 claim 与 organizations", async () => {
  const id = await accountIdOf(
    jwt({
      "https://api.openai.com/auth": { chatgpt_account_id: "acct-ns" },
      chatgpt_account_id: "acct-flat",
      organizations: [{ id: "org-1" }],
    }),
  )
  expect(id).toBe("acct-ns")
})

test("K10:命名空间 claim 缺失 → 退到扁平 chatgpt_account_id,再退到 organizations[0].id", async () => {
  expect(await accountIdOf(jwt({ chatgpt_account_id: "acct-flat" }))).toBe("acct-flat")
  expect(await accountIdOf(jwt({ organizations: [{ id: "org-1" }] }))).toBe("org-1")
})

test("K11:id_token 缺失 / 非字符串 / 畸形 → accountId 为 undefined,绝不因此让刷新失败", async () => {
  for (const idToken of [undefined, null, 42, "", "not-a-jwt", "a.@@@@.c", jwt({}), "a..c"]) {
    expect(await accountIdOf(idToken)).toBeUndefined()
  }
})

// Rotation makes a blank tip unrecoverable: writing it back would strand the account.
test("K12:200 但缺 access_token / refresh_token → 诚实报错,绝不返回空 token", async () => {
  for (const payload of [{ access_token: "a2" }, { refresh_token: "r2" }, {}]) {
    stubFetch(() => jsonRes(payload))
    const error = await refreshOpenaiToken("r1").catch((err: unknown) => err)
    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(OpenaiRefreshRevokedError)
  }
})
