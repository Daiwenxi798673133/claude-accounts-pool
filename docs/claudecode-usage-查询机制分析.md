# Claude Code 泄露源码 & 开源生态：Usage 查询与 Token 刷新机制分析

> 本文档汇总三路调研结果，目标是搞清楚官方 Claude Code 与成熟开源项目**如何查询订阅用量、如何刷新 OAuth token、如何避免 429**，用于指导我们插件 (`claude-accounts-usage`) 的修复方向。
>
> 调研来源：
> 1. **官方 Claude Code v2.1.88** — 从 `cli.js.map` 还原的 TypeScript 源码（[`Exhen/claude-code-2.1.88`](https://github.com/Exhen/claude-code-2.1.88)，commit `c8cd2535`）
> 2. **开源 usage 仪表盘** — orca (4.7k⭐)、Aperant (14k⭐)、moai-adk (1k⭐)、openclaw、TokenEater 等
> 3. **OAuth token 端点限流规律** — sing-box、hermes-agent、sub2api 的 refresh 实现 + issue 讨论

---

## 0. 核心结论（TL;DR）

| 问题 | 结论 |
|------|------|
| **Usage 查询主路径** | 不 poll `/api/oauth/usage`，而是从 **inference 响应头** `anthropic-ratelimit-unified-*` 读取 |
| **`/api/oauth/usage` 角色** | 仅启动时调一次显示初始进度条；该端点有**已知持续性 429 问题（Issue #31021）** |
| **Token 刷新触发** | 提前量缓冲 **60 秒 ~ 5 分钟**（官方 5min / sing-box 60s / sub2api 3min） |
| **Refresh Token 轮换** | ✅ **每次刷新返回新 refresh_token，旧的立即失效（one-time use）** |
| **并发刷新同一账号** | 必然 `invalid_grant`（先到者消耗了 token） |
| **并行刷新多账号** | 触发 429（**IP 维度限流**，非 client_id 维度） |
| **429 处理** | Pro/Max 用户**不重试** 429；用指数退避 + `Retry-After` 头 |
| **防并发** | 进程内 Promise/Mutex 单飞 + 跨进程文件锁/Redis 锁 + 双重检查 |
| **限流阈值** | 无任何公开数字 |
| **TOKEN_URL** | 主 `platform.claude.com`，备 `console.anthropic.com`（两者都有效） |

---

## 1. Usage 查询：响应头优先，而非 poll 接口

### 1a. 官方 Claude Code：实时额度来自 inference 响应头

官方 CLI **不轮询** `/api/oauth/usage`，每次 inference 请求返回后从响应头解析额度。

**Evidence**（`claudeAiLimits.ts`，[L164-L178](https://github.com/Exhen/claude-code-2.1.88/blob/c8cd253554319f32ff64ff7000636199f720c9bc/source/src/services/claudeAiLimits.ts#L164-L178)）：

```typescript
function extractRawUtilization(headers: globalThis.Headers): RawUtilization {
  const result: RawUtilization = {}
  for (const [key, abbrev] of [['five_hour', '5h'], ['seven_day', '7d']] as const) {
    const util = headers.get(`anthropic-ratelimit-unified-${abbrev}-utilization`)
    const reset = headers.get(`anthropic-ratelimit-unified-${abbrev}-reset`)
    if (util !== null && reset !== null) {
      result[key] = { utilization: Number(util), resets_at: Number(reset) }
    }
  }
  return result
}
```

响应头字段清单：

| 响应头 | 含义 |
|---|---|
| `anthropic-ratelimit-unified-5h-utilization` | 5 小时窗口用量 (0-1 小数) |
| `anthropic-ratelimit-unified-5h-reset` | 5 小时窗口重置时间 |
| `anthropic-ratelimit-unified-7d-utilization` | 7 天窗口用量 |
| `anthropic-ratelimit-unified-7d-reset` | 7 天窗口重置时间 |
| `anthropic-ratelimit-unified-status` | `allowed` / `allowed_warning` / `rejected` |
| `anthropic-ratelimit-unified-representative-claim` | 当前限速类型 |
| `anthropic-ratelimit-unified-5h-surpassed-threshold` | 已超警告阈值 |
| `anthropic-ratelimit-unified-fallback` | `available` 时有降级模型 |

### 1b. `/api/oauth/usage` 只在启动时调一次

**Evidence**（`usage.ts`，[L33-L63](https://github.com/Exhen/claude-code-2.1.88/blob/c8cd253554319f32ff64ff7000636199f720c9bc/source/src/services/api/usage.ts#L33-L63)）：

```typescript
export async function fetchUtilization(): Promise<Utilization | null> {
  if (!isClaudeAISubscriber() || !hasProfileScope()) return {}
  // ⚠️ token 已过期直接跳过，不发请求（避免 401）
  const tokens = getClaudeAIOAuthTokens()
  if (tokens && isOAuthTokenExpired(tokens.expiresAt)) return null
  const url = `${getOauthConfig().BASE_API_URL}/api/oauth/usage`  // api.anthropic.com
  const response = await axios.get<Utilization>(url, { headers, timeout: 5000 })
  return response.data
}
```

### 1c. ⚡ `/api/oauth/usage` 的已知 429 问题（Issue #31021）

开源项目 **moai-adk** 明确把"header probe"作为绕过 `/api/oauth/usage` 持续 429 的 workaround。

**Evidence**（`usage.go`，[L105-L113](https://github.com/modu-ai/moai-adk/blob/0ef55361707d4538eac7172d6c247ce7f2ac5296/internal/statusline/usage.go#L105-L113)）：

```go
// Strategy: Try Haiku probe (response headers) first, fall back to OAuth endpoint.
// The OAuth /api/oauth/usage endpoint has a known persistent 429 issue (Issue #31021),
// so we prefer extracting rate limit data from Messages API response headers.
apiResp, err := u.fetchUsageFromHeaders(ctx, token)
if err != nil {
    apiResp, err = u.fetchUsageFromOAuthAPI(ctx, token)
}
```

**Header probe 做法**：发一个最便宜的 `max_tokens=1` Haiku 请求，从响应头读额度（200 和 429 响应都带这些头）：

```go
body := fmt.Sprintf(`{"model":"%s","max_tokens":1,"messages":[{"role":"user","content":"h"}]}`, haikuProbeModel)
// 从 resp.Header 读 anthropic-ratelimit-unified-5h-utilization 等
```

官方 `checkQuotaStatus` 也是这个套路（`max_tokens=1` 探测，读响应头），见 [claudeAiLimits.ts#L199-L248](https://github.com/Exhen/claude-code-2.1.88/blob/c8cd253554319f32ff64ff7000636199f720c9bc/source/src/services/claudeAiLimits.ts#L199-L248)。

> **对我们的启示**：`/api/oauth/usage` 本身就容易 429，这与"token 刷新 429"是两个独立问题，但都指向同一个解法——**减少对这些端点的主动请求频率，优先用响应头**。

---

## 2. Token 刷新：三层防并发 + 提前量缓冲

### 2a. 官方 Claude Code：三层去重

**第一层 — 进程内 Promise 去重**（`auth.ts`，[L1424-L1444](https://github.com/Exhen/claude-code-2.1.88/blob/c8cd253554319f32ff64ff7000636199f720c9bc/source/src/utils/auth.ts#L1424-L1444)）：

```typescript
let pendingRefreshCheck: Promise<boolean> | null = null
export function checkAndRefreshOAuthTokenIfNeeded(retryCount = 0, force = false): Promise<boolean> {
  if (retryCount === 0 && !force) {
    if (pendingRefreshCheck) return pendingRefreshCheck   // 复用 in-flight promise
    const promise = checkAndRefreshOAuthTokenIfNeededImpl(retryCount, force)
    pendingRefreshCheck = promise.finally(() => { pendingRefreshCheck = null })
    return pendingRefreshCheck
  }
  return checkAndRefreshOAuthTokenIfNeededImpl(retryCount, force)
}
```

**第二层 — 跨进程文件锁 (`proper-lockfile`)**（[L1484-L1561](https://github.com/Exhen/claude-code-2.1.88/blob/c8cd253554319f32ff64ff7000636199f720c9bc/source/src/utils/auth.ts#L1484-L1561)）：

```typescript
release = await lockfile.lock(claudeDir)        // ~/.claude/ 加锁
// 加锁后再次从磁盘读 token（双重检查）
const lockedTokens = await getClaudeAIOAuthTokensAsync()
if (!isOAuthTokenExpired(lockedTokens.expiresAt)) return false  // 别的进程已刷新
const refreshedTokens = await refreshOAuthToken(lockedTokens.refreshToken)
saveOAuthTokensIfNeeded(refreshedTokens)
// ELOCKED → 退避重试（最多 5 次，1-2s 随机抖动）
```

**第三层 — 401 跨标签页协调**（[L1343-L1391](https://github.com/Exhen/claude-code-2.1.88/blob/c8cd253554319f32ff64ff7000636199f720c9bc/source/src/utils/auth.ts#L1343-L1391)）：以失败的 access token 为 key 去重，重读 keychain 判断是否别的进程已刷新。

**过期判据 — 5 分钟缓冲**（`client.ts`，[L344-L353](https://github.com/Exhen/claude-code-2.1.88/blob/c8cd253554319f32ff64ff7000636199f720c9bc/source/src/services/oauth/client.ts#L344-L353)）：

```typescript
export function isOAuthTokenExpired(expiresAt: number | null): boolean {
  if (expiresAt === null) return false
  const bufferTime = 5 * 60 * 1000  // 5 分钟提前量
  return (Date.now() + bufferTime) >= expiresAt
}
```

### 2b. 开源项目的提前量缓冲对比

| 项目 | 提前量 | 锁机制 |
|---|---|---|
| 官方 Claude Code | 5 min | Promise + 文件锁 + 401 协调 |
| sing-box | 60 s | `sync.RWMutex` 双重检查 |
| hermes-agent | 60 s | 原子写文件 (tmp+rename) |
| sub2api | 3 min | 进程内 Mutex + Redis 分布式锁 |
| **我们 (`TOKEN_EXPIRY_BUFFER_MS`)** | **60 s** | 已加单飞锁 (inflightRefresh) |

**sing-box 双重检查模式**（[service.go#L251-L280](https://github.com/SagerNet/sing-box/blob/fa34e6c8a5e4bfb6802c99d86dbbec15a85eb544/service/ccm/service.go#L251-L280)）：

```go
s.accessMutex.RLock()
if !s.credentials.needsRefresh() { /* 快路径返回 */ }
s.accessMutex.RUnlock()
s.accessMutex.Lock()            // 升级写锁
defer s.accessMutex.Unlock()
if !s.credentials.needsRefresh() { return token }  // ← 双重检查
newCredentials, _ := refreshToken(...)
```

---

## 3. Refresh Token 轮换（关键风险）

### ✅ 确认：one-time use，刷新即轮换，旧 token 立即失效

**sing-box**（[credential.go#L108-L121](https://github.com/SagerNet/sing-box/blob/fa34e6c8a5e4bfb6802c99d86dbbec15a85eb544/service/ccm/credential.go#L108-L121)）：

```go
var tokenResponse struct {
    AccessToken  string `json:"access_token"`
    RefreshToken string `json:"refresh_token"`   // 每次都返回新值
    ExpiresIn    int    `json:"expires_in"`
}
if tokenResponse.RefreshToken != "" {
    newCredentials.RefreshToken = tokenResponse.RefreshToken  // 必须更新存储
}
```

### sub2api Issue #1035：并发消耗 refresh_token 导致 invalid_grant

[Issue #1035](https://github.com/Wei-Shaw/sub2api/issues/1035) / [PR #1039](https://github.com/Wei-Shaw/sub2api/pull/1039) / [PR #1382](https://github.com/Wei-Shaw/sub2api/pull/1382) 精确描述了这个 Bug：

> **根因**：后台定时刷新任务与请求时内联刷新**同时**对同一账号刷新 → 第一个成功消耗旧 refresh_token 写入新值 → 第二个拿着已失效的旧 token → **`invalid_grant`**

**竞争恢复逻辑**（重读存储，对比 refresh_token 是否已变）：

```go
func (api *OAuthRefreshAPI) tryRecoverFromRefreshRace(ctx, usedAccount) (*Account, bool) {
    reReadAccount, _ := api.accountRepo.GetByID(ctx, usedAccount.ID)
    usedRT := usedAccount.GetCredential("refresh_token")
    currentRT := reReadAccount.GetCredential("refresh_token")
    if usedRT != currentRT {       // 已变 → 别人刷新成功 → 直接用新的，不报错
        return reReadAccount, true
    }
    return nil, false              // 未变 → 真正的 invalid_grant
}
```

### ⚠️ 这正好解释用户的观察

> "我重新登录之后就不是 429 了，我始终觉得就是 token 过期的问题"

**机制串联**：
1. ex-machina 刷新活跃账号时轮换 refresh_token 并写回 auth.json。
2. 我们的 `claude-accounts.json` 里若存着**已被轮换作废的旧 refresh_token**，用它刷新 → 失败/重试。
3. 多账号并行刷新 + 旧 token 重试 → 集中打到刷新端点 → **IP 维度 429**。
4. 用户重新登录 → 拿到全新 refresh_token → 轮换链路重置 → 不再失败。

所以"token 过期/失效"（用户直觉）和"429 限流"（日志证据）**是同一条因果链的两端**。

---

## 4. 多账号管理：顺序，不并行

成熟项目在多账号场景下**一致地避免并行**刷新/查询。

### orca (4.7k⭐)：顺序 for 循环 + 60s 防抖

**Evidence**（[service.ts#L319-L370](https://github.com/stablyai/orca/blob/dc8fdf65a3b5a2a8ce21d26448f97ca73b98fa22/src/main/rate-limits/service.ts#L315-L375)）：

```typescript
async fetchInactiveClaudeAccountsOnOpen(): Promise<void> {
  if (Date.now() - this.lastInactiveClaudeFetchAt < INACTIVE_FETCH_DEBOUNCE_MS) return  // 60s 防抖
  // 关键：顺序 for 循环，不用 Promise.all —— 避免轰炸 API 触发 429
  for (const account of accounts) {
    const fresh = await fetchManagedAccountUsage(account)
    this.inactiveClaudeCache.set(account.id, this.applyStalePolicy(fresh, cached))
    this.pushToRenderer()   // 每个账号完成后立即推 UI
  }
}
```

**orca 的非活跃账号策略**：只读 token 文件，**不主动刷新**——让服务端判断 token 是否还有效。轮询间隔 15 min。

### Aperant (14k⭐)：per-account 冷却 + 主动刷新 + 请求合并

```typescript
private apiFailureTimestamps: Map<string, number> = new Map()
private static API_FAILURE_COOLDOWN_MS = 2 * 60 * 1000   // 普通失败 2min
private rateLimitedProfiles: Map<string, number> = new Map()
private static RATE_LIMIT_COOLDOWN_MS = 10 * 60 * 1000   // 429 专用 10min
private needsReauthProfiles: Set<string> = new Set()      // invalid_grant → 永久标记

// 提前 30 分钟主动刷新
const PROACTIVE_REFRESH_THRESHOLD_MS = 30 * 60 * 1000

// 请求合并：已有 inflight 就复用
if (!forceRefresh && this.allProfilesUsageInflight) return this.allProfilesUsageInflight
```

> **重要警告**（Aperant 注释）：refresh 后旧 token 立即被 Anthropic 吊销，必须原子写回，否则有"新旧都失效"的时间窗。

---

## 5. 缓存与 429 退避

| 项目 | 缓存 TTL | 429 退避 |
|---|---|---|
| moai-adk | 5min fresh + 无限 stale | 指数退避 1→2→4→8→16→32 min，冷却期返回 stale |
| orca | 15min poll，30min stale 丢弃 | Retry-After 头 + 3 次重试 |
| Aperant | 5min（非活跃账号） | per-account 10min 429 冷却 |
| cc-token-status | 4min fresh + 2h stale fallback | 429 时直接用 stale |

**官方 429 不重试**（`withRetry.ts`，[L766-L769](https://github.com/Exhen/claude-code-2.1.88/blob/c8cd253554319f32ff64ff7000636199f720c9bc/source/src/services/api/withRetry.ts#L766-L769)）：

```typescript
if (error.status === 429) {
  // Pro/Max 用户不重试 429（retry-after 可能是几小时）；Enterprise PAYG 才重试
  return !isClaudeAISubscriber() || isEnterpriseSubscriber()
}
```

**退避公式**（[withRetry.ts#L530-L548](https://github.com/Exhen/claude-code-2.1.88/blob/c8cd253554319f32ff64ff7000636199f720c9bc/source/src/services/api/withRetry.ts#L530-L548)）：优先 `Retry-After` 头，否则 `min(500ms * 2^(attempt-1), 32s)` + 25% 抖动。

---

## 6. TOKEN_URL 域名考证

| 来源 | 主端点 | 备端点 |
|---|---|---|
| 官方 Claude Code v2.1.88 | `platform.claude.com/v1/oauth/token` | — |
| ex-machina | `platform.claude.com/v1/oauth/token` | — |
| hermes-agent | `platform.claude.com/v1/oauth/token` | `console.anthropic.com/v1/oauth/token` |
| sing-box | `console.anthropic.com/v1/oauth/token` | — |
| **我们** | `console.anthropic.com/v1/oauth/token` | — |

**结论**：两个域名**都有效**（sing-box 仍在用 console 且正常）。`platform.claude.com` 是官方当前主用，`console.anthropic.com` 是旧/备用。建议跟随官方迁移到 `platform.claude.com`，并保留 console 作为 fallback（参考 hermes-agent）。

---

## 7. 限流维度推断

**几乎确定是 IP 维度，而非 client_id 维度**，依据：

1. 所有项目（claude-code、sing-box、hermes-agent、sub2api、ex-machina）**共用同一个 `client_id`** `9d1c250a-e61b-44d9-88ed-5944d1962f5e`。若按 client_id 限流，全球用户早就互相拖垮。
2. 用户现象（同时刷新多账号才 429）与 IP 维度一致。
3. 无任何项目/issue 公开过具体阈值数字。

---

## 8. 对我们插件的最终修复清单

综合三路调研，给出与业界对齐的修复方向（按优先级）：

1. **【最高】绝不并发刷新同一账号** — refresh_token 是 one-time use。已实现 `inflightRefresh` 单飞锁 ✅
2. **【高】多账号串行刷新 + 抖动** — 学 orca 的顺序 for 循环，账号间隔 500ms~1s，避免对齐轰炸。已实现 `REFRESH_DELAY_MS` ✅
3. **【高】invalid_grant 竞争恢复** — 刷新失败先重读 `claude-accounts.json`，若 refresh_token 已变则视为"别人刷过了"，用新的，不报错、不无限重试。**待实现**
4. **【高】per-account 429 冷却** — 学 Aperant，429 后该账号冷却 10min，不影响其他账号。已实现 `refresh429Cooldown` ✅
5. **【中】stale-while-revalidate** — 429 冷却期内仍展示上次的 usage 数据，而非空白。**待实现**
6. **【中】TOKEN_URL 迁移** — 改 `platform.claude.com` 主用，`console.anthropic.com` 兜底。**待实现**
7. **【中】token-keeper 提前量** — 提前 60s~5min 刷新非活跃账号。已实现 `KEEPER_REFRESH_THRESHOLD_MS = 30min`（偏激进，可调到 5min）
8. **【低】header probe 替代 /usage** — 长远可选：发 `max_tokens=1` Haiku 探测读响应头，绕过 `/api/oauth/usage` 的 Issue #31021。但我们是 TUI 插件，读不到成功响应的限流头，此方案受限。
9. **【低】原子写凭证** — `claude-accounts.json` 已用 tmp+rename 原子写 ✅

> **核心洞察**：用户的"token 过期"直觉与日志的"429 限流"是同一因果链——**轮换作废的旧 refresh_token 被反复重试，集中打到刷新端点触发 IP 限流**。根治办法是 invalid_grant 竞争恢复 + 串行刷新 + per-account 冷却，三者已实现两个，还差 **invalid_grant 竞争恢复**。
