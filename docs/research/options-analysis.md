# 方案可行性详细分析（A/B/C/D/E）

> 对应 Issue #1。这是对 `pool-feasibility.md` 的**深化 + 勘误**。
>
> 上一份报告给出了「推荐 A」的结论，但逐方案分析只有一张四行表。本文补足每个方案的**机制阻塞点、工程量、失败模式、维护成本、合规定性**，并纠正上一份报告中的两处事实错误（§0.2 billing header、§0.3 合规定性）。
>
> ⚠️ 本文初版曾额外指控上一份报告「伪造引用」，**该指控经复核不成立，已在 §0.1 撤回**（根因：审计时用了本地旧检出）。
>
> **本轮新增证据源**（均为本次实读/实测，非回忆）：
> - `../claude-code-main` —— 51.2 万行 Claude Code TypeScript 源码快照（README 自述为 2026-03-31 source-map 泄漏镜像；provenance 不可验证，但代码内部自洽、非混淆，含真实内部工单号）
> - `ex-machina-co/opencode-anthropic-auth` @ `1488bd8` (v1.8.1) —— 实际 clone 后逐文件读
> - `../claude-accounts-usage` 源码 + `.omo/` 事故日志 + 回归测试
> - 生产级账号池项目实地调研：`sub2api`(34.5k★)、`claude-relay-service`(12.4k★)、`clewdr`(1.2k★)、`teamclaude`、`CC-Router`、`codex-pool`、`claude-usage-swap`
> - opencode 官方文档 + 源码 `anomalyco/opencode@bc2d3df`；Anthropic 官方 `llm-gateway-protocol` / `llm-gateway-connect` / `env-vars` 文档

---

## 0. 对上一份报告的勘误（先纠错，再分析）

在展开方案分析前，必须先修正三处问题，否则后续论证建立在错误地基上。

### 0.1 ~~【严重】伪造引用~~ → **已撤回：该指控不成立**（2026-07-28 修订）

> **本小节原先指控 `pool-feasibility.md` 伪造引用，该指控是错的，现予撤回并保留原文脉络备查。**

原指控称：`pool-feasibility.md` 四次引用的 `docs/账号token迁移到新电脑操作指南.md`「不存在」，
因而「access token 跨机器可用已实证」这条地基失效。

**复核结果：该文件存在，原引用有效。** 对上游仓库重新 clone 后：

```
docs/ 实有 3 个文件
  claudecode-usage-查询机制分析.md
  ex-machina-源码机制分析.md
  账号token迁移到新电脑操作指南.md          ← 180 行，被误判为"不存在"的那个

git log --diff-filter=A -- 'docs/*'   →  2 次提交，非 1 次
  4d50c07  2026-07-24  docs: 新增账号 token 迁移到新电脑操作指南
  32da7e4  2026-06-13  docs: 新增 ex-machina 与 Claude Code 源码机制分析
```

**误判根因**：本文 §0 那一轮审计的证据源是本地旧检出 `../claude-accounts-usage`（见文首证据源清单），
其工作副本停留在 2026-07-24 之前，`docs/` 里当时确实只有 2 个文件，`find` 自然也搜不到。
在**新 clone** 上重跑同样的命令即返回 3 个文件 / 2 次提交。这是旧检出造成的假阴性，不是伪造。

**连带更正**：
- 「access token 跨机可用」**既有一手证据、也有生产旁证**。一手证据就在该文件「踩坑 B」：
  旧机签发的 access token 带到新机（不同机器 / 不同 IP）后实测仍有效，`/api/oauth/usage`
  返回 `200` 与真实用量；§3 步骤 5 亦逐账号验证 `200`。
  原先「该实验从未存在」「我们没有一手验证」的说法作废。
- 「三条铁律」确实出自该文件 §4，引用有效；`claudecode-usage-查询机制分析.md §3`、
  `.omo/drafts/auth-file-lock-multi-instance.md:38` 的生产事故日志、`anthropics/claude-code#43392`
  是**额外的交叉印证**，而非替代出处。
- §1.2 关于 sub2api / claude-relay-service 的生产规模实证**依然有效且有价值**，
  定位从「唯一依据」调整为「一手证据之外的强旁证」。

> 教训（双向）：引用必须可回溯到真实存在的 `文件:行号` 或 URL；**核验引用时也必须在最新副本上进行**——
> 用旧检出做「文件不存在」这类否定性断言，极易产生假阴性并升级为错误的指控。

### 0.2 【事实错误】billing header 不是 HTTP 头

上一份报告的架构图写「套用 ex-machina 改写(... beta & UA & cch 头 ...)」，把 `cch` 归类为 HTTP 头。

**实际上**（`claude-code-main/src/constants/system.ts:73-95` + `src/services/api/claude.ts:1358-1369`）：

```
x-anthropic-billing-header: cc_version=<VER>.<fp>; cc_entrypoint=cli; [cch=00000;]
```

这一整行虽然长得像 HTTP 头、名字也叫 header，但它是**被塞进 system prompt 数组的第 0 个 block**，作为请求体的一部分发送。服务端从 prompt 正文里把它解析出来（源码注释：`Server _parse_cc_header tolerates unknown extra fields`）。

**为什么这个错误要紧**：如果按上一份报告的理解去实现代理，把它当 HTTP 头设置，服务端**永远读不到**，账号会被判定为第三方流量 → 落到 §3.1.3 的静默计费漂移。这是一个会让 MVP 直接失败、且难以定位的错误。

### 0.3 【定性偏软】合规风险不是「待拍板」，上游已经用脚投票

上一份报告 §2.6 把 ToS 风险写成「产品/合规决策，工程上无法消除，需 owner 知情拍板」。

**实际情况更硬**——opencode 官方文档（`providers.mdx:356-361`）：

> "There are plugins that allow you to use your Claude Pro/Max models with OpenCode. **Anthropic explicitly prohibits this.** Previous versions of OpenCode came bundled with these plugins but that is no longer the case as of 1.3.0."

即：**opencode 在 1.3.0 主动下架了捆绑的 Anthropic OAuth 插件，理由就是 Anthropic 明令禁止。** 而本项目的 base repo `ex-machina-co/opencode-anthropic-auth` 正是被点名的那一类插件。我已在 opencode 源码中 grep 确认：现在 `anthropic` provider **不存在任何 `type:"oauth"` 的登录方式**，`/connect` 只剩手填 API key。

这不再是「可能违反 ToS」的假设，而是一个上游维护者已经据此做出下架决策的既成事实。

---

## 1. 证据强度分级（先说清哪些是硬事实、哪些是推断）

决策文档最危险的事是把推断当事实。本文所有关键论断按下表分级。

### 1.1 硬事实（多来源交叉验证的实读源码）

| 事实 | 出处 |
|---|---|
| refresh token 一次性使用、每次刷新轮换，响应返回新 refresh 必须写回 | 三个独立代码库实读：sing-box `credential.go`、ex-machina `index.ts:69-137`、Claude Code 源码 |
| 同账号并发刷新 → 败者 `invalid_grant`，确定性而非偶发 | `anthropics/claude-code#43392`（Anthropic 自家 CLI 踩过，v2.1.136 用跨进程锁修复）；sub2api #1035 |
| OAuth Bearer 鉴权被 `oauth-2025-04-20` beta flag 服务端硬门控 | `claude-code-main/src/services/api/filesApi.ts:25-26` 注释：`auth.py: 'oauth_auth' not in beta_versions → 404` |
| billing header 位于 system prompt 而非 HTTP 头 | `claude-code-main/src/constants/system.ts:73-95`、`claude.ts:1358-1369` |
| 指纹 = `SHA256(salt "59cf53e54c78" + 首条消息 offset[4,7,20] 字符 + CLI 版本)[:3]` | `claude-code-main/src/utils/fingerprint.ts:8,50-63`（注释："Do not change without careful coordination with 1P and 3P APIs"） |
| 5h/7d 限额窗口是 per-account，且按模型族分别计 | `anthropic-ratelimit-unified-*` 响应头族；CRS `claudeAccountService.js:1417-1474` |
| 客户端可零插件接入自定义网关 | opencode `provider.anthropic.options.{baseURL,apiKey}`（源码 `anthropic.ts:13-18`）；Claude Code `ANTHROPIC_BASE_URL`+`ANTHROPIC_AUTH_TOKEN`（官方 env-vars 文档） |

### 1.2 强经验证据（大规模生产部署实证）

「中心服务器持 refresh、刷出 access、从机房 IP 代理给任意用户」这件事**已被大规模验证可行**：

| 项目 | 语言 | Star / Fork | 状态 |
|---|---|---|---|
| `sub2api`（作者自称 CRS2） | Go | 34,588★ / 7,122 | 当日仍在推送 |
| `claude-relay-service` (CRS) | Node | 12,421★ / 1,862 | 活跃 |
| `clewdr` | Rust | 1,232★ / 223 | 活跃 |
| `teamclaude` / `OurClaude` / `CC-Router` / `codex-pool` / `CLIProxyAPI` | 混合 | 小到中 | 均 2026 年活跃 |

这在样本规模上远强于任何单次 curl 实验，与迁移指南「踩坑 B」的一手实测互相印证：**access token 不绑 IP、不绑机器**，否则这些项目一天都活不下去。

**最强的单一信号是收敛性**：≥6 个互不相关的代码库（JS/Go/Rust/Python，**其中包括 Anthropic 自家的 claude-code**）独立收敛到同一套 refresh 竞争修法——分布式锁 + 锁内重读 + 共享结果。没有任何一个做过这件事的项目最后放弃了代理形态。

### 1.3 推断 / 未证实（必须标注，不可当事实用）

| 论断 | 真实状态 |
|---|---|
| 「刷新端点是 IP 维度限流」 | `claudecode-usage-查询机制分析.md §7` 标题本身就写着「限流维度**推断**」。论据是「全球共用一个 client_id 却没互相拖垮」，合理但从未做过隔离单变量的对照实验。**全生态无任何公开阈值数字。** 上一份报告把它当事实用了。 |
| 「中心刷新 + 另一 IP 用 access 打 inference 完全无冲突」 | **部分已证**：「access token 跨机器/跨 IP 可用」有一手实证（迁移指南「踩坑 B」，见 §0.1）+ §1.2 生产旁证。**仍未定向验证的是**：`/v1/messages` 这个端点本身（带完整伪装），以及「刷新与使用并发」的时序。见 §7 实验 2。 |
| NATIVE_CLIENT_ATTESTATION 服务端是否已启用强制校验 | 源码里只有占位符和 build flag，无法从外部判断服务端开关状态。见 §3.1.4。 |

---

## 2. 五个方案的定义

上一份报告只列了 A/B/C/D。本轮调研浮现出第五个方案 E，它是唯一一个**合规干净**的选项，必须摊到桌面上。

| | 方案 | 用户怎么用 | token 在哪 | 谁做伪装 |
|---|---|---|---|---|
| **A** | 反向代理网关 | 改 `baseURL` + 池子签发的 key | 全在服务端，用户永不接触 | 服务端（我们自己写、自己维护） |
| **B** | Token 租借 API + CLI | CLI 领 access token 写进本地 auth 存储 | refresh 在服务端，access 下发到客户端 | 客户端现有的 ex-machina 插件（上游维护） |
| **C** | 纯 Web 控制台 | 浏览器看用量/管账号 | 服务端 | 不适用（本身不发放使用能力） |
| **D** | 纯 CLI，无常驻 | 本地命令 | 本地 | 客户端 |
| **E** | 池子持 Console API key | 改 `baseURL` + 池子签发的 key | 服务端 | **无需伪装** |

**E 的关键权衡**：`create_api_key` 那条 OAuth 路由（`api.anthropic.com/api/oauth/claude_cli/create_api_key`）能换出真正的 `sk-ant-` key，但**只对 console / 按量计费账号有效，对 Max/Pro/Team 订阅席位无效**（已在 ex-machina `index.ts:188-218` 确认）。所以 E 等于放弃「共享订阅额度」这个初衷，改为真金白银按 token 付费——换来零伪装、零封号风险、100% 官方支持。

---

## 3. 逐方案机制分析

### 3.1 方案 A：反向代理网关

#### 3.1.1 必须在服务端复刻的伪装清单（完整版）

这是 A 的全部工程风险所在。下表是从 Claude Code 源码 + ex-machina 实现 + 生产代理三方交叉得出的完整清单：

| 项 | 内容 | 稳定性 |
|---|---|---|
| HTTP 头 | `Authorization: Bearer`、`anthropic-beta`（含必需的 `oauth-2025-04-20`）、`user-agent: claude-cli/<ver> (external, cli)`、删除 `x-api-key` | 简单，但 UA 版本号需跟随 |
| URL | 仅 `/v1/messages` 追加 `?beta=true` | 简单稳定 |
| system prompt 首块 | `x-anthropic-billing-header: cc_version=<VER>.<fp>; cc_entrypoint=cli;` —— **注意是 prompt block 不是 HTTP 头** | 脆弱，版本+内容双耦合 |
| 指纹 `<fp>` | `SHA256(salt + 首条消息 offset[4,7,20] + CLI版本)[:3]` | 脆弱，salt 由反编译得来 |
| 身份句 | 必须以 `"You are Claude Code, Anthropic's official CLI for Claude."` 开头 | 中等 |
| 第三方特征清洗 | 必须删掉客户端自身品牌段落。**已知一句无害英文**（`"Here is some useful information about the environment you are running in:"`）会触发 400 —— 这是 ex-machina 把 10KB prompt 二分到单句才定位出来的 | 极脆弱，靠踩坑积累 |
| 工具名 | `mcp_` + 首字母大写；流式回程必须还原 | 中等，有已知边界 bug（见下） |
| 生产级代理还额外做 | 每账号 TLS JA3/JA4 指纹（sub2api 内置 `claude_cli_v2` profile）、`metadata.user_id` 的 device/account/session UUID 三元组、`cache_control` 块数与 TTL 归一化、`anti_distillation` 字段 | 高成本 |

**移植时会继承的已知 bug**：ex-machina 的流式还原（`transform.ts:370-396`）对每个 `pull()` 到的 chunk 单独跑正则 `/"name"\s*:\s*"mcp_([^"]+)"/g`，**没有跨 chunk 缓冲**。真实网络下 `"name":"mcp_Bash"` 被 TCP 分片切开时正则匹配不到，`mcp_` 前缀会泄漏给客户端。它的单测按整行 SSE 喂数据，所以测不出来。照搬即继承。

#### 3.1.2 失败模式：不优雅

ex-machina `constants.ts:63-70` 原文：

> "When it reaches Anthropic in combination with typical agent-orchestration context, `/v1/messages` responds with a **400 invalid_request_error disguised as 'You're out of extra usage.'**"

即：伪装出错的表现是**硬 400，且错误信息误导性地伪装成额度耗尽**。对多租户网关来说这是最坏的失败形状——一个常量过期，所有用户同时挂，且第一反应会误判为"额度用完了"而不是"伪装失效"。

#### 3.1.3 静默财务失败（上一份报告完全没提）

比封号更隐蔽的一类失败：伪装不完美时，流量被重分类为第三方 →

> `400: "Third-party apps now draw from your extra usage, not your plan limits"`

**账单从订阅额度悄悄漂移到按 token 计费的 overage。** 你以为在共享订阅，实际在烧钱。这是财务风险，不是可用性风险，且不会有任何告警。

#### 3.1.4 存在性威胁：NATIVE_CLIENT_ATTESTATION

`claude-code-main/src/constants/system.ts:73-88`：billing header 里有个 `cch=00000` 占位符。注释说明当 `NATIVE_CLIENT_ATTESTATION` 特性编译进去时，**Bun 的原生 HTTP 栈**（实现在 `bun-anthropic/src/http/Attestation.zig`，**不在源码快照里**）会在请求离开进程前把这串 0 覆写成计算出的 attestation hash，长度相同以免 `Content-Length` 变化。

**含义**：算法被刻意放在不可读的原生代码里。任何 JS/Go/Rust 代理都无法复现。目前藏在 build flag 后，服务端是否已开启强制校验无法从外部判断。

旁证：`Chris0x88/claude-cli-auth` README 记录他们试了 15 种方案想从 Python 走 OAuth 打 Sonnet/Opus，最终结论是**唯一可靠的路径是 shell out 调用真正编译好的 `claude` 二进制**，因为"连接层（HTTP/2、TLS session、服务端 session tracking）有些东西 SDK 复现不了"。

#### 3.1.5 维护成本：这是 A 最真实的软肋

ex-machina 一年内 ~145 个 PR / ~10 次纠正性发布，全在追这套伪装：

- v1.2.0 / v1.3.0：初版 system prompt 清洗，然后因过于激进而"最小化"
- v1.4.0：*"为绕过 Anthropic 对 system prompt 的扫描，把除身份标记外的全部内容移进 user message"* —— 一整套架构方案
- v1.5.1：加 `EXPERIMENTAL_KEEP_SYSTEM_PROMPT` 逃生开关
- **v1.6.1：把 v1.4.0 的方案完全回滚**，"align system blocks to match Anthropic"
- v1.6.0：工具名改 PascalCase
- v1.7.0：修 v1.5.1 引入的 `StructuredOutput` 回归
- v1.7.4：修「刷新前未重读导致用了陈旧 refresh 快照」→ 级联 401
- v1.7.5：修上面那句"useful information"指纹

维护方式是**用 mitmproxy 抓真实 Claude Code 流量做 diff**（仓库里有 `scripts/capture-with-mitmproxy.sh`）。**不存在任何规范文档**，这是对一个活的、无版本号的反滥用分类器做持续逆向工程。

走 A 意味着：把这份逆向工程负担从上游 OSS 社区搬到我们自己的 on-call 上，且爆炸半径是全体用户同时。

#### 3.1.6 A 的正面：几乎所有难点都有成熟先例

- 形态本身被 34.5k★ / 12.4k★ 的项目大规模验证。
- 调度、429 处理、粘性会话、refresh 竞争，生产项目都已趟平并公开源码。
- 客户端零插件（§4 已验证）。
- Anthropic **官方文档化并支持 LLM Gateway 机制本身**（`llm-gateway-protocol`），只是不背书具体产品。机制合法，灌订阅 OAuth 才是违规点。

### 3.2 方案 B：Token 租借（owner 的原始设计）

#### 3.2.1 B 的核心吸引力

**把伪装维护成本外包出去。** 客户端继续用上游持续维护的 ex-machina 插件做伪装；池子只做「唯一刷新者 + 租借调度」。§3.1.5 那份 145-PR 的负担留在上游社区，不进我们的 on-call。这是支持 B 最强、也是上一份报告完全没有认真评估的论据。

同时 B 也保留了"唯一刷新者"这个关键性质：用户只拿 access token，永不接触 refresh，双机互顶的前提依然被消除。

#### 3.2.2 实证：全网找不到 B 在多用户规模下的先例

调研覆盖到的唯一一个「交出凭据而非代理」的项目是 `jonazri/claude-usage-swap`（"cus"）。它连 access token 都不发，而是直接**原子替换 `.credentials.json` + `~/.claude.json` 文件**，让官方 `claude` 进程直连 Anthropic（"no proxy, no third-party client in the path"）。其 README 自述的限制：

- 默认 global 模式：**一台机器同时只有一个账号是活的**，每次切换炸掉所有会话的 prompt cache。
- `per_session` 模式（2026-07-02 新增）：给每个并发会话独立 `CLAUDE_CONFIG_DIR`，但**每个可并发槽位需要一个独立的 OAuth 登录家族**，且 README 记录了和 `claude-code#43392` 完全相同的失败：「两个持有同一账号*副本*的活动挂载会互相踩踏 —— 其中一个会话被静默登出」。它的修法同样是分布式锁。
- **明确无跨机协调**："if you run `cus daemon` on multiple machines, they don't coordinate."

调研者结论（原文实质）：交凭据这个形态被试过，对**单用户 + 多个自己的账号 + 单机**可用，但撞上和代理方案完全相同的单次性 refresh token 墙——只是从自动加锁退化成手动且痛苦。**找不到任何项目把短期 OAuth token 中心化分发给 N 个不同用户。** 所有瞄准这个场景的项目（CRS、sub2api、OurClaude、CC-Router、teamclaude）全部收敛到中心代理。

#### 3.2.3 B 的具体机制缺口（待 Oracle 裁决权重）

- **调度失去执行力**：access token 一旦下发就是个 8h 有效的裸 Bearer，池子无法撤回、无法改路由、无法在撞 429 时替用户切号。租借回收只能靠过期。
- **用量可观测性丢失**：`anthropic-ratelimit-unified-*` 头在用户的响应里，池子看不到。只能退化成主动轮询 `/api/oauth/usage`（该端点有已知的持续 429 问题，upstream Issue #31021）。
- **粘性会话/prompt cache 无法编排**：见 §3.4，这是正确性问题不只是公平性问题。
- **爆炸半径反转**：A 是"一个常量错了全员挂"；B 是"每个用户各自的插件版本不一致，故障面碎片化、难以复现"。
- **仍未逃离合规问题**：用户端跑的正是 opencode 1.3.0 下架的那类插件。B 不比 A 更合规，只是把违规动作分散到各客户端。

### 3.3 方案 C / D

- **C（纯 Web 控制台）**：本身不发放使用能力，只能作为 A 或 B 的管理面。不是独立候选。
- **D（纯 CLI 无常驻）**：无法常驻做保活/唯一刷新者/调度。N 个用户各自本地刷新 = 精确复现 `claude-code#43392` 和我们自己那份生产事故。**这正是本项目要解决的现状**，不构成方案。

### 3.4 所有方案共享的调度约束

| 约束 | 内容 |
|---|---|
| 限额是 per-account | 多用户打同一账号共享 5h/7d 窗口；按模型族分别计（Opus 打满不影响 Sonnet） |
| **粘性会话是正确性需求，不只是公平性** | CRS 的粘性 hash **直接从请求里 `cache_control: ephemeral` 标记的内容派生**，源码注释："基于 Anthropic 的 prompt caching 机制"。会话在账号间跳动会摧毁 prompt cache 命中（显著的成本与延迟惩罚）并可能扰乱会话状态。4 个独立项目各自表述了这一点 |
| 吞吐最优与缓存最优直接冲突 | `teamclaude` 故意默认关闭粘性以最大化配额吞吐——证明这是一个必须显式取舍的设计决策，不存在两全 |
| 不是所有 429 都是限流 | "Extra usage is required for long context requests" 也是 429，但属于权益错误。CRS 曾因把它当限流而锁死整个账号（#1000），修法是只在 429 带权威 reset 时间戳时才标记限流（PR #1213，并注明这是向 sub2api 的正确行为对齐） |
| **部分 429 按出口 IP 计** | `teamclaude` 明确记录并为此加了住宅代理故障转移。**我们的设计是单台中心服务器 = 单一出口 IP**，切账号解决不了 IP 维度的 429 |
| Cloudflare WAF 误伤 | Anthropic 自家 issue：#47754（无头 OAuth 刷新被 WAF 挡）、#30502（同一 Max 账号第二个并发会话收到无法通过的 JS challenge） |

---

## 4. 客户端接入可行性（已实测，两个客户端均零插件）

| | opencode | Claude Code CLI |
|---|---|---|
| 配置 | `opencode.json` → `provider.anthropic.options.{baseURL,apiKey}` | 环境变量 `ANTHROPIC_BASE_URL` + `ANTHROPIC_AUTH_TOKEN` |
| 需要插件 | **否** | **否** |
| 凭据头 | `x-api-key`（内置 `@ai-sdk/anthropic`）／ `Authorization: Bearer`（声明为 `@ai-sdk/openai-compatible` 时） | 两者皆可，由用户选 |
| 与已有登录冲突 | config 恒胜（源码 `provider.ts:1582-1590` 注释 "load config - re-apply with updated data"，且 `resolveSDK` 只在 `options.apiKey===undefined` 时才回退到存储凭据）；且 opencode 已无内置 Anthropic OAuth，无冲突源 | 凭据变量恒胜于已保存登录 |
| 最小需实现端点 | 流式 `/v1/messages` | 流式 `/v1/messages`（必需）＋ `count_tokens`（可选）＋ `/v1/models`（需显式开 `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1`）＋ `HEAD /`（可拒） |

**三个必须写进实现说明的坑**：

1. **只设 `ANTHROPIC_BASE_URL` 不设凭据变量 = 池子被绕过。** Anthropic 官方文档明说：此时请求确实走网关，但**仍然用用户自己的 claude.ai OAuth 会话鉴权和计费**。必须两个一起设。
2. **必须真流式。** 官方原文："a gateway that buffers complete responses before relaying them stalls the client"。opencode 侧硬编码 `stream: true as const`。
3. **`anthropic-beta` 必须原样透传，不能做白名单。** 官方警告：把头和 body 字段当封闭列表处理的网关，会在下个版本引入新能力时把客户端搞坏。

**另有一类流量永远绕开网关**（Claude Code）：fast-mode 可用性检查、WebFetch 域名安全检查始终直连 `api.anthropic.com`。

---

## 5. 封号与合规证据

| 证据 | 内容 |
|---|---|
| `claude-relay-service#587` | 标题「这两天封号严重」。多人第一手报告 **Claude Max 20x（$200/月）账号入池后数天内被封**。相关因素：多人共用单账号的请求频次/量、机房 IP、周末高峰。退款视原支付渠道而定，不一致 |
| `claude-relay-service#1108` | 一批「稳定运行半年」的账号在 Claude Code CLI 版本更新前后集中被封 → 服务端检测在收紧 |
| `clewdr#154` | 池化凭据开始被 flag，498/500，换哪个凭据都一样 |
| `CC-Router` README | 维护者自己警告用户："Anthropic has been known to ban accounts for unusual OAuth usage patterns" |
| opencode `providers.mdx:356-361` | "Anthropic **explicitly prohibits** this"，并据此在 1.3.0 下架捆绑插件 |
| 反面证据 | 同样的 issue 线程里，多位运营者报告在做好 IP 卫生的前提下稳定运行数月。**不是必然结局，是需要主动管理的风险** |

**必须与之拆开看的一点**：Anthropic **官方文档化并支持 LLM Gateway 机制**（`llm-gateway-protocol` / `llm-gateway-connect`），官方原文是"任何暴露受支持 API 格式的网关都能工作，Anthropic 不背书/不维护/不审计第三方网关产品"。

→ **机制是官方祝福的；违规点在于往里灌池化的订阅 OAuth token。** 这正是方案 E 存在的意义。

---

## 6. 可复用代码资产盘点

| 类别 | 内容 |
|---|---|
| **可原样移植**（纯逻辑，无单机假设） | 账号库 schema（`StoredAccount{id,label,refresh,access,expires,excluded,needsReauth}`）、refresh HTTP 调用形状、单飞去重、per-account 429 冷却（5min）、`invalid_grant` 竞争恢复（锁内重读→若 refresh 已变则「采纳赢家的轮换」而非误标死账号）、keeper 节奏（5min tick / 串行 / 刷成功后 500ms 间隔）、autoswitch 打分与冷却状态机 |
| **需换底座**（逻辑不变） | `withFileLock`（O_EXCL + rename + 45s stale + 30s 超时）→ DB 行锁/进程内 mutex；`atomicWriteJson` → DB 事务。**注意：这在单台服务器上是简化而非复杂化**——原实现的文件锁本来就只在本地文件系统有效，跨机器无意义 |
| **必须新写** | 逐请求 token 注入 + 整个伪装层（仅方案 A）。`auth.json` 作为"外部拥有的单一活跃账号文件"这个前提在服务端不成立，需换成 per-request 的账号**选择**概念 |
| **不可用** | `create_api_key` 只对 console 账号有效，对 Max/Pro 订阅席位无效 |

---

## 7. 逐方案裁决与推荐

> **方法说明**：本节结论经两轮对抗产生——先由独立裁决者基于 §1-§6 全部证据出裁决，再由红队专门攻击该裁决。
> 红队**推翻了初版裁决的主结论**。下文是经攻防后的收敛结果，并标注了哪些论断在攻击下存活、哪些被修正。
> （原计划由 Oracle 出裁决，两次尝试均 30 分钟无活动超时、零输出，判定环境不可用，改用此双轨方案。）

### 7.1 裁决总表

| 方案 | 裁决 | 决定性理由 |
|---|---|---|
| **A-build**（自己写代理） | **被 A-adopt 支配**（非「不可行」） | 边际成本相对 A-adopt 只是「移植 + 跟踪」，不是「从零拥有整个规避面」——sub2api / CRS / ex-machina 源码都可读。它不是不可行，而是**没必要** |
| **A-adopt**（直接部署 sub2api / CRS 不改） | ✅ **FEASIBLE-WITH-CAVEATS —— 自建路线的默认选择** | 伪装维护降级为 `git pull`；**结构上只有一个刷新者**；中心可观测；失败是响亮的；一个下午就能回退 |
| **A′**（网关后端 shell out N 个真 `claude` 进程） | 可行但代价大 | 唯一同时具备中心控制 + attestation 免疫的形态；但把 §5 的封号相关因素推到最大，且退化为 `-p` print 语义而非流式 `/v1/messages`，不是 drop-in |
| **B**（Token 租借） | ❌ **UNPROVEN —— 存在未解决的正确性缺陷**（详见 §7.2） | 核心不变量「池子是唯一刷新者」**无法强制**。客户端拥有凭据生命周期 |
| **C**（纯 Web 控制台） | 不是方案，是组件 | 本身不发放使用能力；应在 A 或 B 之上、共用同一个 DB，最后做 |
| **D**（纯 CLI 无常驻） | ❌ NOT-VIABLE | N 台机器各自跑无常驻 CLI，**正是**产生本组织那次生产事故和 `claude-code#43392` 的拓扑 |
| **E**（Console 按量计费 key） | ✅ FEASIBLE —— **唯一完全合规** | 放弃共享订阅额度，但零伪装、零封号、attestation 免疫、零 on-call。**部分流量今天就应该迁过去** |
| **Bedrock / Vertex**（两轮分析初期都漏掉） | ✅ FEASIBLE —— **应作为一切方案的成本基准线** | Claude Code 一等支持 `CLAUDE_CODE_USE_BEDROCK`，opencode 两者都支持。官方认可、集中计费、按人 IAM 授权、完整审计、零 ToS 暴露、attestation 免疫 |
| **「什么都不做 +」**（共享密码库 + 调度建议服务） | ✅ 可能支配以上全部 | 真正的痛点是凭据分发、可见性、调度。共享 vault + 一个「现在哪个号还有余量」的小服务即可覆盖大部分价值，**无 token 中介、无新失败模式、≈0 FTE** |

### 7.2 决定性发现：方案 B 有一个正确性缺陷，不只是治理缺陷

这是整轮分析中最重要的结论，也是推翻初版裁决的原因。

初版裁决列出的「B 会坏在哪」全是**治理**问题（无法强制、无可观测、调度粒度粗、客户端异构），**没有一条是正确性问题**。这本身就是破绽。把机制走具体：

**租借来的 access token 物理上怎么进到客户端？只有两条通道，且各自失败。**

**通道 1：`ANTHROPIC_AUTH_TOKEN` / `options.apiKey`**

§4 已证实：只设 baseURL 不设凭据变量，客户端会继续用自己的 OAuth 会话——反过来说，**设了 `AUTH_TOKEN` 就把客户端切进了 gateway / API-key 模式**。而在该模式下客户端没有理由再发 `oauth-2025-04-20`、带指纹的 system 首块、身份句——它以为下游网关会提供真 key。但 §1.1 已证实 **Bearer 鉴权被那个 beta flag 服务端硬门控**。

→ 拿原生 Claude Code 配 `AUTH_TOKEN=<OAuth access token>` 直连 `api.anthropic.com`，**大概率 401**；若不 401，更坏的结果是落进 §3.1.3 的静默重分类。**无论哪种，通道 1 都无法实现「客户端做伪装」这个 B 的核心前提。**

**通道 2：写 credentials 文件**

这确实能进入真正的 OAuth 模式、拿到原生伪装。但它把**凭据生命周期的所有权交给了客户端**：

| 池子写入 | token 过期时实际发生什么 |
|---|---|
| **(a) 不写 refresh** | 客户端到期尝试刷新、无 refresh 可用 → 掉进重新登录提示。工程师在任务中途顺手做了交互式 `/login`：好的情况是用了自己私人账号、**静默脱离池子**；坏的情况是登进了**池化账号**，铸造出一条池子并不持有的新 refresh 链 |
| **(b) 写入真实 refresh** | **等于把 refresh token 重新分发到 10 台笔记本**——正是本项目要逃离的现状——并且把并发刷新竞争**搬到了跨主机**，而那里没有任何锁（Anthropic 的修法是**跨进程**锁，只在单机有效） |
| **(c) 写文件 + 本机 shim 守护进程抢在客户端之前刷新** | 唯一诚实的版本。要求每台机器一个常驻 agent，拥有 credentials 文件、遵守客户端 v2.1.136 同款锁纪律（否则损坏文件）、赢下与一个**触发窗口未文档化**的主动刷新器的时间竞赛、跨两种客户端不同的凭据存储、并在 Claude Code 每次自动更新改格式或改时序后继续存活 |

**并且 (b)(c) 有一个反向失败**：如果客户端赢下竞争，它会烧掉池子的 refresh token、把轮换出的新 token 存在本地，**池子从此被锁在自己的账号外面**，直到有人去那台笔记本上把新 token 捞回来。**在方案 A 下这在结构上不可能发生——A 按构造只有一个刷新者。**

**粗粒度租借解决不了这个问题。** 失败不发生在租借边界上，而是「一个原生客户端持有 credentials 文件时，会按它自己的节奏、在启动时、在任何 401 时自行刷新」——这些租借都不知道。一个工程师周五合上笔记本、周一打开，第一次敲键盘就会触发。

**这条同时击穿了「规模形状错配」的论证**：初版裁决把「没人做 B」解读为"5-10 人规模下细粒度复用没价值，所以没人为这个形状建"。但它引用 `claude-usage-swap` 作为「最接近 B」的证据时，列出了那个项目的限制（一机一活跃账号、无跨机协调、per_session 仍撞上 **clobbering wall**），**却从没问为什么**。那个 clobbering wall **就是**上面这个凭据所有权冲突。**最接近 B 的现存项目，正是死于 B 将会死的同一个原因，而裁决引用了它却没读它的死因。**

规模形状能解释为什么没人做**细粒度**的 B；解释不了为什么唯一尝试**粗粒度** B 的项目撞上了一堵与用户数完全无关的墙。**一个根植于单客户端凭据存储所有权的阻塞点，在 1 个用户和 1000 个用户身上完全一样。**

### 7.3 A vs B：修正后的对比

初版裁决给出的几条「B 更优」，在攻击下大部分不成立：

| 初版论断 | 攻击后 |
|---|---|
| 封号面不对称是最大因素，B 显著更优 | **部分反转**。§5 的两个相关因素中，**per-account 请求量/频次在 A 和 B 之间完全不变**（同样的总需求 ÷ 同样的 N 个账号）；B 只动了「机房 IP」这一个，而这恰恰是**可以花钱买掉的**那个（teamclaude 自己的解法就是住宅代理，A-adopt 加住宅/静态出口约 $50-200/月）。更关键：**B 引入了一个裁决从未考虑的新相关因素——per-account 的 IP 漂移**。粗租借下 N < 并发人数时，同一个账号上午出现在工程师甲的家庭宽带、下午出现在乙的咖啡厅——**这是账号共享的典型信号**。A 下账号始终来自一个稳定 IP，看起来就是一台机器。**这一维度上 A 更干净。** 另：CRS#1108（稳定半年后随 CLI 版本更新被封）根本不是 IP 信号，是**指纹漂移**信号，B 经由 ex-machina 漂移同样中招 |
| 爆炸半径 B 更优（A 一个常量挂全员，B 可单人 pin 旧版本） | **方向反了**。本项目的**主导失败模式是静默的**（§3.1.3 重分类到 overage，无告警）。A：一个常量过期 → 全员同时 400 → **响亮、即时、中心可观测、一次修复一次部署**。B：某个工程师 pin 的旧插件漂移 → **只有他**被静默计费到 overage → 持续一周 → 而裁决自己也承认 **B 没有逐请求可观测性**。这两条不是两个独立的小 caveat，它们**复合成最坏象限：一个不可观测系统里、分布在 10 个互不协调端点上的、不可检测的失败**。而且 CRS#1108 说明**版本 pin 本身就是封号触发器**——裁决把一个已知危害写成了特性 |
| 粘性会话 B 免费获得 | **打平**。CRS 已内置从 `cache_control` 内容派生的粘性会话（配置开关即可）。B 相对 A-adopt 无优势，且 N < 并发人数时租借交接照样打散缓存 |
| 可用性 B 更优（池子挂了还能用 8 小时） | **成立，予以保留**。A 无对应能力。但要注意这是「延迟的悬崖」而非优雅降级，且池子恰好在刷新边界挂掉会触发 §7.2 的凭据捕获 |
| 六库收敛证据在 A/B 之间权重为零 | **狭义部分成立，但「零」是错的**。收敛证据不只是「六个项目集中了刷新」，而是「**六个互不相关的团队、包括厂商自己，各自独立发现『让单账号的刷新保持单飞』难到需要作为 bug 修复发版**」。这直接迁移：A 按构造只有一个刷新者；B 有 1 + N 个客户端安装，中间隔着一条没有共享锁的主机边界。**这是关于「B 免费假设的那个不变量有多难保证」的基础概率。权重应为中等，且不利于 B** |
| 伪装维护负担只在「自建」时才算 | **不成立**。B 下你依赖 ex-machina：一年 ~10 次纠正性发布、一次整架构回滚、无规范、靠 mitmproxy diff 维护、单维护者量级，**且刚被 opencode 以 ToS 理由下架**（宿主项目不再走这条插件路径 → 静默损坏概率上升，且无延续性保证）。这比 A-adopt 依赖的 sub2api(34.5k★) / CRS(12.4k★) **更薄**。B 没有逃掉伪装维护，只是把它外包给了最脆弱的维护者，并且（见上）失去了检测它失效的能力 |

**「5-10 人规模」这个论据能否救 B？** 不能。规模确实让 A 的核心价值（逐请求细粒度复用）趋近于零——这一点成立且重要。但 §7.2 的缺陷与规模无关。

### 7.4 对 owner 原始设计的裁定

**「推翻 owner 的设计」这件事，论证过程是不充分的，但方向大概率是对的。**

上一份报告推荐 A 的理由（六库收敛、成熟先例）是**弱理由**——它没看出真正的原因。真正的原因是**凭据生命周期所有权**：B 需要一个「池子可证明是唯一刷新者」的机制，而**这个机制在所有现存先例中都不存在**。

所以 owner 的设计不是「需要一个小修正（粗租借 + 客户端 shim）」，而是**需要一个先例中不存在的机制**。这不是拍脑袋否定，是有具体机制的否定。

**但 B 有一条初版裁决和上一份报告都没识别出的最强变体**，值得花一个下午做 spike：

> **opencode + fork 版 ex-machina，其 auth provider 每次会话从池子动态取 token，本地永不存储 refresh token。**

这是唯一能干净解决 §7.2 的 B 变体——因为客户端根本没有 refresh token 可刷。**前提是全组织统一用 opencode。** 但注意它与 attestation 的关系（见 §7.5）：**它恰恰是 attestation 最先杀死的东西**，所以不能作为长周期押注。

### 7.5 attestation 裁定

若 Anthropic 开启服务端 `cch` 强制校验：

- **A 全部死亡**，包括 Bun 写的代理——公开版 Bun 没有 `Attestation.zig`。sub2api 的 34.5k star 一夜之间变成 34.5k star 的死代码。
- **B 也死**。B 的伪装是 JS 插件（ex-machina），同样无法 attest，**和 A 死法一致**。初版裁决说 B 能退化到"大家都用真 Claude Code"——但那正好退进了 §7.2 通道 2 那个未解决的子变体。**而且 §7.4 那个最强 B 变体（opencode + fork）是第一个被杀死的。**
- **只有 A′ 存活**：网关后端 shell out N 个真 `claude` 进程。它有一个初版裁决没注意到的额外优势——N 个自刷新的 CLI 实例**共处一台主机，跨进程锁在这里终于真的有效**。代价是把 §5 的封号相关因素推到最大，且语义退化。

**处置**：把 attestation 当作 **Anthropic 手里一张随时可打、且已经造好的牌**（代码已随二进制发布、只差 flag，这不是闲置代码）。这一条单独就把「A 值得投入多少」封顶在**一次性、可抛弃**。

### 7.6 成本模型：两轮分析都没算的那个数

初版裁决只给 A-build 标了价（0.3-0.5 FTE ≈ $5-8k/月）。**其余三个选项全部没标价**，这是个干净的记账缺陷：

- **B 被标价为零。** B 需要：池子 + 租借服务 + 每机 shim（§7.2）+ 两种客户端集成 + 跟随 Claude Code 自动更新维护 shim + 一个 fork 版 ex-machina。而且它**没有上游可跟踪**——不像 A-build 还能读 sub2api / CRS / ex-machina 源码。一个无先例的定制守护进程，**很可能 ≥ 0.3 FTE，且发现风险严格更高**。
- **套利本身从未被计算。** 而且对比轴错了：N 份订阅在**每个**方案下都是沉没成本，所以 A-build 应该和 A-adopt、B 比，而不是和「订阅 vs API 的总套利」比。
- **同一把成本尺子从未量过 B，也从未量过「什么都不做」。** 如果真实套利只有每月低四位数，那么**任何 0.3 FTE 的方案都是亏的——包括 B**，答案变成「买席位 / 上 Bedrock，别建了」。

**在算出套利数字、并把 B 的自建成本放到同一页之前，任何方案都不该被贴上「可行 / 不可行」的标签。**

### 7.7 推荐路径

**1. 今天就做（零风险、与裁决无关）**
把 CI / 自动化 / 批处理流量迁到 Console 按量计费 key（方案 E）。这是频次最高、最机器节奏、最符合封号相关因素的流量，一个下午就能从订阅账号上摘下来，官方支持。**它同时降低了 per-account 请求量——那个 A/B 都动不了的封号相关因素。**

**2. 本周并行做两件事**
- **算出套利数字**，并把 Bedrock / Vertex 相对 N 份订阅定价。这是**一切方案的基准线**，两轮分析初期都漏了它：官方认可、集中计费、按人 IAM 授权、完整审计、零 ToS 暴露、attestation 免疫。
- **联系 Anthropic**，问 Team / Enterprise 席位方案。这不是"信息缺口"，是**支配性论证**——整套 A/B 分析本质上是在对一个你从未询问过的对手方维持可否认性。
  ⚠️ **但询问不是免费的**：向销售描述"我们把 N 个 Team 席位的 OAuth refresh token 集中在一台服务器上"，等于用实名账号披露一项可能被禁止的做法。**只问目标（集中席位管理、小团队网关支持、Team/Enterprise 定价、Bedrock/Vertex），永远不要描述现有机制。**

**3. Gate 0（约 4 小时，而非 1 小时）——在写任何产品代码之前**
见 §9。必须包含：
- 计费桶归属测试（含**烧穿式可观测量**，不能只读面板——Team/Max 用量报告粒度粗且延迟，逐请求 overage 归属可能根本观测不到）
- **跨过期的刷新所有权测试**（≥9 小时真实会话、客户端刷新器保持活跃、两种客户端都测；然后看**是谁刷新的**、以及**池子的 refresh token 是否还能用**）——这一条单独就能解决 §7.2
- 两个并发工程师、两个账号
- Claude Code 自动更新后重跑一遍

**4. 若必须自建，默认选 A-adopt**
sub2api 或 CRS 原样部署 + 住宅/静态出口 + 打开粘性会话。理由：可逆（一个下午回退）、中心可观测、失败响亮、**按构造只有一个刷新者**、并且用约 $100/月买回了 B 在封号维度的大部分优势。

**5. B 仅在 Gate 0 证明存在「池子可证明为唯一刷新者」的客户端路径时复活**
最强候选是 §7.4 那个 opencode + fork ex-machina 动态凭据加载器变体（值得一个下午的 spike），但它也是 attestation 最先杀死的东西，不能作为长周期押注。

**6. 总投入上限 2-3 周。** A 和 B 都违反 ToS，且都离「一个 build flag 就死」只有一步。**不要建平台。**

### 7.8 攻击后仍然成立的论断

为免矫枉过正，明确记录哪些初版判断在攻击下存活：

- ✅ CI 迁 Console key —— 完全成立，且应提升到第一优先级
- ✅ 「返回 200 什么都不证明」—— 完全正确，是本轮最有价值的单条洞察
- ✅ A-adopt = FEASIBLE-WITH-CAVEATS
- ✅ A′ 是唯一同时具备中心控制 + attestation 免疫的形态，且 attestation 部分做了正确的条件化（未断言启用时机）
- ✅ 可用性：B 的 ≤8h 续航是真实优势，A 无对应能力
- ✅ 「刷新集中化本身」在 A/B 之间确实中立，上一份报告确实过度依赖了「收敛即权威」
- ✅ 上一份报告推荐 A 的**论证**确实不充分（虽然**结论方向**大概率对）

---

## 9. 前置验证实验（与裁决无关，A/B/E 都需要，应在写任何产品代码之前跑完）

无论最终选哪个方案，下面两个实验都决定项目地基。**成本约 1-2 小时，但能把整个项目从"押注"变成"已知"。**

### 实验 1【最高优先级】计费桶归属验证

**为什么是它**：整个项目的价值主张是「共享**订阅额度**」。但存在一个**静默失败模式**——伪装不完美时流量被重分类为第三方，账单漂移到按 token 计费的 overage（§3.1.3），**且没有任何告警**。如果不验证这一条，项目可能"看起来在跑"，实际每一分钱都在按量烧。

**协议**：

1. 取一个池化账号，记录实验前的用量基线（该账号的 plan limits 与 extra usage 两个数字都要记）。
2. 在一台**原生、未装任何插件**的 Claude Code 上，保持默认 base URL，设
   `ANTHROPIC_AUTH_TOKEN=<该账号的 OAuth access token>`。
3. 发一次真实请求。
4. **打开该账号的用量页，确认这次请求扣在哪个桶：plan limits 还是 extra usage。**
5. 同一小时内跑变体：不用环境变量，改为把 token 写进本地 credentials 文件
   （`claude-usage-swap` 的机制），重复步骤 3-4。

> ⚠️ **验证扣费桶才是这个实验的全部。「返回 200」什么都不证明**——静默重分类的表现恰恰就是 200 + 正常回答 + 扣错桶。

**判读**：
- 任一变体扣在 plan limits → **方案 B 成立**，且是个约 2 周的工程量，A 变得不必要。
- 两个变体都被重分类 → B 死。转向 A-adopt，并且**必须用同一套扣费桶检查再验一遍代理**后才能信任它。

### 实验 2 access token 跨 IP 可用性（本环境冒烟确认）

证据状态**好于**本文初版的描述（初版误判引用不存在，已在 §0.1 撤回）：既有迁移指南「踩坑 B」的
一手实测（旧机 access 拿到新机仍返回 200 + 真实用量），又有 34.5k★ 级生产项目的大规模旁证。
本实验的目的不是补证结论，而是把「在别人环境成立」坐实为「在我们的部署环境成立」——
毕竟整个池子的地基压在这条上，一次低成本冒烟很划算。

**协议**：中心机刷新账号 X → 立刻从另一台不同 IP（最好不同网络出口）的机器，用该 access token 打一次
`/v1/messages`（带完整伪装）与 `/api/oauth/usage`，确认均 200；同时确认中心机后续刷新不受影响。

### 待裁决的开放技术问题（影响 B 的成败，需在实验中一并确认）

**Q：方案 B 下，客户端到底会不会自己刷新？这可能是 B 的致命伤。**

ex-machina 的刷新判据是 `auth.expires < Date.now()`（`index.ts:46-140`，**无提前量 buffer**）。池子把租借的 token 写进客户端 `auth.json` 后：

| 池子写入什么 | token 过期时会发生什么 |
|---|---|
| 只写 `access + expires`，不给 refresh | ex-machina 拿 `refresh: undefined` 去 POST → 失败。行为未知，可能污染凭据状态 |
| 写入哨兵/无效 refresh | POST → `invalid_grant` → ex-machina 可能把凭据标记为损坏 |
| 写入**真实** refresh | **「池子是唯一刷新者」这个 B 的核心性质当场破产**，退回多机竞争 |

可行解是**客户端 shim 在过期前主动续租并重写 `auth.json`**（ex-machina 每次请求都重读该文件），让 `expires` 永远在未来，ex-machina 就永远不会触发自己的刷新路径。但这要求 shim 常驻且可靠——**shim 挂掉或机器休眠期间 token 过期，就会落进上表某一行**。

**这直接关系到 B 最核心的论据能否成立**：如果规避这个问题必须 fork ex-machina，那么「把逆向工程维护负担外包给上游」的论据就塌掉一半——我们又变回了维护者。

必须在实验阶段用真实 ex-machina 确认：写入无效/缺失 refresh 后 token 过期，客户端的实际行为是什么。

---

## 8. 风险登记册（按 期望损失 × 概率 排序）

| # | 风险 | 概率 | 损失 | 受影响方案 | 说明 |
|---|---|---|---|---|---|
| **R1** | **静默计费漂移**：流量被重分类为第三方，账单从订阅额度漂到按量 overage，**无任何告警** | 高 | 高 | A、B 均有 | 主导失败模式。**B 更糟**：分布在 10 个端点、逐个静默发生，且 B 自认无逐请求可观测性 → 最坏象限。A 至少是中心可观测的 |
| **R2** | **客户端捕获 refresh 链**：客户端自行刷新赢下竞争，池子被锁在自己账号外 | 高（若走 B） | 高 | **仅 B** | §7.2。A 按构造不可能发生。这是推翻 B 的那条 |
| **R3** | **账号被封** | 中（已有"数天内"实例） | 高且不可逆 | 全部 | $200/月席位永久损失 + 可能的组织级后果。相关因素：per-account 请求量/频次（**A/B 相同**）、机房 IP（A 可花约 $100/月买掉）、per-account IP 漂移（**B 更差**）、指纹漂移（A/B 相同） |
| **R4** | **伪装漂移** | 高（一年 ~10 次纠正发布） | 中 | A、B 均有 | A：全员同时 400，响亮、一次修复。B：外包给 ex-machina（更薄的维护者、刚被 opencode 下架），单人静默中招 |
| **R5** | **NATIVE_CLIENT_ATTESTATION 启用** | 未知（代码已发布，只差 flag） | **总损失** | A 死、B 也死；仅 A′ 存活 | 单这一条就把 A 的投入封顶在"可抛弃" |
| **R6** | **无熔断器**：粗租借给出对整个配额窗口 ≤8h 的无节流权限 | 中 | 中 | **仅 B** | 一个善意工程师的失控 agent 循环就能烧穿一个账号的窗口，中心无从限流。A 免费获得令牌桶 |
| **R7** | **429 分类逻辑需在每台笔记本上复刻** | 中 | 中 | **仅 B** | 客户端看到 429、但池子看不到 → CRS#1000/PR#1213 那个教训要在 10 台笔记本上重新学一遍、重新发一遍。A 只需一处 |
| **R8** | **单一出口 IP 的 IP 维度 429** | 中 | 中 | 主要 A | 切账号无效。可用住宅/静态出口缓解 |
| **R9** | **中心 token 库泄露** vs **凭据散布到 10 台笔记本** | 低 | 高 | A 集中 / B 分散 | A：单点但可控（加密、审计、最小权限）。B：活凭据落在管控最弱的机器上，且离职回收需要轮换整条 refresh 链 |
| **R10** | **prompt cache 被打散** | 低（A-adopt 已内置粘性；B 粗租借天然粘） | 中 | 主要 A-build | A-adopt 配置开关即可 |
| **R11** | **refresh 竞争** | —— | —— | **A、B 相同，已解决** | 本组织已有可用实现。**这条不应影响 A/B 决策**，上一份报告让它承担了过多权重 |
| **R12** | **锁定与不可逆性** | —— | 中 | **B 明显更差** | A-adopt 一个下午回退；B 需要卸载每台笔记本的 shim，若 refresh 链已被捕获还需逐账号人工恢复。**在 attestation / 封号 / ToS 三重外生不确定性下，应当优选可逆方案** |
| **R13** | **合规（按席位授权）** | —— | 未知 | **B 契约上更差** | B 下每个工程师从自己机器上以全部 N 个受许可席位的身份鉴权——这是最清晰的席位共享形态。检测维度上 B 略优，合规维度上 B 更差 |
| **R14** | **询问 Anthropic 本身的披露风险** | —— | 中 | 全部 | 向销售描述现有机制 = 用实名账号披露可能被禁止的做法。**只问目标，不描述机制** |

---

*本文为 Issue #1 的深化交付物。所有论断均可回溯至上文标注的 `文件:行号` 或 URL。*
