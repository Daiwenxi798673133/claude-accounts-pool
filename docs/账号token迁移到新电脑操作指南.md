# 账号 token 迁移到新电脑操作指南

> 场景：把本插件(`claude-accounts-usage`)在旧电脑上管理的一个或多个 Claude(Pro/Max)账号，整体搬到新电脑继续使用。
>
> 本文是一份**可复现的操作 runbook**：先讲 token 存在哪、迁移的整体流程，再给出新电脑侧的分步操作（含刷新 / 验证命令）、三条必须遵守的铁律，最后附一段真实迁移中的踩坑记录。
>
> ⚠️ 全文不含任何真实 token / 账号 uuid / 邮箱，命令里的 `<...>` 均为占位符。

---

## 1. token 存在哪：两个文件

迁移的本质是搬两个文件，都在家目录下、权限都是 `0600`：

| 文件 | 作用 | 路径 |
|---|---|---|
| **账号库** `claude-accounts.json` | 本插件的账号档案——**所有**账号 + 每个账号的 `refresh` / `access` / `expires`、`label`、`activeId`、`excluded` 标记。这是真正的数据源。 | `~/.config/opencode/claude-accounts.json` |
| **激活 token** `auth.json` | opencode(经 ex-machina)实际发 Claude 请求时读取的**当前激活账号** token | 见下方探测顺序 |

`auth.json` 的路径按以下顺序**探测第一个存在的**：

```
$XDG_DATA_HOME/opencode/auth.json
~/.local/share/opencode/auth.json          # Linux / 常见默认
~/Library/Application Support/opencode/auth.json   # macOS 部分版本
```

> 单个账号在 `claude-accounts.json` 里长这样（字段含义）：
>
> - `id`：来自 Anthropic profile 的账号 `uuid`，跨 token 刷新保持不变，跨机器一致 → 迁移时**直接搬，不用改**。
> - `refresh`：长期刷新令牌，长期凭证（会轮换，见铁律 #1）。
> - `access`：短期访问令牌，会按 `expires` 过期。
> - `expires`：`access` 的绝对过期时间（Unix 毫秒）。
> - `excluded`：可选，`true` 表示"不自动切号"。

---

## 2. 迁移总流程

```
旧电脑                                     新电脑
─────────                                 ─────────
1. 从 claude-accounts.json 里挑出          3. 导入 / 合并账号到本机
   要迁移的账号，打包成一个文件夹              claude-accounts.json
   (含账号数据 + 一份操作说明)                （已有账号则「合并」，不是覆盖）
        │                                        │
        │  2. 通过 AirDrop / scp -p 传输          4. 刷新每个账号的 token
        └───────────────────────────────►         （拿到新 access + 新 refresh 并写回）
                                                   │
                                              5. 把激活账号写入 auth.json
                                                   │
                                              6. 用 usage 接口验证两个账号可用
                                                   │
                                              7. 清理明文 token 文件
```

**核心原则**：账号库(`claude-accounts.json`)是数据源，只要把它搬过去、在新机刷新一次 token，插件就能接管；`auth.json` 只是"当前激活的那一个"的快照，切一次号插件会自动重写。

---

## 3. 新电脑侧分步操作

> 下面这套步骤，就是打包时随附给"新电脑 agent"的操作说明的标准化版本。每一步做完都要验证。

### 步骤 1 · 确认本机存储路径

- 账号库：`~/.config/opencode/claude-accounts.json`
- 激活 token：按第 1 节的顺序探测 `auth.json` 实际落在哪（先跑一次 opencode 或直接查这几个路径）。

### 步骤 2 · 导入 / 合并账号库

- 新机**没有**账号库 → 直接把迁移过来的账号数据拷成 `~/.config/opencode/claude-accounts.json`。
- 新机**已有**账号库（本机已登录过别的账号）→ 把迁移账号的对象**合并**进已有的 `accounts[]` 数组，**按 `id` 去重**（同 `id` 覆盖），**不要整体覆盖**掉本机原有账号。`activeId` 可保留本机原值，也可指向迁移进来的某个账号。
- 设权限：`chmod 600 ~/.config/opencode/claude-accounts.json`

### 步骤 3 · 刷新每个账号的 token（关键）

对每个账号，用它的 `refresh` 调刷新接口拿一套新 token：

```bash
curl -s -X POST https://platform.claude.com/v1/oauth/token \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/plain, */*' \
  -d '{"grant_type":"refresh_token","refresh_token":"<该账号的refresh>","client_id":"9d1c250a-e61b-44d9-88ed-5944d1962f5e"}'
```

成功返回：`{ "access_token": "...", "refresh_token": "...", "expires_in": <秒> }`

写回该账号：

- `access`  ← `access_token`
- `refresh` ← **新的** `refresh_token`（务必替换，旧的已作废——见铁律 #1）
- `expires` ← `当前毫秒 + expires_in * 1000`

失败排查：

- **`400` + body 含 `invalid_grant`** → 该 refresh 已被作废（多半是旧电脑之后又刷过一次），此账号必须重新登录，无法靠旧 token 恢复。
- **`429`** → 限流，**不会**消耗 refresh token，稍后重试即可（见第 5 节踩坑记录）。

### 步骤 4 · 写入 auth.json（让 opencode 真正能发请求）

把要激活的那个账号刷新后的 token 写进步骤 1 找到的 `auth.json`，**只加 / 改 `anthropic` 这一项，保留文件里其他 provider 条目**：

```json
{
  "anthropic": {
    "type": "oauth",
    "access": "<刷新后的access>",
    "refresh": "<刷新后的refresh>",
    "expires": <刷新后的expires毫秒>
  }
}
```

设权限：`chmod 600 <auth.json路径>`

> 也可以跳过手动写 `auth.json`：直接启动 opencode，在插件 `/usage` 面板里 `enter` 切到目标账号，插件会自动把该账号 token 写进 `auth.json`。

### 步骤 5 · 验证可用

用**刷新后的** access 调用量接口，返回 `200` + 用量 JSON 即成功：

```bash
curl -s https://api.anthropic.com/api/oauth/usage \
  -H 'Authorization: Bearer <刷新后的access>' \
  -H 'anthropic-beta: oauth-2025-04-20'
```

逐个账号验证。然后启动 opencode，`/usage` 面板里应能看到迁移进来的账号并可 `↑↓` 选、`enter` 切换。

### 步骤 6 · 清理

- 删除传输用的明文 token 文件夹。
- 旧电脑上被迁移的账号在新机刷新过一次后，其原 token 已失效，建议在旧机插件里删掉，避免误刷冲突（见铁律 #2）。

---

## 4. 三条铁律（迁移前必读）

这些约束来自 OAuth 刷新链的机制，违反会导致账号锁死。

1. **refresh token 会轮换（rotate）。** 每次刷新成功，服务端返回一个**新的** `refresh_token`，你刚用的那个**立即作废**。刷完必须把新 refresh 写回存储，否则下次刷新报 `invalid_grant`。

2. **同一个账号不能在两台机器同时使用。** 两边各自持有各自的 refresh 去刷新，会互相把对方的 refresh 顶掉，导致其中一台永久 `invalid_grant` 锁死。要迁移就彻底迁移：新机刷新成功后，旧机上这些账号的 token 已失效，直接删掉。

3. **`access` token 只会自己按时过期，别人刷新不会顶掉它。** 但 `access` 到期后要靠 `refresh` 续命，而 refresh 可能已被铁律 #2 顶掉 → 续不了 → 锁死。所以到手先刷新拿新 access，别指望旧 access 能一直用。

> 补充：`invalid_grant` 作废的是 **refresh token**（刷新链），不是 access token。判断谁被顶掉时看这一点。

---

## 5. 实战踩坑记录

一次真实迁移（旧机打包 → 新机导入）中遇到的两个点，记下来供参考：

### 踩坑 A · 刷新接口 429 限流（并行触发）

新机侧**同时并行**对多个账号发刷新请求，立刻全部撞 `HTTP 429`（接口前面挂了 Cloudflare，且**不返回 `Retry-After` 头**）。关键认知：

- **`429` 发生在 token 轮换之前，不会消耗 refresh token** → 撞限的账号 refresh 仍然完好，可以安全重试。
- 处理方式：**改成串行**，请求之间留间隔（几十秒级）退避重试，最终逐个刷新成功（`200`，新 token 均为 8 小时有效期）。

教训：刷新多个账号时**串行 + 间隔**，不要并行猛发。

### 踩坑 B · "access 已过期"的判断偏差

打包说明里按本地时间估算 access "即将过期"，但新机实际用 usage 接口一测，两个账号的 access **都还有约 6 小时有效**（接口 `200` 返回真实用量）。

结论：不要只靠 `expires` 时间戳的粗略换算下判断，**以 usage 接口的实际返回为准**；但无论是否过期，迁移时都建议主动刷新一次以完成 refresh 轮换、坐实"旧机副本失效"。

### 迁移完成后的验证样例

两个账号最终都刷新 + 验证通过（`usage` 接口 `200`），拿到各自 5h / 7d 窗口的实时用量，`invalid_grant` 零发生。新机若已有本地账号，采用**合并**策略后账号库里同时保留本机原账号与迁移进来的账号，`activeId` 按需保持或切换。

---

## 6. 相关文档

- 账号库 / 自动收录 / 切换 / 后台保活等工作原理：见项目 `README.md` 的「工作原理」章节。
- ex-machina 的 OAuth 登录与 token 刷新机制：见 [`docs/ex-machina-源码机制分析.md`](./ex-machina-源码机制分析.md)。
