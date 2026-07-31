# claude-accounts-usage

一个 OpenCode **TUI 插件**,用来查看多个 Claude(Pro/Max)与 ChatGPT(Plus/Pro)账号的订阅用量、在账号之间切换,并查看本地 OpenCode 的用量统计仪表盘(`/stats`)。

它**不接管**任何 auth provider:`anthropic` 条目仍由 [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth) 负责 OAuth 登录与请求注入,`openai` 条目仍由 OpenCode **自带的 codex 插件**负责登录与 token 刷新。本插件只在工具层做"账号档案 + 切换 + 用量展示",因此与两者**共存**。

## 功能

| 命令 | 作用 |
|------|------|
| `/usage` | 弹框显示账号用量,按 provider 分 `Claude` / `ChatGPT` 两页(`tab` / `←→` / `h l` 切页),并常驻一行「当前对话」显示本轮真实的 provider / model。两页都可 `↑↓` 选择、`enter` 切换(立即生效)、`m` 标记/取消"不自动切"、`d` 删除账号(再按一次 `d` 确认,当前账号不可删)、`esc` 关闭 |
| `/stats` | 弹框显示本地 OpenCode 的用量统计仪表盘:总览 / 模型 / 提供方三个分页,含活跃热力图与 token 折线图,可切 All / 7天 / 30天 范围 |

Claude 页显示 5h / 7d 两个窗口,外加各受限模型的周窗口(如 `Fable`,由 Anthropic 的 `limits` 动态返回),均带进度条与重置倒计时。ChatGPT 的窗口长度**按订阅计划动态变化**(某些计划只返回一个 30 天窗口),因此标签由接口返回的秒数换算,不假设固定两个窗口。

两边的账号都会在**插件加载时**以及每次 `/usage` 时**自动收录**当前登录的账号,无需手动添加。

## 用量统计仪表盘(`/stats`)

直接读取本地 OpenCode 会话库(`opencode.db`)做统计,**只读、不联网**:

- **三个分页**:`总览`(整体 token / 花费 / 会话 / 消息 / 活跃天数 + 连续天数,GitHub 风格活跃热力图)、`模型`、`提供方`(各自的 token 折线图与明细,`j/k` 选择条目)。
- **时间范围**:`All` / `7天` / `30天`,打开时一次性扫描全表、之后切范围走内存聚合,切换即时无卡顿。
- **快捷键**:`tab` / `←→` / `h l` 切页 · `r` 或 `1/2/3` 切范围 · `j/k` 选条目 · `q` / `esc` 关闭。

> 数据来源是 OpenCode 自身记录的会话库,与 `/usage` 的"订阅额度"是两回事:`/usage` 看的是 Anthropic 订阅窗口剩余额度,`/stats` 看的是你本地累计的 token / 花费统计。

## ChatGPT(OpenAI)多账号

ChatGPT 账号的登录仍然由 `opencode auth login` 完成(走 OpenCode 自带的 codex 插件),本插件负责**收录、展示、手动切换**。

- **收录**:读 `auth.json` 的 `openai` 条目,按其自带的 `chatgpt_account_id` 建档。这比 Claude 侧更省——不需要额外调 profile 接口,邮箱和计划类型随用量接口一起返回。
- **切换**:把目标账号的 token 写进 `auth.json` 的 `openai` 条目。codex 插件每次请求都会重读,所以下一条消息就用新账号。
- **故意不刷新目标 token**:即使目标的 access token 已过期也原样写入。codex 插件是这个槽位**唯一**的刷新者,它会在下一次请求时自己惰性轮换;我们再去刷就是给一条一次性轮换链增加第二个写入者,只有风险没有收益。
- **不覆盖 API key**:`openai` 这个键被 OAuth 和纯 API key(`sk-…`)共用。若槽位里装的是 API key,切换会**诚实报错并拒绝**,绝不覆盖。
- **非活跃账号的额度显示为「未知」**:只有占着槽位的那个账号有新鲜 token 能查额度。其余行显示「额度未知(切换到该账号后可见)」——**不显示缓存旧值、不估算**。原因见下面的 `openaiKeepalive`。

### 两个默认关闭的开关

| 开关 | 默认 | 说明 |
|---|---|---|
| `OPENAI_KEEPALIVE_ENABLED` | `false` | 给**非活跃** ChatGPT 账号做后台保活刷新。代码完整、测试充分,但**在只有一个 ChatGPT 账号的环境里一次都不会执行**(那个账号永远占着槽位),因此零真机覆盖,而它出错的后果是账号的 refresh token 整族被吊销、必须重新登录。等有第二个账号能真机验证再打开。关闭时的行为就是上面那条「额度未知」。 |
| `OPENAI_AUTOSWITCH_ENABLED` | `false` | ChatGPT 撞限时自动切号。检测器已实现(严格要求 `429` + 响应体 `error.type === "usage_limit_reached"`,**不接受裸 429**,因为 ChatGPT 的裸 429 可能只是瞬时限速,误切会白烧一个健康账号),但 OpenCode 的事件层是否会把 429 的响应体透给 TUI 插件**尚未实测**——`session.status` 只带一个 message 字符串。开关关闭时检测与决策日志照常输出(这正是用来确认的手段),只有切号动作被抑制。 |

### 为什么刷新 ChatGPT token 这么小心

`auth.json` 的 `openai` 条目有**两个我们控制不了的写入者**:codex 插件按请求惰性刷新(且不持有本插件的文件锁),以及我们自己。OpenAI 的 refresh token 用一次就轮换,服务端对重放的回答是 `refresh_token_reused`,吊销的是**整个 token 族**——不是单个 token 失效,而是那个账号彻底死掉、必须重新登录。

安全性不来自文件锁(codex 不认它),而来自一条结构性事实:**codex 只会刷新槽位当前的占用者**。所以插件的规则是:

- 覆盖槽位前,先把槽位里现有的 token 归档进账号库(链尖只被接管,绝不丢弃);
- 槽位内容与我们的记账不一致时,**以槽位为准**(采纳,而不是把我们认为的"当前账号"重新写回去);
- 判断一个账号能不能刷新时,在锁内**实时重读** `auth.json`,按 `chatgpt_account_id` 和 refresh 字符串双重比对,**绝不相信自己的记账**;
- 刚离开槽位的账号有一段隔离期不刷(此时可能还有 codex 的请求在飞);
- 槽位**读不出来**时拒绝刷新任何账号——读不到不等于没人在用。

## 限流自动切号(自动重试)

当**当前账号撞到订阅额度上限**(5h 窗口或周/全模型窗口的 429)时,插件会**中断当前请求、自动切到下一个可用账号,并在原 session 上自动发 `continue` 续接**,无需手动干预。该能力**始终开启**。

工作方式:

- **检测**:主要监听 OpenCode 的 `session.status` 的 retry 事件(同时也注册 `session.next.retried` / `session.error` 作为补充,但 TUI 插件通常只能收到 `session.status`),只在命中 Anthropic 订阅额度签名(`anthropic-ratelimit-unified-*: rejected`,或响应体/消息含 `rate_limit_error` + 额度文案,或 429 状态码)时触发;529 过载等会被排除,避免误切号。
- **选号**:优先按用量挑剩余额度最多的账号(用 `/usage` 时缓存的数据,TTL 10 分钟),无缓存则轮询下一个;跳过正在冷却(已知额度未恢复)的账号。
- **不自动切**:被标记为"不自动切"的账号**不会被自动切号选中**;当所有**未标记**账号都撞限/冷却时,自动切号会**停下**(绝不自动切到标记号)。标记号仍可在 `/usage` 里手动 `enter` 切换;被标记的当前账号撞限时仍会自动切**走**到未标记号。标记保存在 `~/.config/opencode/claude-accounts.json` 对应账号的 `"excluded": true`(可手动编辑)。
- **续接**:命中订阅额度限流时,插件**中断当前请求 → 切到可用账号 → 在原 session 上自动发 `continue` 续接**(等价于手动"按两次 esc 再发 continue");若该轮尚无任何输出,则自动重发你的原始消息。
- **不回退**:这一轮已改动的文件、已完成的工具进度**全部保留**,新账号带完整上下文接着干,**无需手动按键**。
- **冷却**:撞限的账号进入冷却,恢复时刻优先取限流响应头给出的 reset;拿不到响应头时,退而用该账号真实的按窗口 `resets_at`(由 `/usage` 缓存,并在切号后的那次刷新里回填)。两者都拿不到时,账号仍会被排除出自动选号,但**不编造任何倒计时**、也**不安排定时解除**,直到后续某次用量刷新拿到真实 reset 才安排精确的定时解除。已知 reset 的冷却持久化在 `tui.json` 的 KV 中;账号下次成功使用后自动解除冷却。
- **耗尽**:当所有账号都在冷却时停止切换,并弹出最近恢复时间的倒计时提示(仅当至少有一个账号有已知 reset 时才显示倒计时,否则只提示已达上限)。
- **恢复**:冷却账号到达其真实恢复时刻(来自响应头或缓存的 `resets_at`)后,**静默解除冷却**、重新参与自动选号,不再弹任何提示框;若此前所有账号都撞限导致会话停摆,则自动切回该恢复账号并逐个 `continue` 续接停摆的会话(被标记"不自动切"的账号只静默恢复、不会被自动切入)。恢复时刻未知时不安排定时解除,改由账号下次成功使用后自动解除。

## 日志与排查

插件日志写入 OpenCode 内建日志文件 `~/.local/share/opencode/log/opencode.log`,每条都带 `claude-accounts-usage` 标记,方便单独筛出来。

查看:

```bash
grep "claude-accounts-usage" ~/.local/share/opencode/log/opencode.log
```

想看更详细的 debug 级日志(比如限流检测的原始样本):启动 opencode 时加上 `OPENCODE_LOG_LEVEL=DEBUG`(或 `--log-level DEBUG`),并设环境变量 `CLAUDE_AUTOSWITCH_DEBUG=1`。两者配合才会输出 debug 级别的诊断信息。

提 issue 时:把相关日志行 grep 出来,贴到 <https://github.com/Daiwenxi798673133/claude-accounts-usage/issues>,并附上复现步骤。日志已对 token 做脱敏处理,但仍建议你粘贴前自查一遍,确认没有夹带敏感信息。

## 前置条件

- 想管理 Claude 账号:已安装并使用 `@ex-machina/opencode-anthropic-auth` 登录 Claude Pro/Max。**无需移除 ex-machina**,两者共存。
- 想管理 ChatGPT 账号:用 `opencode auth login` 登录过 ChatGPT 订阅(走 OpenCode 自带的 codex 插件),无需额外安装。
- 两者都是可选的,只用其中一边也能正常工作。

## 安装

TUI 插件只在 `~/.config/opencode/tui.json` 配置,**不要**放进 `opencode.json`。

### 方式一:npm(推荐)

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["claude-accounts-usage@0.3.0"]
}
```

OpenCode 会自动解析并安装该包,无需手动 `npm install`。

> `0.3.0` 是当前**最新稳定版**,新增 **ChatGPT(OpenAI)多账号支持**:`/usage` 按 provider 分页,ChatGPT 账号可收录、可手动切号、可删除;账号库加上了 provider 判别字段(旧文件零迁移);跨 provider 的选号与刷新被结构性隔离,顺带修掉了一个既有缺陷——一次成功的 ChatGPT 对话会误解除某个 Claude 账号的冷却。ChatGPT 的**自动切号**与**非活跃账号保活**已实现但**默认关闭**,原因见「ChatGPT(OpenAI)多账号」一节。
>
> 升级到 0.3.0 无需任何手工操作:旧的 `claude-accounts.json` 原样可读,Claude 侧行为不变。
>
> **建议带上版本号**。OpenCode 按"含版本号的包名"建独立缓存目录:写死版本号后,以后升级只需把后缀改成新版本号;若不带版本号,会被首次安装的版本锁住,发布新版也不会自动更新。

### 方式二:本地 clone(开发/离线)

```bash
git clone https://github.com/Daiwenxi798673133/claude-accounts-usage.git
cd claude-accounts-usage && bun install
```

然后让 `tui.json` 指向克隆下来的 `tui.tsx` 绝对路径:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/绝对路径/claude-accounts-usage/tui.tsx"]
}
```

修改配置后**完全退出并重新打开** OpenCode。

## 账号管理流程

1. 登录账号 A:`opencode auth login` → Claude Pro/Max(经 ex-machina)或 ChatGPT。
2. 打开 OpenCode,插件自动收录账号 A。
3. 想加更多账号:登录账号 B,然后重新打开 OpenCode 或运行一次 `/usage`,插件自动收录 B。
4. 之后用 `/usage` 查看用量,在对应 provider 的分页里 `↑↓` 选号、`enter` 切换。

> Claude 账号的标签默认是邮箱。ChatGPT 账号首次收录时拿不到邮箱(那需要额外一次网络请求),因此先用 `ChatGPT <账号id前8位>` 占位。想改名?直接编辑 `~/.config/opencode/claude-accounts.json` 里对应账号的 `label`(自动收录不会覆盖你改过的标签)。

## 工作原理

- 账号档案保存在 `~/.config/opencode/claude-accounts.json`(权限 `0600`),每个账号含 OAuth `refresh` / `access` / `expires`、邮箱 `label`,以及来自 Anthropic profile 的账号 `uuid`。
- **自动收录**:读 `auth.json` 当前账号 → 调 `oauth/profile` 拿到稳定的账号 `uuid` 和邮箱 → 按 `uuid` upsert。`uuid` 跨 token 刷新保持不变,因此同一账号只会被更新(不重复),换成新账号则自动新增。
- **切换**:把目标账号的 token 写入 `auth.json` 的 `anthropic` 条目。ex-machina 每次请求都会重新读取 `auth.json`,所以切换立即生效(下一条消息就用新账号),无需重启。
- **查看用量**:对每个账号调用 Anthropic 的 `oauth/usage` 接口;若 access token 过期,会用 refresh token 刷新并回写档案。
- **后台保活**:插件常驻一个 token keeper——每 5 分钟自动给所有**非活跃**账号续期(快过期才刷);**活跃账号**只在**空闲时**(没有 Anthropic 会话在跑)预刷新,与 ex-machina 天然错开(它只在发请求时刷新),零竞争;同时用文件监听实时跟踪 `auth.json`:ex-machina 每次轮换/每次新登录都会被立即收录,当前账号最新的 refresh token 永不丢失。
- 跨实例安全 — 所有 token 的读改写都持有一把跨进程文件锁(`claude-accounts-usage.lock`,位于 auth.json 同目录),因此同时开多个 OpenCode 实例(TUI / `opencode serve`)也不会互相抢刷同一张一次性 refresh token 或覆盖彼此的轮换结果;极端争用下操作最多等锁 30 秒后诚实报错。
- **实时优先、诚实报错**:面板显示的用量**永远是实时拉取的**,绝不显示缓存旧数据(共享账号场景下旧数据会严重失真)。某账号实时拿不到时直接显示真实错误;refresh token 被服务端**永久吊销**的账号显示"需重新登录"(不参与自动切号、不能手动切入,重新用 ex-machina 登录一次即自动恢复;在其行上按 `enter` 可先尝试一次重试刷新)。若其 access token 尚在有效期内,仍会正常显示实时用量。
- 每次写 `auth.json` 都是"读整个文件 → 只改自己那一个 provider 的条目 → 整体原子写回",其他 provider 的条目原样保留。写入前会**紧邻原子写再重读一次**,把与另一个写入者互相覆盖的窗口压到毫秒级。
- 账号库里每条记录都带 `provider` 判别字段(旧文件里没有这个字段的记录一律读作 `anthropic`,**零迁移成本**),Claude 与 ChatGPT 各有独立的"当前账号"指针。选号、轮询、计数、刷新全部按 provider 过滤,所以一个 Claude 会话在结构上不可能被切到 ChatGPT 账号上,反之亦然。

## 已知限制

- ex-machina 同一时刻只持有一个账号,所以一个新账号必须先用 ex-machina 登录过一次,插件才能在下次加载/操作时收录它。
- 自动切号依赖 OpenCode 的 `session.status` 事件(辅以 `session.next.retried` / `session.error`),因此只对经由 OpenCode(及 ex-machina)发出的 Anthropic 请求生效;额度恢复后的解除冷却需要该账号成功跑过一次对话。
- refresh token 是按"登录"分链、一次性轮换的:若某账号的链在服务端被永久吊销(极少数场景),任何客户端都无法再用旧链刷新,该账号需要重新登录一次;插件会将其标为"需重新登录"(access token 未过期时仍显示实时用量),重登后自动恢复。
- 该锁只协调本插件的各实例;ex-machina 与 OpenCode 自带的 codex 插件对 auth.json 的写入都不经过它(由"绝不刷新槽位占用者"策略规避)。电脑在临界区内睡眠超过 45 秒被唤醒的极端场景下,旧持锁者可能与新持锁者短暂竞争。**在 ChatGPT 侧这个残余风险的后果更重**:Claude 侧最坏是一次 `invalid_grant`(单条链),ChatGPT 侧是整个 token 族被吊销(账号需重新登录)。这也是 `OPENAI_KEEPALIVE_ENABLED` 默认关闭的原因之一。
- ChatGPT 的隔离期是唯一依赖**挂钟**的判定。时钟往后跳是安全的;往前跳(NTP 校正、虚机迁移、长时间睡眠恢复)若超过隔离窗口,会让所有时间戳一次性"老化"、隔离失效。当前槽位占用者不受影响(它靠身份比对,与时钟无关),暴露面仅限刚被换出去的账号——而能让时钟跳那么远的场景里,那些还在飞的请求基本上早已随连接一起断掉。
- `auth.json` 的路径是插件自己按 `XDG_DATA_HOME` → `~/.local/share` → `~/Library/Application Support` 顺序推断的,取第一个能解析成 JSON 的。正常安装下与 OpenCode 一致;若历史遗留导致候选顺序错位,插件与 OpenCode 可能读写不同的文件(这是既有行为,与本次多 provider 支持无关)。
- **只用一个 ChatGPT 账号验证过。** 选号、冷却、以及非活跃账号保活这些只有多账号才走得到的路径,目前只有单元测试覆盖,没有真机验证——这也是两个开关默认关闭的直接原因。

## License

MIT
