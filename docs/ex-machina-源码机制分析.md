# ex-machina (`@ex-machina/opencode-anthropic-auth`) 源码机制分析

> 分析对象：`~/.config/opencode/node_modules/@ex-machina/opencode-anthropic-auth/dist/`
> 文件：`index.js` (163 行) / `auth.js` (202 行) / `transform.js` (155 行) / `constants.js` (19 行)
>
> 本文档用于理解 ex-machina 如何接管 OpenCode 的 `anthropic` auth provider，以及它的 token 刷新、请求改写机制。我们的插件 (`claude-accounts-usage`) 与之共存，所以必须搞清楚它的行为边界。

---

## 1. 整体架构

ex-machina 是一个 **OpenCode auth provider 插件**，导出 `AnthropicAuthPlugin`。它做了三件事：

1. **注入 system prompt**：把 `"You are Claude Code, Anthropic's official CLI for Claude."` 插到每个 anthropic 请求最前面（伪装成官方 CLI）。
2. **接管 `anthropic` provider 的认证**：提供一个自定义 `fetch` 包装器，负责 OAuth token 注入、刷新、请求改写。
3. **提供登录方式**：Claude Pro/Max（OAuth）、Create API Key、手动输入 API Key。

```
AnthropicAuthPlugin({ client })
├── 'experimental.chat.system.transform'  → 注入 "You are Claude Code..." 前缀
└── auth
    ├── provider: 'anthropic'
    ├── loader(getAuth, provider)         → 返回 { apiKey:'', fetch }
    │   ├── max plan 成本归零
    │   └── fetch(input, init)            → 核心：token 刷新 + 请求改写
    └── methods: [Claude Pro/Max, Create API Key, Manually enter API Key]
```

---

## 2. 关键常量（`constants.js`）

```javascript
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
export const AUTHORIZE_URLS = {
    console: 'https://platform.claude.com/oauth/authorize',
    max:     'https://claude.ai/oauth/authorize',
};
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';  // ⚠️ 注意域名
export const OAUTH_SCOPES = [
    'org:create_api_key',
    'user:profile',
    'user:inference',
    'user:sessions:claude_code',
    'user:mcp_servers',
    'user:file_upload',
];
export const TOOL_PREFIX = 'mcp_';
export const REQUIRED_BETAS = [
    'oauth-2025-04-20',
    'interleaved-thinking-2025-05-14',
];
```

### ⚠️ 与我们插件的关键差异：TOKEN_URL 域名

| | TOKEN_URL |
|---|---|
| **ex-machina（官方同款）** | `https://platform.claude.com/v1/oauth/token` |
| **我们的 `src/constants.ts`** | `https://console.anthropic.com/v1/oauth/token` |

ex-machina 和官方 Claude Code v2.1.88 都已迁移到 **`platform.claude.com`**。我们仍在用旧的 `console.anthropic.com`。旧域名可能限流策略更严或存在重定向开销，这是我们 429 问题的嫌疑点之一。

`client_id`、`grant_type`、刷新请求体格式完全一致，所以两个域名应该都能接受同一份 refresh token，但**推荐统一迁移到 `platform.claude.com`**。

---

## 3. Token 刷新机制（`index.js` 的核心）

ex-machina 的 token 刷新**不是后台定时任务**，而是**懒刷新（lazy refresh）**：嵌在每次请求的 `fetch` 包装器里，只在 token 过期时才刷新。

### 3a. 触发条件

```javascript
async fetch(input, init) {
    const auth = await getAuth();                  // 每次请求重新读 auth.json
    if (auth.type !== 'oauth') return fetch(input, init);

    // 只有 access 缺失 / 无 expires / 已过期 才刷新
    if (!auth.access || !auth.expires || auth.expires < Date.now()) {
        // ... 刷新逻辑
    }
    // ... 注入 header 并发起真实请求
}
```

**重点**：
- 判据是 `auth.expires < Date.now()`，**没有提前量缓冲**（不像官方 Claude Code 有 5 分钟 buffer，也不像我们的 `TOKEN_EXPIRY_BUFFER_MS = 60_000`）。
- 每次请求都 `await getAuth()` 重新读取 auth.json —— 这就是**为什么我们切换账号后下一条消息立即生效**：ex-machina 总是读最新的 auth.json。

### 3b. 重试策略：只重试 5xx 和网络错误，**不重试 429**

```javascript
const maxRetries = 2;
const baseDelayMs = 500;
for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
        if (attempt > 0) {
            const delay = baseDelayMs * 2 ** (attempt - 1);  // 500ms, 1000ms 指数退避
            await new Promise((resolve) => setTimeout(resolve, delay));
        }
        const response = await fetch(TOKEN_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json, text/plain, */*',
                'User-Agent': 'axios/1.13.6',          // ⚠️ 刷新请求伪装成 axios
            },
            body: JSON.stringify({
                grant_type: 'refresh_token',
                refresh_token: auth.refresh,
                client_id: CLIENT_ID,
            }),
        });
        if (!response.ok) {
            if (response.status >= 500 && attempt < maxRetries) {
                await response.body?.cancel();
                continue;                              // 只对 5xx 重试
            }
            throw new Error(`Token refresh failed: ${response.status}`);  // 429/4xx 直接抛
        }
        const json = await response.json();
        await client.auth.set({                        // ⚠️ 关键：写回 auth.json
            path: { id: 'anthropic' },
            body: {
                type: 'oauth',
                refresh: json.refresh_token,           // 写回新的 refresh_token（轮换）
                access: json.access_token,
                expires: Date.now() + json.expires_in * 1000,
            },
        });
        auth.access = json.access_token;
        break;
    } catch (error) {
        const isNetworkError = /* ECONNRESET / ECONNREFUSED / ETIMEDOUT / fetch failed */;
        if (attempt < maxRetries && isNetworkError) continue;  // 只对网络错误重试
        throw error;
    }
}
```

**关键观察**：
1. **429 不重试** —— `if (response.status >= 500)` 才 continue，429 直接 `throw`。这和官方 Claude Code 的策略一致（Pro/Max 收到 429 不盲目重试）。
2. **refresh_token 会轮换** —— 响应里返回新的 `json.refresh_token`，ex-machina 立即用 `client.auth.set()` 写回 auth.json。**这是 refresh token rotation**。
3. **`client.auth.set()` 是原子写回** —— ex-machina 用 OpenCode 的 SDK 写 auth.json，而不是自己 fs.writeFile。

### 3c. ⚠️ refresh token rotation 对我们的影响（重要）

ex-machina 每次刷新都会**轮换 refresh_token**（旧的失效，新的写回 auth.json）。这对我们的多账号插件有直接影响：

- **活跃账号**：ex-machina 持续刷新并轮换，auth.json 里始终是最新的 refresh_token。我们的 `autoCapture()` 会读 auth.json 同步到 `claude-accounts.json`，所以活跃账号 token 总是新鲜的 → **活跃账号从不 429**。
- **非活跃账号**：存在 `claude-accounts.json` 里，ex-machina 不会碰它们。如果我们用一个**已经被轮换作废的旧 refresh_token** 去刷新，服务端可能返回错误。如果旧 token 还没作废但临近过期，频繁刷新就会撞限流。

> 这解释了用户的观察："重新登录之后就不是 429 了" —— 重新登录拿到全新的 refresh_token，旧的轮换链路断了，自然不再触发刷新失败。

---

## 4. 请求改写机制（`transform.js`）

每个 anthropic 请求在发出前都会被改写：

### 4a. `setOAuthHeaders` — 注入 OAuth 头

```javascript
export function setOAuthHeaders(headers, accessToken) {
    headers.set('authorization', `Bearer ${accessToken}`);
    headers.set('anthropic-beta', mergeBetaHeaders(headers));   // 合并 oauth-2025-04-20 等
    headers.set('user-agent', 'claude-cli/2.1.2 (external, cli)');  // ⚠️ inference 伪装成 CLI
    headers.delete('x-api-key');                                 // 删掉 API key（用 OAuth）
    return headers;
}
```

注意 **两个不同的 User-Agent**：
- Token 刷新请求：`axios/1.13.6`
- Inference 请求：`claude-cli/2.1.2 (external, cli)`

### 4b. `rewriteUrl` — 给 `/v1/messages` 加 `?beta=true`

```javascript
if (requestUrl.pathname === '/v1/messages' && !requestUrl.searchParams.has('beta')) {
    requestUrl.searchParams.set('beta', 'true');
}
```

### 4c. `prefixToolNames` / `stripToolPrefix` — 工具名加/去 `mcp_` 前缀

请求体里所有 tool 定义和 `tool_use` block 的 `name` 加上 `mcp_` 前缀（发出时）；流式响应里再把 `mcp_` 前缀去掉（返回时）。这是为了绕过 Anthropic 对工具名的某种校验。

### 4d. `createStrippedStream` — 流式响应改写

包装响应流，逐块解码 → `stripToolPrefix` → 重新编码。保留原始 status/headers。

> **对我们的启示**：`createStrippedStream` 重新构造了 Response，但 `headers: response.headers` 保留了原始响应头。这意味着 inference 响应的 `anthropic-ratelimit-unified-*` 头**理论上是保留的**——但 OpenCode 上层是否把这些头透传给 TUI 插件是另一回事（之前调研确认 TUI 插件读不到成功响应的限流头）。

---

## 5. OAuth 登录流程（`auth.js`）

标准 PKCE OAuth flow：

1. `generatePKCE()` 生成 challenge/verifier。
2. 起一个 localhost HTTP server 监听 `/callback`（随机端口，5 分钟超时）。
3. 构造授权 URL（`claude.ai/oauth/authorize` 或 `platform.claude.com/oauth/authorize`），带 PKCE challenge、state、scope。
4. 用户浏览器授权后回调到 localhost，校验 state。
5. `exchangeCode()` 用 authorization code 换 token（`grant_type: 'authorization_code'`）。
6. 返回 `{ refresh, access, expires }`。

**关键**：登录用的 `TOKEN_URL` 和刷新用的是同一个 `https://platform.claude.com/v1/oauth/token`。

---

## 6. 我们插件与 ex-machina 的边界

| 职责 | ex-machina | 我们的插件 |
|---|---|---|
| OAuth 登录 | ✅ 负责（PKCE flow） | ❌ 不碰，复用 ex-machina 登录结果 |
| 活跃账号 token 刷新 | ✅ 懒刷新 + 轮换 + 写回 auth.json | ❌ 不碰活跃账号 |
| inference 请求注入 | ✅ 全权负责 | ❌ 不碰 |
| 多账号档案存储 | ❌ 只持有 auth.json 单账号 | ✅ `claude-accounts.json` |
| 账号切换 | ❌ | ✅ 写 auth.json 的 anthropic 条目 |
| 用量查询 `/usage` | ❌ | ✅ 调 `/api/oauth/usage` |
| 撞限自动切号 | ❌ | ✅ 监听 session.status 事件 |

**共存关键**：我们只读/谨慎写 auth.json 的 `anthropic` 一项；ex-machina 每次请求重读 auth.json，所以我们切换账号后立即生效。

---

## 7. 对我们 429 问题的结论

综合 ex-machina 源码，定位到 **3 个可改进点**：

1. **TOKEN_URL 域名过时**：我们用 `console.anthropic.com`，ex-machina/官方用 `platform.claude.com`。→ **应迁移**。
2. **refresh token rotation 未对齐**：ex-machina 刷新活跃账号时轮换 refresh_token 并写回 auth.json，我们的 `autoCapture` 同步活跃账号没问题；但非活跃账号若持有被轮换作废的旧 token，刷新会失败。
3. **429 不应重试**：ex-machina 明确只对 5xx/网络错误重试，429 直接抛。我们已实现 429 冷却，方向一致。

> ex-machina 对**单个活跃账号**的处理是健壮的（懒刷新、不并发、轮换写回、429 不重试）。我们的多账号场景天然需要管理 N 个 refresh token，必须**串行刷新 + 单飞 + per-account 冷却**才能避免撞限——这正是 token-keeper 方案要补齐的。
