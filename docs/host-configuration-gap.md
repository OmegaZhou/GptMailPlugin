# 宿主连接配置能力核查（2026-10-11）

## 必须满足的边界

用户要求 MCP 地址和认证密钥由插件/宿主维护，不通过目标邮件服务接口保存或恢复；跨端持久化，服务离线时仍可进入配置，修改后实际改变后续工具请求。不得用浏览器本地存储、导出文件或固定中转服务替代。

## 已确认的公开契约

- 官方认证文档明确：ChatGPT 不能向 MCP 服务提供自定义 API Key；受保护连接使用 OAuth。来源：<https://developers.openai.com/plugins/build/auth#client-identification>。
- UI 由 MCP 服务提供资源；跨会话持久化依赖开发者控制的存储，widget state 只是组件状态机制，不是跨端凭据保险库。来源：<https://developers.openai.com/plugins/build/chatgpt-ui#manage-state>。
- 官方插件迁移说明将持久设置放在托管服务并关联认证用户，没有提供插件自带跨端配置存储。来源：<https://developers.openai.com/plugins/guides/submit-claude-plugin#replace-claude-userconfig>。
- 安装的 `@openai/mcp-extensions` 0.1.0 的 `OpenAISettingsRegistration` 是服务器 read/update 回调契约，SDK 不提供存储；设置面板不是宿主 MCP 地址/认证配置 API。
- 安装的 MCP Apps SDK 1.7.5 的 `App.callServerTool` 接收工具参数和请求选项，没有修改宿主 MCP URL 或认证头的接口。未找到插件可调用的宿主跨端 secret store。

## 结论范围

### 认证角色纠正及线上核查

2026-10-11 通过线上 OAuth metadata 与只读 tools/list 检查确认：issuer、authorization_endpoint 和 token_endpoint 均位于用户现有服务；不是 OpenAI 作为授权服务器。ChatGPT 是 OAuth 客户端。官方明确支持自有授权服务器：<https://developers.openai.com/plugins/build/auth#custom-auth-with-oauth-21>。

该次早期核查之后，线上已部署外部认证版本：删除 `settings_login`，使用 `settings_bootstrap` 恢复已认证面板。Authelia 维护账号和令牌；GptMail 校验令牌。原应用仍缓存旧授权地址和 scopes，重新连接尚未成功。不能归因为 ChatGPT 不支持持久 OAuth，也不能把外部登录页成功当成插件连接成功。

必须分别判断：已知服务地址上的首次认证、令牌续期、面板会话恢复可以实现；自定义面板修改宿主连接 URL 和任意 secret store 的能力仍未证实。后者不构成前者不能开发的理由。原先将这些能力一并标为受阻的结论过宽。

现有公开文档与 SDK 尚不能支持用户要求的完整宿主侧配置流程。这里不声称 OpenAI 内部绝无该能力，但不能把 Gmail 内置连接器权限推断为自定义插件也拥有同样接口。需要可访问且受支持的宿主能力，才能继续这一实现方向。

## 当前实现状态

- `settings_bootstrap`、服务端 `connection` 存储和导出按钮均不能解决上述宿主配置能力缺口。
- 外部认证服务和邮件服务均已部署、运行。只读线上验证通过资源发现、issuer/JWKS 一致性及未认证 MCP 拒绝访问；已认证调用、实际刷新、ChatGPT 面板和真实邮箱均未因此验收。
- 不发布上述实验代码作为已满足目标的版本，不把构建/测试结果当成面板和跨端验收。
- 既有源码和线上插件保留，目标未完成。缺口解决前不得再次承诺已实现插件侧配置持久化或真实地址切换。

## 早期阻碍记录（下方联调进展已部分替代）

- 原插件发布仍为 0.4.3，绑定原 `asdk_app`。实际管理页仅提供应用名称、描述编辑、刷新工具及删除；没有可编辑的 URL、issuer、授权端点或 scopes。当前仍显示“无法加载或保存设置”。刷新工具此前返回 404，未修复授权配置。
- Plugin Creator 可编辑独立插件包，但原 `.app.json` 只有已注册应用引用；修改包内连接生成器不等于修改该注册。App-backed 插件的档案更新契约要求保留连接配置，当前可用连接管理工具也没有 OAuth 配置更新接口。
- 已核查的官方文档与 SDK 没有提供自定义面板写入宿主 MCP 地址并跨端持久化的接口；官方将普通持久偏好交给托管服务，不满足“首次未知道服务器地址时配置入口仍可工作”的引导要求。这里只说明当前可用接口的证据边界，不推断内部 Gmail 实现。
- 继续需要宿主提供受支持的原应用 OAuth 配置更新入口，以及插件调用的服务器连接配置/持久化契约。重新注册连接最多可能解除旧 OAuth 缓存，不能据此宣布满足用户可配置服务器的要求。
- 不能通过硬编码中转服务、恢复旧密钥授权分支、手工访问授权 URL 或重复上传无效包来规避这些条件。当前工作受阻，完整目标未完成。

## 后续实际联调进展

- 用户要求继续负责解决后，通过 ChatGPT「添加自定义 MCP 服务器 → 高级 OAuth 设置」创建正确的连接注册：`<registered-app-id>`。原插件及原绑定尚未修改；新连接工作正常后再更新原插件的依赖引用。
- 新注册自动发现 Authelia 端点；指定已有 public client、基础 openid/offline_access 和 mail.read/mail.write。新增精确回调 `/connector_platform_oauth_redirect` 到认证服务器白名单，已验证配置并重启；初始化脚本同步修复。
- 在当前内置浏览器通过按钮完成账号登录、同意及自动返回 ChatGPT。首次显示 `Authentication succeeded, action discovery failed`，不是旧授权地址 404。
- 重复连接的实际回调响应为 HTTP 409 `OAUTH_ACCOUNT_ALREADY_CONNECTED`。刷新页面后可见已连接账号，但状态为 `REAUTH_REQUIRED` / `ACTION_AUTH_ISSUE`，actions 为空。不得继续重复创建授权。
- Authelia 只读数据库核验：grant 的 subject/client 与服务端预期匹配，scopes 正确，granted_resource 匹配 MCP 资源；尚未完成实际 access token 的 MCP 调用核验。不能仅由 granted_audience 为空推断 JWT 的 aud 不正确。
- 线上加入仅输出固定错误分类、MCP 方法白名单和 HTTP 状态的诊断；不记录令牌、地址或 claims。当前后续重复授权并未产生新的 MCP 发现请求。下一步是恢复现有新连接的工具发现并定位第一次 ACTION_AUTH_ISSUE，而非要求用户自行排查。

## 工具发现失败根因已定位并修复

- 通过独立 PKCE 诊断授权取得实际 Authelia access token，仅在私有文件和服务端使用。实际 JWT 使用 `scp: string[]`，之前校验器仅支持 `scope: string`，因此错误拒绝有效访问令牌。
- 校验器现支持 Authelia 的 `scp` 数组，严格拒绝非字符串元素、含空白的 scope 项及同时提供两种 scope claim 的歧义令牌。签名、issuer、audience、client、subject 和有效期限制不变，针对性测试通过。
- 已部署修复；同一枚实际令牌从 HTTP 401 恢复 HTTP 200，`tools/list` 返回 32 个工具，含 `open_settings`。这证明服务端互操作已修复，不等于 ChatGPT 面板验收通过。
- 独立诊断 refresh/access token 已通过 Authelia 撤销接口撤销；临时诊断 callback 已从白名单移除，未撤销用户的 ChatGPT 授权。
- 原插件已发布 0.5.0，release `<plugin-release-id>`；插件 ID 保持原值，`.app.json` 已回读确认指向新注册。ChatGPT 中第一次失败的连接尚未恢复工具发现，面板和真实邮箱仍待验收。
