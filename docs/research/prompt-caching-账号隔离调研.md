# Anthropic Prompt Caching 的隔离边界调研（面向多账号池切号）

调研日期：2026-09-08。所有原文均由 `curl` 抓取官方页面正文（docs 站点的 `.md` 原文视图）后摘录，未改写。
若引文中原本含 Markdown 内联链接标记，已在该条目下注明"已去除内联链接标记"。

---

## 一句话结论

**是：prompt cache 按 organization 隔离，在 Claude API / Claude Platform on AWS / Microsoft Foundry 上进一步按 workspace 隔离。**
换一个属于不同 organization 的 Claude 账号去发同一段前缀，缓存必然 miss，必须重新支付 cache write（`cache_creation_input_tokens`）。
反向的例外只有一个：**同一 organization、同一 workspace 内**的不同用户 / 不同 API key，只要 model 与前缀完全一致，是可以互相命中同一份缓存的。

---

## 证据表

### E1. 缓存在组织之间隔离，且组织之间永不共享（核心结论）

- 论断：跨 organization 一定 miss；这是官方明文，不是推断。
- 英文原文：
  > **Organization and workspace isolation:** Caches are isolated between organizations. Different organizations never share caches, even if they use identical prompts. Caches are also isolated per workspace within an organization on the Claude API, Claude Platform on AWS, and Microsoft Foundry; Bedrock and Google Cloud use organization-level isolation only.
- 中文翻译：
  > **组织与工作区隔离：** 缓存在各组织之间是隔离的。不同的组织之间永远不共享缓存，即使它们使用完全相同的提示词。在 Claude API、Claude Platform on AWS 和 Microsoft Foundry 上，缓存在同一组织内还会按工作区隔离；Bedrock 和 Google Cloud 仅使用组织级别的隔离。
- URL：https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-storage-and-sharing
  （用户给出的 `docs.claude.com/en/docs/build-with-claude/prompt-caching` 与 `docs.anthropic.com/en/docs/build-with-claude/prompt-caching` 均 301/302 跳转到该地址，实测 2026-09-08）
- 证据强度：**官方文档**

### E2. 隔离粒度是 workspace，不是 API key

- 论断：同一 workspace 下的多把 API key 共享缓存；隔离维度是 workspace / organization，官方从未按 API key 隔离。
- 英文原文（同页 Warning 块，已去除内联链接标记）：
  > Prompt caching uses workspace-level isolation. Caches are isolated per workspace, ensuring data separation between workspaces within the same organization. This applies to the Claude API, Claude Platform on AWS, and Microsoft Foundry; Bedrock and Google Cloud maintain organization-level cache isolation. If you use multiple workspaces, review your caching strategy to account for this difference.
- 中文翻译：
  > 提示词缓存采用工作区级别的隔离。缓存按工作区隔离，从而保证同一组织内不同工作区之间的数据分离。该规则适用于 Claude API、Claude Platform on AWS 和 Microsoft Foundry；Bedrock 和 Google Cloud 维持组织级别的缓存隔离。如果你使用多个工作区，请据此复核你的缓存策略。
- URL：https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-storage-and-sharing
- 证据强度：**官方文档**

### E3. workspace 文档侧的同一表述 + "每个请求只运行在一个 workspace"

- 论断：请求的归属 workspace 由 API key 或 access token（含 OAuth 访问令牌）解析得到；缓存随之被限定在该 workspace。
- 英文原文（两处，第二处已去除内联链接标记）：
  > Every request runs in exactly one workspace and can only access resources within that workspace.

  > Prompt caches are also isolated per workspace on the Claude API, Claude Platform on AWS, and Microsoft Foundry. On Amazon Bedrock and Google Cloud, prompt caches are isolated per organization.

  另有（说明 OAuth token 同样解析到某个 workspace，已去除内联链接标记）：
  > Claude API responses include an `anthropic-workspace-id` header alongside the `request-id` and `anthropic-organization-id` response headers. Its value is the `wrkspc_`-prefixed ID of the workspace that the request's API key or access token resolved to, including when that workspace is the Default Workspace.
- 中文翻译：
  > 每个请求都恰好运行在一个工作区中，并且只能访问该工作区内的资源。

  > 在 Claude API、Claude Platform on AWS 和 Microsoft Foundry 上，提示词缓存同样按工作区隔离。在 Amazon Bedrock 和 Google Cloud 上，提示词缓存按组织隔离。

  > Claude API 的响应会在 `request-id` 与 `anthropic-organization-id` 响应头之外附带 `anthropic-workspace-id` 响应头。它的值是该请求的 API key 或访问令牌所解析到的、以 `wrkspc_` 开头的工作区 ID，即使该工作区是默认工作区也一样。
- URL：https://platform.claude.com/docs/en/manage-claude/workspaces#api-keys-and-resource-scoping
- 证据强度：**官方文档**

### E4. 缓存 key 的构成：prompt 前缀的加密哈希 +（隔离边界）

- 论断：cache key = 到 `cache_control` 断点为止的整段前缀的加密哈希；命中要求 100% 逐字节一致。官方未把"账号/组织 ID"描述为 key 的一部分，而是把组织/工作区描述为查找的**隔离边界**——对使用者而言效果相同：换组织必 miss。
- 英文原文（FAQ "How does prompt caching handle privacy and data separation?"，第 2 条已在 "even for identical prompts." 处截断，去除其后内联链接）：
  > 1. Cache keys are generated using a cryptographic hash of the prompts up to the cache control point. This means only requests with identical prompts can access a specific cache.
  >
  > 2. On the Claude API, Claude Platform on AWS, and Microsoft Foundry, caches are isolated per workspace within an organization. On Bedrock and Google Cloud, caches are isolated per organization. In every case, caches are never shared across organizations, even for identical prompts.
- 中文翻译：
  > 1. 缓存键是用截至 cache control 断点为止的提示词的加密哈希生成的。这意味着只有提示词完全相同的请求才能访问某个特定的缓存。
  >
  > 2. 在 Claude API、Claude Platform on AWS 和 Microsoft Foundry 上，缓存在组织内部按工作区隔离。在 Bedrock 和 Google Cloud 上，缓存按组织隔离。在任何情况下，缓存都不会跨组织共享，即使提示词完全相同。
- URL：https://platform.claude.com/docs/en/build-with-claude/prompt-caching#faq
- 证据强度：**官方文档**

### E5. 前缀范围：tools → system → messages，写入只发生在断点

- 论断：缓存 key 覆盖 `tools`、`system`、`messages` 三层，按此顺序累积到 `cache_control` 断点为止；写入只在断点处发生一次。
- 英文原文（三处）：
  > Prompt caching references the entire prompt - `tools`, `system`, and `messages` (in that order) up to and including the block designated with `cache_control`.

  > Cache prefixes are created in the following order: `tools`, `system`, then `messages`. This order forms a hierarchy where each level builds upon the previous ones.

  > **Cache writes happen only at your breakpoint.** Marking a block with `cache_control` writes exactly one cache entry: a hash of the prefix ending at that block. The system does not write entries for any earlier position. Because the hash is cumulative, covering everything up to and including the breakpoint, changing any block at or before the breakpoint produces a different hash on the next request.
- 中文翻译：
  > 提示词缓存引用的是整个提示词——`tools`、`system` 和 `messages`（按此顺序），直到并包含被 `cache_control` 标记的那个块。

  > 缓存前缀按以下顺序创建：`tools`、`system`，然后是 `messages`。这一顺序形成层级结构，每一层都建立在前一层之上。

  > **缓存写入只发生在你的断点处。** 用 `cache_control` 标记一个块，只会写入一条缓存条目：以该块结尾的前缀的哈希。系统不会为任何更早的位置写入条目。由于该哈希是累积的，覆盖直到并包含断点的全部内容，因此改动断点处或断点之前的任何一个块，都会让下次请求产生不同的哈希。
- URL：https://platform.claude.com/docs/en/build-with-claude/prompt-caching
- 证据强度：**官方文档**

### E6. 精确匹配 + model 也参与匹配

- 论断：命中要求前缀逐字节一致；model 也是匹配条件之一（不同模型不共享缓存）。
- 英文原文（第一条来自 API 文档，第二条来自 Claude Code 文档 "Cache scope"，已去除内联链接标记）：
  > **Exact matching:** Cache hits require 100% identical prompt segments, including all text and images up to and including the block marked with cache control.

  > The underlying API cache is broader. Caches are isolated between organizations, and on some providers, between workspaces within an organization. Within those boundaries, any two requests with the same model and prefix read the same cache.
- 中文翻译：
  > **精确匹配：** 缓存命中要求提示词片段 100% 完全相同，包括截至并包含被 cache control 标记的那个块的所有文本和图像。

  > 底层的 API 缓存范围更宽。缓存在各组织之间隔离，在部分供应商上还会在同一组织内的各工作区之间隔离。在这些边界之内，任意两个使用相同模型和相同前缀的请求都会读取同一份缓存。
- URL：
  - https://platform.claude.com/docs/en/build-with-claude/prompt-caching#cache-storage-and-sharing
  - https://code.claude.com/docs/en/prompt-caching#cache-scope
- 证据强度：**官方文档**
- 备注：这条同时是"同组织内跨用户可共享缓存"的正面官方依据。Agent SDK 甚至提供 `excludeDynamicSections` 来把随机器变化的 system prompt 片段挪走，好让不同用户/不同机器共用一条缓存条目：
  > To make the system prompt identical across sessions, set `excludeDynamicSections: true` in TypeScript or `"exclude_dynamic_sections": True` in Python. The per-session context moves into the first user message, leaving only the static preset and your `append` text in the system prompt so identical configurations share a cache entry across users and machines.
  >
  > 中文：要让 system prompt 在各会话之间完全一致，可在 TypeScript 中设置 `excludeDynamicSections: true`，或在 Python 中设置 `"exclude_dynamic_sections": True`。每个会话独有的上下文会被移入第一条用户消息，system prompt 中只留下静态的 preset 与你的 `append` 文本，从而让配置相同的会话在不同用户和不同机器之间共享同一条缓存条目。
  - URL：https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts#improve-prompt-caching-across-users-and-machines
  - 证据强度：**官方文档**

### E7. 什么会让缓存失效（除账号维度外的其他 key 组成）

- 论断：tool 定义、system prompt、`tool_choice`、图像有无、thinking 配置、`output_config.effort`、web search / citations 开关、speed 设置等都会失效对应层级的缓存。
- 英文原文（表格摘录）：
  > | **Tool definitions** | ✘ | ✘ | ✘ | Modifying tool definitions (names, descriptions, parameters) invalidates the entire cache |
  > | **Web search toggle** | ✓ | ✘ | ✘ | Enabling/disabling web search modifies the system prompt |
  > | **Tool choice** | ✓ | ✓ | ✘ | Changes to `tool_choice` parameter only affect message blocks |
  > | **Images** | ✓ | ✓ | ✘ | Adding/removing images anywhere in the prompt affects message blocks |
- 中文翻译：
  > | **工具定义** | 失效 | 失效 | 失效 | 修改工具定义（名称、描述、参数）会使整个缓存失效 |
  > | **网页搜索开关** | 有效 | 失效 | 失效 | 启用/停用网页搜索会修改 system prompt |
  > | **tool_choice** | 有效 | 有效 | 失效 | 对 `tool_choice` 参数的改动只影响 message 块 |
  > | **图像** | 有效 | 有效 | 失效 | 在提示词任意位置增删图像都会影响 message 块 |
- URL：https://platform.claude.com/docs/en/build-with-claude/prompt-caching#what-invalidates-the-cache
- 证据强度：**官方文档**

### E8. TTL：默认 5 分钟，命中即免费续期（滑动窗口），另有 1 小时选项

- 论断：默认 5 分钟 ephemeral；每次使用都会免费刷新寿命（sliding window）；计时从**请求开始**算起，不是响应结束。1 小时 TTL 需显式声明。
- 英文原文：
  > By default, the cache has a 5-minute lifetime. The cache is refreshed for no additional cost each time the cached content is used.

  > The lifetime is measured from the start of the request that writes or reads the cache entry, not from the end of its response. Time spent generating a response counts against the lifetime: if a response takes 4 minutes to stream, a follow-up request that reuses the same cached prefix must start within about 1 minute of that response completing.

  > By default, automatic caching uses a 5-minute TTL. You can specify a 1-hour TTL at 2x the base input token price:
  >
  > `{ "cache_control": { "type": "ephemeral", "ttl": "1h" } }`

  > Currently, "ephemeral" is the only supported cache type, which by default has a 5-minute lifetime.
- 中文翻译：
  > 默认情况下，缓存的寿命为 5 分钟。每次使用被缓存的内容时，缓存都会被免费刷新。

  > 寿命是从写入或读取该缓存条目的那个请求的开始时刻计算的，而不是从其响应结束时算起。生成响应所花的时间要计入寿命：如果一个响应流式输出耗时 4 分钟，那么复用同一缓存前缀的后续请求必须在该响应结束后约 1 分钟内发起。

  > 默认情况下，自动缓存使用 5 分钟 TTL。你可以按基础输入 token 价格的 2 倍指定 1 小时 TTL。

  > 目前 "ephemeral" 是唯一受支持的缓存类型，其默认寿命为 5 分钟。
- URL：https://platform.claude.com/docs/en/build-with-claude/prompt-caching#1-hour-cache-duration
- 证据强度：**官方文档**

### E9. 计费倍率

- 论断：5m 写 = 1.25x base input；1h 写 = 2x base input；读 = 0.1x base input（Fable 5.1 / Mythos 5.1 例外为 0.025x）。
- 英文原文：
  > * 5-minute cache write tokens are 1.25 times the base input tokens price
  > * 1-hour cache write tokens are 2 times the base input tokens price
  > * Cache read tokens are 0.1 times the base input tokens price (see the table footnote for per-model exceptions)

  > *1 Cache hits and refreshes on Claude Fable 5.1 and Claude Mythos 5.1 are priced at 0.025x the base input price. All other models use the standard 0.1x multiplier.*
- 中文翻译：
  > * 5 分钟缓存写入 token 的价格是基础输入 token 价格的 1.25 倍
  > * 1 小时缓存写入 token 的价格是基础输入 token 价格的 2 倍
  > * 缓存读取 token 的价格是基础输入 token 价格的 0.1 倍（按模型的例外见表格脚注）

  > *1 Claude Fable 5.1 与 Claude Mythos 5.1 上的缓存命中与刷新，按基础输入价格的 0.025 倍计价。其他所有模型使用标准的 0.1 倍系数。*
- URL：https://platform.claude.com/docs/en/build-with-claude/prompt-caching#pricing
- 证据强度：**官方文档**
- 旁证（官方博客，2024 年首发口径，仍为 1.25x / 0.1x）：
  > Writing to the cache costs 25% more than our base input token price for any given model, while using cached content is significantly cheaper, costing only 10% of the base input token price.
  >
  > 中文：对任意给定模型，写入缓存的价格比基础输入 token 价格高 25%，而使用已缓存内容则便宜得多，只需基础输入 token 价格的 10%。
  - URL：https://claude.com/blog/prompt-caching （即 https://www.anthropic.com/news/prompt-caching）
  - 证据强度：**官方博客**

### E10. 速率限制口径：cache read 多数模型不计入 ITPM

- 论断：API key 场景下，`cache_read_input_tokens` 在多数模型上不计入 ITPM；`cache_creation_input_tokens` 计入。
- 英文原文：
  > **For most Claude models, only uncached input tokens count toward your ITPM rate limits.**
  >
  > * `input_tokens` (tokens after the last cache breakpoint) ✓ **Count toward ITPM**
  > * `cache_creation_input_tokens` (tokens being written to cache) ✓ **Count toward ITPM**
  > * `cache_read_input_tokens` (tokens read from cache) ✗ **Do NOT count toward ITPM** for most models
- 中文翻译：
  > **对于大多数 Claude 模型，只有未缓存的输入 token 才计入你的 ITPM 速率限制。**
  >
  > * `input_tokens`（最后一个缓存断点之后的 token）计入 ITPM
  > * `cache_creation_input_tokens`（正在写入缓存的 token）计入 ITPM
  > * `cache_read_input_tokens`（从缓存读取的 token）在大多数模型上**不**计入 ITPM
- URL：https://platform.claude.com/docs/en/api/rate-limits#cache-aware-itpm
- 证据强度：**官方文档**
- 注意：这条讲的是 **API 速率限制**，不是订阅制的 5h / 7d 用量窗口，两者不可混用（见 E12/E13）。

### E11. 订阅（OAuth）场景：Claude Code 默认给主对话 1 小时 TTL，用尽套餐额度后降为 5 分钟

- 论断：订阅账号在套餐内额度中，主对话默认走 1h TTL；一旦开始消耗 usage credits（按量付费），降为 5m。
- 英文原文（已去除内联链接标记）：
  > Unless you choose a TTL yourself, Claude Code requests the one-hour TTL only on a Claude subscription within your plan's included usage. There it requests the hour for the main conversation, plus a small set of helper requests that Anthropic controls server-side.

  > Once you go over your plan's usage limit and Claude Code draws on usage credits, you are billed for that usage, so Claude Code drops the main conversation to the cheaper five-minute TTL.

  > your first message after a break longer than the cache lifetime misses the cache and reprocesses your full context. The lifetime is an hour on a subscription and drops to five minutes once you're drawing on usage credits; on an API key or cloud provider, it's five minutes by default.
- 中文翻译：
  > 除非你自己指定 TTL，否则 Claude Code 只在使用 Claude 订阅且处于套餐内含额度时才请求 1 小时 TTL。此时它会为主对话请求 1 小时，另外还有一小部分由 Anthropic 在服务端控制的辅助请求。

  > 一旦你超出套餐用量上限、Claude Code 开始动用 usage credits，这部分用量就要计费，因此 Claude Code 会把主对话降级到更便宜的 5 分钟 TTL。

  > 在超过缓存寿命的停顿之后，你的第一条消息会 miss 缓存并重新处理完整上下文。该寿命在订阅上是 1 小时，一旦开始动用 usage credits 就降为 5 分钟；在 API key 或云供应商上，默认是 5 分钟。
- URL：
  - https://code.claude.com/docs/en/prompt-caching#which-ttl-each-request-gets
  - https://code.claude.com/docs/en/costs#reduce-token-usage
- 证据强度：**官方文档**

### E12. 订阅 5h / 7d 窗口的计量口径：官方未给出精确公式（**未找到官方说明**）

- 已找到的官方口径只有定性描述，没有"按 token 数"还是"按加权成本"的明确定义，也没有 cache read 的权重系数。
- 官方帮助中心（claude.ai 侧，讲的是 Projects 缓存）英文原文：
  > Our system also includes caching that helps you optimize your limits: Content in projects is cached and doesn't count against your limits when reused. Similar prompts you use frequently are partially cached.

  > When you upload documents to a project, they're cached for future use. Every time you reference that content, only new/uncached portions count against your limits.
- 中文翻译：
  > 我们的系统还包含缓存机制，帮助你优化额度：项目中的内容会被缓存，复用时不计入你的额度。你频繁使用的相似提示词会被部分缓存。

  > 当你把文档上传到项目中时，它们会被缓存以备后用。每次引用这些内容时，只有新增的/未缓存的部分才计入你的额度。
- URL：https://support.claude.com/en/articles/9797557-usage-limit-best-practices
- 证据强度：**官方帮助中心**（但适用对象是 claude.ai 的 Projects，不能直接推广到 Claude Code 的 API 级缓存）
- 与之口径不同的官方 Claude Code 文档表述（已去除内联链接标记）：
  > With prompt caching, Claude Code re-reads that history at the cached token rate, so a one-line question in a session that has been open all day still draws usage for the whole conversation.
  >
  > 中文：借助提示词缓存，Claude Code 会以缓存 token 费率重新读取那段历史，因此在一个开了一整天的会话里，哪怕只问一行的问题，仍然会按整段对话来消耗用量。
  - URL：https://code.claude.com/docs/en/costs#reduce-token-usage
  - 证据强度：**官方文档**
  - 解读：官方在 Claude Code 语境下承认 cache read **会**消耗订阅用量（"draws usage"），并暗示按 cached token rate（0.1x）加权，但没有任何页面把 5h/7d 窗口的计量公式写死。

### E13. 社区/逆向证据：cache read 计入订阅 5h 与周窗口，权重存在争议

- 论断（弱证据）：订阅用户的 5h / 周额度实际被 `cache_read_input_tokens` 主导；用户对权重是 0.1x 还是 1.0x 有争议，Anthropic 官方未在这些 issue 中回复确认。
- 原文引用 1（GitHub issue #24147，2026-02-08）：
  > Every message in a Claude Code session re-sends the full instruction set (CLAUDE.md files, system prompts, conversation history) as cached context. Cache read tokens count against the usage quota.
  >
  > 中文：Claude Code 会话中的每条消息都会把完整指令集（CLAUDE.md 文件、system prompt、对话历史）作为缓存上下文重新发送。缓存读取 token 计入用量配额。
  - 该 issue 中的 30 天统计：`Cache read tokens: 5,092,500,074`，占全部 token 的 99.93%。
  - URL：https://github.com/anthropics/claude-code/issues/24147
  - 证据强度：**社区（用户实测 + 本地 transcript 统计），无官方回复**
- 原文引用 2（GitHub issue #81234，2026-07-25，Max 20x 个人账号）：
  > **Suspected cause:** `cache_read_input_tokens` metered at full input weight ... Cache reads should meter at 0.1×. If they are metered at 1.0×: ... A ~6× metering inflation is exactly the magnitude needed to turn a normal two days into 53% of a weekly quota.
  >
  > 中文：**疑似原因：** `cache_read_input_tokens` 被按完整输入权重计量……缓存读取本应按 0.1 倍计量。如果它们被按 1.0 倍计量：……约 6 倍的计量膨胀，恰好能把两天的正常用量变成周配额的 53%。
  - URL：https://github.com/anthropics/claude-code/issues/81234
  - 证据强度：**社区推测（基于本地 transcript 的成本还原），未被官方证实**
- 原文引用 3（GitHub issue #87646，2026-08-18，Max 20x）：
  > A Max 20x subscriber consumed **25% of a weekly usage limit in under one day**. Investigating locally, **91% of that consumption was context re-reading, not work**: sessions grow until they sit at the 1M context ceiling, and from then on every single API call re-reads ~1M cached tokens.
  >
  > 中文：一位 Max 20x 订阅者在不到一天内消耗了周用量上限的 25%。本地排查发现，其中 91% 的消耗是上下文重复读取，而非实际工作：会话不断增长直到顶到 1M 上下文上限，此后每一次 API 调用都要重新读取约 1M 个缓存 token。
  - 该 issue 自述其成本还原用的是 `cache read at 0.1x, cache write at 1.25x`。
  - URL：https://github.com/anthropics/claude-code/issues/87646
  - 证据强度：**社区实测**
- 结论：**订阅制 5h/7d 窗口的具体计量单位与 cache read 权重，未找到官方说明。** 可确定的只有方向性事实：cache read 会消耗订阅用量，且在长上下文会话中占主导。

### E14. 是否存在"跨账号共享 prompt cache"的证据

- **无。** 没有任何官方或强社区证据表明缓存可以跨 organization 共享；官方原文是相反的强否定（见 E1："Different organizations never share caches, even if they use identical prompts."）。
- 唯一被官方承认的"跨主体共享"发生在**同一 organization / 同一 workspace 内部**（E6：same model + same prefix → same cache），例如 Team/Enterprise 同组织的多个 seat、或 Console 计费下同一个自动创建的 Claude Code workspace 中的多个成员 key：
  > Anthropic creates the Claude Code workspace automatically the first time a member of your organization signs in to Claude Code with their Console account. ... Claude Code mints a per-user API key in this workspace at sign-in.
  >
  > 中文：当你所在组织的成员首次用其 Console 账号登录 Claude Code 时，Anthropic 会自动创建 Claude Code 工作区。……Claude Code 会在登录时于该工作区内为每个用户签发一把 API key。
  - URL：https://platform.claude.com/docs/en/manage-claude/workspaces#claude-code-workspace
  - 证据强度：**官方文档**
- 社区侧的间接旁证：多账号中转项目 claude-relay-service 依赖"粘性会话"把同一会话绑定到同一账号，而不是假设缓存可跨账号复用：
  > 因为 Nginx 默认会移除带下划线的请求头（如 session_id），一旦该头被丢弃，多账号环境下的粘性会话功能将失效。
  - URL：https://github.com/Wei-Shaw/claude-relay-service（README）
  - 证据强度：**社区实现（弱证据，仅说明业界做法是绑定账号，不构成对缓存机制的直接证明）**

---

## 对多账号池切号的含义

### 1. 切号后第一次请求要重新写多少缓存

换到不同 organization 的账号后，前一账号的缓存条目在新账号下完全不可见，等价于冷启动：

- 新账号首个请求的 `cache_creation_input_tokens` ≈ **整段可缓存前缀**（tools + system + 历史 messages，直到最后一个 `cache_control` 断点），`cache_read_input_tokens` = 0。
- Claude Code 场景下，这就是一次全量 re-cache：system prompt + 工具定义 + CLAUDE.md 注入 + 整段对话历史。issue #87646 记录的长会话稳态是每请求约 1M token 的上下文，切号即意味着这 1M token 全部按 cache write 重付一次。

### 2. 成本倍率

以基础输入价 `P` 计（官方倍率见 E9）：

| 情形 | 倍率 | 说明 |
| --- | --- | --- |
| 同账号命中 | 0.1 × P（Fable 5.1 / Mythos 5.1 为 0.025 × P） | 正常稳态 |
| 切号后首请求，5m TTL | 1.25 × P | 相对命中贵 **12.5 倍** |
| 切号后首请求，1h TTL | 2.0 × P | 相对命中贵 **20 倍** |

举例（Claude Sonnet 5，base input $2/MTok，200k token 前缀）：

- 命中：0.2 MTok × $0.20/MTok = **$0.04**
- 切号后 5m 写：0.2 MTok × $2.50/MTok = **$0.50**（12.5x）
- 切号后 1h 写：0.2 MTok × $4.00/MTok = **$0.80**（20x）

Claude Opus 5（base $5/MTok，1M token 上下文）：命中 $0.50，切号后 5m 写 $6.25，1h 写 $10.00。

### 3. 订阅账号池的额外影响

- 订阅账号（OAuth）在套餐内默认使用 1h TTL（E11），意味着**不切号时**缓存能跨长间隔存活，切号收益的对照基线更高——切一次号损失的是本可以命中一小时的缓存。
- 切号后的全量 cache write 会计入**新账号**的 5h/周窗口。按社区实测（E13），cache read 已经占用量的 90%+；而 cache write 的权重不低于 read（官方定价上是 12.5 倍），所以频繁切号会把额度消耗从"读"结构性地推向"写"，整体额度效率下降。具体倍率无官方计量公式，属不确定项。
- 实践建议（基于以上事实的工程推论，非官方口径）：
  1. **粘性绑定**：同一会话/同一工作目录绑定同一账号，直到该账号触发限流或会话结束；不要按请求轮询切号。
  2. **在缓存本就要重建的时点切号**：`/clear`、`/compact`、会话结束、超过 TTL 的空闲之后——此时缓存已冷，切号的边际成本接近 0。
  3. **同组织多 seat 优先**：如果账号来源是同一 Team/Enterprise 组织（同一 workspace），按 E6 它们之间**可以**命中同一份缓存，切号不必然 miss；跨独立个人订阅账号（不同 organization）则必然 miss。
  4. **前缀稳定化**：若在同组织内做池化，用 Agent SDK 的 `excludeDynamicSections`（E6 备注）去掉 cwd/机器名等动态段，让不同机器、不同用户共用一条缓存条目。
  5. 切号后如果预期还会长时间用这个账号，考虑显式 `promptCacheTtl=1h`，用 2x 的一次性写入换取更长的命中窗口；如果是短时探测就保持 5m。

---

## 不确定项清单

1. **订阅制 5h / 7d 窗口的精确计量口径**：是原始 token 数、成本加权 token，还是美元当量，官方无任何页面写明。（未找到官方说明）
2. **订阅制下 cache read 的权重**：官方 Claude Code 文档只说"以 cached token rate 重新读取……仍会消耗用量"，未给系数；社区在 0.1x 与 1.0x 之间存在争议（#81234、#24147、#87646 均为用户侧推断，无官方确认）。
3. **claude.ai 个人 Pro/Max 账号是否各自构成独立 organization**：官方文档只说明"每个请求解析到一个 workspace/organization"且"跨组织不共享缓存"，没有一页直接写"每个个人订阅账号是一个独立组织"。本报告的"跨个人账号必然 miss"结论建立在这一推断之上（证据强度：推断，非官方明文）。若两个账号实际归属同一个 Team/Enterprise 组织，则结论相反（E6）。
4. **缓存 key 是否把 organization/workspace ID 编进哈希**：官方只说 key 是 prompt 前缀的加密哈希，并把组织/工作区描述为隔离边界，未公开实现细节。对使用者的可观测结果相同，但内部机制未知。
5. **同一 workspace 内跨用户命中的实际稳定性**：官方称同 model + 同前缀即可命中，但受路由、并发写入时序（"a cache entry only becomes available after the first response begins"）等影响，实际命中率未有官方数字。
6. **claude.ai Projects 的"缓存内容不计入额度"是否等同于 API 级 prompt caching**：帮助中心用词是产品级描述，与 API 的 `cache_read_input_tokens` 是否同一机制，官方未说明。

---

## 抓取来源清单（2026-09-08 实测可访问）

| 来源 | URL | 类型 |
| --- | --- | --- |
| Prompt caching（API 文档） | https://platform.claude.com/docs/en/build-with-claude/prompt-caching | 官方文档 |
| Workspaces | https://platform.claude.com/docs/en/manage-claude/workspaces | 官方文档 |
| Rate limits（cache-aware ITPM） | https://platform.claude.com/docs/en/api/rate-limits#cache-aware-itpm | 官方文档 |
| Claude Code / Prompt caching | https://code.claude.com/docs/en/prompt-caching | 官方文档 |
| Claude Code / Costs | https://code.claude.com/docs/en/costs | 官方文档 |
| Agent SDK / Modifying system prompts | https://code.claude.com/docs/en/agent-sdk/modifying-system-prompts | 官方文档 |
| Usage limit best practices | https://support.claude.com/en/articles/9797557-usage-limit-best-practices | 官方帮助中心 |
| Models, usage, and limits in Claude Code | https://support.claude.com/en/articles/14552983-models-usage-and-limits-in-claude-code | 官方帮助中心 |
| Prompt caching with Claude（博客） | https://claude.com/blog/prompt-caching | 官方博客 |
| issue #24147 | https://github.com/anthropics/claude-code/issues/24147 | 社区 |
| issue #81234 | https://github.com/anthropics/claude-code/issues/81234 | 社区 |
| issue #87646 | https://github.com/anthropics/claude-code/issues/87646 | 社区 |
| claude-relay-service | https://github.com/Wei-Shaw/claude-relay-service | 社区实现 |
