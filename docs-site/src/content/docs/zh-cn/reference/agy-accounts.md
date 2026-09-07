---
title: AGY 账号
description: 切换已登录的 Google Antigravity 账号，并同步到本机 CLI 与 IDE。
---

在 OpenCodex 订阅页切换 Google Antigravity（AGY）账号，会同时更改代理的当前账号并同步代理主机上的本地凭据。打开 **订阅 → Antigravity**，在已登录账号上点击 **设为当前活跃账号**。

## 一次切换做了什么

`PUT /api/oauth/accounts/active`，请求体为 `{"provider": "google-antigravity", "accountId": "<id>"}`（默认目标为 `["cli", "ide"]`）：

1. 校验账号后设置代理当前账号。
2. 将该账号的 OAuth 凭据写入代理主机的原生 `agy` 钥匙串条目（`gemini` / `antigravity`，仅用户可读写）**以及**旧版 CLI 文件（`~/.gemini/oauth_creds.json` 与 `~/.gemini/google_accounts.json`，仅用户可读写），两处都通过回读校验。在 macOS 上钥匙串写入是强制的：仅写了文件的结果会报告为失败，绝不谎报成功。
3. 将该账号的令牌写入代理主机上 Antigravity IDE 的存储（`Antigravity IDE` 产品 `state.vscdb` 中的 `antigravityUnifiedStateSync.oauthToken`），在单个事务中只更新该行，保留所有无关数据行与同级认证状态，写入后解码校验。另保留一份 WAL 感知的快照，仅供人工灾难恢复 —— 失败的事务直接回滚，绝不会把备份拷回覆盖线上数据库（那会丢弃已提交的历史数据）。磁盘写入成功后报告 `pending_restart` 而非 `synced`：凭据已落盘，但运行时生效尚未确认，需 IDE 重启并核验账号（见下）。

响应中带有分目标的同步状态 —— 仅凭 HTTP 200 **不代表**成功：

```json
{
  "ok": false,
  "provider": "google-antigravity",
  "activeAccountId": "<id>",
  "code": "AGY_SWITCH_IDE_ATTENTION",
  "message": "Proxy account switched and CLI credentials verified, but IDE needs attention …",
  "cli": { "target": "cli", "status": "synced", "code": "AGY_CLI_SYNCED", "retryable": false },
  "ide": { "target": "ide", "status": "pending_restart", "code": "AGY_IDE_PENDING_RESTART", "retryable": true }
}
```

仅当所有请求目标均为 `synced` 时 `ok` 才为 true（请求了 IDE 但代理主机未安装 IDE 时记为附注通过，不记为已同步）。任何部分失败都会报告真实的当前账号、每个目标的稳定错误码以及是否可重试。

目标状态包括：`synced`、`pending_restart`、`failed`、`unsupported`、`not_installed`、`unknown`。

## 重复切换即重试同步

用同一个 `accountId` 再次请求会重新执行所请求目标的同步，因此之前失败的目标可以直接重试，无需更换账号 —— 包括当前已是活跃账号的情况。`GET /api/oauth/accounts?provider=google-antigravity` 会返回脱敏的 `agySync` 快照（仅布尔值与状态码，不含令牌），页面刷新后展示的是真实的 CLI/IDE 状态，而不是从代理账号推导出来的状态。

## 支持环境

- 已验证的目标为 **macOS 代理主机**。未经验证的平台对钥匙串/IDE 写入报告 `unsupported`，绝不谎报成功。
- 同步始终作用于**运行代理的主机**，不一定是浏览器所在主机。
- CLI 切换对**切换后启动**的 `agy` 进程生效。运行中的 CLI 不做热切换。
- IDE 在下次正常启动时读取新令牌；如果 IDE 正在运行，请**正常退出后重新打开**（绝不强制关闭未保存的工作）。运行中时 IDE 同步报告 `pending_restart` 且不触碰其存储。
- 仅写盘**不等于**生效：重启后请在 IDE 自带的账号界面确认当前账号。在确认之前 IDE 目标保持 `pending_restart`；只有核验通过的生效才会报告 `synced`（`AGY_IDE_ACTIVATED`）。
- IDE 已存令牌若带有企业/商务登录标记（`is_gcp_tos` / `enable_business_login`），将保持不动并报告 `unsupported`（`AGY_IDE_ENTERPRISE_UNSUPPORTED`）—— 这类账号请在 IDE 内自行切换。旧账号的模式标记绝不会带入新令牌。
- 账号切换仅适用于 consumer OAuth 模式。CLI 若配置为 API-key 模式（`antigravity-cli/settings.json` 中 `modelProvider: "gemini"` 且设置了 `GEMINI_API_KEY`）或 ADC（`GOOGLE_APPLICATION_CREDENTIALS`），将报告 `unsupported`（`AGY_CLI_AUTH_MODE_UNSUPPORTED`），且不写入任何内容。
- 原生钥匙串访问有超时保护：钥匙串被锁定（或弹出授权框）时操作直接失败，不会卡住代理；页面此时显示 `unknown` 而不是一直等待。若上一次钥匙串写入在限时内仍未落定，下一次切换将以可重试的 `AGY_CLI_KEYRING_PENDING` 拒绝，避免迟到的写入悄悄覆盖已报告的成功。
- 令牌材料永不进入 API 响应、日志或进程参数：钥匙串写入走操作系统凭据接口，响应中只有状态码与脱敏邮箱。

## 额度语义（卡片上真实展示的内容）

卡片使用 Google 的 `retrieveUserQuotaSummary` 接口，按各账号自己的凭据与
Cloud AI Companion 项目查询。它明确返回 **Gemini** 和 **Claude / GPT**
两个订阅组，各自具有**每周**与 **5 小时**限额；组内模型共享这些限额。

`fetchAvailableModels` 是模型目录，不是订阅汇总。即使每周额度已被消耗，
目录内各模型仍可能全部返回剩余比例 1。因此不再用该接口或旧模型缓存作为
订阅进度条的回退来源；只有目录数据的旧缓存会立即重新查询。

- 四个明确的额度条目必须完整有效。缺失、格式错误、重复或查询失败时显示
  **未知/不可用**，不虚构满额，也不根据额度推断套餐名称。
- 百分比最多显示两位小数，真实的 0% 和 100% 正常保留。
  缺失重置日期显示**重置时间未知**；时间戳已过不等于已经观测到额度恢复。
- 路由使用的 `Gem` 与 `Cla` 窗口取对应组中已用比例最高的限额，
  避免 5 小时满额掩盖每周额度耗尽。
- 显示的观测时间来自 `quota.updatedAt`，不会使用凭据过期时间。
  探测失败时保留上次成功额度，以灰色进度条及“旧数据”标记展示，观测时间不变。
- 成功读数缓存十分钟；失败读数缓存 30 秒，页面打开期间自动重试，
  恢复后停止。手动刷新绕过缓存，各平台响应返回后独立显示。

AGY 查询成功后会更新内存，并经防抖写入 OpenCodex 数据目录下的
`provider-account-quota-cache.json`。重启后加载该快照：十分钟内的读数直接复用，
过期读数先标记为旧数据返回，每个账号仅启动一次后台查询。超过六小时的磁盘
快照会被丢弃。更新期间页面仅轮询 AGY，成功后替换旧读数；失败后 30 秒重试。
没有有效缓存时先显示账号与“正在更新”提示，不虚构额度。
快照不写入凭据或邮箱。

## `ocx agy`

```bash
ocx agy accounts [--json]        # 列出已登录的 AGY 账号
ocx agy use <id|email|index>     # 切换代理账号并同步本机 CLI（仅 CLI 目标）
ocx agy --account <id> [...]     # 切换后用该账号启动 agy
ocx agy [...]                    # 多账号时弹出交互式选择
```

`use`/`switch`、`--account`、交互式选择与启动共用同一份同步结果：

- 代理切换或同步失败时返回非零退出码；启动场景下**拒绝启动** `agy`，不会用旧账号凭据继续执行。
- 远程（非本机回环）代理不会触碰本机 CLI 文件，并会明确说明。
- 当 OpenCodex 中没有任何 AGY 账号时，`ocx agy` 直接启动原生程序，不改变其原生登录流程。

## 失败处理

- 缺失凭据、过期且刷新失败、文件读写失败、钥匙串被拒、校验不一致，各自对应不同的 `AGY_CLI_*` 错误码。部分写入会从备份恢复（文件**与**原钥匙串条目）并重新校验；若恢复本身失败，结果会如实报告可能不一致的状态（`AGY_CLI_INCONSISTENT`），而不是成功。
- IDE 数据库锁定、事务失败、校验不一致时直接回滚事务，不保留任何更改 —— 线上数据库（含已提交历史）绝不会被备份覆盖。缺表或现有状态无法解码时拒绝写入（`AGY_IDE_DB_UNEXPECTED` / `AGY_IDE_STATE_CORRUPT`），绝不猜测格式。
- IDE 的 `pending_restart` 永不记为完整成功；失败或未知状态在页面上永不显示为已同步。
- 并发切换按目标串行化，两个请求不会交错写出混合凭据。
