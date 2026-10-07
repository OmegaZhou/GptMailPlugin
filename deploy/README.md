# Nginx /mail-mcp 部署

使用 Linux、systemd、Nginx 和有效 HTTPS 证书。应用监听 `127.0.0.1:18082`，Nginx 将 `/mail-mcp` 和相关发现路径转发给应用。以下域名与 SSH 别名均为占位符。

## 私有部署参数

复制 `server/deploy.env.example` 为 `server/deploy.env`，填写：

```dotenv
MAIL_PUBLIC_ORIGIN=https://mail.example.com
MAIL_NGINX_SITE=/etc/nginx/sites-available/site.conf
MAIL_SSH_HOST=your-ssh-alias
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

首次安装生成 256 位随机服务端密钥，不输出到控制台。后续部署保留已有密钥与邮箱账号。初始 `mail.accounts:[]` 可先启用 OAuth 接入，邮箱工具在添加账号前返回未配置错误。

| 用途 | 占位地址或服务器位置 |
|---|---|
| ChatGPT OAuth MCP / issuer | `https://mail.example.com/mail-mcp` |
| API Key MCP | `https://mail.example.com/mail-mcp/mcp` |
| REST API | `https://mail.example.com/mail-mcp/api/v1` |
| 健康检查 | `https://mail.example.com/mail-mcp/healthz` |
| 邮箱与连接面板 | `https://mail.example.com/mail-mcp/panel/` |
| OAuth discovery | `https://mail.example.com/.well-known/oauth-authorization-server/mail-mcp` |
| Resource discovery | `https://mail.example.com/.well-known/oauth-protected-resource/mail-mcp` |
| 服务代码 | `/opt/gpt-mail/current/server.cjs` |
| 服务端配置 | `/etc/gpt-mail/config.json`，root:gpt-mail，0640 |
| 邮箱环境变量 | `/etc/gpt-mail/mail.env`，root:gpt-mail，0640 |
| 持久状态 | `/var/lib/gpt-mail`，gpt-mail，0700 |
| systemd | `gpt-mail.service` |
| Nginx include | `/etc/nginx/snippets/gpt-mail.conf`、`gpt-mail-proxy.conf` |

部署设置 `oauth.mcpPath` 和 `oauth.routePrefix` 为 `/mail-mcp`，`http.publicUrl` 使用私有 origin。授权、注册、换码、刷新及撤销位于前缀下，发现路径放在 origin 的 `/.well-known/` 下。

## 接入与邮箱配置

可以直接打开 `/mail-mcp/panel/`，使用服务端密钥登录后添加、测试和保存邮箱。面板账号无需修改配置文件或重启服务，凭据加密保存在 `/var/lib/gpt-mail/panel/settings.enc.json`。面板静态资源已嵌入单文件运行包，现有 `/mail-mcp/` Nginx 转发规则覆盖面板及管理 API，无需增加公网端口。操作、凭据迁移和备份说明见 [面板文档](../server/panel.md)。

ChatGPT 使用表中的 OAuth MCP 地址，选择 OAuth/动态客户端注册，在自己的服务器授权页输入服务端 `apiKey`。Windows 可手动运行以下脚本把密钥复制到剪贴板，脚本不在控制台打印密钥：

```powershell
pwsh -NoProfile -File deploy/copy-login-key.ps1 -SshHost your-ssh-alias
```

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

`deploy/verify.py` 在服务器验证 HTTPS 发现、注册、PKCE、OAuth、MCP 和刷新/撤销，仅调用只读账号工具，并在结束时撤销验证授权。手动使用 `--restart` 可额外检查重启恢复；该选项会重启服务。

版本位于 `/opt/gpt-mail/releases/时间戳`，部署前备份位于 `/var/backups/gpt-mail/时间戳`，仅 root 可读。部署失败自动恢复旧 include 和服务，持久状态不回滚。手工回退时将 `/opt/gpt-mail/current` 指向已验证的旧版本，再重启服务。保留 `/var/lib/gpt-mail` 及私有配置，以维持授权和发送去重记录。
