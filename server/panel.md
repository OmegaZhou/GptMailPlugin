# 邮箱与连接管理面板

面板是本服务提供的网页，默认路径 `/panel/`，Nginx `/mail-mcp` 部署的路径为 `/mail-mcp/panel/`。从浏览器打开，或通过 OAuth 授权页的面板链接打开。ChatGPT 插件设置页负责发起连接，邮箱表单由本服务提供。

## 登录与 MCP 配置

1. 在自己的服务地址下打开面板，输入现有服务端 `apiKey`。
2. 填写客户端使用的 MCP 完整地址，选择 OAuth 或 API Key，也可点击“使用当前服务地址”。
3. 保存设置，复制地址或下载客户端 `mcp.json`。

OAuth 配置不包含密钥。API Key 配置包含本次登录使用的密钥，下载后私有保存；刷新页面后如需再次导出含密钥的配置，应重新输入密钥登录。面板不将密钥或邮箱授权码保存在 localStorage/sessionStorage，不自动修改 ChatGPT 的连接配置，不修改服务端密钥、公开 origin 或端口。

浏览器管理会话有效期为 1 小时，使用 HttpOnly、SameSite=Strict Cookie，在 HTTPS 下设置 Secure。状态变化请求要求同源和会话 CSRF 校验。登录密钥和邮箱凭据只发给当前面板服务，修改导出用 MCP URL 不会把凭据自动传给新地址。

## 添加邮箱

1. 点击“添加邮箱”，填写唯一账号 ID、邮箱地址及显示名称。
2. 选择 QQ、163、126 的快捷参数或填写自定义 IMAP/SMTP 地址。快捷参数仍需与邮箱后台的实际设置核对。
3. 填写收件和发件授权码，可使用不同登录账号和凭据。“使用相同的收件凭据”将输入值复制到发件字段。
4. 点击“测试连接”验证登录；测试不保存配置、不发送邮件，也不保证实际发信一定投递成功。
5. 点击“保存邮箱”。配置立即进入邮件工具的账号列表，无需重启服务。

`TLS` 对应隐式 TLS，`STARTTLS` 强制升级加密，均验证服务器证书。QQ/163 等通常使用邮箱后台生成的授权码，不是网页登录密码。已有邮箱 OAuth access token 也可填写，但服务不自动申请或刷新供应商 token。

编辑邮箱时不回显凭据。空凭据保留原值；修改服务器、端口、TLS、登录账号或认证方式时必须重新填写凭据。可设置默认邮箱、测试已保存连接、移除面板添加的账号；移除只删除服务连接，不删除邮箱内的邮件。

已有 `server/config.json` 账号在面板中只读展示，不覆盖环境变量凭据；这些账号仍通过原私有配置管理。面板账号 ID 不得与配置文件账号重复。

## 状态与备份

连接设置、邮箱参数及凭据加密保存在 `MAIL_STATE_DIR/panel/settings.enc.json`。加密使用 AES-256-GCM 和随机 nonce，密钥从现有服务端 `apiKey` 经 HKDF-SHA-256 派生。目录权限 0700、文件 0600（Linux）；Windows 按文件系统 ACL 管理访问。私有文件被 Git 和 Docker 构建上下文忽略。

备份需保留状态目录和匹配的服务端密钥。当前版本不提供在线密钥轮换；直接替换 `apiKey` 会导致旧面板配置无法解密，服务拒绝丢弃配置启动。需要换密钥时，应在受控环境中迁移配置并重新授权。

当前为单所有者、单进程服务：面板账号共享现有 OAuth 授权范围，已有授权可访问新增邮箱。面板管理会话与邮件 OAuth 令牌分开，不通过模型工具创建或修改邮箱凭据。

## 管理 API

以下路径相对于面板根路径，例如 `/mail-mcp/panel/api/state`：

| 方法 / 路径 | 作用 |
|---|---|
| `POST api/session` | JSON `{apiKey}` 登录；返回 CSRF 值并设置会话 Cookie |
| `GET api/state` | 获取连接设置、脱敏账号列表、端点及 CSRF 值 |
| `DELETE api/session` | 退出登录 |
| `PUT api/connection` | 保存 `{mcpUrl, authType}`，不保存客户端密钥 |
| `POST api/accounts` | 添加或更新面板邮箱；接收 IMAP/SMTP 配置及凭据 |
| `DELETE api/accounts/{id}` | 移除面板邮箱 |
| `PUT api/default` | JSON `{id}` 设置默认账号 |
| `POST api/test` | JSON `{account}` 测试未保存配置，或 `{id}` 测试已有配置 |

除登录外，管理 API 要求独立会话 Cookie；变更请求需同源 `Origin` 和 `X-Panel-CSRF`。API Key Bearer 和邮件 OAuth token 不会被当作面板会话。登录和连接测试另外限流；错误响应不包含供应商原始错误或凭据。完整接口定义见 [panel-openapi.json](api/panel-openapi.json)。
