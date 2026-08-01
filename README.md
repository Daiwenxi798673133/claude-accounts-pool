# claude-accounts-pool

一个 OpenCode **TUI 插件**:查看多个 Claude(Pro/Max)与 ChatGPT(Plus/Pro)账号的订阅用量、在账号之间切号、看本地用量统计仪表盘(`/stats`),并把一批 Claude 账号做成**跨机器共享的账号池**。

## 怎么使用

### 前置条件

- 想管理 Claude 账号:已安装并使用 `@ex-machina/opencode-anthropic-auth` 登录 Claude Pro/Max。**无需移除 ex-machina**,两者共存。
- 想管理 ChatGPT 账号:用 `opencode auth login` 登录过 ChatGPT 订阅(走 OpenCode 自带的 codex 插件),无需额外安装。
- 两者都是可选的,只用其中一边也能正常工作。

### 安装

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

### cloud 模式:配置

模式来自 OpenCode 的**插件参数元组**——`plugin` 数组里的每一项既可以是一个字符串,也可以是 `[插件路径, 参数对象]` 这样一对。

**`cloud-master`**(中心主机):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["/绝对路径/claude-accounts-pool/dist/tui.js", { "mode": "cloud-master", "hostname": "100.64.0.36", "port": 8787 }]]
}
```

**`cloud-worker`**(工程师机器):

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [["/绝对路径/claude-accounts-pool/dist/tui.js", { "mode": "cloud-worker", "masterUrl": "http://100.64.0.36:8787", "workerId": "laptop-1" }]]
}
```

参数规则:

- `hostname` 省略时默认 **`127.0.0.1`**。这是**故意**的:这个端口没有任何应用层鉴权,对外发放的又是活的 access token,所以绑更宽的地址必须显式写出来。上面例子里的 `100.64.0.36` 是一个 Tailscale 地址——本项目的部署就是这么绑的,于是"谁能用这个池子"等价于"谁在这个 tailnet 里"。注意**写了但不是非空字符串**(空串、纯空白、数字)不会退回默认值,而是整份配置直接判为非法。
- `port` 必须是 `1`–`65535` 的整数。
- `cloud-worker` 只要两个字段:`masterUrl`(http/https)和 `workerId`,**缺一不可**。`workerId` 不是凭据,master 不认证它——它只是一个自报的标签,用来让 master 的日志能把一条租约归到某台机器上,服务端只按 `^[A-Za-z0-9._-]{1,64}$` 校验一下形状。这份 `tui.json` 通常不用手写,见下面那条一键命令。
- 参数不合法时,插件**什么都不装**,只弹一个错误提示——宁可不工作,也不半配置地跑。

### cloud 模式:把账号和机器接进池子

**1. 把 Claude 账号纳管进池子**,两条路任选:

- **浏览器**(推荐):打开 master 的看板(`http://<master 的 hostname>:<port>/`),点右上角「添加账号」,照着弹窗里的链接登录授权,再把授权页给出的 code 粘回来即可。
- **命令行**:在 master 主机上照常 `opencode auth login`(经 ex-machina),master 的 keeper 会自动收录进账号库。

**2. 把一台 worker 配好**,在那台机器的终端里粘这一条:

```bash
git clone --depth 1 https://github.com/Daiwenxi798673133/claude-accounts-pool.git ~/.claude-accounts-pool \
  && cd ~/.claude-accounts-pool && bun install && bun run build \
  && bun run scripts/configure-worker.ts --master <MASTER_URL> --worker <LABEL>
```

这条命令幂等地把那台机器并进池子:装依赖、构建(**`bun` 是硬前置**——`dist/` 不入库,worker 必须本机构建),再合并 `~/.config/opencode/` 下的配置。它**只增不改**:别人的插件条目一个字节都不碰,语义没变的文件干脆不写,拿不准就拒绝并打出该手工粘贴的 JSON;写之前会打 diff、做备份,`--dry-run` 可以只看不写。完整的保证与四种拒写条件见 [docs/cloud-mode.md](docs/cloud-mode.md#一条命令把-worker-配好)。跑完**完全退出并重开** OpenCode。

`<LABEL>` 就是写进 `workerId` 的那个标签,随便起一个能认出这台机器的名字即可。

**3. 想看全池用量**:浏览器打开 master 的看板。右上角的**刷新**按钮让 master 立刻采集一轮(服务端 30 秒节流一次),页面本身每 5 秒重拉一次,master 自己也每 5 分钟定时轮询。每张账号卡显示邮箱、徽标(冷却中 / 需重新登录 / 不自动切 / 本轮无数据)、access token 剩余时间,以及各窗口的用量条与重置倒计时。

**4. 想把一个号移出池子**:同一个看板,点右上角「删除账号」,选中那一行,再把它的邮箱**完整输入一遍**确认。这是**不可撤销**的——账号记录里那份 refresh token 是唯一一份,Anthropic 不补发,删掉只能重新授权。master 会在删除前把这条记录单独备份到 `claude-accounts.json` 的同目录下(`claude-accounts.deleted-<时间戳>-<id前缀>.json`),后悔了从那里拷回来。

### 更多细节

- [docs/local-mode.md](docs/local-mode.md) —— 单机模式详解:账号管理流程、`/usage` 面板键位、`/stats` 仪表盘、限流自动切号的完整机制、ChatGPT 多账号(含两个默认关闭的开关)
- [docs/cloud-mode.md](docs/cloud-mode.md) —— 账号池详解:三种模式的职责划分、哨兵 refresh、租约视界与 401 恢复、为什么整台 master 都不做鉴权、一键配好 worker 的那条命令、用量看板、内部标识符为何不改
- [docs/internals.md](docs/internals.md) —— 两种模式共通的实现机制:与两个 auth provider 的共存边界、存储模型、跨进程锁、原子写、provider 隔离、后台保活、日志与排查、开发命令
- [docs/limitations.md](docs/limitations.md) —— **已知限制**(采用前建议先读)
- [docs/design/cloud-mode-adr.md](docs/design/cloud-mode-adr.md) —— cloud 模式的架构决策记录,含 Gate-0 实测证据与被推翻的先验假设
- [docs/research/](docs/research/) —— 账号池的可行性与方案对比调研

另有三篇上游留下的机制分析:[Claude Code 用量查询机制](docs/claudecode-usage-查询机制分析.md)、[ex-machina 源码机制](docs/ex-machina-源码机制分析.md)、[账号 token 迁移到新电脑](docs/账号token迁移到新电脑操作指南.md)。

## 注意事项

**1. master 的 HTTP 端口没有任何应用层鉴权,绑定地址就是全部的访问控制。**

一条带鉴权的路由都没有:看板、`/v1/usage`、「添加账号」、「删除账号」、`/v1/lease`、`/v1/ratelimit` 全都免鉴权。也就是说**凡能连到这个端口的人**都能看到池内账号(含邮箱)与余量、能往池里加号、能把号删出池子(需要照着页面把该账号的邮箱一字不差地打出来)、**能直接租走一枚活的 access token**——能连到这个端口,基本等于能用这个池子。

想收窄,**能收窄的只有绑定地址**。本项目的部署里绑的是 Tailscale 地址,访问控制实际上外包给了 tailnet 的成员资格;`hostname` 不写就默认 `127.0.0.1`。**在决定 `hostname` 写什么的那一刻,你就把这个池子的访问控制策略定完了**——取舍与理由见 [docs/cloud-mode.md](docs/cloud-mode.md#为什么整台-master-都不做鉴权)。

**2. 纳入池子的账号,在池外不能再有任何刷新者。**

旧机器上残留的登录、第二个 master,都算。Anthropic 的 refresh token 是一次性并且轮换的,而且(**实测**)一次刷新还会**立刻作废上一枚已签发的 access token**——池外的第二个刷新者不仅会打断 refresh 链(败者拿到 `invalid_grant`,账号需重新登录),还会当场击毙所有在外的租约。这是整套设计里唯一一条你必须自己守住的前提,代码拦不住它。

**3. ChatGPT 侧的自动切号与后台保活默认关闭,且未经真机验证。**

Claude 撞到订阅额度上限时会自动切号并续接被打断的那一轮;**ChatGPT 侧要手动切**。两个开关(`OPENAI_AUTOSWITCH_ENABLED`、`OPENAI_KEEPALIVE_ENABLED`)是 `src/constants.ts` 里硬编码的常量,不是环境变量,关着是因为只有一个 ChatGPT 账号的环境走不到那些路径,而它们出错的后果是整族 token 被吊销、账号必须重新登录。

**4. 采用之前请先读一遍 [docs/limitations.md](docs/limitations.md)。** 跨机器的计费归属尚未验证、worker 无法在请求层被拦住、同一账号会从多个出口 IP 出现——这些都是已知且明写的限制,不是待修的 bug。

## License

MIT
