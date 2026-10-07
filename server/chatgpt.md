# ChatGPT OAuth 适配层

ChatGPT 连接 `/chatgpt/mcp`，原有 API Key 客户端连接 `/mcp` 或 REST。两种入口共享 21 个邮件工具；邮箱连接仍只发生在托管服务上。ChatGPT 使用标准 OAuth 访问令牌，不需要自定义 API Key 请求头。

## 1. 配置服务

在私有 `server/config.json` 保留现有 `apiKey` 和 `mail`，补充以下配置（域名仅为示例，用你的真实 HTTPS 域名替换）：

```json
{
  "http": {
    "bindHost": "127.0.0.1",
    "port": 3000,
    "publicUrl": "https://mail.example.com",
    "trustProxy": 1,
    "allowedOrigins": []
  },
  "oauth": {
    "enabled": true,
    "mcpPath": "/chatgpt/mcp",
    "redirectOrigins": ["https://chatgpt.com", "https://chat.openai.com"]
  }
}
```

这是配置片段，不是完整服务配置；`apiKey` 与邮箱参数仍为必填项。`trustProxy:1` 仅适用于一个可信反向代理；直接访问时用 `0`。`publicUrl` 是公开 origin，不能带 `/mcp`、查询参数或账号密码。公网必须 HTTPS，HTTP 仅用于 loopback 测试。代理需要保留公开 Host，并转发本页列出的全部路径。仅转发 `/chatgpt/mcp` 会导致 OAuth 发现失败。

可用 `oauth.mcpPath` 修改 ChatGPT MCP 路径，默认 `/chatgpt/mcp`。相应的资源 URL、资源发现路径和 `WWW-Authenticate` 会自动调整；插件地址及所有 `resource` 参数也须使用新路径。路径只允许字母、数字、下划线、连字符和目录分隔符，不得与既有端点冲突。OAuth 的 `/authorize`、`/token` 等路径仍在域名根下。

同站点部署可再设置 `oauth.routePrefix`，默认空字符串。例如 `mcpPath:"/mail-mcp"`、`routePrefix:"/mail-mcp"` 会将授权端点移到 `/mail-mcp/authorize` 等路径，issuer 为 `https://你的域名/mail-mcp`；授权服务器发现地址为 `/.well-known/oauth-authorization-server/mail-mcp`。授权表单、Cookie 路径、API Key MCP 和 REST 的前缀也一并调整。部署示例见 [../deploy/README.md](../deploy/README.md)。

`redirectOrigins` 限定动态注册的回调来源；每个客户端实际回调 URI 会注册并匹配。默认来源覆盖 ChatGPT 域名。如需其他 OAuth MCP 客户端，添加它的可信回调 origin；不要添加通配符。浏览器直接跨域调用 API 时，另将可信浏览器 origin 加入 `http.allowedOrigins`。不同用途的这两个列表不能互相替代。

状态目录 `MAIL_STATE_DIR` 必须可写且持久化；其中 `oauth/state.json` 保存客户端注册信息和令牌摘要。Docker 配置中的 `mail-state` 卷同时保存邮件发送状态与 OAuth 状态。启动命令为 `npm run build`、`npm start`。

可在 `server/address.json` 记录：

```json
{
  "mcpUrl": "https://mail.example.com/mcp",
  "chatgptMcpUrl": "https://mail.example.com/chatgpt/mcp",
  "apiBaseUrl": "https://mail.example.com/api/v1"
}
```

## 2. 在 ChatGPT 中连接

如需先添加邮箱，可打开本服务 `/panel/`；`/mail-mcp` 部署使用 `/mail-mcp/panel/`。授权页也提供面板入口，使用服务端密钥登录即可配置。面板是服务提供的网页，ChatGPT 设置页不会直接显示 IMAP/SMTP 表单。详细步骤见 [面板说明](panel.md)。

根据当前官方 [连接文档](https://developers.openai.com/plugins/deploy/connect-chatgpt)，在支持自定义 MCP 的账号/工作区中：

1. 打开 Plugins，选择添加自定义 MCP（Add custom MCP）。
2. 输入名称 GptMail 和你的完整 HTTPS URL：`https://你的域名/chatgpt/mcp`。
3. 选择 OAuth，使用动态客户端注册（DCR）；此服务提供 `/register`，无需手工生成客户端 ID/Secret。
4. 创建/连接后会打开你的服务器授权页。核对域名、回调地址及权限，在该页面输入 `server/config.json` 的 `apiKey`，点击“验证并授权”。密钥只提交给自己的服务端，不粘贴到 ChatGPT 对话中。
5. 完成回调后安装/启用插件，在对话中通过 `@GptMail` 使用工具，先测试“列出邮箱账号”或“查看未读邮件”。

界面名称和可用入口以账号实际界面为准。这里实现的是远程 OAuth MCP，连接依赖你配置的公网服务；不会自动安装到账号。无需 OpenAI API Key，也不导入旧版 `ai-plugin.json`。

回调 URI 由 ChatGPT 创建连接时提供，服务不会硬编码或伪造 callback ID。该授权服务器没有声明 `authorization_response_iss_parameter_supported:true`，使用平台展示的对应回调配置。[官方认证文档](https://developers.openai.com/plugins/build/auth) 说明了不同回调形式、PKCE 和动态注册要求。

## 3. 可选：生成便携插件配置

使用 `config/plugin.oauth.example.json` 创建私有 `config/plugin.json`：

```json
{
  "authType": "oauth",
  "apiUrl": "https://你的域名/chatgpt/mcp"
}
```

执行 `npm run configure:plugin` 生成远程 `mcp.json`。`apiUrl` 留空时读取 `server/address.json` 的 `chatgptMcpUrl`；OAuth 配置不写入 `Authorization` 或 API Key。宿主需支持 MCP OAuth 发现及 DCR。ChatGPT 自定义 MCP 入口直接填 URL 即可，不必上传 ZIP；便携包供支持该格式的插件宿主加载。`npm run package` 可导出私有模板，认证在连接时完成。

原有 API Key 模式仍使用 `authType:"apiKey"`、`apiUrl` 和 `apiKey`，对应 `/mcp`。不能把 API Key 作为 `/chatgpt/mcp` 的 access token；也不能把 OAuth token 当作原有 REST 的服务端密钥。

## 协议与权限

| 路径 | 认证 / 作用 |
|---|---|
| `GET /.well-known/oauth-protected-resource/chatgpt/mcp` | 无须认证；资源 URL、issuer 和 scopes |
| `GET /.well-known/oauth-authorization-server` | 无须认证；授权服务器元数据 |
| `POST /register` | 动态注册；限定回调 origin；JSON 客户端元数据 |
| `GET /authorize` | 授权码 + PKCE S256；显示所有者登录/授权表单 |
| `POST /oauth/approve` | 服务端密钥 + 同源检查 + Cookie/表单 nonce；同意或取消 |
| `POST /token` | form-urlencoded；授权码换令牌或刷新，按客户端注册方式认证 |
| `POST /revoke` | form-urlencoded；客户端认证后撤销该令牌所属授权 |
| `POST /chatgpt/mcp` | OAuth Bearer access token；MCP Streamable HTTP |

授权和令牌请求必须携带 `resource=https://你的域名/chatgpt/mcp`，包括刷新请求。资源校验用于避免其他服务的令牌被复用。客户端支持 `none` 或 `client_secret_post`，客户端注册和 Secret 会持久化；Secret 无自动过期，重新授权不会重新生成已有客户端的 Secret。

`mail.read` 允许账号/文件夹列表、搜索、阅读、附件和草稿列表。`mail.write` 允许创建/更新草稿、发送/回复/转发、创建文件夹、标记、移动/归档/Trash；写操作可能读取其处理的原始邮件。授权页展示申请的 scopes，授权范围为本服务配置的全部邮箱账号。省略 scopes 时请求读写权限。

OAuth 工具声明包含顶层 `securitySchemes` 和 `_meta.securitySchemes`。缺少所需 scope 时，工具返回 `_meta["mcp/www_authenticate"]`，供宿主触发再次授权；缺少/无效令牌时 HTTP 返回 401 和包含资源发现地址的 `WWW-Authenticate`。工具 Schema 见 [api/chatgpt-tools.json](api/chatgpt-tools.json)。

访问令牌为 32 字节密码学随机不透明值，有效 1 小时；刷新令牌有效期为首次授权后 30 天，刷新不延长总期限。令牌只持久化 SHA-256 摘要；刷新会轮换，重复使用旧刷新令牌会撤销整组授权。授权码一次性，授权请求/码 5 分钟过期。服务端密钥同样用 SHA-256 摘要进行恒定时间比较；不使用 JWT，也不把密钥变成 OAuth token。

修改服务端密钥或公开域名后重启服务，会撤销所有旧 OAuth 授权，需要重新连接；注册客户端信息仍保留。日常重启保留令牌和客户端。授权页待处理请求/授权码只在内存中，重启期间未完成的授权需重试。此实现用于单所有者、单进程私有服务；状态目录不要由多个实例同时写入。状态中含客户端 Secret，应按私有凭据文件管理。

## 故障排查

- 入口 404：确认 `oauth.enabled:true`，并已重启。
- 添加连接时发现失败：检查公开 HTTPS、完整 MCP URL、Host 转发和所有 discovery/OAuth 路径可访问。
- `invalid_target`：授权、换码和刷新都必须使用完全一致的 `/chatgpt/mcp` resource URL。
- `invalid_client_metadata`：核对实际回调 origin 是否在 `redirectOrigins` 中；不要把整个回调路径当作 origin。
- 授权页 403：检查密钥、同源提交、Cookie 是否启用；过期/进程重启后从 ChatGPT 重新发起授权。不要在浏览器开发日志或代理日志记录表单正文。
- `insufficient_scope`：重新连接并批准所需读/写权限。
- 重启后无法刷新：检查状态目录是否持久化、密钥/域名是否变化；过期或已撤销授权需重新连接。

本仓库测试覆盖发现、DCR、授权、PKCE、权限声明/隔离、刷新轮换、撤销及重启恢复。实际 ChatGPT 安装和真实邮箱操作需要在私有配置完成后验证；服务器验证方法见 [部署说明](../deploy/README.md)。
