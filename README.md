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

**3. 想看全池用量**:浏览器打开 master 的看板。右上角的**刷新**按钮让 master 立刻采集一轮(服务端 30 秒节流一次),页面本身每 5 秒重拉一次,master 自己也每 5 分钟定时轮询。每张账号卡显示邮箱、徽标(冷却中 / 需重新登录 / 不自动切 / 本轮无数据)、access token 剩余时间、正在用这个号的机器名(带 📌 的那台是**钉住**了它、在额度用满前不会被轮换走),以及各窗口的用量条与重置倒计时。

**4. 想把一个号移出池子**:同一个看板,点右上角「删除账号」,选中那一行,再把它的邮箱**完整输入一遍**确认。这是**不可撤销**的——账号记录里那份 refresh token 是唯一一份,Anthropic 不补发,删掉只能重新授权。master 会在删除前把这条记录单独备份到 `claude-accounts.json` 的同目录下(`claude-accounts.deleted-<时间戳>-<id前缀>.json`),后悔了从那里拷回来。

### cloud 模式:用池子的号跑原生 Claude Code

worker 配好之后,这台机器还多一条入口:直接用账号池的号起一个**原生 `claude` 会话**。

```bash
bun ~/.claude-accounts-pool/claude-pool.ts            # 等价于 `claude`,但用池子的号
bun ~/.claude-accounts-pool/claude-pool.ts -p "..."   # 参数原样透传,一个都不解析
```

它不直接把凭证交给 `claude`,而是在本机起一个**中间层(relay)**,把 `claude` 的 `ANTHROPIC_BASE_URL` 指向它(`127.0.0.1:18787`)。relay 把每个请求的凭证换成当前租约,其余原样转发给 `api.anthropic.com`。**不碰你自己的登录**:`~/.claude/.credentials.json` 与 Keychain 条目一个字节都不动,不用这条命令时,手敲的 `claude` 照常用你自己的号。

为什么要多这一层:实测 claude 2.1.278,凭证在进程内冻结——改 settings、送 401,都不会让一个已经在跑的会话换掉 token。把换 token 挪到进程外面之后:

- **会话中途会自动续期**,不再有「租约 4 小时到期、长会话以 401 结束」。
- **撞额度会自动换号,会话不用重开**。只有带配额头的 429(`anthropic-ratelimit-unified-representative-claim` / `-overage-status`,或 `unified-status: rejected`)才换;不带这些头的 429(容量问题,或「1M 上下文需要 Extra Usage」这类权限问题)换到哪个号都一样,原样交给 `claude` 显示。换号前先把限流上报给 master,别的机器不用各自再撞一次墙。
- **`-p` 模式同样生效**——以前靠 `StopFailure` 钩子上报限流,而 `-p` 下那个钩子不触发。

**本机所有会话共用一个号**,这是有意的:到期续期、撞额度换号都只发生一次。反过来每个会话各持一个号,5 个会话同时撞墙就会一瞬间切走 5 个号。relay 内部也按这个原则处理并发:5 个请求同时在同一个号上吃到 429,只有第一个去上报并换号,其余的直接在换好的号上重发。

relay 由 `claude-pool` 按需拉起(端口绑定即单例),所有会话结束 10 分钟后自行退出,日志在 `~/.claude-accounts-pool/cc-relay.log`。会话运行期间启动器每 15 秒确认一次 relay 还在,它意外退出时会被拉起、会话重新登记。

**环境里有更高优先级的凭证时,它会拒绝启动而不是将就。** `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_BASE_URL`、`CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY`,以及 settings 里的 `apiKeyHelper`,都排在池子租约之前。`ANTHROPIC_BASE_URL` 是另一种情况:子进程的 base URL 必须是本机 relay,你自己设的那个会被覆盖——而你设了它,说明想让流量去别处,这得由你决定,所以同样拒绝。将就的后果是会话照跑、钱记在池子没租过的号上,而且无法从内部察觉——所以宁可不启动,并告诉你 unset 哪一个。

退出码:`78` = 这台机器配置得让租约用不上(先按提示修);`75` = 池子这会儿给不出号(稍后再试);其余都是 `claude` 自己的退出码。

在 `~/.claude-accounts-pool/senpi-worker.json` 里可以加两个字段(只增不改):

```jsonc
{ "ccWorkerId": "vince-cc",   // 看板上会被人读到的名字;不配则由 worker 标签推导
  "ccRelayPort": 18787 }      // relay 端口;被别的程序占着时改这个
```

旧版的 `ccSlots` 已不再使用,留在文件里也无妨。

**可以点名用哪个账号**,或把它钉住——点名作用于**整台机器**:

```bash
claude-pool --pool-account af008f89              # 把本机共享号切到这个号
claude-pool --pool-account af008f89 --pool-pin   # 并且以后一直用它,直到额度用满
claude-pool --pool-unpin                         # 取消钉住
```

前缀就是看板上显示的账号 id 前 8 位。这几个参数**只在最前面**被解析,遇到第一个不是 `--pool-*` 的就停止,其余原样透传给 `claude`——所以 `claude-pool -p "参数叫 --pool-pin"` 里那个字符串不会被当成参数。

几条行为值得先知道:

- **点名会带着正在跑的会话一起换**:它们从下一个请求起用新号,启动时会说明有几个会话受影响。
- **被点名的号不可用时(冷却中、需重登、已满员、前缀匹配到多个),启动直接失败**,绝不替换成别的号——你的用量归属依赖「我要的就是我拿到的」。其余会话继续用原来的号。
- **钉住是机器级的,一次性点名只撑到下一次续期**:另一个号钉着时,`--pool-account X`(不带 `--pool-pin`)会切过去,但下一次续期 relay 会点名钉住的那个、切回去——启动时会提醒这一句。
- **钉住的号额度用满时**,relay 先上报、再点名,master 以「冷却中」拒绝,钉住随之交还并按用量换号;master 明说不服务被钉住的号时同样交还,否则以后每次续期都白跑一趟往返。

设计依据与实测记录见 [issue #83](https://github.com/Daiwenxi798673133/claude-accounts-pool/issues/83)。已知代价见 [docs/limitations.md](docs/limitations.md#原生-claude-codeclaude-pool)。

### 一键接管本机 Claude Code:make setup / make revert

不想每次敲 `claude-pool`,想让手敲的 `claude`、后台会话、agent view 全都走池子:

```bash
cd claude-accounts-pool
make setup      # 提示输入 master 的 ip:port,再提示输入 WorkerID,然后一键配好
make status     # 装没装、relay 在不在、当前共享哪个号
make revert     # 一键撤回:Claude Code 回到你自己的号
```

也可以不提问:`make setup MASTER=100.64.0.36:8787 WORKER=vince-mbp`。WorkerID 就是看板上这台机器的名字。

`make setup` 做五件事。每一件都记进 `~/.claude-accounts-pool/cc-takeover.json`,改别人的文件之前先备份(`*.bak-<时间>`):

| 改了什么 | 为什么 |
|---|---|
| `~/.claude-accounts-pool/senpi-worker.json` | 池子配置:master 地址、`ccWorkerId`(已有的 senpi 标签不动) |
| `~/.claude-accounts-pool/bin/claude-pool-launch` | 启动器:向 relay 领当前共享租约,注入环境后 `exec` |
| `~/.claude/settings.json` 的 `env.CLAUDE_CODE_PROCESS_WRAPPER` | 官方[启动器契约](https://code.claude.com/docs/en/corporate-launcher):Claude Code 从自己二进制拉起的一切进程(后台服务、agent view、自我重启、Remote Control、队友 pane)都经过启动器 |
| `~/.claude-accounts-pool/bin/claude` + shell rc 末尾一段 PATH | 终端里手敲的 `claude` 不在契约覆盖内,文档的建议做法就是在 PATH 前面放一个名为 `claude` 的脚本(官方 symlink 不动) |
| `~/Library/LaunchAgents/com.claude-accounts-pool.relay.plist` | relay 常驻:不闲置退出,崩溃自动拉起 |

装完**开一个新终端**再敲 `claude`。已经开着的会话读的是旧设置,重启后生效;后台服务要重启一次(没有在跑的后台会话时执行 `claude daemon stop --any`)。

**出问题时启动器会拒绝启动,而不是退回你自己的号**,并在报错里告诉你 `make revert`。退回你自己的号意味着会话照跑、用量却记在你没打算用的号上,而且你察觉不到。

`make revert` 按清单逐项撤回:删掉 settings 里那个键、删掉 shell rc 里那段 PATH、卸下 launchd 任务、停掉 relay、删掉转发脚本;池子配置由 setup 新建的就删掉,被 setup 改过的就还原。撤回的第一步是挪开清单,而启动器看不到清单就原样放行,所以哪怕撤回中途出错,新起的 Claude Code 也已经回到你自己的号上。几件事要知道:

- 撤回之前开着的 `claude` 会话还指向刚停掉的 relay,需要重启。已打开的终端若提示找不到 `claude`,执行 `rehash`。
- 启动器文件会留下(它此时只做 `exec`):撤回前启动的会话和后台服务还指着它,删掉会让它们起不来。所有会话都重启过之后可以手工删。
- 拉了新代码之后重跑一次 `make setup`(幂等),常驻 relay 才会换成新代码。

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

## 提 issue

出了问题请到 <https://github.com/Daiwenxi798673133/claude-accounts-pool/issues> 开一个 issue,**需要两样东西**:

**1. 问题描述** —— 你做了什么、期望看到什么、实际看到什么。有报错或 toast 就把原文抄进去。

**2. 相关日志 zip** —— 在 OpenCode 里执行 `/update-log`,插件会把日志打成一个 zip 并把路径 toast 出来(默认落在 `~/Downloads/`,没有这个目录就落在家目录),把这个文件拖进 issue 即可。

开 issue 时仓库的表单会把这两项列成必填项,照着填即可。

zip 里是三样东西:

- `meta.txt` —— 插件版本、**运行模式**(local / cloud-master / cloud-worker)、OpenCode 版本、操作系统、**终端**、运行时、**日志级别开关**、**已加载的插件清单**、日志目录,以及日志按 `run`(OpenCode 给每个进程的标识)的分布。字段是对着 `opencode debug info` 和 OpenCode 自己的 issue 表单选的——插件清单尤其关键,新旧两个插件是否同装只有这里看得出来。
- `issue.md` —— 一份填好环境信息的 issue 草稿,复现/期望/实际留空,直接复制粘贴即可。
- `plugin-<日志文件名>.log` —— OpenCode 日志里属于本插件的行(每个文件最多保留**最后** 20000 行,裁掉的永远是旧的那头;真被裁了 `meta.txt` 会写明"命中 N 行、保留 M 行、已丢弃最早 X 行",不会拿截断过的日志假装完整)。

**脱敏是在写入 zip 之前做的**,不是让你自己事后检查:token / Bearer / JWT / `*_token` 字段一律掩码,账号邮箱只留首字母与域名(`alice@gmail.com` → `a***@gmail.com`)。zip 本身是明文的,上传前仍然建议你解开扫一眼。

三种模式都有这个命令。cloud 模式下 **master 与 worker 各打各的包**:选号与刷新只在 master 的日志里看得见,所以只要问题涉及"为什么给我这个号"、刷新失败或租约,请把 master 那一侧的包也一起带上。

两个例外:模式配置非法时插件**什么都不装**(这个命令也没有),先按 toast 里的提示修好 `tui.json`;想附更详细的 debug 级日志,按 [docs/internals.md](docs/internals.md#日志与排查) 打开开关再复现一次,然后再 `/update-log`。

## License

MIT
