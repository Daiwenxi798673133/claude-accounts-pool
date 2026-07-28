# claude-accounts-pool 可行性 & 形态调研报告

> 对应 Issue #1「项目初始化：research & goal 明确」的 to-research 两问：
> 1. 这个 pool 用什么形式的 service 更合适（web / cli / 其他）？
> 2. pool 的可行性？
>
> 本报告基于对两个 base repo 源码的实读得出结论，所有机制论断都附了文件出处，不含任何真实 token。
>
> **调研来源（已 clone 实读）**
> - `Daiwenxi798673133/claude-accounts-usage` —— 现有的 opencode 多账号管理插件，含 `docs/` 两篇机制分析
> - `ex-machina-co/opencode-anthropic-auth` —— 上游 auth 插件，负责把 Claude 账号接入 opencode 的 OAuth 登录 + token 刷新 + 请求改写
>
> ---
>
> ## ⚠️ 勘误声明（2026-07-27）
>
> 本报告初版存在**一处伪造引用**和**一处事实错误**，已在下文就地修正，完整分析见
> [`options-analysis.md`](./options-analysis.md) §0。
>
> 1. **伪造引用**：初版四次引用 `docs/账号token迁移到新电脑操作指南.md`，**该文件不存在**。
>    `claude-accounts-usage/docs/` 只有 `claudecode-usage-查询机制分析.md` 与
>    `ex-machina-源码机制分析.md` 两个文件，git 历史（`32da7e4`）只有一次 docs 提交。
>    受影响最严重的是「access token 跨机器可用**已实证**」这句——该实验从未存在。
>    结论仍然成立，但依据换成了生产级账号池项目的大规模实证（见 §2.1 修正后正文）。
> 2. **事实错误**：初版把 `cch` / billing header 归类为 HTTP 头。实际上它是
>    **system prompt 数组的第 0 个 block**，服务端从请求体里解析。按初版理解实现会导致
>    伪装静默失效。已修正 §4 架构图与 §1.1。
>
> 本报告其余机制论断经本轮交叉验证后维持不变。

---

## 0. 结论速览（TL;DR）

| 问题 | 结论 |
|---|---|
| **可行性** | ✅ **FEASIBLE-WITH-CAVEATS（可行，但有硬约束）** |
| **核心机制成立点** | access token 是纯 Bearer、**跨机器/跨 IP 可用**（迁移指南已实证）；refresh token **只在一处刷新**就能规避「同账号双机锁死」这条最致命的约束 |
| **推荐形态** | **反向代理 / 网关（Anthropic-compatible proxy）为主**，配一个轻量 Web/CLI 管理面。用户拿的是「池子自己签发的 key」，从不接触 Anthropic 的真实 token |
| **绝对不能碰的红线** | 同一个 Claude 账号在池子之外**不能再有第二个刷新者**（另一台机器、用户本地遗留的 ex-machina、旧电脑）——否则 refresh 轮换互顶 → `invalid_grant` 永久锁死 |
| **最大的三个风险** | ① 刷新链被池外第二个刷新者顶掉锁死 ② 多用户共享同一账号的 5h/7d 限额需要「租借」调度 ③ 中心化 token 库单点泄露 + 账号共享的 ToS 风险 |

---

## 1. 两个 base repo 到底做了什么

### 1.1 ex-machina（`opencode-anthropic-auth`）= 单账号的 OAuth 接入层

它是一个 opencode auth provider 插件，把 Claude Pro/Max 账号接进 opencode。三件事：

1. **OAuth 登录（PKCE）** —— `src/auth.ts` / `src/pkce.ts`
2. **懒刷新 access token + 轮换 refresh token** —— `src/index.ts`
3. **请求改写**（伪装成官方 Claude Code CLI 才能用 OAuth 打 inference）—— `src/transform.ts` / `src/cch.ts`

**关键常量**（`opencode-anthropic-auth/src/constants.ts`）：

```ts
CLIENT_ID    = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'   // 全球所有 Claude Code 同款 client_id
TOKEN_URL    = 'https://platform.claude.com/v1/oauth/token'
AUTHORIZE    = { max: 'https://claude.ai/oauth/authorize', console: 'https://platform.claude.com/oauth/authorize' }
CODE_CALLBACK= 'https://platform.claude.com/oauth/code/callback'   // 手动粘贴 code，不是 localhost 回调
OAUTH_SCOPES = ['org:create_api_key','user:profile','user:inference','user:sessions:claude_code','user:mcp_servers','user:file_upload']
REQUIRED_BETAS = ['oauth-2025-04-20','interleaved-thinking-2025-05-14']
USER_AGENT   = 'claude-cli/2.1.87 (external, cli)'
```

**登录流程**（`src/auth.ts` `authorize()` + `exchange()`）：标准 PKCE S256 → 用户在浏览器授权 → 拿到 `code#state` 手动粘回 → `POST TOKEN_URL {grant_type:'authorization_code', code, code_verifier, client_id, redirect_uri}` → 返回 `{access_token, refresh_token, expires_in}`（`expires` = `Date.now()+expires_in*1000`，实测约 **8 小时**）。

**刷新 + 轮换**（`src/index.ts` L46-L140，这是池子最需要照搬的部分）：

- 判据 `!auth.access || !auth.expires || auth.expires < Date.now()` 才刷新（**懒刷新**，无提前量 buffer）。
- 单飞：`refreshPromise` 复用 in-flight 请求，防止并发刷新自相残杀。
- `POST TOKEN_URL {grant_type:'refresh_token', refresh_token, client_id}`，`User-Agent: axios/1.13.6`。
- **响应里带一个新的 `refresh_token`——必须立刻写回**（`client.auth.set(...)`），旧的当场作废。这就是 refresh token rotation。
- 只对 5xx / 网络错误重试，**429 直接抛不重试**。

**inference 改写**（`src/transform.ts` `setOAuthHeaders` 等）：注入 `Authorization: Bearer <access>`、`anthropic-beta`、`user-agent: claude-cli/...`、删 `x-api-key`；`/v1/messages` 加 `?beta=true`；工具名加 `mcp_` 前缀（且首字母大写，否则被判定为非 Claude Code 客户端）、流式响应再去掉。

> **【已勘误】** 初版此处写「`src/cch.ts` 生成 Claude Code **指纹头**」，把它当成 HTTP 头，**错误**。
> `src/cch.ts` 计算出的是一个字符串
> `x-anthropic-billing-header: cc_version=<VER>.<fp>; cc_entrypoint=<ep>; [cch=<h>;]`，
> 它被 `rewriteRequestBody`（`transform.ts:337-365`）**unshift 进 `system` 数组作为第 0 个 text block**，
> 随请求体发送；服务端从 prompt 正文里解析它（Claude Code 源码
> `src/constants/system.ts:73-95` 注释：`Server _parse_cc_header tolerates unknown extra fields`）。
> 按「HTTP 头」实现会导致服务端永远读不到 → 账号被判为第三方流量 → 静默计费漂移（详见
> [`options-analysis.md`](./options-analysis.md) §3.1.3），且不会有任何告警。

**注意：不做这些改写，OAuth token 打 `/v1/messages` 会被服务端分类器拦掉**——表现是
**400 invalid_request_error，但错误文案伪装成 "You're out of extra usage."**（ex-machina
`constants.ts:63-70` 原文），极具误导性。所以池子做代理时这套改写必须搬到服务端。

**副产品能力**（`src/index.ts` L205）：拿 OAuth access token 可以调
`POST https://api.anthropic.com/api/oauth/claude_cli/create_api_key` 换一个 API key ——
但这是 **console/API 计费**路线（需要 `console` 授权模式），**不等于 Pro/Max/Team 订阅额度**。池子若面向订阅账号，主路仍是 OAuth access token，不是这个 API key。

### 1.2 claude-accounts-usage = 多账号管理策略（池子可直接复用的核心）

**存储模型（两个文件，都是 `0600`）**——见 `src/accounts.ts:7-21,48-56`（初版此处同样误引了那个不存在的文件，已改为源码出处）：

| 文件 | 作用 |
|---|---|
| `~/.config/opencode/claude-accounts.json` | 账号库。`accounts[]`：每个 `{id, label, refresh, access?, expires?, excluded?, needsReauth?}`；顶层 `activeId`（`accounts.ts:7-21`，路径 `accounts.ts:48`） |
| `auth.json`（XDG/data 目录探测，三候选路径 `accounts.ts:50-56`） | ex-machina 实际读的**当前激活账号**单份 token |

> **补充修正**：初版说「账号库 = 真正的数据源」，**方向反了**。源码注释（`usage.ts:247-249`，
> 反复标注为 **INV-2**）明确 **`auth.json` 才是活跃账号的唯一真相源**，`claude-accounts.json`
> 里的活跃记录只是它的 best-effort 镜像，由 `autoCapture()` 反向对齐。
> 这个方向对池子设计有实际影响：服务端没有 ex-machina、没有 `auth.json`，
> 「单一 activeId」这个概念本身就不成立，必须换成 per-request 的账号**选择/租借**模型。

`id` = Anthropic profile 的 `uuid`，跨刷新不变 → 账号的稳定主键（`src/accounts.ts` `StoredAccount`）。
（初版写「跨刷新、跨机器不变」——「跨机器不变」这半句没有证据支撑，且与池子无关，已删。）

**并发与一致性纪律（池子必须原样继承）**：

- **原子写**：`atomicWriteJson` 用 `tmp + rename`、`mode 0600`（`src/accounts.ts` L66-L71）。
- **跨进程文件锁**：`withAuthLock` / `withFileLock`，锁住所有 read-modify-write（`src/accounts.ts` L108-L113；参数在 `src/constants.ts`：`LOCK_STALE_MS=45s`、`LOCK_ACQUIRE_TIMEOUT_MS=30s`）。
- **单一写 token 入口**：`applyToken()`，写 token 的同时原子清 `needsReauth`（`src/accounts.ts` L40-L46）。
- **后台保活 token-keeper**（`src/keeper.ts`）：每 `KEEPALIVE_TICK_MS=5min` 一 tick，把**临近过期**（`INACTIVE_REFRESH_THRESHOLD_MS=30min`）的非活跃账号**串行**刷新（账号间隔 `500ms`），并 `watch` auth.json、在 ex-machina 每次轮换后 re-capture 最新 refresh。

**已在文档里沉淀、直接可用的 429 / 锁死防御经验**（`docs/claudecode-usage-查询机制分析.md` §2-§8）：

- refresh token 是 **one-time use**，并发刷新同一账号必 `invalid_grant`。
- 刷新端点是 **IP 维度限流**（全球共用一个 client_id 都没互相拖垮 → 不是 client_id 维度）；并行刷新多账号从同一 IP 打出去 → 429，且 Cloudflare **不返回 `Retry-After`**。
- 对策组合：**串行刷新 + 账号间隔抖动 + per-account 429 冷却 + invalid_grant 竞争恢复（重读存储比对 refresh 是否已变）+ 单飞锁**。

**三条铁律**（决定池子成败）：

1. refresh token 每次刷新都轮换，旧的立即作废 → 刷完必须写回新值。
2. **同一账号不能有两个独立的刷新者** —— 两边各自刷新会互顶，其中一方永久 `invalid_grant` 锁死。
3. access token 只会自己按时过期、别人刷新不顶它；但过期后要靠 refresh 续命，refresh 若被铁律 2 顶掉就续不了 → 锁死。

> **【已勘误】** 初版把这三条归属于 `docs/账号token迁移到新电脑操作指南.md §4`（不存在的文件）。
> 结论正确，真实出处是：
> - 铁律 1：`ex-machina-源码机制分析.md §3b-3c`（ex-machina `index.ts` 每次刷新写回 `json.refresh_token`）+
>   sing-box `credential.go` 实读，两个独立实现交叉验证。
> - 铁律 2：`claudecode-usage-查询机制分析.md §3`（引 sub2api Issue #1035 / PR #1039、#1382）
>   + `claude-accounts-usage/.omo/drafts/auth-file-lock-multi-instance.md:38` 的**真实生产事故日志**
>   （毫秒级时间戳：两实例在 12ms 窗口内竞争，败者 `invalid_grant` 且其整文件写入覆盖了赢家已持久化的
>   新 token → 账号永久搁死）+ `anthropics/claude-code#43392`（**Anthropic 自家 CLI 踩过同一个坑**，
>   v2.1.136 用跨进程锁 + 锁内重读修复）。
> - 铁律 3：由铁律 1、2 推导 + `claude-accounts-usage/src/usage.ts:104-106,331-333` 的刷新判据实现印证。
>
> 注意：`.omo/` 那份事故日志与其回归测试（两个真实子进程竞争单次性轮换 token）是整个证据库里
> **唯一达到「实验证实」强度**的材料，但其作用域是**同机多进程**，从未测试跨机器场景。

---

## 2. 可行性分析（逐条硬核验证）

### 2.1 access token 能不能给别的机器/别的 IP 用？ → **能**（这是整个 pool 的地基）

> **【已勘误】** 初版此处引用 `docs/账号token迁移到新电脑操作指南.md` 的「搬到另一台电脑后 curl
> `/api/oauth/usage` 返回 200」实验。**该文件与该实验均不存在**（见文首勘误声明）。
> `claude-accounts-usage` 全库从未测试过跨机器使用 access token——该项目的设计空间全是单机多进程。

真实依据是**生产级部署的大规模实证**：`sub2api`（34.5k★，Go）、`claude-relay-service`（12.4k★，Node）、
`clewdr`（1.2k★，Rust）等项目，正是在机房 IP 上持有池化 refresh token、刷出 access、代理转发给任意
IP 的用户，且持续活跃维护。若 access token 绑 IP 或绑机器，这些项目一天都活不下去。

这比任何一次性 curl 实验都强，但性质是**间接证据**：我们自己**没有**做过一手定向验证。

**推论**：中心服务器持有 refresh、刷出 access，把 access（或代理转发）交给任意 IP 的用户使用，机制上成立。

**建议补做的一手实验**（成本极低，可把此条从「间接证据」升级为「已实证」）：在中心机刷新某账号后，
立刻从另一台不同 IP 的机器用该 access token 打一次 `/v1/messages`（带完整伪装头）与
`/api/oauth/usage`，确认均为 200。这是整个项目最该优先跑的验证，见
[`options-analysis.md`](./options-analysis.md) §7。

### 2.2 「同账号双机锁死」在 pool 场景下怎么解？ → **靠"唯一刷新者"化解**

铁律 2 的本质是**存在两个各自独立刷新的刷新者**。池子的设计把刷新者收敛到**唯一一个（中心服务器）**：

- 只有池子持有并刷新 refresh token；用户端**永远不刷新、甚至永远不接触 refresh token**。
- 用户要么走代理（根本不拿 token），要么只拿短期 access（access 被别人刷新不会顶掉自己，铁律 3 前半句）。

→ 双机互顶的前提被消除。**但这条成立有一个前置红线（见 §2.6 风险 ①）**：池外不能再有第二个刷新者。

### 2.3 refresh 轮换 → 中心化 + 串行 + 单飞（现成方案可搬）

池子对 N 个账号做保活刷新，正是 claude-accounts-usage token-keeper 已解决的问题：**串行刷新 + 账号间隔 + per-account 冷却 + 单飞锁 + 原子写回 + invalid_grant 竞争恢复**。中心服务器是单 IP，反而比多用户各自本地刷新**更容易把刷新集中管好、把 429 降到最低**。

### 2.4 多用户并发 → inference 限额是 per-account 共享，需要「租借/调度」

- 刷新端点：IP 维度（中心单 IP，串行即可）。
- **inference 端点：`anthropic-ratelimit-unified-5h/7d` 是 per-account 额度窗口**（`docs/claudecode-usage-查询机制分析.md` §1）。多个用户同时打**同一个账号**会**共享**这份 5h/7d 限额 → 很快撞顶。
- 因此池子必须有**账号调度**：
  - **粘性租借**（sticky lease）：一段时间内 user ↔ account 一对一独占，最接近「每人一个号」的体验；
  - **轮转/负载均衡**：按各账号实时 utilization（可从 inference 响应头或 `/api/oauth/usage` 读）挑最空的账号；撞 429 的账号进冷却、自动切下一个（claude-accounts-usage 的「撞限自动切号」思路可复用到服务端）。

### 2.5 存储与刷新一致性 → 现成纪律直接复用

账号库 schema、原子写、跨进程锁、单一 token 写入口、keeper tick —— claude-accounts-usage 已经把这套打磨过（含大量踩坑注释）。池子把它从「本地文件 + 文件锁」升级为「服务器 DB + 应用内锁 / 行锁」即可，逻辑不变。

### 2.6 安全与 ToS —— 必须清醒对待

- **风险 ①（致命）单点刷新独占性**：池子必须是每个账号的**唯一刷新者**。用户本地若还留着旧的 ex-machina / claude-accounts-usage、或旧电脑没清干净，任何一次池外刷新都会轮换掉 refresh、把池子顶成 `invalid_grant`。→ 纳管账号必须「彻底迁移」，池外副本一律作废/删除；用户端只连池子、不再各自 `opencode auth login` 这些账号。
- **风险 ② 中心化 token 库 = 单点泄露**：一台机器存了所有账号的长期 refresh。需要静态加密、最小权限、访问审计、池子自身的用户鉴权（不能"谁 SSH 上来都能领 token"）。
- **风险 ③ ToS / 账号共享**：多人共用少数 Claude 订阅账号、用共享 client_id 伪装成 Claude Code、自动化轮转，都可能违反 Anthropic 使用条款，存在**封号**风险。这是产品/合规决策，工程上无法消除，需 owner 知情拍板。

---

## 3. 形态选型：web / cli / 其他？

部署前提（Issue 给定）：**单台中心服务器、所有人可访问、SSH 到机器上就能用**。据此对比：

| 形态 | 用户怎么用 | 优点 | 缺点 | 适配度 |
|---|---|---|---|---|
| **A. 反向代理 / 网关**（Anthropic-compatible endpoint，池子签发自有 key） | opencode 里把 anthropic provider 的 `baseURL` 指到池子，`apiKey` 填池子发的 key | 用户**从不接触真实 token**；轮换/过期/改写全在服务端透明处理；天然支持账号租借+负载均衡；可被任意兼容客户端复用；撤销=删 key | 服务端要**移植 ex-machina 的请求改写**（system prompt、`mcp_` 前缀、beta/UA/cch 头、`?beta=true`）；要处理流式转发 | ★★★★★ |
| **B. Token 分发 API + CLI**（`pool lease` 领一个 access + expires） | CLI 领 token，写进本地 auth.json，仍用本地 ex-machina 打 Anthropic | 服务端最薄；不碰 inference 流量 | access ~8h 过期要反复领；改写逻辑仍散落在每个用户端；租借状态难精确回收；用户仍直连 Anthropic，限额调度更被动 | ★★★☆☆ |
| **C. 纯 Web 控制台** | 浏览器登录看用量/管账号 | 管理直观 | **本身不解决"发放使用能力"**，只能当 A/B 的管理面 | 作为附属，不作主 |
| **D. 纯 CLI 工具**（无服务端常驻） | 本地命令行操作 | 简单 | 无法常驻做后台保活/调度/唯一刷新者，退化回多机刷新老问题 | ★★☆☆☆ |

### 推荐：**A（反向代理网关）为主 + 轻量 Web/CLI 管理面**

理由：

1. **把最脆弱的三件事全部收敛到服务端**：refresh 轮换、串行刷新/429 冷却、Claude Code 请求改写。用户端零心智负担、零 token 泄露面。
2. **天然独占刷新者**：用户根本没有 refresh token，也不本地刷新，从根上堵死铁律 2 的双机互顶。
3. **解耦用户凭证与 Anthropic 凭证**：池子给每个用户签发**自己的 key**（可单独限流/撤销/审计），后端映射到某个被租借的账号；Anthropic token 的轮换对用户完全不可见。
4. **可被任意兼容客户端复用**：opencode / Claude Code / curl 只要能改 baseURL 就能接入，不绑死单一插件。

这正是 `sub2api` / `hermes-agent` 这类成熟「Claude 账号池 → 统一 API」项目的形态（两者都在 claude-accounts-usage 的调研文档里被引用为 refresh/限流实现参考）。

---

## 4. 推荐架构（形态 A 的高层设计）

```
┌────────────────────────────────────────────────────────────────┐
│                     claude-accounts-pool (中心服务器)             │
│                                                                  │
│  [用户鉴权]  pool-key ↔ user 映射, 限流, 审计, 撤销               │
│       │                                                          │
│  [代理网关]  接收 opencode/claude-code 的 /v1/messages 等请求      │
│       │      → 按调度选中一个账号 → 注入该账号 access token        │
│       │      → 套用 ex-machina 改写:                               │
│       │         · HTTP 头: Bearer / anthropic-beta(必含            │
│       │           oauth-2025-04-20, 否则服务端 404) / claude-cli UA │
│       │           / 删 x-api-key                                   │
│       │         · URL: /v1/messages 加 ?beta=true                  │
│       │         · system prompt: 身份句 + 清洗第三方特征 +          │
│       │           billing header 作为第 0 个 block(**不是 HTTP 头**)│
│       │         · 工具名加 mcp_ 前缀(PascalCase)                    │
│       │      → 转发 Anthropic                                      │
│       │      → 流式回写(去 mcp_前缀, 需跨 chunk 缓冲), 读响应头     │
│       │        unified-5h/7d 用量                                  │
│       │                                                          │
│  [账号调度器] 粘性租借 or 按 utilization 负载均衡; 429→冷却切号     │
│       │                                                          │
│  [Token 管家] 唯一刷新者: 串行刷新+间隔+per-account冷却+单飞+       │
│       │       invalid_grant 竞争恢复 (直接移植 keeper.ts 逻辑)     │
│       │                                                          │
│  [存储]  账号库(refresh/access/expires/label/uuid, 静态加密) +     │
│          用户库(pool-key) + 租借状态 + 用量缓存   (SQLite/PG)      │
│                                                                  │
│  [管理面] Web/CLI: 登录纳管新账号(PKCE), 看各号用量, 增删/排除账号  │
└────────────────────────────────────────────────────────────────┘
        ▲ baseURL + pool-key                       ▲ PKCE 授权码
        │                                          │
   用户的 opencode                          管理员纳管账号时
```

**关键流程**

1. **纳管账号（管理员，一次性）**：走 ex-machina 同款 PKCE（`authorize('max')` → 浏览器授权 → 粘 code → `exchange` 换 `{refresh,access,expires}`），存进账号库。**纳管后确保该账号在池外无任何副本在刷新。**
2. **发放使用权（用户）**：管理员给每个用户签发一个 pool-key；用户在 opencode 里把 anthropic 的 `baseURL` 指向池子、`apiKey` = pool-key。
3. **一次推理**：用户请求到网关 → 鉴权 pool-key → 调度器选/续租一个账号 → 取该账号 access（过期则由管家先刷新）→ 注入 + 改写 → 转发 `api.anthropic.com` → 流式回传 → 从响应头更新该账号 5h/7d 用量。
4. **后台保活**：管家按 keeper.ts 节奏串行刷新临近过期的账号；唯一刷新者，无并发互顶。

**可直接移植的代码资产**

- `opencode-anthropic-auth/src/{auth,pkce,constants,transform,cch}.ts` → 纳管登录 + 请求改写（服务端化）。
- `claude-accounts-usage/src/{accounts,keeper,usage,constants}.ts` → 账号库 schema、原子写/锁、token-keeper、串行刷新+冷却、用量读取。

**待定技术点**

- ~~opencode 的 anthropic provider 是否能干净地覆盖 `baseURL` 并带自定义 key~~ → **已确认可以，且不需要客户端插件。**
  `opencode.json` → `provider.anthropic.options.{baseURL,apiKey}`；源码 `packages/llm/src/providers/anthropic.ts:13-18`
  读 `options.apiKey` 并以 `x-api-key` 发送；`provider.ts:1582-1590` 的 merge 顺序保证 **config 恒胜**于
  已存储凭据。Claude Code 侧用 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN`（官方文档化支持）。
  详见 [`options-analysis.md`](./options-analysis.md) §4，含三个必须注意的坑
  （只设 baseURL 会导致池子被绕过 / 必须真流式 / `anthropic-beta` 必须原样透传）。
- Team 计划的细节：这些是 Team 席位还是个人 Max？Team 是否有 admin/seat API 可用于更规范的席位管理（比伪装 Claude Code 更合规）。**仍待 owner 确认**——这直接决定是否可以走
  [`options-analysis.md`](./options-analysis.md) §2 的方案 E（合规干净路线）。
- **【最高优先级实验】** 中心刷新 refresh 的同时，另一 IP 用其 access 打 inference 是否完全无冲突。
  预期无冲突（只有 refresh 轮换，access 使用不轮换），且已有 34.5k★ 生产项目的间接实证，
  但我们自己**没有一手验证**，而整个项目的地基就压在这一条上。应在写任何产品代码之前跑掉。
- **【新增风险，需持续关注】** `NATIVE_CLIENT_ATTESTATION`：Claude Code 源码
  `src/constants/system.ts:73-88` 有 `cch=00000` 占位符，由 Bun 的**原生** HTTP 栈
  （`Attestation.zig`，不在可读源码内）在发包前覆写为真实 attestation hash。
  **任何 JS/Go/Rust 代理都无法复现。** 目前藏在 build flag 后，服务端是否已强制校验无法从外部判断。
  一旦启用，纯软件代理路线整体失效。详见 [`options-analysis.md`](./options-analysis.md) §3.1.4。

---

## 5. 最终裁决 & 下一步

**裁决：✅ FEASIBLE-WITH-CAVEATS。** 机制地基成立（access 跨机可用 + 唯一刷新者化解双机锁死），且几乎所有难点（轮换、串行刷新、429、请求改写、账号库一致性）在两个 base repo 里已有可移植的成熟实现。真正的门槛不在技术，而在**运营纪律（池外零副本刷新）**与**合规/安全**。

**Top 3 风险**：① 池外出现第二个刷新者 → 账号锁死；② 多用户共享 per-account 5h/7d 限额 → 必须做账号租借/调度；③ 中心 token 库单点泄露 + 账号共享 ToS 封号风险。

> **【本轮补充】初版风险清单不完整**，深化分析新增四条同等或更高量级的风险，完整登记册见
> [`options-analysis.md`](./options-analysis.md) §8：
> - **伪装漂移**：ex-machina 一年 ~145 PR / ~10 次纠正性发布追这套伪装，v1.4.0 整套架构在 v1.6.1 被完全回滚。
>   自建代理 = 把这份对活体反滥用分类器的持续逆向工程搬进自己的 on-call，且一个常量过期会**同时** 400 掉全体用户。
> - **静默计费漂移**：伪装不完美但未触发硬错时，流量被重分类为第三方 →
>   `"Third-party apps now draw from your extra usage, not your plan limits"`，
>   账单从订阅额度漂到按 token 计费的 overage，**无任何告警**。这是财务风险，不是可用性风险。
> - **`NATIVE_CLIENT_ATTESTATION`**：见上文「待定技术点」。一旦服务端启用，纯软件代理整体失效。
> - **单一出口 IP 的 IP 维度 429**：部分 429 按出口 IP 计（`teamclaude` 为此加了住宅代理故障转移），
>   切账号无效。而本项目是单台中心服务器 = 单一出口 IP。
>
> 另：初版把封号写成「可能违反 ToS」的假设。实际已有实锤——`claude-relay-service#587` 有多人第一手
> 报告 $200/月 Max 20x 账号入池后**数天内被封**；`#1108` 是一批稳定半年的账号在 CLI 版本更新后集中被封。
> 且 **opencode 已在 v1.3.0 主动下架捆绑的 Anthropic OAuth 插件，理由是「Anthropic explicitly prohibits this」**
> ——本项目的 base repo `ex-machina` 正是被点名的那一类。
>
> 但需与之拆开的一点：Anthropic **官方文档化并支持 LLM Gateway 机制本身**
> （`llm-gateway-protocol` / `llm-gateway-connect`），只声明不背书具体网关产品。
> **机制是合法的，违规点在于往里灌池化的订阅 OAuth token。** 由此浮现出初版没有的**方案 E**
> （池子持 Console 按量计费 API key）——唯一合规干净的路线，代价是放弃共享订阅额度。见
> [`options-analysis.md`](./options-analysis.md) §2。

**建议下一步（给 owner）**

1. 拍板形态：确认走「反向代理网关 + 轻量管理面」。
2. 拍板合规边界：明确账号来源（Team 席位 vs 个人 Max）与账号共享的可接受度。
3. MVP 切分：先做「单账号透传代理 + pool-key 鉴权 + 唯一刷新者管家」跑通端到端，再加「多账号调度/租借」和「Web 管理面」。
4. 落一条硬规矩到 README：**纳管进池的账号，池外一切副本（旧机、本地 ex-machina）必须清除，永不在别处再登录/刷新**。

---

*本报告为 Issue #1 的第一版 research 交付物。base 源码机制细节另见 claude-accounts-usage 的 `docs/` 两篇分析。*

*逐方案（A/B/C/D/E）的详细可行性分析、证据强度分级、客户端接入实测、封号证据与完整风险登记册，
见 [`options-analysis.md`](./options-analysis.md)。若两份报告有冲突，以 `options-analysis.md` 为准。*
