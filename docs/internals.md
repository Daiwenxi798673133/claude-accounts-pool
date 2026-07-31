# 实现机制(两种模式共通)

存储模型、并发纪律、以及"为什么这么写"。模式相关的部分见 [local-mode.md](local-mode.md) 与 [cloud-mode.md](cloud-mode.md)。

## 存储与收录

- 账号档案保存在 `~/.config/opencode/claude-accounts.json`(权限 `0600`),每个账号含 OAuth `refresh` / `access` / `expires`、邮箱 `label`,以及来自 Anthropic profile 的账号 `uuid`。
- **自动收录**:读 `auth.json` 当前账号 → 调 `oauth/profile` 拿到稳定的账号 `uuid` 和邮箱 → 按 `uuid` upsert。`uuid` 跨 token 刷新保持不变,因此同一账号只会被更新(不重复),换成新账号则自动新增。
- 账号库里每条记录都带 `provider` 判别字段(旧文件里没有这个字段的记录一律读作 `anthropic`,**零迁移成本**),Claude 与 ChatGPT 各有独立的"当前账号"指针。选号、轮询、计数、刷新全部按 provider 过滤,所以一个 Claude 会话在结构上不可能被切到 ChatGPT 账号上,反之亦然。

## 切换与用量

- **切换**:把目标账号的 token 写入 `auth.json` 的 `anthropic` 条目。ex-machina 每次请求都会重新读取 `auth.json`,所以切换立即生效(下一条消息就用新账号),无需重启。
- **查看用量**:对每个账号调用 Anthropic 的 `oauth/usage` 接口;若 access token 过期,会用 refresh token 刷新并回写档案。
- **实时优先、诚实报错**:面板显示的用量**永远是实时拉取的**,绝不显示缓存旧数据(共享账号场景下旧数据会严重失真)。某账号实时拿不到时直接显示真实错误;refresh token 被服务端**永久吊销**的账号显示"需重新登录"(不参与自动切号、不能手动切入,重新用 ex-machina 登录一次即自动恢复;在其行上按 `enter` 可先尝试一次重试刷新)。若其 access token 尚在有效期内,仍会正常显示实时用量。

## 后台保活

插件常驻一个 token keeper——每 5 分钟自动给所有**非活跃**账号续期(快过期才刷);**活跃账号**只在**空闲时**(没有 Anthropic 会话在跑)预刷新,与 ex-machina 天然错开(它只在发请求时刷新),零竞争;同时用文件监听实时跟踪 `auth.json`:ex-machina 每次轮换/每次新登录都会被立即收录,当前账号最新的 refresh token 永不丢失。

cloud-master 模式下这个循环被替换成"刷新**全部**账号"——master 不跑推理、也没有"单一活跃账号"这个概念,账号库本身就是真相源。cloud-worker 模式下 anthropic 侧的保活被整体关掉(master 才是刷新者),但 OpenAI 侧照常工作。

## 并发与一致性

- **跨实例安全**:所有 token 的读改写都持有一把跨进程文件锁(`claude-accounts-usage.lock`,位于 auth.json 同目录),因此同时开多个 OpenCode 实例(TUI / `opencode serve`)也不会互相抢刷同一张一次性 refresh token 或覆盖彼此的轮换结果;极端争用下操作最多等锁 30 秒后诚实报错。锁文件名不可更改,原因见 [cloud-mode.md](cloud-mode.md#为什么内部标识符仍然叫-claude-accounts-usage)。
- 每次写 `auth.json` 都是"读整个文件 → 只改自己那一个 provider 的条目 → 整体原子写回",其他 provider 的条目原样保留。写入前会**紧邻原子写再重读一次**,把与另一个写入者互相覆盖的窗口压到毫秒级。
- 写 `auth.json` 的 anthropic 条目只有**唯一一个入口**。它支持两种写法:写入完整 token(含真实 refresh),或写入一份**租约**(access + expires + 哨兵 refresh)。加一种新写法会是编译错误,直到有人显式决定它怎么序列化。

## 开发

```bash
bun install
bun test              # 全量测试
bun test src/x.test.ts # 单文件
bun run typecheck     # tsc --noEmit
bun run build         # → dist/tui.js
bun scripts/e2e-lease.ts  # cloud 租借链路的端到端验证(仅 127.0.0.1,不访问 Anthropic)
```

`scripts/gate0-*.ts` 是两个**需要真实账号**的验证脚本,默认只打印协议;加 `--yes` 才真的跑。其中 `gate0-refresh-ownership.ts` 会消耗并轮换一张真实 refresh token,只能用可牺牲的账号。
