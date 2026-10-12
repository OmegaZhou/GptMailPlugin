# 插件内邮箱管理

先安装或关联固定云端邮箱服务并登录独立 AuthService；ChatGPT 保存 OAuth 连接。多端技能 ZIP 引用这项服务，引用本身不创建服务或自动授权。服务器地址无需填写，面板只读显示已连接地址。

从服务详情“打开插件”或正式插件“网站”进入 ChatGPT 的内嵌面板。宿主原生设置组目前可能只显示标题，没有按钮；直接链接和 open_settings 工具提供入口。

## 添加与管理

Google：填写内部账号 ID、可选显示名称，点击登录 Google，在官方页授权；邮箱地址由 Google 确认，无需填写密码或 token。返回面板刷新列表，服务加密保存刷新令牌并自动续期。Gmail SMTP 使用 587 STARTTLS；Gmail 自动保存 Sent，不再重复追加副本。

QQ：在 QQ 邮箱启用 IMAP/SMTP 并生成授权码，选择 QQ 预设（SMTP 587 STARTTLS），填写邮箱及授权码；不使用 QQ 主账号密码。iCloud：使用 Apple 账号生成的应用专用密码，选择 iCloud 预设；IMAP 用户名可用邮箱本地部分，SMTP 使用完整邮箱。

测试连接只认证收件与发件，不发送邮件。保存立即生效；可添加多个、编辑、测试、设置默认、移除连接。Google 账号通过重新连接更新授权。移除连接不删除真实邮件，亦不代替邮箱服务商的授权撤销。编辑凭据不回显；留空保留旧值，连接身份变化需重新填写。

QQ/iCloud 直接服务商 OAuth 登录未实现：QQ 没有查到可供本项目使用的公开邮件 OAuth 契约；Apple 支持获准第三方的直接授权，但 GptMail 尚未获得接入资格。当前使用上述官方密码方式，不把身份登录等同于邮箱授权。

## 保存和隔离

SettingsStore 使用 AES-256-GCM 保存于 MAIL_STATE_DIR/panel/settings.enc.json；panel 是历史磁盘目录名，没有 HTTP panel。App 表单经宿主桥接调用 settings_* 私有工具，会话和凭据只在组件内存及 _meta；模型不参与填写凭据。服务器重启保留配置；面板管理会话失效后通过已保存 OAuth 自动恢复。

settings_google_begin 发起一次性 state + PKCE S256。认证结果 callback 是短暂的状态说明页，不是服务端管理面板。Google client secret 只在服务器环境文件，绝不进入 Git 或 ZIP。

## 状态

2026-10-13 实际网页安装、AuthService 登录、面板恢复、Google 授权回调保存、QQ 收发连接测试通过。Gmail 和 QQ 均通过实际 IMAP、SMTP 认证；Gmail 使用 587 STARTTLS。Gmail 访问令牌过期后刷新成功，服务重启后仍能读取两个邮箱的文件夹。Google 项目已切换正式模式，尚未通过 Google 验证；新的正式授权仍需完成。各端最终验收、原包发布和测试清理仍在进行，见 [当前目标](acceptance-goal.md)。
