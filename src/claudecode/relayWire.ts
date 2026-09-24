// 本机中间层(relay)的线缆规则 —— 纯函数,不碰网络、不碰磁盘。
//
// 【relay 只换一个 header】。请求由真 `claude` 组装:计费首块、身份句、anthropic-beta、metadata 全是
// 客户端原生的,relay 把 Authorization 换成当前租约,其余一个字节不动。这正是它与
// docs/research/options-analysis.md 否掉的方案 A 的区别 —— A 的全部成本在伪装(§3.1.1),因为那里的
// 客户端是 opencode;这里没有要伪装的东西。所以本模块【永远不读、不改 body】,改 body 就是走上 A 那条
// 滑坡的第一步。
//
// 唯一的例外是 x-client-request-id:它是一个 header,原生客户端对 api.anthropic.com 每个请求都带,
// 只因为 base URL 指向了 127.0.0.1 才省掉(claude-code 源码 services/api/client.ts 的
// isFirstPartyAnthropicBaseUrl 门)。relay 的上游就是 api.anthropic.com,补回来是还原,不是伪装。

// 不向上游转发、也不向下游回传的头。逐跳头(RFC 9110 §7.6.1)属于这一跳的连接,不属于报文;
// host 必须由 fetch 按上游地址重填;content-length 由运行时按实际字节重算 —— 原样转发一个旧值,
// 遇到任何长度变化(下游被解压、被分块)就是一条截断或挂死的连接。
const NOT_FORWARDED = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
])

// 凭证头。进来的那枚一律丢掉:Authorization 是会话启动时冻结的那枚(可能早已换号或过期),
// x-api-key 出现说明客户端被配进了别的车道 —— 两者都不该到达上游,由当前租约取代。
const CREDENTIAL_HEADERS = new Set(["authorization", "x-api-key"])

import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib"
import { anthropicQuotaVerdict } from "../providers.ts"

export const CLIENT_REQUEST_ID_HEADER = "x-client-request-id"

/** 发往 api.anthropic.com 的请求头:原样照抄,只换凭证。 */
export function upstreamHeaders(incoming: Headers, access: string, newRequestId: () => string): Headers {
  const out = new Headers()
  incoming.forEach((value, key) => {
    if (NOT_FORWARDED.has(key) || CREDENTIAL_HEADERS.has(key)) return
    out.append(key, value)
  })
  out.set("authorization", `Bearer ${access}`)
  if (!out.has(CLIENT_REQUEST_ID_HEADER)) out.set(CLIENT_REQUEST_ID_HEADER, newRequestId())
  return out
}

/** 回给 claude 的响应头:原样照抄,只去掉逐跳头。content-encoding 保留 —— 上游字节不解压直接回传。 */
export function downstreamHeaders(upstream: Headers): Headers {
  const out = new Headers()
  upstream.forEach((value, key) => {
    if (NOT_FORWARDED.has(key)) return
    out.append(key, value)
  })
  return out
}

// 【什么样的 429 才算额度用满】—— 规则照抄客户端自己的分类,不是自己发明的
// (claude-code 源码 services/api/errors.ts 的 429 分支):带 `-representative-claim`(five_hour /
// seven_day / seven_day_opus)或 `-overage-status` 的是配额;两者都没有的 429 客户端自己的注释写着
// "this is NOT a quota limit",容量问题与权限问题(典型:「1M 上下文需要 Extra Usage」)都落在那里。
// 另认 `unified-status: rejected`,与 src/providers.ts 的 isAnthropicUsageLimit 同一个信号。
//
// 为什么必须这么窄:权限类 429 换到哪个号都一样。见 429 就换,relay 会把整个池子挨个切一遍,每一次
// 还附带一条冤枉的限流上报。429 之外(529 overloaded、5xx)一律不算 —— 那是服务端的事,与账号额度
// 无关,PR #86 的钩子 matcher 排除 overloaded 是同一个道理。
// 判定本身在 src/providers.ts 的 anthropicQuotaVerdict —— master 核对上报用的是同一个函数(issue #95),
// 两处各写一份迟早会漂成两套规则。
export function isQuotaExhausted(status: number, headers: Headers): boolean {
  if (status !== 429) return false
  const record: Record<string, string> = {}
  headers.forEach((value, key) => (record[key] = value))
  return anthropicQuotaVerdict(record) === "quota"
}

// 配额重置点,epoch 毫秒。【只认 unified-reset】,不拿 retry-after 兜底:src/senpi/limitReport.ts 记过
// 一次实测 —— 把客户端的重试窗口当成配额重置点发给 master,master 一分钟后就把空号发给下一台机器。
// 缺省反而诚实:master 记一个待定冷却,由它自己的用量轮询把真实期限填上。
export function resetsAtOf(headers: Headers): number | undefined {
  const reset = Number(headers.get("anthropic-ratelimit-unified-reset"))
  return Number.isFinite(reset) && reset > 0 ? reset * 1000 : undefined
}

/** 上报给 master 的头:只要限流相关的那几个。master 的日志只记 key,但不该收到一整份响应头。 */
export function limitHeadersOf(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {}
  headers.forEach((value, key) => {
    if (key.startsWith("anthropic-ratelimit-") || key === "retry-after") out[key] = value
  })
  return out
}

/**
 * relay 自己给不出凭证时回给 claude 的错误。形状是 Anthropic 的错误报文,于是客户端按它认识的方式
 * 显示 message —— 操作者在会话里读到的就是这句话,所以它必须说出补救动作。
 *
 * 状态码的选择决定客户端怎么做:5xx 会被它按退避重试(master 暂时不可达时正是想要的),
 * 429(不带配额头)会直接显示给人看、不重试(池子没号时重试只是空转)。
 */
export function relayErrorResponse(status: number, message: string): Response {
  const type = status === 429 ? "rate_limit_error" : "api_error"
  return Response.json({ type: "error", error: { type, message } }, { status })
}

/**
 * 错误应答正文的可读文本,只给日志用。上游字节是原样过来的(decompress: false),多半压过 ——
 * 不解压,日志里只有一串乱码,而"这个 429 到底是容量、权限还是额度"就写在这段正文里。
 * 解不开就如实说明,绝不抛出:这是诊断,不是转发路径。
 */
export function decodeBodyForLog(bytes: Uint8Array, contentEncoding: string | null): string {
  const encoding = (contentEncoding ?? "").trim().toLowerCase()
  try {
    const plain =
      encoding === "gzip" || encoding === "x-gzip"
        ? gunzipSync(bytes)
        : encoding === "br"
          ? brotliDecompressSync(bytes)
          : encoding === "deflate"
            ? inflateSync(bytes)
            : encoding === "" || encoding === "identity"
              ? bytes
              : undefined
    return plain === undefined ? `<${encoding} 编码的 ${bytes.length} 字节>` : new TextDecoder().decode(plain)
  } catch {
    return `<${encoding || "未知"} 编码的 ${bytes.length} 字节,解不开>`
  }
}
