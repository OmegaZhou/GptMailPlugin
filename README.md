# GptMailPlugin

通用 IMAP/SMTP 邮箱插件，提供邮件查询、阅读、草稿、发送和整理功能。插件通过 HTTPS 连接托管服务，邮箱连接及凭据保存在服务端。支持多账号和多设备接入。

```text
ChatGPT ── HTTPS + OAuth ── MCP ┐
MCP 客户端 ── HTTPS + API Key ──┼── 托管服务 ── IMAP / SMTP ── 邮箱
REST 客户端 ── HTTPS + API Key ─┘
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

复制 `server/config.example.json` 为 `server/config.json`，设置服务端密钥及邮箱账号，并向进程注入相应的邮箱环境变量后运行：

```bash
npm start
```

默认只监听 `127.0.0.1:3000`。公开服务由 Nginx 提供 HTTPS，部署路径使用 `/mail-mcp`，操作步骤见 [部署说明](deploy/README.md)。允许 `mail.accounts:[]` 先启动接口，添加真实邮箱配置后再使用邮件工具。

## 私有配置与 Git

| 本地私有文件 | 可提交模板 | 用途 |
|---|---|---|
| `server/config.json` | `server/config.example.json` | 服务端密钥、HTTP/OAuth 配置及邮箱账号 |
| `server/address.json` | `server/address.example.json` | 托管 MCP、ChatGPT 和 REST 地址 |
| `config/plugin.json` | `config/plugin.example.json` 或 `config/plugin.oauth.example.json` | 插件认证模式、接口路径和 API Key |
| `.env` | `.env.example` | Docker 邮箱环境变量 |
| `server/deploy.env` | `server/deploy.env.example` | 私有 HTTPS origin、Nginx 站点文件及 SSH 别名 |
| `mcp.json` | `mcp.example.json` | 生成的客户端连接配置 |

`.gitignore` 排除真实配置、环境变量、密钥、OAuth 状态、邮件数据、日志、依赖、构建产物和发布包；模板、接口定义和依赖锁文件保留在 Git 中。`.gitattributes` 统一文本为 LF，便于 Windows 开发和 Linux 部署。提交前可用 `git status --short`、`git diff --cached` 核对内容。

文档中的 `mail.example.com` 和 `your-ssh-alias` 都是占位符。真实域名、IP、SSH 连接信息及密钥仅填写在被忽略的私有配置中，不写入源码或提交记录。

## 网页配置面板

打开服务的 `/panel/`；采用 `/mail-mcp` 部署时，入口为 `/mail-mcp/panel/`。使用现有服务端密钥登录后，可以：

- 配置客户端 MCP 完整地址，选择 OAuth 或 API Key，复制地址并下载 `mcp.json`。
- 添加、编辑、测试和移除通用 IMAP/SMTP 邮箱，设置默认账号，无需手动修改服务配置或重启。
- 快速填写 QQ、163、126 的服务器参数，或自行填写企业邮箱参数；支持独立收发凭据及文件夹配置。

面板中的密钥用于登录和 API Key 客户端配置，不会修改服务端密钥。连接地址设置用于客户端导出，不会修改服务端公开 origin、监听端口或 ChatGPT 已有连接。ChatGPT 插件设置页仍需填写 MCP 地址；授权页提供“打开邮箱配置面板”的入口。

邮箱凭据直接提交给当前服务，加密保存在 `MAIL_STATE_DIR/panel/settings.enc.json`，API 只返回是否已有凭据。面板使用独立的短期登录会话，不接受 MCP OAuth token 作为管理权限。测试仅验证 IMAP/SMTP 登录，不发送邮件。

已有配置文件账号在面板中显示为只读，可以测试和设为默认；账号参数仍在原私有配置中管理。面板新增邮箱立即加入本服务账号列表，现有授权覆盖全部配置邮箱，尚未按每个 ChatGPT 连接隔离单独邮箱。详细操作见 [面板说明](server/panel.md)。

## 服务端认证和邮箱

服务端 `apiKey` 与 API Key 模式的客户端密钥一致，长度为 32–512 字符。使用至少 32 字节的密码学安全随机值；它是 Bearer 凭据，不是邮箱密码，也不需要客户端计算签名。部署脚本首次安装时生成 256 位随机密钥，后续发布保留现有值。

`mail.accounts` 支持多个账号，`mail.defaultAccount` 指定默认账号。邮箱授权码通过账号的 `passwordEnv` 指定环境变量；也可用 `accessTokenEnv` 提供现有邮箱 OAuth token，两者选一。服务不会自动申请或刷新邮箱供应商的 token。IMAP/SMTP 地址和端口以邮箱供应商的设置为准。

`secure:true` 使用隐式 TLS，`secure:false` 强制 STARTTLS，始终验证服务器证书。`folders` 可以设置 `drafts/sent/trash/archive` 的精确路径；未配置时尝试 IMAP SPECIAL-USE，可通过 `list_labels` 获取路径。`saveSent` 控制保存已发送副本。

`MAIL_SERVER_CONFIG` 可覆盖配置文件路径，`MAIL_STATE_DIR` 指定持久状态目录。状态保存发送去重记录、OAuth 客户端和令牌摘要，需要跨重启保留。`npm start` 不自动读取 `.env`；直接运行时需自行注入环境变量，Docker Compose 使用 `.env`，systemd 使用私有环境文件。

`http.publicUrl` 设置公开 HTTPS origin，`http.allowedOrigins` 可增加浏览器来源；只有经过一个可信反向代理时才设置 `http.trustProxy:1`。服务端配置说明见 [server/README.md](server/README.md)。

## 插件和 ChatGPT 接入

API Key 客户端：复制 `config/plugin.example.json` 为 `config/plugin.json`，填写 MCP 完整地址 `apiUrl` 和与服务端一致的 `apiKey`，然后运行：

```bash
npm run configure:plugin
```

生成的 `mcp.json` 使用远程 Streamable HTTP 和 `Authorization: Bearer <apiKey>`。留空地址时从 `server/address.json` 读取 `mcpUrl`。客户端需支持自定义请求头；修改配置后重新生成并重载。

ChatGPT：使用 `config/plugin.oauth.example.json`，设置 `authType:"oauth"` 和公开 OAuth MCP 地址。`/mail-mcp` 部署的占位示例为 `https://mail.example.com/mail-mcp`。服务端启用 OAuth，在 ChatGPT 自定义 MCP 连接中选择 OAuth 和动态客户端注册，然后在自己的服务器授权页使用服务端密钥登录。生成的 OAuth 客户端配置不嵌入服务端密钥。

账号或工作区需要开放自定义 MCP 功能。具体步骤和故障排查见 [ChatGPT 接入](server/chatgpt.md)，适配依据官方 [认证要求](https://developers.openai.com/plugins/build/auth) 和 [连接流程](https://developers.openai.com/plugins/deploy/connect-chatgpt)。

`npm run package` 导出私有插件 ZIP，包含远程连接模板、技能、图标及说明，不包含服务端代码、邮箱凭据或 API 密钥。配置后的发布包可能包含私有接口地址，因此 `artifacts/` 被忽略；导出不会自动安装或上传。

## 接口路径

| 用途 | 默认路径 | `/mail-mcp` 部署路径 |
|---|---|---|
| OAuth MCP | `/chatgpt/mcp` | `/mail-mcp` |
| API Key MCP | `/mcp` | `/mail-mcp/mcp` |
| REST 工具定义 | `/api/v1/tools` | `/mail-mcp/api/v1/tools` |
| REST 工具调用 | `/api/v1/tools/{toolName}` | `/mail-mcp/api/v1/tools/{toolName}` |
| 健康检查 | `/healthz` | `/mail-mcp/healthz` |

MCP 支持 initialize、tools/list 和 tools/call。REST 调用的 JSON 请求体为工具参数，响应为 MCP CallToolResult。API Key 入口携带服务端密钥；OAuth MCP 携带授权生成的 access token。凭据放请求头，不放 URL。完整约定见 [OpenAPI](server/api/openapi.json) 和 [OAuth 工具定义](server/api/chatgpt-tools.json)。`npm run api` 可重新生成接口文件。

## 邮箱语义与验证

- IMAP 文件夹对应邮箱目录；归档和删除移到 Archive/Trash，普通邮件不永久删除。
- 会话在同一文件夹中按 Message-ID/References 有界匹配，并返回截断标记。
- 搜索支持明确的 Gmail 风格子集，不支持的操作符返回错误；默认搜索 INBOX，按 UID 倒序分页。
- 默认单封邮件上限 25 MiB、附件读取上限 5 MiB、工具响应上限 12 MiB；附件返回原始字节。
- 移动要求 MOVE 或 UIDPLUS，草稿清理要求 UIDPLUS。
- SMTP 接收不保证最终送达；部分收件人拒收和 Sent 副本失败分别报告。
- 发送使用 `operation_id` 防止重试重复发送；结果不确定时不会自动重发。发送邮件需要用户明确授权。

详细行为见 [语义说明](skills/mail/references/semantics.md)。测试覆盖 MCP/REST、密钥认证、OAuth/PKCE/权限/刷新/撤销/重启、搜索分页、邮件 ID、草稿与附件、发送去重及 SMTP。IMAP 使用可控测试实现，真实邮箱和 ChatGPT 界面接入需在配置后验证。CI 在 Windows 和 Linux 运行构建、测试及接口定义同步检查。

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
