# ADR：claude-accounts-usage 分模式（local / cloud-master / cloud-worker）

> 状态：**待验证（Gate-0 未跑，禁止动产品代码）**
> 关联：Issue #1 · [pool-feasibility.md](../research/pool-feasibility.md) · [options-analysis.md](../research/options-analysis.md)
> 决策日期：2026-07-30
> 后记（2026-08-01）：本 ADR 中的 pool key 鉴权其后被移除，master 改为无应用层鉴权、以绑定地址为唯一边界；本文按原样保留为当时的决策记录，现状见 [cloud-mode.md](../cloud-mode.md#为什么整台-master-都不做鉴权)。

---

## 0. 背景与定性

把现有 opencode 插件 `claude-accounts-usage` 从「纯本地」拆成三种模式：

- **local**：保持现状不变（ex-machina 做 OAuth 登录+伪装+刷新，插件在工具层做账号档案+切换+用量展示）。
- **cloud-master**：跑在中心主机，维护所有账号的 token（唯一刷新者），对外发放短期 access token。
- **cloud-worker**：工程师机器，向 master 索要 access token 使用，本地不刷新、不持有 refresh。

**这个架构在 research 分类里 = 方案 B（Token 租借），且是 [options-analysis.md §7.4](../research/options-analysis.md) 点名的「唯一干净的 B 变体」**：

> worker 每次会话从池子动态取 token，本地永不存储 refresh token。

research 对该变体的定性必须原样带入本 ADR：**「唯一能干净解决 §7.2 正确性缺陷的 B 变体」，但「attestation 最先杀死的东西」「不能作为长周期押注」，且只有在 Gate-0 实验通过后才复活。** 本 ADR 记录的是「若要建，怎么建」，不改变「该不该建由 Gate-0 裁决」这一前提。

---

## 1. 决策记录（10 条）

| # | 决策点 | 选择 | 关键理由 / 代价 |
|---|---|---|---|
| 1 | worker 防自刷新 | **worker keeper 提前续租，永不持 refresh** | ex-machina 刷新判据是 `auth.expires < Date.now()`（无 buffer，见 ex-machina `index.ts:46-140`）。只要 worker 的 auth.json 里永远只有 access、`expires` 永远在未来，ex-machina 就永不触发自刷新路径。这是从根上掐掉 §7.2 正确性缺陷的唯一干净做法。代价：worker keeper 必须常驻可靠。 |
| 2 | 调度权归属 | **master 集中调度 + 按用量轮转（无粘性）** | 吞吐最大化。**主动接受**两个代价：prompt cache 被打散；per-account IP 漂移最重（同账号频繁跨 worker/IP = 最强账号共享封号信号 R3）。连带强制决策 6 = 必须回传用量。 |
| 3 | 撞限自动切号 | **worker 检测+续接，master 决策换号** | 429 和 session 事件物理上只在 worker 看得到（检测 + 原 session 发 continue 必须留 worker）；选号归 master（符合决策 2），冷却状态机集中在 master 一处（避免 R7 在每台机器复刻 429 分类逻辑）。 |
| 4 | worker↔master 鉴权/传输 | **内网/VPN + 每 worker 一个 pool-key（Bearer）** | 决策 1 是拉取续租 → 普通请求/响应，无需长连接。master 只在内网面暴露，pool-key 可单独撤销/审计/限流，把 research §2.6 风险②（中心 token 库泄露）暴露面压到最低。 |
| 5 | 续租失败 fail-safe | **提前续租 + 过期即硬阻报错（宁停勿污）** | keeper 剩 N 分钟就续租+指数退避；万一真过期且 master 不可达，worker gate 直接拦请求报错，**绝不让 ex-machina 用 `refresh: undefined` 去 POST、绝不弹 /login**。宁可任务暂停，也不污染凭据、不铸新链（R2）。 |
| 6 | 用量可观测 | **worker 逐响应回传 ratelimit 头** ⚠️**已修订，见 §7**| 决策 2 要按用量轮转，实时用量只在 worker 的 `anthropic-ratelimit-unified-*` 响应头里。**残留缺口**：纯静默的「200 + 扣错桶」计费漂移（R1）在响应头里看不到，需查用量页——这只眼睛暂时闭着，待 Gate-0 实验 1 结果决定是否补 master 轮询。 |
| 7 | 纳管入口 | **master 上跑 ex-machina PKCE 登录，keeper 自动收录** | 复用现有全套 autoCapture 逻辑，零新代码。定死了 master 上必须装 ex-machina（纳管要用）。硬规矩：纳管进池的账号，池外一切副本必须清除（否则铁律 2 锁死）。 |
| 8 | master 角色 | **纯 token 维护 + lease server，不跑 inference** | auth.json 的「单一 activeId」语义在 master 上废弃，账号库成为真相源（正是 research §1.2 预言的转变）。keeper 从「依赖 ex-machina 惰性刷活跃号 + 只主动刷非活跃号」改造成「主动刷全部账号」。opencode server 只承载插件运行时 + 管理面。 |
| 9 | provider 范围 | **MVP 只 cloud 化 Claude；OpenAI 走本地不纳池** | OpenAI 侧机制不同且更危：codex 是刷新者、refresh 重放吐销整个 token 族、插件 keepalive/autoswitch 默认关且只单账号验证过。收窄到 anthropic 单 provider 避雷。 |
| 10 | mode 配置/共存 | **tui.json 结构化配置 + 单代码库分支** | mode 与参数（mode / masterUrl / poolKey）写进 tui.json 配置块（现在是纯 env，需新写解析）。一份代码库按 mode 分支，local 走现有路径、cloud-* 走新路径，共享 accounts/lock/usage 底层模块。 |

---

## 2. 由决策推导出的架构

```
┌─ master（中心主机，内网/VPN 面）──────────────────────────────────┐
│ opencode server + ex-machina + claude-accounts-usage(cloud-master)  │
│                                                                     │
│ [纳管]     管理员 opencode auth login (ex-machina PKCE) → 账号库      │
│ [keeper改造] 主动刷新「全部」账号 refresh；账号库=真相源             │
│            （废弃单一 activeId / auth.json / INV-2）                 │
│ [调度器·新] 按用量轮转选号 + 冷却状态机（从 worker autoswitch 迁来）  │
│ [lease server·新] pool-key 鉴权：reg / 发 access / 收用量 / 报撞限换号 │
│ [token库]  全部 refresh 静态加密，永不出机器                         │
└─────────────────────────────────────────────────────────────────────┘
        ▲  领 access / 回传用量 / 报撞限换号   (HTTP + pool-key, 内网)
        │
┌─ worker（每个工程师机器）─────────────────────────────────────────┐
│ opencode + ex-machina + claude-accounts-usage(cloud-worker)         │
│                                                                     │
│ [keeper改造] 不本地刷新；提前向 master 续租，重写 auth.json          │
│            让 expires 永在未来；auth.json「只写 access，永不写 refresh」│
│ [gate·新]  access 过期且 master 不可达 → 硬阻请求+报错，             │
│            绝不让 ex-machina 拿 undefined refresh POST、不弹 /login   │
│ [ex-machina] 照常在「客户端」做伪装 → 直连 api.anthropic.com         │
│ [autoswitch改造] 检测 429 + 原 session 发 continue 留本地；          │
│            选号改为「上报 master 要新号」                            │
│ [回传]     逐响应抓 ratelimit 头 → master                           │
└─────────────────────────────────────────────────────────────────────┘
```

**一次推理数据流**：worker opencode → ex-machina（本地伪装，用 master 租来的 access）→ `api.anthropic.com` → 响应头 ratelimit → worker 回传 master。
**后台续租**：worker keeper 定期向 master 续租 access → 重写 auth.json（`expires` 永在未来）。

---

## 3. 工作量清单（「不是加个 flag」的证据）

**master 侧净新增**
- lease server：HTTP + pool-key 鉴权 + reg + 发号 + 收用量 + 换号端点。现在是纯 TUI 插件、**零网络面**，这块全新。
- keeper 改造：脱离「active/inactive + ex-machina 惰性刷活跃号」假设（见 `src/keeper.ts` `keeperTick`），改成主动刷全部账号。
- 中心调度器：按用量轮转 + 冷却状态机（把 `src/autoswitch.ts` 的选号逻辑迁移并中心化）。
- 账号库取代 auth.json 成真相源（脱离 INV-2，见 `src/usage.ts:247`）+ refresh 静态加密。

**worker 侧净新增**
- keeper 改造：本地刷新 → 向 master 续租。注意 `AuthToken.refresh` 现为必填（`src/accounts.ts:91`），worker 要能写「只有 access、无 refresh」的记录，schema 要动。
- gate：过期 + master 不可达的硬阻断 fail-safe。
- autoswitch 改造：选号→上报 master；检测 + continue 保留。
- 逐响应 ratelimit 头抓取 + 回传。

**共享**
- tui.json 配置解析（mode + masterUrl + poolKey，现在是纯 env）。
- accounts / lock / usage 底层模块复用。

---

## 4. 决策未关闭的残留风险（诚实记账）

| 风险 | 状态 | 说明 |
|---|---|---|
| **R3 per-account IP 漂移** | **主动接受** | 决策 2 无粘性轮转 → 同账号频繁跨 worker/IP → 最强账号共享封号信号。这是本设计相对代理(A-adopt)**结构上更差**的一维。 |
| **R1 静默计费漂移** | **暂时闭眼** | 决策 6 只回传响应头，纯静默「200 + 扣错桶」看不到。待 Gate-0 实验 1；若证明存在静默重分类，决策 6 必须回来加 master 轮询。 |
| **R4 伪装漂移** | **未消除** | 决策 8 让 master 做纯发放机，伪装仍跑在 worker 的 ex-machina 里。押注单维护者、且刚被 opencode 1.3.0 下架的插件；一个常量过期 → 全体 worker 静默挂，而决策 6 看不到。 |
| **R5 attestation** | **不可控外生** | 这个「客户端 JS 伪装」变体是服务端 `cch` 强制校验最先杀死的（§7.5）。押注上限 = 可抛弃，别建平台。 |

**结论**：这 10 个决策把方案做成了「最强的 B」，但 B 相对 A-adopt 的三个结构劣势（IP 漂移、伪装漂移+盲区、attestation 先死）是决策层面消不掉的。

---

## 4.5 Gate-0 实测结果（2026-07-31 凌晨，真实账号实跑）

### ✅ 实验 1（lease 形态功能验证）—— PASS
隔离 `XDG_DATA_HOME` 沙箱，`auth.json` = `{真 access, 哨兵 refresh, 真 expires}` → `opencode run` 走**真实 ex-machina** → **推理成功**。事后沙箱 `auth.json` 的 `refresh` **仍是哨兵**，证明 ex-machina 全程未触发刷新。前置的 containment 门禁（假 token → `Invalid bearer token`）证明请求真的到达 Anthropic、哨兵不阻断链路、且沙箱未回落到真实凭据。

⇒ **决策 1 + 修订 A1 在真实 API 上被验证**：worker 只持 `access + 哨兵` 即可跑真实推理，且不会成为第二个刷新者。

### ✅✅ 计费桶归属 —— **PASS，租借流量计入订阅额度**（决定整个价值主张的那一问）
受试 `vince.dai2`，全新 5h 窗口。沙箱 `auth.json` = lease 形态（真 access + 哨兵 refresh），经**真实 ex-machina** 发出 3 次真实推理：

| 指标 | before | after | delta |
|---|---|---|---|
| `five_hour.utilization`（订阅桶） | 0.0% | **7.0%** | **+7** |
| `seven_day.utilization`（订阅桶） | 0.0% | **1.0%** | **+1** |
| `spend.used.amount_minor`（超额桶，**分**为单位） | 0 | **0** | **0** |
| `extra_usage.is_enabled` | false | false | — |

⇒ **订阅窗口被扣，超额桶分文未动。R1（静默计费漂移）在本通道上未发生。** 事后沙箱 `refresh` 仍是哨兵，ex-machina 全程未刷新；真实 `auth.json` 中**未出现哨兵**（已 grep 验证），三个 anthropic 号的 refresh 仍全是合法 `sk-ant-ort…` 形态。

**测量仪器的发现（此前被忽略的字段）**：完整 usage 载荷含 `spend.used.amount_minor`（**分**级分辨率的超额计数器，远优于 `utilization` 的 1% 粒度）与 `extra_usage.*`。这两个字段才是检测「静默漂移」的正确仪器，`utilization` 单独看不出来。

**并且一个反转风险评估的发现**：该账号 `extra_usage.is_enabled = false`、`user_disabled = true`、`spend.can_purchase_credits = false` —— **超额通道是关闭的**。而 R1「静默漂移到 overage」**要求 overage 处于开启状态**才可能发生；关闭时被重分类的流量只能**硬失败**（research 引的原文即 `400: "Extra usage is required…"` / `"Third-party apps now draw from your extra usage"`），而非无声烧钱。⇒ 对这批账号，R1 的失败形状从「静默」变成「响亮」。

**仍未证的残余**：本测量在**同一台机器**完成。真实部署中 worker 在**另一台机器/另一出口 IP**。research 已有反面证据（access token 不绑 IP：迁移指南「踩坑 B」一手实测 + 34.5k★ 生产项目依赖此性质），但「跨 IP 是否影响计费归属」本机永不可测，需第二台机器复跑本协议。

**顺带的分析修正**：research §9 实验 1 的原协议测的是「原生客户端 + `ANTHROPIC_AUTH_TOKEN`」= **通道 1（绕过伪装）**；而本架构走**通道 2（写凭据文件 + 未经修改的真实 ex-machina）**。§3.1.3 的静默重分类风险源于**方案 A 自行重写伪装**，cloud-worker 的请求与常规流量同源——这解释了为何本次测得的结果是干净的。

### 🚨 实验 2（refresh 归属权）—— 推翻先验，暴露真实设计缺陷
| 步骤 | 观测 |
|---|---|
| 刷新前 `access1` | HTTP **200** |
| `POST /v1/oauth/token`（`grant_type=refresh_token`） | 成功，`refresh2 ≠ refresh1`（轮换确认），`expires_in=28800s`（8h） |
| **刷新后 `access1`** | HTTP **401** |
| 新 `access2` | HTTP **200** |

⇒ **Anthropic 在刷新时立即作废上一枚 access token。** 这违反常规 OAuth 2.0 语义（access token 本应独立按期失效），也推翻了「从 OAuth 语义 + 生产池存活推断不会作废」的先验论证。

**由此暴露的缺陷：缓冲区方向是反的。** master 在 `expires - MASTER_MIN_REMAINING_MS`（10min）刷新 → 所有在外租约当场死亡；而 worker 直到 `expiresAt - LEASE_RENEW_BUFFER_MS`（5min）才续租 ⇒ **中间 5 分钟 worker 手持死 token**。

**修法（两层，均已实施）**：
1. **INV-CLOUD-4**：master 下发 `expiresAt = accountExpires - MASTER_REFRESH_THRESHOLD_MS`（即 master 自己可刷新的时刻）。worker 的 5min 缓冲随即落在其之前 ⇒ 恒早于 master 轮换至少 5 分钟续租。租约视界若已过期则返回 503，绝不下发「到手即死」的 token。**减数必须恒等于 refresher 的触发门槛**：两者一旦脱钩，下发的视界就会越过那次轮换，worker 会抱着一枚已被作废的 token 直到自己的续租时刻才发现。
2. **INV-CLOUD-5**：worker 把 **401 当作「租约被轮换」**而非额度问题——立刻以 `reason:"prelease"` 重新领租并续接，**不冷却该账号、不通知 master 排除它**。把 401 误route进限流路径会白白冷却一个健康账号、削减池子容量。

**连带影响**：这条也解释了为什么「master 必须是唯一刷新者」比原先理解的更严格——任何一次池外刷新不仅会轮换 refresh 链，还会**当场击毙所有在外的 access 租约**。

---

## 5. 开工前硬门槛：Gate-0（决策做完也不能跳）

两个实验来自 research §9，本 B 变体对它们比代理更敏感。**在写任何产品代码之前必须跑完。**

### 实验 1 · 计费桶归属（最高优先级）
拿一个池化账号的 OAuth access token + 客户端 ex-machina 打一次真实 inference，**打开该账号用量页**确认扣在 plan-limit 还是 overage。
- ⚠️ 返回 200 什么都不证明——静默重分类的表现恰恰是 200 + 正常回答 + 扣错桶。
- **判读**：扣 overage → 整套「共享订阅额度」价值主张归零，本架构当场死亡，一行产品代码都不该写。

### 实验 2 · 跨过期刷新所有权
worker 的 auth.json = 「过期 access + 无/无效 refresh」时，用**真实 ex-machina** 观察其实际行为（是否 POST `refresh: undefined`、是否弹重登、是否污染凭据）。
- 直接验证决策 1 + 决策 5 的地基是否成立。
- 若规避这个问题必须 fork ex-machina，则「把伪装维护外包给上游」的论据塌掉一半。

---

## 7. 决策修订（2026-07-30，实施阶段实测发现）

### 7.0 决策 1 的编码方式必须改：opencode 要求 `refresh` 字段存在，否则**静默丢弃整个凭据**

原决策 1 写的是「worker 的 auth.json 只写 access + expires，**永不写 refresh**」。**实测证明这样 worker 根本跑不起来。**

**实验**（隔离 `XDG_DATA_HOME`，未触碰真实 auth.json，opencode 1.18.9）：

| # | anthropic 条目内容 | `opencode auth list --pure` 结果 |
|---|---|---|
| A（对照） | `type + access + expires + refresh`，**refresh 是假字符串** | `● Anthropic oauth` → **1 credentials** ✅ |
| B | `type + access + expires`，**无 refresh** | **0 credentials** ❌ |

**结论**：opencode 的运行时校验**要求 oauth 条目带 `refresh`**（与官方 SDK 类型 `OAuth = { type, refresh: string, access, expires }` 的必填声明一致）。缺失时条目被**静默丢弃**——exit 0、零报错、零日志。`anthropic` provider 因此没有任何凭据，ex-machina 的 loader 拿不到可用 auth，worker 完全不可用。**这是本 ADR 未预见、research 也未覆盖的失败模式，且失败形状最坏（静默）。**

**修订后的决策 1**：

> worker 的 auth.json 写 `access + expires + 哨兵 refresh`——一个**明确的、可识别的非真实 token 常量**（例如 `"cloud-worker-no-refresh-sentinel"`）。

**为什么这仍然完整保住原始意图**：
1. 哨兵**不是** refresh token，worker 手里依然**没有任何可用于刷新的凭据**；master 仍是唯一刷新者。铁律 2 的双机互顶前提依然被消除。
2. 实验 A 已证明 refresh 的**值不被校验**，只校验字段存在性 → 哨兵满足 schema。
3. **双重保护**：正常路径下 keeper 把 `expires` 续在未来 → ex-machina 的刷新分支永不触发（`index.ts:49` 无 buffer，已源码确证）；万一 gate 失守真的触发了，ex-machina 拿哨兵 POST → Anthropic 400 → **只重试 5xx 故立即 throw → 绝不写 auth.json、绝不 rotate 任何东西**（`index.ts:84-92`、`auth.set` 仅在 `response.ok` 后）。**没有合法 refresh 被发出，master 的链路零风险。**

**新增实现约束（否则哨兵会变成新的 bug 源）**：
- 哨兵必须是**可识别的常量**，且 cloud-worker 模式下 `autoCapture` / `onAuthJsonChanged` 的捕获路径**必须拒绝把它当成真实 refresh 收录进账号库**，更不能回传 master。这是 INV-2（auth.json 为活跃链真相源）在 worker 侧被废弃后必须补上的护栏。

### 7.1 决策 6 的「逐响应回传」被证伪

**结论：决策 6 原文「worker 逐响应回传 ratelimit 头」在 opencode 插件层不可实现。**

### 证据（一手源码，非推断）

1. `session.status` 的事件形状在本仓代码里写死，**只有三个字段**：
   ```typescript
   properties: { sessionID: string; status?: { type: string; message?: string; next?: number } }
   const error: RetryErrorLike = { message: status.message }   // ← 只有 message
   ```
2. `RetryErrorLike`（`statusCode` / `responseHeaders` / `responseBody`）**不是插件 API 提供的类型，是本仓自己手写的期望形状**（`src/providers.ts:8-13`）。其注释原文：
   > `session.status(retry)` fills in `message` ONLY; `session.error` can carry the full HTTP triple.
3. 在 `node_modules/@opencode-ai/plugin@1.18.9` 的**全部 `.d.ts` 中 grep `responseHeaders|responseBody|statusCode` → 零命中**。插件 API 没有响应头这一类型化表面。
4. 头部唯一可能的来源是 `session.error` → `toErrorData()`，而它**只认 `name === "APIError"` 的 `.data`**（`src/autoswitch.ts:37-42`）——**仅存在于错误路径**。

→ **成功响应的 ratelimit 头在插件层不存在。** master 无法从 worker 流量获得稳态的 per-account 剩余额度。

### 修订后的决策 6（不删需求，换成唯一能达成同一目的的机制）

| 用途 | 机制 |
|---|---|
| **稳态轮转数据**（服务决策 2 的按用量选号） | **master 轮询 `/api/oauth/usage`** —— master 本就持全部 refresh，仓内已有 `fetchUsage` / `collectAllUsage` 打 `USAGE_ENDPOINT` 的成熟实现可直接复用。这正是决策 6 当时的选项 2。 |
| **撞限即时信号**（服务决策 3 的换号） | **worker 回传它唯一能看到的限流头** —— 即 `session.error` 的 `APIError.data` 里的 `anthropic-ratelimit-unified-*`。这本就是决策 3 要求的「worker 上报撞限」，两者合并为同一条上报。 |

**连带影响**：master 轮询会顺带拿到 plan-limit 与 overage 两个桶，因此 ADR §4 里「R1 静默计费漂移这只眼睛暂时闭着」的缺口**被动补上了一半**——但仍需 Gate-0 实验 1 确认扣费桶归属，轮询只能观测、不能证明归因。

**代价**：`/api/oauth/usage` 有已知的持续 429 问题（upstream #31021），且粒度粗、有延迟。轮询节奏必须复用 keeper 既有的「串行 + 账号间隔 + per-account 429 冷却」纪律，不能并行打。

---

## 6. 后续
- Gate-0 两个实验各出一份可执行协议 + 判读结论。
- 实验通过后再落 Work Plan（`.omo/plans/*.md`，含显式 Git Strategy）。
- 实验任一失败 → 回到 [options-analysis.md §7.7](../research/options-analysis.md) 的 A-adopt / E / Bedrock 路线重新决策。
