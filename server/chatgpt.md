# ChatGPT 接入

ChatGPT 连接托管 MCP 服务，认证由独立 AuthService 模块提供。用户只在首次连接时填写服务器地址并使用管理员创建的账号登录。完成后宿主保存地址和 OAuth 凭据，自动为 MCP 请求附加访问令牌；邮箱面板无需再次输入地址、密码或 API 密钥。

## 部署配置

认证模块以 `auth/` Git submodule 引入，模块内部维护 Authelia 依赖。使用
`auth/deployment/configuration.example.yml`、`auth/deployment/users.example.yml`
及模块的 systemd/Nginx 模板准备私有配置。账号和授权状态由认证模块维护。
邮箱发布包不携带或安装认证服务器文件。

GptMail 的 `oauth.provider` 填写 `issuer`、`jwksUrl`、`resource`、`clientId` 和 `allowedSubjects`。`resource` 必须等于公开 MCP 完整地址；`allowedSubjects` 必须对应 Authelia 所有者的稳定 subject。部署脚本从私有 `MAIL_AUTH_PROVIDER_CONFIG` 读取这些字段，不在源码中保存生产地址。

可选 `accountNames` 将已允许的 subject 映射到管理员维护的账号显示名称。映射不参与授权，不允许前端覆盖；只通过面板结果 `_meta` 显示，不进入模型可见的账号资料。修改认证账号名称时同步更新此私有映射。

## 在宿主建立连接

1. 添加自定义 MCP 服务器，填写实际服务器 URL，如 `https://mail.example.com/mail-mcp`。
2. 使用 OAuth，配置管理员预先注册的公开客户端 ID，token endpoint authentication method 为 `none`；强制 PKCE S256。
3. 权限使用 `openid offline_access mail.read mail.write`，基础授权范围为 `openid offline_access`。客户端允许的 OIDC 范围包含 `openid profile email offline_access`；宿主重连可能请求 email。
4. Authelia 客户端登记宿主实际使用的精确回调 URI。本次高级配置流程使用 `https://chatgpt.com/connector_platform_oauth_redirect`；不要使用通配符。
5. 提交连接后，在 Authelia 登录并授权。确认 ChatGPT 显示已连接且工具发现成功，不能只以登录页成功作为验收。
6. 进入邮箱应用详情，点击 **打开插件**。邮箱表单、保存及测试见 [面板说明](../docs/settings.md)。

现有应用的 OAuth 配置不会因为上传插件 ZIP 自动改变。插件包通过 `.app.json` 绑定已验证的应用；应检查应用的实际配置、连接及工具发现结果。

## 令牌验证与持久化

访问令牌为 RS256 签名的 `at+jwt`，通过 JWKS 验证。校验 issuer、resource audience、client_id、允许的 subject、时间及权限。Authelia 使用 `scp` 字符串数组表示权限；标准 `scope` 字符串也支持，同时出现两者或结构错误时拒绝。不能用 ID token 代替 access token。

Authelia 管理刷新与撤销；GptMail 不自行签发用户 OAuth 令牌。保留 Authelia 配置、签名密钥、用户 subject 和 SQLite 数据库。面板会话绑定所有者，重新打开可由已保存的 OAuth 连接恢复。

旧 `/mail-mcp/authorize`、`token`、`register` 和密钥登录流程已移除。所有 MCP 和 REST 接口统一使用 Authelia access token；storageKey 只加密邮箱凭据，不用于登录。

## 排查

- 登录成功但 MCP 401：检查实际 access token 的签名、resource audience、client_id、subject 和 `scp` 类型。不要将令牌或私有配置输出到日志。
- 授权回调被拒绝：核对精确 callback URI 和客户端配置。
- 工具发现失败后宿主要求重连：先修复服务端，再使用宿主支持的重新连接或刷新工具流程，确认真实 MCP 请求成功。
- 面板不显示：区分原插件、关联应用详情和应用全局入口；原生设置按钮在当前 hosted UI 可能不显示。不能以存在设置协议替代真实点击验证。
- 无邮箱：在面板添加；缺少邮箱授权码时不得在聊天收集密码。

已在真实 ChatGPT 验证连接、32 项工具发现、打开面板、测试服务及刷新恢复；真实邮件与第二设备尚待验收。
