# Nginx /mail-mcp 部署

使用 Linux、systemd、Nginx 和有效 HTTPS 证书。应用监听 `127.0.0.1:18082`，Nginx 将 `/mail-mcp` 和相关发现路径转发给应用。以下域名与 SSH 别名均为占位符。

认证模块独立部署，见 `auth/README.md`。邮箱发布包只包含邮箱服务。
部署邮箱前须通过独立 Nginx 配置暴露 issuer 和 OAuth 端点。若旧站点通过
`gpt-mail.conf` 间接包含认证路由，先将认证 include 移入 HTTPS server 块，
由认证部署流程维护，再更新邮箱 include。

## 私有部署参数

复制 `server/deploy.env.example` 为 `server/deploy.env`，填写：

```dotenv
MAIL_PUBLIC_ORIGIN=https://mail.example.com
MAIL_NGINX_SITE=/etc/nginx/sites-available/site.conf
MAIL_SSH_HOST=your-ssh-alias
MAIL_AUTH_PROVIDER_CONFIG=/etc/gpt-mail/provider.json
```

`MAIL_PUBLIC_ORIGIN` 是仅含 HTTPS origin 的地址，不带路径，使用 443 端口。`MAIL_NGINX_SITE` 指向已有 HTTPS 站点配置；其中需有与 origin 主机名匹配的 `server_name`，部署脚本向该块添加应用 include。`MAIL_SSH_HOST` 供手动 SSH/scp 使用，部署脚本不自动连接服务器。

真实参数保存在被 Git 忽略的私有文件中。将部署环境文件安全放到服务器后，在执行部署的 shell 中加载：

```bash
set -a
. /path/to/private/deploy.env
set +a
```

脚本要求 `MAIL_PUBLIC_ORIGIN` 和 `MAIL_NGINX_SITE` 已设置，不自带生产地址。

## 发布

服务器需已安装 Python 3、Nginx、systemd、curl，以及 `/usr/local/bin/node`（Node.js 22 或更高版本）。本地执行：

```bash
npm ci
npm run release:server
```

将生成的 `artifacts/` 发布目录通过 SSH/scp 上传到服务器私有暂存目录，使用 root 在已加载部署参数的 shell 中执行：

```bash
bash /path/to/release/deploy.sh /path/to/release
```

发布包仅含运行程序、配置模板和部署脚本，SHA-256 manifest 在安装前校验。脚本安装专用服务用户、systemd 服务和 Nginx include，运行 `nginx -t`、服务健康检查及 HTTPS 发现检查。Nginx 保留原始请求路径，`proxy_pass` 不带会去掉前缀的尾斜杠。

首次安装生成独立的 256 位存储加密密钥，不输出到控制台。升级旧配置时暂停服务、备份配置与邮箱密文，生成新的 storageKey 并重新加密，移除 apiKey；失败时成对回滚。后续部署保留存储密钥和邮箱。所有邮件接口统一使用认证服务令牌。

| 用途 | 占位地址或服务器位置 |
|---|---|
| ChatGPT OAuth MCP | `https://mail.example.com/mail-mcp` |
| MCP 别名 | `https://mail.example.com/mail-mcp/mcp` |
| REST API | `https://mail.example.com/mail-mcp/api/v1` |
| 健康检查 | `https://mail.example.com/mail-mcp/healthz` |
| OIDC issuer | `https://mail.example.com/mailauth` |
| Resource discovery | `https://mail.example.com/.well-known/oauth-protected-resource/mail-mcp` |
| 服务代码 | `/opt/gpt-mail/current/server.cjs` |
| 服务端配置 | `/etc/gpt-mail/config.json`，root:gpt-mail，0640 |
| 邮箱环境变量 | `/etc/gpt-mail/mail.env`，root:gpt-mail，0640 |
| 持久状态 | `/var/lib/gpt-mail`，gpt-mail，0700 |
| systemd | `gpt-mail.service` |
| Nginx include | `/etc/nginx/snippets/gpt-mail.conf`、`gpt-mail-proxy.conf` |

部署设置 `oauth.mcpPath` 和 `oauth.routePrefix` 为 `/mail-mcp`，`http.publicUrl` 使用私有 origin。MCP 资源发现位于 origin 的 `/.well-known/` 下，认证由独立 `/mailauth` Authelia 服务提供。部署前必须准备有效的私有 provider 配置并启动认证服务。

## 接入与邮箱配置

邮箱在插件设置中的 **配置连接与邮箱** 内嵌界面添加、测试和保存，无需修改配置文件或重启。没有网页 panel 或管理 REST API；UI 由 MCP 资源协议返回，Nginx 只转发现有 MCP、OAuth 和邮件 API。为了兼容旧数据，凭据继续加密保存在 `/var/lib/gpt-mail/panel/settings.enc.json`。操作和备份说明见 [插件配置文档](../docs/settings.md)。

ChatGPT 使用表中的 OAuth MCP 地址及预注册公开 clientId，在自己的 Authelia 登录页输入管理员创建的用户名和密码。无需输入或复制服务端 API 密钥。详见 [接入说明](../server/chatgpt.md)。

参考服务器 `/etc/gpt-mail/config.example.json`，在 `/etc/gpt-mail/config.json` 的 `mail.accounts` 填写邮箱地址、IMAP/SMTP 参数及 `passwordEnv`，在 `/etc/gpt-mail/mail.env` 设置相应授权码环境变量。`mail.defaultAccount` 指向实际账号 ID。然后执行：

```bash
systemctl restart gpt-mail.service
systemctl is-active gpt-mail.service nginx
```

使用 `list_accounts` 和 `list_labels` 检查账号与文件夹；发送邮件需明确授权。配置、邮箱授权码及 OAuth 状态不放进发布包或 Git。

## 验证与恢复

```bash
systemctl status gpt-mail.service --no-pager
nginx -t
curl -fsS "${MAIL_PUBLIC_ORIGIN}/mail-mcp/healthz"
```

`deploy/verify.py` 在服务器执行只读检查：验证 HTTPS 资源发现、外部认证服务的 issuer/JWKS、PKCE S256 和刷新授权声明，以及未认证 MCP 请求被拒绝。它不创建账号、不申请授权、不重启服务，也不接触邮箱。输出明确将 ChatGPT 登录、已认证 MCP 调用、实际令牌刷新及真实读信标记为 `not_checked`；这些项目必须另行完成实际验收。旧的 API 密钥授权、动态注册及 `--restart` 验证流程已移除。

版本位于 `/opt/gpt-mail/releases/时间戳`，部署前备份位于 `/var/backups/gpt-mail/时间戳`，仅 root 可读。部署失败自动恢复旧 include 和服务，迁移失败会同时恢复配置和加密邮箱状态。手工回退跨越存储密钥迁移版本时，必须同时恢复对应备份中的 config.json 与 settings.enc.json；发送去重记录保留。将 `/opt/gpt-mail/current` 指向已验证的旧版本，再重启服务。保留 `/var/lib/gpt-mail` 及私有配置，以维持授权和发送去重记录。
