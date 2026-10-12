# ChatGPT 接入

多端交付使用固定托管云端邮箱服务，加引用该服务的技能 ZIP。个人 ZIP 内声明 MCP（即使远程 HTTPS）会被 ChatGPT 标为仅桌面端，不能用于多端交付。用户已允许因此放宽单 ZIP 安装。

## 管理员部署

认证模块以 `auth/` Git submodule 引入，独立维护认证库、账号及 SMTP 登录。邮箱业务只依赖认证令牌契约，不读取 Authelia 用户库，不接收固定 API 密钥。

GptMail 的 `oauth.provider` 配置 issuer、jwksUrl、resource、clientId、allowedSubjects。resource 必须等于公开 MCP 完整地址；allowedSubjects 是独立认证服务的稳定用户标识。可选 accountNames 仅用于面板显示，不能改变鉴权。

登记公开 OAuth 客户端，token endpoint authentication 为 none，强制 PKCE S256；允许 openid、offline_access、mail.read、mail.write，以及宿主需要的 email/profile。ChatGPT 当前回调是 `https://chatgpt.com/connector_platform_oauth_redirect`，精确登记，不用通配符。认证 issuer 路由和邮箱 `/mail-mcp` 分别由独立 Nginx include 维护。

在 ChatGPT 登记云端 MCP 服务的固定地址和 OAuth。把已验证的应用 ID 写入被忽略的 config/app-binding.json；公开 Git 只提交模板。

```bash
npm run configure:plugin
npm run package -- --hosted-app config/app-binding.json
```

## 使用者安装

1. 导入私有 ZIP。
2. 安装或关联其声明的云端邮箱服务；若宿主没有自动安装依赖，从服务插件页安装。ZIP 不创建服务注册。
3. 登录 AuthService 并授权。当前部署使用邮件临时密码，后续 OAuth 连接由 ChatGPT 保存。
4. 服务详情的“打开插件”或正式包的“网站”链接进入 ChatGPT 内嵌邮箱面板。当前原生设置组可能只显示标题；不能把它声明为原生按钮已可用。
5. 添加 Google（官方登录）、QQ（授权码）或 iCloud（应用专用密码）。无需再次登录服务器。

服务器地址保存在 ChatGPT 云端服务注册中。面板中的只读地址只是当前连接信息，不参与请求路由。不支持在面板任意切换服务器。管理员更换固定服务时更新注册及私有引用配置。

## 令牌和恢复

访问令牌为 RS256 at+jwt；验证 JWKS 签名、issuer、resource audience、client_id、subject、时间和权限。兼容标准 scope 字符串或 scp 字符串数组，歧义或无效结构拒绝。ID token 不可当 access token。

AuthService 管理服务器授权的刷新和撤销；GptMail 不签发这些令牌。面板自动 bootstrap 短期管理会话，会话过期可从已有连接恢复。邮箱凭据与 Google refresh token 另行加密持久化；Google 访问令牌自动刷新。服务器重启不删除邮箱。

所有邮件 MCP/REST 入口都要求认证令牌。storageKey 只加密磁盘凭据。没有服务端 panel 或配置 REST；公开 about/privacy/terms 是静态说明，Google callback 是认证结果页。

## 排查与验收

登录成功但 MCP 401：检查签名、resource、client_id、subject 及 scopes。授权路由 404：检查独立认证 Nginx include。工具或面板资源变更后使用宿主“刷新工具”；面板资源 URI 随 HTML 内容摘要改变，避免旧资源缓存。不要输出凭据或令牌。

实际验收和未验证项见 [当前目标](../docs/acceptance-goal.md)。网页、桌面、移动端的实际证据分别记录，不用窄屏浏览器测试冒充原生手机测试。

依据：[个人 MCP ZIP 的桌面限制](https://learn.chatgpt.com/docs/enterprise/plugin-management)、[插件多端使用](https://learn.chatgpt.com/docs/plugins)、[自有 OAuth 认证](https://developers.openai.com/plugins/build/auth#custom-auth-with-oauth-21)。
