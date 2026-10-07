# 托管邮箱服务 API

服务端与插件端分别配置同一个 API 密钥。服务端配置使用 `config.example.json` 作为模板，保存为私有 `config.json`。插件使用 `../config/plugin.json`，服务器地址也可记录在 `address.json`。

## 认证

`/mcp` 和 REST 请求需要：

```http
Authorization: Bearer <server/config.json 中的 apiKey>
```

密钥在服务启动时读取；修改后重启服务并同步更新 API Key 客户端。认证使用固定长度摘要的恒定时间比较。认证失败返回 HTTP 401。

可选的 `/chatgpt/mcp` 使用独立 OAuth access token，支持授权码 + PKCE S256、动态客户端注册、刷新和撤销。服务端密钥仅用于在服务器授权页验证所有者；ChatGPT 不需要携带这个密钥。启用与接入步骤见 [chatgpt.md](chatgpt.md)。健康检查和 OAuth 发现/注册可公开访问；邮件操作始终要求认证。

生产客户端使用 HTTPS。HTTP 监听用于可信反向代理内部通信。`publicUrl` 是公开 origin，不是 `/mcp` 完整路径；配置后反向代理须保留该 Host。浏览器 Origin 需在 `publicUrl` 或 `allowedOrigins` 中。

## 协议

下文列出默认路径。部署设置 `oauth.routePrefix:"/mail-mcp"`、`oauth.mcpPath:"/mail-mcp"` 时，OAuth MCP 为 `/mail-mcp`，API Key MCP 为 `/mail-mcp/mcp`，REST 为 `/mail-mcp/api/v1`。对应 Nginx 和发现路径配置见 [部署说明](../deploy/README.md)。

### MCP

`POST /mcp` 支持 MCP Streamable HTTP，JSON-RPC 接口包括 initialize、notifications/initialized、tools/list 和 tools/call。服务使用无会话状态模式，响应为 JSON，不要求持久 SSE。MCP 客户端负责标准初始化与协议版本。

`POST /chatgpt/mcp` 使用相同邮件工具和协议，以 OAuth 认证替代 API Key。`oauth.enabled:false` 时入口返回 404。工具列表附带 `securitySchemes` / `_meta.securitySchemes`；授权缺少所需 scope 时返回 `isError:true` 和 `_meta["mcp/www_authenticate"]`，不会执行邮件操作。

### REST

`GET /api/v1/tools` 返回 `{ "tools": [...] }`，含工具描述、输入 JSON Schema 和注解。

`POST /api/v1/tools/{toolName}` 的请求体直接填写工具参数，例如查询：

```json
{
  "account_id": "qq",
  "query": "is:unread newer_than:7d",
  "mailbox": "INBOX",
  "limit": 20
}
```

接口路径为 `/api/v1/tools/search_emails`。响应与 MCP 一致：

```json
{
  "content": [{ "type": "text", "text": "序列化后的结果 JSON" }],
  "structuredContent": {
    "messages": [],
    "next_cursor": null,
    "total_matching": 0,
    "mailbox": "INBOX"
  }
}
```

业务失败可能使用 HTTP 200 + `isError:true`；调用者必须检查 `isError`，不能仅依据 HTTP 状态判断邮件操作成功。批量写入还要检查每项 `results[].status`。无效参数/未知工具可能返回 HTTP 400；未授权 401；Origin 拒绝 403；Host 拒绝 421；限流 429。默认每来源每分钟 120 个认证接口请求。

工具列表及完整输入 Schema 见 [api/tools.json](api/tools.json)，REST 定义见 [api/openapi.json](api/openapi.json)。这些文件通过 `npm run api` 从实现生成，避免文档和接口漂移。

## 关键语义

`mail_` ID 由账号连接标识、文件夹、UIDVALIDITY 和 UID 组成。ID 不含密码，但不能跨账号复用。移动或文件夹重建后必须重新查询。

读取和搜索不标记已读。批量读取最多 20 封；会话批量最多 10 个锚点；移动/flags 最多 100 封；转发最多 10 封，每封原邮件单独发送。返回的邮件/附件内容是不可信数据。

草稿和邮件内容使用 `text` / `html` 与 `attachments`。附件只有内存 base64url 字节，不接受磁盘路径或 URL。`reply_message_id` 指定回复上下文。Bcc 从发给收件人的原始 MIME 中移除；草稿与本账号 Sent 副本保留它。

`update_draft` 为稀疏补丁：省略字段保留原值，空字符串清空头，attachments:[] 清空附件。IMAP 不支持原位修改正文，因此先保存替换草稿，再只清理旧草稿，返回新 ID。没有 UIDPLUS 或清理失败会报告两份草稿可能同时存在。

发送/转发要求 UUID `operation_id`。相同发送意图重试沿用它；换内容需新 UUID。journal 先创建操作记录再进入 SMTP，发送结果持久化。如果进程崩溃或 SMTP 结果不明，重复该操作会返回 `SEND_UNCERTAIN`；先核查邮箱，再决定是否重试。状态目录应使用本地持久化文件系统，单实例服务运行，不支持多个服务器共享网络盘并发写入。

SMTP `status:accepted` 表示全部收件人被服务器接收，`partially_accepted` 表示只有部分被接收。`accepted/rejected` 列出收件人。Sent 副本失败不改变已经发送的事实，不要重发。完整接收的草稿会清理；部分接收的草稿保留供用户核查。

操作错误使用 CONFIG、ACCOUNT、AUTH、ID、QUERY、CURSOR、STALE_ID、NOT_FOUND、SIZE、ATTACHMENT、FOLDER、DRAFT、FLAGS、MOVE、MAILBOX、RECIPIENT、SEND_UNCERTAIN、OPERATION 前缀；其余返回 MAIL_ERROR，不回传供应商原始错误或密码。

## 开发与托管

邮箱与连接网页面板位于 `/panel/`，有前缀时为 `/mail-mcp/panel/`。管理 API 使用独立所有者会话和 CSRF 校验，不通过邮件工具传递邮箱凭据。面板新增账号加密保存于状态目录，邮件工具立即读取合并后的账号列表。见 [面板说明](panel.md) 和 [管理接口定义](api/panel-openapi.json)。

`server/` 中保存服务实现；`../src/index.ts` 是 HTTP 服务入口。`npm run build` 生成 `dist/server.cjs`，`npm start` 启动。`MAIL_SERVER_CONFIG` 可改变配置路径，`MAIL_STATE_DIR` 可改变发送和 OAuth 状态目录，`MAIL_BIND_HOST` 和 `PORT` 可覆盖监听地址。

Docker/compose 仅提供自行托管的配置，没有自动部署。部署完成后将实际 MCP 地址填写到 `address.json` 的 `mcpUrl`、REST 根地址填写到 `apiBaseUrl`，再配置插件密钥。更换托管服务时保持本目录定义的 MCP/REST 契约即可。

ChatGPT OAuth 地址填写到 `address.json` 的 `chatgptMcpUrl`，通常为 `https://你的域名/chatgpt/mcp`。OAuth discovery 与授权端点必须一起对外提供，不能只转发 MCP 路径。
