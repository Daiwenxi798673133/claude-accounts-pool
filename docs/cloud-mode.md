# cloud 模式详解(账号池)

把一批 Claude 账号做成跨机器共享的池子:一台 **master** 持有全部 refresh token 并作为**唯一的刷新者**,多台 **worker** 向它租借短时效 access token。配置写法与运维步骤见 [README](../README.md);架构决策的完整记录与实测证据见 [design/cloud-mode-adr.md](design/cloud-mode-adr.md)。

## 职责划分

| | master | worker |
|---|---|---|
| refresh token | 持有**全部**账号的真实 refresh | **永不持有可用的 refresh** |
| 刷新 | **唯一的刷新者**,单飞(同账号并发只发一次刷新请求) | 从不刷新,只领租 |
| 选号 | 按各账号订阅用量挑最空的,维护冷却状态 | 不参与选号 |
| 撞限检测 / 续接 | 看不到(429 只在 worker 的会话事件里) | 检测 429、上报 master、拿到新号后续接那一轮 |
| 推理 | 不跑 | 跑 |
| ChatGPT | 不纳入池子 | 仍走本地 codex 插件 |

## worker 的 `auth.json` 里那个奇怪的 refresh 是什么

如果你在 worker 上打开 `auth.json`,会看到 `anthropic` 条目的 `refresh` 是一串**明显不像 token 的常量**。这是故意的。

实测发现 **OpenCode 会静默丢弃缺少 `refresh` 字段的 `anthropic` 条目**:带一个假值时 `opencode auth list` 报 `1 credentials`,去掉该字段就变成 `0 credentials`,而且退出码 0、一句报错都没有。所以租约只能写成 `access` + `expires` + 一个**可识别的哨兵字符串**。

账号库的收录路径会**按值拒绝**这个哨兵,因此它永远不会被误当成真凭据存起来、也不会被回传给 master。这个守卫是按值判断而非按模式判断的,所以在 local 模式下这条分支永远不会被走到。

## 为什么租约的到期时间比账号 token 的真实到期更早

master 会在账号 token 即将过期前把它刷新掉,而**这次刷新会立刻作废上一枚 access token**(实测:旧 access 刷新前 `200`,刷新后同一枚 `401`)。这违反常规 OAuth 2.0 语义,却是实际行为。

所以 master 下发租约时,故意把到期时间**封顶在自己动手刷新的那一刻之前**,worker 再提前一段续租——这样 worker 永远在 master 轮换之前就换到了新 token。若租约视界已经落到过去,master 直接拒绝发放(返回"暂无可用账号"),而不是下发一枚到手即死的 token。

万一 worker 仍然握着被轮换掉的 token(时钟偏移、笔记本休眠唤醒),它会把 `401` 当作"租约被轮换"处理:立刻重新领租并续接那一轮,**不会**把这个健康账号误判成撞限而冷却掉——把 401 误 route 进限流路径会白白冷掉一个好号、削减池子容量。

## 为什么内部标识符仍然叫 `claude-accounts-usage`

包名改成了 `claude-accounts-pool`,但代码里的内部标识符**一律保持原样**。这是刻意的,**请不要"顺手统一"**:

- **跨进程锁文件名 `claude-accounts-usage.lock`** —— 这把锁防的正是"两个插件实例并发轮换同一张一次性 refresh token"。如果某台机器上新旧两个包同时存在而锁名不同,**互斥会直接消失**,而这正是整个项目要避免的那个失败。
- **OpenCode 的 KV 命名空间** —— 已签发的 pool key 存在里面,改了会全部孤立。
- **日志服务名** —— 所以 README 里那条 `grep` 命令不变。
- **租约哨兵字符串** —— 改了两个版本就互不认识对方的租约。

## pool key

- 每台 worker 一把,由 master 上的 `reg` 命令签发。
- **明文只显示一次**,库里只存 SHA-256 摘要;校验用常量时间比较(lease 端点是个在线 oracle,对摘要做朴素 `===` 是计时侧信道)。
- 编号从**已发出的最大号 + 1** 推导,而不是从当前条目数——否则吊销一台 worker 留下编号缺口后,下一次签发会重用编号并**静默覆盖**另一台在用 worker 的摘要。
- `/v1/health` 是**免鉴权**的就绪探针,两个 POST 端点都要求 `Authorization: Bearer <poolKey>`;请求体里的 `workerId` 只作参考,**身份一律由 key 决定**(信任请求体等于可被伪造)。

## 一条硬规矩

**纳入池子的账号,在池外不能再有任何刷新者。** 旧机器上残留的登录、第二个 master,都算。

Anthropic 的 refresh token 是一次性并且轮换的,而且一次刷新还会立刻作废上一枚已签发的 access token——所以池外的第二个刷新者不仅会打断 refresh 链(败者拿到 `invalid_grant`,账号需重新登录),还会**当场击毙所有在外的租约**。
