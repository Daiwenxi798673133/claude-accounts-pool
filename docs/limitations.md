# 已知限制

## 通用

- ex-machina 同一时刻只持有一个账号,所以一个新账号必须先用 ex-machina 登录过一次,插件才能在下次加载/操作时收录它。
- 自动切号依赖 OpenCode 的 `session.status` 事件(辅以 `session.next.retried` / `session.error`),因此只对经由 OpenCode(及 ex-machina)发出的 Anthropic 请求生效;额度恢复后的解除冷却需要该账号成功跑过一次对话。
- refresh token 是按"登录"分链、一次性轮换的:若某账号的链在服务端被永久吊销(极少数场景),任何客户端都无法再用旧链刷新,该账号需要重新登录一次;插件会将其标为"需重新登录"(access token 未过期时仍显示实时用量),重登后自动恢复。
- `auth.json` 的路径是插件自己按 `XDG_DATA_HOME` → `~/.local/share` → `~/Library/Application Support` 顺序推断的,取第一个能解析成 JSON 的。正常安装下与 OpenCode 一致;若历史遗留导致候选顺序错位,插件与 OpenCode 可能读写不同的文件。
- 文件锁只协调本插件的各实例;ex-machina 与 OpenCode 自带的 codex 插件对 auth.json 的写入都不经过它(由"绝不刷新槽位占用者"策略规避)。电脑在临界区内睡眠超过 45 秒被唤醒的极端场景下,旧持锁者可能与新持锁者短暂竞争。**在 ChatGPT 侧这个残余风险的后果更重**:Claude 侧最坏是一次 `invalid_grant`(单条链),ChatGPT 侧是整个 token 族被吊销(账号需重新登录)。这也是 `OPENAI_KEEPALIVE_ENABLED` 默认关闭的原因之一。

## ChatGPT(OpenAI)侧

- **只用一个 ChatGPT 账号验证过。** 选号、冷却、以及非活跃账号保活这些只有多账号才走得到的路径,目前只有单元测试覆盖,没有真机验证——这也是两个开关默认关闭的直接原因。
- ChatGPT 的隔离期是唯一依赖**挂钟**的判定。时钟往后跳是安全的;往前跳(NTP 校正、虚机迁移、长时间睡眠恢复)若超过隔离窗口,会让所有时间戳一次性"老化"、隔离失效。当前槽位占用者不受影响(它靠身份比对,与时钟无关),暴露面仅限刚被换出去的账号——而能让时钟跳那么远的场景里,那些还在飞的请求基本上早已随连接一起断掉。

## cloud 模式

- **计费归属只在同一台机器上验证过。** 实测确认:用租借来的 access token 经真实 ex-machina 发推理,用量扣在该账号的**订阅窗口**上(5h +7%、7d +1%),超额(overage)计数器**分文未动**。但这次测量是在**持有该账号的那台机器**上做的;真实部署里 worker 在**另一台机器、另一个出口 IP**。「跨 IP 是否影响计费归属」**尚未验证**,需要在第二台机器上重跑同一套协议(`scripts/gate0-billing-attribution.ts`)。
- **worker 无法在请求层被拦住。** OpenCode 的 TUI 插件拿不到请求级钩子(`Hooks` 只属于 server 插件,而 TUI 模块与 server 模块互斥),所以"租约失效时阻止请求发出"做不到。当前的兜底是:keeper 提前续租、失败时明确报错并拒绝写入陈旧租约,再加上 `401` 的重领租恢复。真正的请求拦截需要额外注册一个 server 插件入口,尚未做。
- **成功响应的限流头拿不到。** `session.status` 只带一个 message 字符串,限流头只在错误路径(`session.error` 的 `APIError.data`)里出现。所以 master 的稳态选号数据来自它自己轮询 `/api/oauth/usage`,而不是 worker 回传——而该端点有已知的持续 429 问题,因此轮询刻意做得很粗。
- **同一账号会在不同 worker 之间轮转**,即同一账号从多个出口 IP 出现。这是"按用量轮转、默认不做粘性"这个取舍的直接代价,也是一个已知的账号共享特征。**按 `p` 钉住**(见 [cloud-mode.md](cloud-mode.md#p钉住一个号))能把这件事按人缓解:钉住的那台机器在额度用满前不再被轮换走,代价正是吞吐——它不再跟着全池最空的号走。但这**只收窄不消除**:pin 不是独占,别人照样能租到同一个号,所以"一个账号同时被多个 IP 使用"依旧可能发生。<br>*(这条原先把粘性写成一个"可以考虑但没做"的假设方案。`p` 落地后那句话不再成立,于是改写而不是在后面补一句——同一条取舍只该有一个当前版本。)*
- **单出口 IP 的限流切号无效。** 部分 429 是按出口 IP 计的,这种情况下换账号解决不了问题。
- 服务端若启用原生客户端 attestation,这套纯软件方案(伪装由客户端 ex-machina 完成)会整体失效。详见 [research/options-analysis.md](research/options-analysis.md)。

## 工程

- **本仓是 fork,上游修复需要手动同步。** `claude-accounts-usage` 之后的修复不会自动流进来,得手动 merge 或移植。
- `tsconfig.json` 的 `include` 只覆盖 `tui.tsx` 与 `src/**/*`,所以 `bun run typecheck` **不检查 `scripts/` 下的脚本**(上游 `scripts/build.ts` 也一样)。
