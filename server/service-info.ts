import { Router } from 'express';

// Public service disclosures contain no account data or management controls.
export function serviceInfoRouter(prefix: string) {
  const router = Router();
  const pages: Record<string, [string, string]> = {
    '/about': ['GptMail', 'GptMail 是个人托管邮箱服务。通过 ChatGPT 插件使用邮件查询、阅读、草稿、发送及整理功能；配置只在已授权的插件内面板进行。'],
    '/privacy': ['GptMail 隐私说明', '服务仅按已授权用户的请求访问其邮箱。Google 邮件数据用于展示、查询、收发与整理邮件，不用于广告、出售或训练模型。邮箱凭据和刷新令牌加密保存在服务端，不返回聊天模型；用户请求的邮件内容可能传给其使用的 ChatGPT 服务。断开连接可停止插件访问；Google 账号的第三方连接页面可撤销 Google 授权。在插件面板移除邮箱会删除本服务保存的邮箱连接和凭据，邮箱原有邮件保留。服务器日志不记录密码或令牌。私人服务由部署管理员维护，可通过管理员处理服务数据删除；备份按管理员的保留策略清理。GptMail 对 Google API 数据的使用遵守 Google API Services User Data Policy，包括 Limited Use 要求。'],
    '/terms': ['GptMail 使用说明', '本服务用于部署管理员及其明确授权的账号。使用者仅连接自己有权使用的邮箱；发送、移动或删除操作应由使用者明确请求。SMTP 接收不保证最终送达；邮件服务商或平台故障可能影响服务。可在 ChatGPT 断开连接，并在邮箱服务商撤销授权。'],
  };
  for (const [path, [title, body]] of Object.entries(pages)) router.get(prefix + path, (_req, res) => {
    res.set({ 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'", 'Referrer-Policy': 'no-referrer' })
      .type('html').send(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font:16px system-ui;max-width:42rem;margin:10vh auto;padding:24px;line-height:1.9}</style><h1>${title}</h1><p>${body}</p></html>`);
  });
  return router;
}
