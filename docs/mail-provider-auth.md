# 邮箱服务商认证

服务器账号认证由独立 AuthService 提供；邮箱服务商授权用于读取和发送该邮箱，二者彼此独立。Google 邮箱授权不是 OpenAI 提供的账号认证。

## Google

管理员在 Google Cloud 项目启用 Gmail API，创建 Web OAuth 客户端。注册精确 HTTPS 回调 `<公开服务地址>/mailbox-oauth/google/callback`，其中公开服务地址包含 `/mail-mcp`。配置服务器根节点 `googleMailbox.clientId` 和 `googleMailbox.clientSecretEnv`，后者指向服务器环境变量；客户端 secret 不放入插件包或 Git。

面板选择 Google，填写内部账号 ID 后跳转 Google 授权。服务验证邮箱地址，使用 state、PKCE S256 和一次性回调，加密保存 refresh token；IMAP 和 SMTP 使用 XOAUTH2。登录后不需要填写 Google 密码。SMTP 默认 587 STARTTLS。

完整邮件权限 `https://mail.google.com/` 属于受限权限。外部应用处于测试模式时，该权限的刷新令牌通常七天失效；切换正式模式也不等于通过 Google 验证。未经验证的个人应用仍有警告和用户数量限制，广泛发布需按 Google 要求申请验证。用户撤销授权、Google 安全策略等仍可能要求重新登录，不承诺永久有效。

依据：[XOAUTH2](https://developers.google.com/workspace/gmail/imap/xoauth2-protocol)、[Web OAuth](https://developers.google.com/identity/protocols/oauth2/web-server)、[令牌生命周期](https://developers.google.com/identity/protocols/oauth2)、[用户数据政策](https://developers.google.com/terms/api-services-user-data-policy)。

## QQ

在 QQ 邮箱设置开启 IMAP/SMTP，生成邮箱授权码，面板选择 QQ 并填写邮箱和授权码。QQ 身份登录不等于邮件读写授权；目前未查到可供本项目接入的公开 QQ 邮件 OAuth 契约，未实现直接 QQ 登录。当前已用真实 QQ 邮箱验证 IMAP、SMTP 认证。

依据：[腾讯 QQ 邮箱接入说明](https://hiflow.tencent.com/document/applications/qq-mail/)。

## iCloud

面板提供 IMAP `imap.mail.me.com:993` TLS 和 SMTP `smtp.mail.me.com:587` STARTTLS。IMAP 用户名通常为邮箱本地部分，SMTP 用户名为完整邮箱；填写 Apple 账号生成的应用专用密码，Apple 账号需要启用双重认证。

Apple 允许获准的第三方应用使用 Apple 账号直接授权邮箱；本项目尚未获得该接入资格，因此未实现 Apple 直接登录。应用专用密码路径已实现，尚未以真实 iCloud 邮箱完成验收。

依据：[邮箱设置](https://support.apple.com/en-us/102525)、[应用专用密码](https://support.apple.com/en-us/102654)、[第三方授权](https://support.apple.com/en-us/121539)、[接入申请](https://developer.apple.com/contact/request/icloud-oauth2/)。
