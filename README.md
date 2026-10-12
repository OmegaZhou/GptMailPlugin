# GptMailPlugin

> 当前目标：固定托管服务、独立认证和插件内邮箱面板，支持网页、桌面、移动端。用户允许放宽单 ZIP 要求。直接声明 MCP 的个人 ZIP 在 ChatGPT 被标为仅桌面端；多端候选采用云端邮箱服务加技能 ZIP。0.5.12 正在真实验收，未交付。

Git 仓库只保留脱敏模板。私有 ZIP 允许包含真实固定 MCP 地址、认证 issuer 和公开 clientId；登录密码、访问/刷新令牌和邮箱凭据不进入 Git 或发布包。

通用 IMAP/SMTP 邮箱插件，提供邮件查询、阅读、草稿、发送和整理功能。插件通过 HTTPS 连接托管服务，邮箱连接及凭据保存在服务端。支持多账号和多设备接入。

当前采用固定服务器：管理员在 ChatGPT 登记托管邮箱服务，并把已验证的应用引用写入私有 ZIP。安装者导入 ZIP、安装或关联邮箱服务，再登录服务器账号；不用创建自己的 MCP 服务，也不用填写地址或服务密钥。当前不支持任意切换服务器。

```text
ChatGPT ── HTTPS + OAuth ── MCP ┐
MCP 客户端 ── HTTPS + OAuth ──┼── 托管服务 ── IMAP / SMTP ── 邮箱
REST 客户端 ── HTTPS + OAuth ─┘
```

21 个工具涵盖账号列表、邮件搜索与 ID 查询、单封和批量读取、会话读取、附件、草稿创建/修改/列表/发送、新邮件/回复/转发、文件夹及计数、已读/星标、移动、归档和回收站。功能及参数见 [工具定义](server/api/tools.json) 和 [邮件操作说明](skills/mail/SKILL.md)。

## 快速开始

需要 Node.js 22 或更高版本。以下命令在仓库根目录执行：

```bash
npm ci
npm run build
npm test
npm run api
```

复制 `server/config.example.json` 为 `server/config.json`，配置认证服务、随机存储加密密钥及邮箱账号，并向进程注入相应的邮箱环境变量后运行：

```bash
npm start
```

默认只监听 `127.0.0.1:3000`。公开服务由 Nginx 提供 HTTPS，部署路径使用 `/mail-mcp`，操作步骤见 [部署说明](deploy/README.md)。允许 `mail.accounts:[]` 先启动接口，添加真实邮箱配置后再使用邮件工具。

## 私有配置与 Git

| 本地私有文件 | 可提交模板 | 用途 |
|---|---|---|
| `server/config.json` | `server/config.example.json` | 存储加密密钥、HTTP/OAuth 配置及邮箱账号 |
| `server/address.json` | `server/address.example.json` | 托管 MCP、ChatGPT 和 REST 地址 |
| `config/plugin.json` | `config/plugin.example.json` 或 `config/plugin.oauth.example.json` | MCP 地址、认证服务 issuer 和已注册的公开 clientId；不保存登录密码 |
| `.env` | `.env.example` | Docker 邮箱环境变量 |
| `server/deploy.env` | `server/deploy.env.example` | 私有 HTTPS origin、Nginx 站点文件及 SSH 别名 |
| `mcp.json` | `mcp.example.json` | 生成的客户端连接配置 |

`.gitignore` 排除真实配置、环境变量、密钥、OAuth 状态、邮件数据、日志、依赖、构建产物和发布包；模板、接口定义和依赖锁文件保留在 Git 中。`.gitattributes` 统一文本为 LF，便于 Windows 开发和 Linux 部署。提交前可用 `git status --short`、`git diff --cached` 核对内容。

文档中的 `mail.example.com` 和 `your-ssh-alias` 都是占位符。真实域名、IP、SSH 连接信息及密钥仅填写在被忽略的私有配置中，不写入源码或提交记录。

## 插件内配置

多端候选 ZIP 通过 `.app.json` 引用已登记的云端邮箱服务；引用本身不创建服务或授予权限。邮箱面板由 `open_settings` 提供。Google 使用官方登录授权并自动刷新令牌；QQ 使用授权码，iCloud 使用应用专用密码。可以添加、测试、编辑、移除连接及设置默认邮箱，新增邮箱无需再次登录服务器。

UI 位于 `ui/`，通过 MCP 资源协议提供，没有服务端 `/panel`。表单经 MCP Apps 桥接调用 App 专用工具，凭据不进入模型上下文。邮箱加密保存于 `MAIL_STATE_DIR/panel/settings.enc.json`，历史目录名不代表网页。详见 [面板说明](docs/settings.md)。

## 服务端认证和邮箱

MCP 和 REST 统一使用独立认证服务签发的 access token，校验签名、有效期、所有者、客户端、资源及读写权限。目前认证服务基于 Authelia；可以更换满足令牌契约的认证库，邮箱业务不依赖其账号数据库。服务端不再接受固定 API 密钥。`storageKey` 是独立的随机存储加密密钥，仅用于保护磁盘上的邮箱凭据，不发送给客户端，也不能用于认证。

当前支持邮件临时密码登录：管理员以邮箱地址创建账号，登录时发送 32 个字符的安全随机临时密码，同一账号 15 分钟内只发送一次，15 分钟过期；认证成功后立即销毁并替换密码哈希。认证服务直接使用自身 SMTP 配置，不调用邮箱插件。切换登录模式、账号管理及更换认证库的接口边界见 [认证模块说明](auth/README.md)。

`mail.accounts` 支持多个账号，`mail.defaultAccount` 指定默认账号。邮箱授权码通过账号的 `passwordEnv` 指定环境变量；也可用 `accessTokenEnv` 提供现有邮箱 OAuth token，两者选一。手工填写的已有 token 不自动刷新；面板中 Google 登录授权的 token 自动刷新并加密保存。IMAP/SMTP 地址和端口以邮箱供应商的设置为准。

`secure:true` 使用隐式 TLS，`secure:false` 强制 STARTTLS，始终验证服务器证书。`folders` 可以设置 `drafts/sent/trash/archive` 的精确路径；未配置时尝试 IMAP SPECIAL-USE，可通过 `list_labels` 获取路径。`saveSent` 控制保存已发送副本。

`MAIL_SERVER_CONFIG` 可覆盖配置文件路径，`MAIL_STATE_DIR` 指定持久状态目录。状态保存发送去重及加密邮箱配置，需要跨重启保留；OAuth 授权由独立认证模块保存。`npm start` 不自动读取 `.env`；直接运行时需自行注入环境变量，Docker Compose 使用 `.env`，systemd 使用私有环境文件。

`http.publicUrl` 设置公开 HTTPS origin，`http.allowedOrigins` 可增加浏览器来源；只有经过一个可信反向代理时才设置 `http.trustProxy:1`。服务端配置说明见 [server/README.md](server/README.md)。

## 插件和 ChatGPT 接入

管理员登记云端邮箱服务的固定 HTTPS 地址和独立 AuthService OAuth 配置，再将已验证的服务 ID 写入被忽略的 `config/app-binding.json`。模板见 `config/app-binding.example.json`。

```bash
npm run configure:plugin
npm run package -- --hosted-app config/app-binding.json
# 独立名称仅用于安装流程测试
npm run package -- --hosted-app config/app-binding.json --validation
```

正式 ZIP 包含技能、图标及云端服务引用，不包含服务端程序或凭据。安装步骤：导入 ZIP，安装或关联它声明的邮箱服务，登录服务器账号，然后通过服务的“打开插件”或正式插件“网站”入口进入 ChatGPT 内嵌面板。平台是否自动安装依赖以实际界面为准；不能声称 ZIP 自动创建云端服务。当前宿主原生设置组可能只显示标题，详情主按钮也可能为“在聊天中试用”；已提供指向内嵌面板的直接链接。

`npm run package -- --desktop` 只生成直接 MCP 调试包，个人导入后仅桌面端可用，不能用于多端交付。官方限制和各端验收状态见 [当前目标](docs/acceptance-goal.md)。

正式更新保留原 `gpt-mail` 条目，通过“上传新版本”或 Plugin Creator guarded update 更新原条目；服务器更新后刷新工具元数据。包内容变化时增加版本，仅服务器变化不强制增加 ZIP 版本。测试结束卸载测试包、断开授权，保留服务器配置和正式插件定义供用户重装。

认证模块作为 `auth/` 子模块引用 [AuthService](https://github.com/OmegaZhou/AuthService)。
运行 `git submodule update --init --recursive` 获取依赖。邮箱仓库只验证令牌，
认证仓库维护 Authelia 依赖、SMTP 登录、账号和部署工具，其他插件也可共用。

## 接口路径

| 用途 | 默认路径 | `/mail-mcp` 部署路径 |
|---|---|---|
| OAuth MCP | `/chatgpt/mcp` | `/mail-mcp` |
| MCP 别名 | `/mcp` | `/mail-mcp/mcp` |
| REST 工具定义 | `/api/v1/tools` | `/mail-mcp/api/v1/tools` |
| REST 工具调用 | `/api/v1/tools/{toolName}` | `/mail-mcp/api/v1/tools/{toolName}` |
| 健康检查 | `/healthz` | `/mail-mcp/healthz` |

MCP 支持 initialize、tools/list 和 tools/call。REST 调用的 JSON 请求体为工具参数，响应为 MCP CallToolResult。所有邮件入口携带认证服务签发的 access token。凭据放请求头，不放 URL。完整约定见 [OpenAPI](server/api/openapi.json) 和 [OAuth 工具定义](server/api/chatgpt-tools.json)。`npm run api` 可重新生成接口文件。

## 邮箱语义与验证

- IMAP 文件夹对应邮箱目录；归档和删除移到 Archive/Trash，普通邮件不永久删除。
- 会话在同一文件夹中按 Message-ID/References 有界匹配，并返回截断标记。
- 搜索支持明确的 Gmail 风格子集，不支持的操作符返回错误；默认搜索 INBOX，按 UID 倒序分页。
- 默认单封邮件上限 25 MiB、附件读取上限 5 MiB、工具响应上限 12 MiB；附件返回原始字节。
- 移动要求 MOVE 或 UIDPLUS，草稿清理要求 UIDPLUS。
- SMTP 接收不保证最终送达；部分收件人拒收和 Sent 副本失败分别报告。
- 发送使用 `operation_id` 防止重试重复发送；结果不确定时不会自动重发。发送邮件需要用户明确授权。

详细行为见 [语义说明](skills/mail/references/semantics.md)。测试覆盖 MCP/REST、固定密钥拒绝、外部 JWT 校验、权限与面板会话恢复、搜索分页、邮件 ID、草稿与附件、发送去重及 SMTP。IMAP 使用可控测试实现，真实邮箱和 ChatGPT 界面接入需在配置后验证。CI 在 Windows 和 Linux 运行构建、测试及接口定义同步检查。

## 目录

| 目录 | 内容 |
|---|---|
| `server/` | 服务端实现、配置模板、API 定义及接入说明 |
| `deploy/` | Nginx/systemd 部署、回滚及验证脚本 |
| `config/` | 插件配置模板 |
| `skills/mail/` | 邮件使用技能和语义说明 |
| `scripts/` | 构建、接口导出、插件配置及发布打包 |
| `test/` | 协议与邮件行为测试 |

实现使用 [MCP SDK](https://github.com/modelcontextprotocol/typescript-sdk)、[ImapFlow](https://imapflow.com/docs/api/imapflow-client/) 和 [Nodemailer](https://nodemailer.com/smtp)。不需要 OpenAI API key。
