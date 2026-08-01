# claude-accounts-pool

一个 OpenCode **TUI 插件**,用来查看多个 Claude(Pro/Max)与 ChatGPT(Plus/Pro)账号的订阅用量、在账号之间切换,并查看本地 OpenCode 的用量统计仪表盘(`/stats`)。在此之上,它还支持把一批 Claude 账号做成**跨机器共享的账号池**。

它**不接管**任何 auth provider:`anthropic` 条目仍由 [`@ex-machina/opencode-anthropic-auth`](https://github.com/ex-machina-co/opencode-anthropic-auth) 负责 OAuth 登录与请求注入,`openai` 条目仍由 OpenCode **自带的 codex 插件**负责登录与 token 刷新。本插件只在工具层做"账号档案 + 切换 + 用量展示",因此与两者**共存**。

> 本仓是 [`Daiwenxi798673133/claude-accounts-usage`](https://github.com/Daiwenxi798673133/claude-accounts-usage) 的 fork,在其之上新增了 cloud 模式(账号池)。上游的单机功能全部保留且行为不变。

## 功能

命令是**按模式注册**的,三种模式装出来的东西并不一样:

| 命令 | 哪些模式有 | 作用 |
|------|------|------|
| `/usage` | `local` | 弹框显示账号用量,按 provider 分 `Claude` / `ChatGPT` 两页(`tab` / `←→` / `h l` 切页),并常驻一行「当前对话」显示本轮真实的 provider / model。两页都可 `↑↓` 选择、`enter` 切换(立即生效)、`m` 标记/取消"不自动切"、`d` 删除账号(再按一次 `d` 确认,当前账号不可删)、`esc` 关闭 |
| `/usage` | `cloud-worker` | **另一个精简面板**:单一 Claude 平铺列表,没有 provider 页签,也没有 `m` / `d`——这两个操作都要改账号库,而账号库在 master 上。键位是 `↑↓ 选择 · enter 切号 · r 刷新 · esc 关闭`:`enter` 是**向 master 申请租用**指定账号,可能被拒(账号不存在 / 前缀有歧义 / 冷却中 / 需重新登录);`r` 让 master 立刻跑一轮采集;master 停止轮询时面板顶部会给出快照陈旧的警告 |
| `/stats` | **仅本地** | 弹框显示本地 OpenCode 的用量统计仪表盘:总览 / 模型 / 提供方三个分页,含活跃热力图与 token 折线图,可切 All / 7天 / 30天 范围 |
| `/reg` | `cloud-master` | 给一台 worker 签发 pool key,**兜底用**——常规路径是在看板上点「领取 key」自助领。见下文「cloud 模式:运维」 |

`cloud-master` **只注册 `/reg`**——它既没有 `/usage` 也没有 `/stats`,master 端要看用量请打开 web 看板。

Claude 页显示 5h / 7d 两个窗口,外加各受限模型的周窗口(如 `Fable`,由 Anthropic 的 `limits` 动态返回),均带进度条与重置倒计时。ChatGPT 的窗口长度**按订阅计划动态变化**,因此标签由接口返回的秒数换算,不假设固定两个窗口。

两边的账号都会在**插件加载时**以及每次 `/usage` 时**自动收录**当前登录的账号,无需手动添加。**Claude** 撞到订阅额度上限时会**自动切号并续接**被打断的那一轮;**ChatGPT** 侧**尚未启用自动切号**,开关默认关闭且未经真机验证([见此](docs/limitations.md)),需要手动切。

## 三种模式

行为由 `tui.json` 里的**插件参数**决定,**不配置参数就是 `local`**——也就是上游那套单机行为,一切照旧。

| 模式 | 跑在哪 | 做什么 |
|---|---|---|
| **`local`**(默认) | 你自己的机器 | 上游原有行为:`/usage`、`/stats`、多账号切换、撞限自动切号、token 保活 |
| **`cloud-master`** | 一台中心主机 | 持有**全部**账号的真实 refresh token,是**整个系统里唯一的刷新者**;保活所有 token、按用量挑最空的号、通过 HTTP 把短时效 access token 租借给 worker。**它自己不跑推理** |
| **`cloud-worker`** | 每个工程师的机器 | **永不持有可用的 refresh token**;向 master 租借 access token 并在过期前续租。撞 **429** 时由 master 换一个账号、自动续接那一轮;租来的 token 撞 **401** 则属于租约失效(master 刷新某个账号会当场作废它在外的 access token),这时 worker 重租**同一个**账号,不冷却也不换号。ChatGPT 仍走本地,不纳入池子 |

## 前置条件

- 想管理 Claude 账号:已安装并使用 `@ex-machina/opencode-anthropic-auth` 登录 Claude Pro/Max。**无需移除 ex-machina**,两者共存。
- 想管理 ChatGPT 账号:用 `opencode auth login` 登录过 ChatGPT 订阅(走 OpenCode 自带的 codex 插件),无需额外安装。
- 两者都是可选的,只用其中一边也能正常工作。

## 安装

TUI 插件只在 `~/.config/opencode/tui.json` 配置,**不要**放进 `opencode.json`。

本插件**没有发布到 npm**,装法只有一种:本地 clone,然后让 `tui.json` 指向构建产物。

```bash
git clone https://github.com/Daiwenxi798673133/claude-accounts-pool.git
cd claude-accounts-pool && bun install && bun run build
```

`bun run build` 会产出 `dist/tui.js`(也可以直接指 `tui.tsx`):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["/绝对路径/claude-accounts-pool/dist/tui.js"]
}
```

这样写(不带参数)就是 **`local` 模式**。修改配置后**完全退出并重新打开** OpenCode。

> 从 `claude-accounts-usage` 迁过来无需任何手工操作:旧的 `claude-accounts.json` 原样可读,`local` 行为与 `0.3.0` 一致。**两个插件不要同时装**,择一即可。

## cloud 模式:配置

模式来自 OpenCode 的**插件参数元组**——`plugin` 数组里的每一项既可以是一个字符串,也可以是 `[插件路径, 参数对象]` 这样一对。

**`cloud-master`**(中心主机):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["/绝对路径/claude-accounts-pool/dist/tui.js", { "mode": "cloud-master", "hostname": "127.0.0.1", "port": 8787 }]]
}
```

**`cloud-worker`**(工程师机器):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["/绝对路径/claude-accounts-pool/dist/tui.js", { "mode": "cloud-worker", "masterUrl": "http://10.0.0.5:8787", "poolKey": "<签发给这台机器的那把 key>", "workerId": "laptop-1" }]]
}
```

参数规则:

- `hostname` 省略时默认 **`127.0.0.1`**。这是**故意**的:这个端口对外发放的是活的 access token,想绑更宽的地址必须显式写出来。注意**写了但不是非空字符串**(空串、纯空白、数字)不会退回默认值,而是整份配置直接判为非法。
- `port` 必须是 `1`–`65535` 的整数。
- `cloud-worker` 三个字段 `masterUrl`(http/https)、`poolKey`、`workerId` **缺一不可**。其中 `workerId` 只是本机日志用的标签:master 认的身份只有 pool key,注册表会自己给每把 key 分配 `worker-N` 编号,另外记下你领 key 时填的那个 label(和这里的 `workerId` 是两个字段,下文那条一键命令只是把同一个字符串同时用作两者)。这份 `tui.json` 通常不用手写,见下文运维第 2 步。
- 参数不合法时,插件**什么都不装**,只弹一个错误提示——宁可不工作,也不半配置地跑。

## cloud 模式:运维

1. **把 Claude 账号纳管进池子**,两条路任选:
   - **浏览器**(推荐):打开 master 的看板,点右上角「添加账号」,照着弹窗里的链接登录授权,再把授权页给出的 code 粘回来即可。
   - **命令行**:在 master 主机上照常 `opencode auth login`(经 ex-machina),master 的 keeper 会自动收录进账号库。
2. **给每台 worker 签发 pool key**,常规路径在看板上:点「领取 key」,填一个这台机器的 label,页面当场给出 key(**明文只显示这一次**,库里只存 SHA-256 摘要),连同一条能直接粘进那台 worker 终端的命令:

   ```bash
   git clone --depth 1 https://github.com/Daiwenxi798673133/claude-accounts-pool.git ~/.claude-accounts-pool \
     && cd ~/.claude-accounts-pool && bun install && bun run build \
     && bun run scripts/configure-worker.ts --master <MASTER_URL> --key <POOL_KEY> --worker <LABEL>
   ```

   这条命令幂等地把那台机器并进池子:装依赖、构建(**`bun` 是硬前置**——`dist/` 不入库,worker 必须本机构建),再合并 `~/.config/opencode/` 下的配置。它**只增不改**:别人的插件条目一个字节都不碰,语义没变的文件干脆不写,拿不准就拒绝并打出该手工粘贴的 JSON;写之前会打 diff、做备份,`--dry-run` 可以只看不写。完整的保证与四种拒写条件见 [docs/cloud-mode.md](docs/cloud-mode.md#一条命令把-worker-配好)。跑完**完全退出并重开** OpenCode。

   **兜底路径**:看板不可达时,在 master 那个 OpenCode 会话里执行斜杠命令 `/reg`(TUI 里的命令,不是 shell 命令),**明文 key 在 toast 里停留 120 秒**。两条路签出的 key 完全等价。
3. **每台 worker 一把独立的 key,有效期 7 天,而且每次成功租借都把到期时间滑到 7 天后。** 所以在用的 worker 不会掉线(放假一周合上笔记本回来也还在),而**领了没用上的 key 7 天后自己消失**——自助签发不会攒下一堆永久凭据。但要清楚:**活着的 key 仍然没有吊销入口**,也没有查看已发 key 清单的入口。想立刻停用某一把,只能手工编辑 OpenCode KV 里的 `claude-accounts-usage.master.poolkeys` 条目——它的值现在是 `{"worker-1": {"digest": "<sha256 摘要>", "label": "laptop-1", "issuedAt": <毫秒>, "expiresAt": <毫秒>}}`,旧版本留下的裸摘要会在升级后**首次用到注册表时自动迁移**(摘要逐字保留,**不会踢掉正在跑的 worker**)。

   **改之前必须先把 master 停掉,顺序是「停服 → 改文件 → 起服」,这一步不是讲究而是必须。** OpenCode 的 KV 在进程内有一份内存副本,`set` 时整份写回磁盘。所以对着运行中的 master 改文件,会连着踩两个坑(**均已实测**):删掉的那把 key **当场仍然租得到号**,因为校验读的是内存不是文件;而 master 下一次写 KV(例如有人领了新 key)会把内存里那份整个盖回去,被你删掉的条目**原样复活**。也就是说照着「热改文件」做,你会以为凭据已经吊销,它却一直活着——这正是吊销最不能出错的地方。
4. **想看全池用量**:浏览器直接打开 `http://<master 的 hostname>:<port>/` 就是看板(JSON 接口是 `GET /v1/usage`,另有 `GET /v1/health` 返回 `{"ok":true}` 供探活),**免鉴权**。也就是说凡能连到这个端口的人都能看到池内账号与余量,**能用「添加账号」往池里加号**,而且——这一条要紧得多——**能用「领取 key」给自己签一把真能租借 access token 的 key**。想收窄,能收窄的只有绑定地址——[取舍与理由见此](docs/cloud-mode.md#为什么这几条路由是裸的)。
5. **看板会自己跟上**:右上角的**刷新**按钮走 `POST /v1/usage/refresh`,让 master 立刻采集一轮;这条路由在服务端全局节流,**30 秒**一次,超频返回 429 并在按钮上显示倒计时。页面本身每 5 秒重拉一次 `/v1/usage`,切回标签页时也会立刻重拉,因此池外触发的采集(别人的浏览器,或 master 自己每 5 分钟的定时轮询)同样跟得上。账号卡片是自适应网格,每张卡显示邮箱、徽标(冷却中 / 需重新登录 / 不自动切 / 本轮无数据)、access token 剩余时间,以及各窗口的用量条与重置倒计时。
6. **一条硬规矩:纳入池子的账号,在池外不能再有任何刷新者。** 旧机器上残留的登录、第二个 master,都算。Anthropic 的 refresh token 是一次性并且轮换的,而且(**实测**)一次刷新还会**立刻作废上一枚已签发的 access token**——池外的第二个刷新者不仅会打断 refresh 链,还会当场击毙所有在外的租约。

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
| [docs/cloud-mode.md](docs/cloud-mode.md) | 账号池详解:master/worker 职责划分、哨兵 refresh、租约视界与 401 恢复、pool key 的自助签发与 7 天滑动过期、一键配好 worker 的那条命令、用量看板与「添加账号」/「领取 key」为什么是裸路由、内部标识符为何不改 |
| [docs/internals.md](docs/internals.md) | 两种模式共通的实现机制:存储模型、跨进程锁、原子写、provider 隔离、后台保活、开发命令 |
| [docs/limitations.md](docs/limitations.md) | **已知限制**(采用前建议先读) |
| [docs/design/cloud-mode-adr.md](docs/design/cloud-mode-adr.md) | cloud 模式的架构决策记录,含 Gate-0 实测证据与被推翻的先验假设 |
| [docs/research/](docs/research/) | 账号池的可行性与方案对比调研 |

另有三篇上游留下的机制分析:[Claude Code 用量查询机制](docs/claudecode-usage-查询机制分析.md)、[ex-machina 源码机制](docs/ex-machina-源码机制分析.md)、[账号 token 迁移到新电脑](docs/账号token迁移到新电脑操作指南.md)。

## License

MIT
