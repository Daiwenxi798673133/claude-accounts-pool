# claude-accounts-pool

一个 OpenCode **TUI 插件**,用来查看多个 Claude(Pro/Max)与 ChatGPT(Plus/Pro)账号的订阅用量、在账号之间切换,并查看本地 OpenCode 的用量统计仪表盘(`/stats`)。在此之上,它还支持把一批 Claude 账号做成**跨机器共享的账号池**。

它**不接管**任何 auth provider:`anthropic` 条目仍由 [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth) 负责 OAuth 登录与请求注入,`openai` 条目仍由 OpenCode **自带的 codex 插件**负责登录与 token 刷新。本插件只在工具层做"账号档案 + 切换 + 用量展示",因此与两者**共存**。

> 本仓是 [`Daiwenxi798673133/claude-accounts-usage`](https://github.com/Daiwenxi798673133/claude-accounts-usage) 的 fork,在其之上新增了 cloud 模式(账号池)。上游的单机功能全部保留且行为不变。

## 功能

| 命令 | 作用 |
|------|------|
| `/usage` | 弹框显示账号用量,按 provider 分 `Claude` / `ChatGPT` 两页(`tab` / `←→` / `h l` 切页),并常驻一行「当前对话」显示本轮真实的 provider / model。两页都可 `↑↓` 选择、`enter` 切换(立即生效)、`m` 标记/取消"不自动切"、`d` 删除账号(再按一次 `d` 确认,当前账号不可删)、`esc` 关闭 |
| `/stats` | 弹框显示本地 OpenCode 的用量统计仪表盘:总览 / 模型 / 提供方三个分页,含活跃热力图与 token 折线图,可切 All / 7天 / 30天 范围 |

Claude 页显示 5h / 7d 两个窗口,外加各受限模型的周窗口(如 `Fable`,由 Anthropic 的 `limits` 动态返回),均带进度条与重置倒计时。ChatGPT 的窗口长度**按订阅计划动态变化**,因此标签由接口返回的秒数换算,不假设固定两个窗口。

两边的账号都会在**插件加载时**以及每次 `/usage` 时**自动收录**当前登录的账号,无需手动添加。撞到订阅额度上限时会**自动切号并续接**被打断的那一轮。

## 三种模式

行为由 `tui.json` 里的**插件参数**决定,**不配置参数就是 `local`**——也就是上游那套单机行为,一切照旧。

| 模式 | 跑在哪 | 做什么 |
|---|---|---|
| **`local`**(默认) | 你自己的机器 | 上游原有行为:`/usage`、`/stats`、多账号切换、撞限自动切号、token 保活 |
| **`cloud-master`** | 一台中心主机 | 持有**全部**账号的真实 refresh token,是**整个系统里唯一的刷新者**;保活所有 token、按用量挑最空的号、通过 HTTP 把短时效 access token 租借给 worker。**它自己不跑推理** |
| **`cloud-worker`** | 每个工程师的机器 | **永不持有可用的 refresh token**;向 master 租借 access token 并在过期前续租,撞限时由 master 换号、自动续接那一轮。ChatGPT 仍走本地,不纳入池子 |

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
  "plugin": ["claude-accounts-pool@0.4.0"]
}
```

OpenCode 会自动解析并安装该包,无需手动 `npm install`。这样写(不带参数)就是 **`local` 模式**。

> 从 `claude-accounts-usage` 迁过来无需任何手工操作:旧的 `claude-accounts.json` 原样可读,`local` 行为与 `0.3.0` 一致。**两个包不要同时装**,择一即可。
>
> **建议带上版本号**。OpenCode 按"含版本号的包名"建独立缓存目录:写死版本号后,以后升级只需把后缀改成新版本号;若不带版本号,会被首次安装的版本锁住,发布新版也不会自动更新。

### 方式二:本地 clone(开发/离线)

```bash
git clone https://github.com/Daiwenxi798673133/claude-accounts-pool.git
cd claude-accounts-pool && bun install && bun run build
```

然后让 `tui.json` 指向 `bun run build` 产出的 `dist/tui.js`(也可以直接指 `tui.tsx`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/绝对路径/claude-accounts-pool/dist/tui.js"]
}
```

修改配置后**完全退出并重新打开** OpenCode。

## cloud 模式:配置

模式来自 OpenCode 的**插件参数元组**——`plugin` 数组里的每一项既可以是一个字符串,也可以是 `[包名, 参数对象]` 这样一对。

**`cloud-master`**(中心主机):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["claude-accounts-pool@0.4.0", { "mode": "cloud-master", "hostname": "127.0.0.1", "port": 8787 }]]
}
```

**`cloud-worker`**(工程师机器):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["claude-accounts-pool@0.4.0", { "mode": "cloud-worker", "masterUrl": "http://10.0.0.5:8787", "poolKey": "<master 打印给你的那把 key>", "workerId": "laptop-1" }]]
}
```

参数规则:

- `hostname` 省略时默认 **`127.0.0.1`**。这是**故意**的:这个端口对外发放的是活的 access token,想绑更宽的地址必须显式写出来。
- `port` 必须是 `1`–`65535` 的整数。
- `cloud-worker` 三个字段 `masterUrl`(http/https)、`poolKey`、`workerId` **缺一不可**。
- 参数不合法时,插件**什么都不装**,只弹一个错误提示——宁可不工作,也不半配置地跑。

## cloud 模式:运维

1. **在 master 主机上逐个登录 Claude 账号**:照常 `opencode auth login`(经 ex-machina),master 的 keeper 会自动收录进账号库。
2. **在 master 上跑 `reg` 命令给每台 worker 签发 pool key**。**明文 key 只显示这一次**(库里只存 SHA-256 摘要),请立刻粘进那台 worker 的 `tui.json`。
3. **每台 worker 一把独立的 key**,可以单独吊销某一把。
4. **想看全池用量**:在 master 主机上用浏览器打开 `http://<master 的 hostname>:<port>/`,输入任意一把 pool key 即可看到只读看板(JSON 接口是 `GET /v1/usage`)。详见 [docs/cloud-mode.md](docs/cloud-mode.md#只读用量看板)。
5. **一条硬规矩:纳入池子的账号,在池外不能再有任何刷新者。** 旧机器上残留的登录、第二个 master,都算。Anthropic 的 refresh token 是一次性并且轮换的,而且(**实测**)一次刷新还会**立刻作废上一枚已签发的 access token**——池外的第二个刷新者不仅会打断 refresh 链,还会当场击毙所有在外的租约。

## 日志与排查

插件日志写入 OpenCode 内建日志文件,每条都带 `claude-accounts-usage` 标记(包名改了但内部标识符刻意保留,[原因见此](docs/cloud-mode.md#为什么内部标识符仍然叫-claude-accounts-usage)):

```bash
grep "claude-accounts-usage" ~/.local/share/opencode/log/opencode.log
```

想看更详细的 debug 级日志(比如限流检测的原始样本):启动 opencode 时加上 `OPENCODE_LOG_LEVEL=DEBUG`(或 `--log-level DEBUG`),并设环境变量 `CLAUDE_AUTOSWITCH_DEBUG=1`。两者配合才会输出 debug 级别的诊断信息。

提 issue 时:把相关日志行 grep 出来,贴到 <https://github.com/Daiwenxi798673133/claude-accounts-pool/issues>,并附上复现步骤。日志已对 token 做脱敏处理,但仍建议你粘贴前自查一遍,确认没有夹带敏感信息。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/local-mode.md](docs/local-mode.md) | 单机模式详解:账号管理流程、`/stats` 仪表盘、限流自动切号的完整机制、ChatGPT 多账号(含两个默认关闭的开关) |
| [docs/cloud-mode.md](docs/cloud-mode.md) | 账号池详解:master/worker 职责划分、哨兵 refresh、租约视界与 401 恢复、pool key、内部标识符为何不改 |
| [docs/internals.md](docs/internals.md) | 两种模式共通的实现机制:存储模型、跨进程锁、原子写、provider 隔离、后台保活、开发命令 |
| [docs/limitations.md](docs/limitations.md) | **已知限制**(采用前建议先读) |
| [docs/design/cloud-mode-adr.md](docs/design/cloud-mode-adr.md) | cloud 模式的架构决策记录,含 Gate-0 实测证据与被推翻的先验假设 |
| [docs/research/](docs/research/) | 账号池的可行性与方案对比调研 |

另有三篇上游留下的机制分析:[Claude Code 用量查询机制](docs/claudecode-usage-查询机制分析.md)、[ex-machina 源码机制](docs/ex-machina-源码机制分析.md)、[账号 token 迁移到新电脑](docs/账号token迁移到新电脑操作指南.md)。

## License

MIT
