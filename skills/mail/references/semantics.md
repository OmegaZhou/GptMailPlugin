# 与 Gmail 的能力映射

| Gmail 插件能力 | GptMail 实现 |
|---|---|
| Profile | get_profile、list_accounts |
| 邮件搜索 / ID 搜索 | search_emails、search_email_ids；单文件夹、部分查询语法 |
| 邮件读取 / 批量读取 | read_email、batch_read_email |
| 会话读取 / 批量读取 | read_email_thread、batch_read_email_threads；同文件夹、有界 References 匹配 |
| 附件读取 | read_attachment；base64url 原始字节，最多 5 MiB；不做 PDF/Office 提取 |
| 草稿创建 / 列表 / 修改 / 发送 | create_draft、list_drafts、update_draft、send_draft；保存在 IMAP Drafts |
| 发送 / 回复 / 转发 | send_email（reply_message_id 回复）、forward_emails |
| 标签及计数 / 创建标签 | list_labels、create_label；对应文件夹及 STATUS 计数 |
| 已读 / 星标 | batch_modify_email；IMAP flags |
| 归档 / 删除 | archive_emails、delete_emails；移动到 Archive/Trash |
| Gmail 多标签 / 无限量批量打标签 | 不伪装成通用能力；可移动文件夹，每次最多 100 封 |

搜索按 UID 倒序，通常近似最近收件顺序，并非保证按邮件 Date 头排序。日期条件按 IMAP 日期精度（天）处理。after 是 inclusive SINCE，不完全等同于 Gmail after。搜索分页 cursor 绑定账号/文件夹/查询/UIDVALIDITY，新到邮件不会挤进后续页；搜索结果仍会因删信等外部变化而变化。

服务器返回 total_matching 是当前单文件夹搜索的数量，不能当作全邮箱计数。所有读取工具只读打开文件夹并使用 PEEK。

所有 MCP 与 REST 入口使用认证服务签发的 `Authorization: Bearer <access_token>`，校验读取/写入权限。不直连本机邮箱。storageKey 只用于邮箱凭据的磁盘加密，不是客户端凭据。
