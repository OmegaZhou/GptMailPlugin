import { createHash, randomBytes } from 'node:crypto';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import { Router } from 'express';
import { z } from 'zod';
import type { SettingsStore } from './settings-store.js';

export const googleMailboxConfigSchema = z.object({
  clientId: z.string().min(1), clientSecretEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
}).strict();
export type GoogleMailboxConfig = z.infer<typeof googleMailboxConfigSchema>;
export type GoogleGrant = { accessToken: string; refreshToken: string; expiresAt: number };
export interface GoogleMailboxGateway {
  authorization(state: string, challenge: string): string;
  exchange(code: string, verifier: string): Promise<GoogleGrant & { email: string }>;
  refresh(grant: GoogleGrant): Promise<GoogleGrant>;
}
const MAIL_SCOPE = 'https://mail.google.com/';
const token = z.string().min(1).max(8192).regex(/^[^\r\n\0]+$/);
const grantSchema = z.object({ accessToken: token, refreshToken: token, expiresAt: z.number().finite().positive() });
export class MailboxOAuthError extends Error {}

export class GoogleMailboxClient implements GoogleMailboxGateway {
  constructor(private config: GoogleMailboxConfig, private callback: string, private secret: string) {}
  private client() {
    const client = new OAuth2Client({ clientId: this.config.clientId, clientSecret: this.secret, redirectUri: this.callback });
    client.transporter.defaults = { ...client.transporter.defaults, timeout: 15000, retry: false };
    return client;
  }
  authorization(state: string, challenge: string) {
    return this.client().generateAuthUrl({ scope: [MAIL_SCOPE], access_type: 'offline', prompt: 'consent select_account',
      state, code_challenge: challenge, code_challenge_method: CodeChallengeMethod.S256 });
  }
  async exchange(code: string, verifier: string) {
    try {
      const client = this.client();
      const { tokens } = await client.getToken({ code, codeVerifier: verifier });
      if (!tokens.scope?.split(' ').includes(MAIL_SCOPE)) throw new Error('Missing mailbox scope');
      const grant = grantSchema.parse({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: tokens.expiry_date });
      client.setCredentials(tokens);
      const profile = await client.request<{ emailAddress: string }>({ url: 'https://gmail.googleapis.com/gmail/v1/users/me/profile' });
      return { ...grant, email: z.email().parse(profile.data.emailAddress) };
    } catch { throw new MailboxOAuthError('Google 邮箱授权未完成。请检查 Gmail API、OAuth 客户端、回调地址和邮箱权限，然后重新连接。'); }
  }
  async refresh(grant: GoogleGrant) {
    try {
      const client = this.client();
      client.setCredentials({ access_token: grant.accessToken, refresh_token: grant.refreshToken, expiry_date: grant.expiresAt });
      const result = await client.getAccessToken();
      return grantSchema.parse({ accessToken: result.token, refreshToken: client.credentials.refresh_token || grant.refreshToken,
        expiresAt: client.credentials.expiry_date });
    } catch { throw new MailboxOAuthError('Google 邮箱授权已失效，请在邮箱面板重新连接 Google。'); }
  }
}

// A flow can only be started by an authenticated, write-authorized MCP App session.
// Callback state and PKCE are one-use; no ChatGPT bearer token is put in a URL.
export class MailboxOAuth {
  private flows = new Map<string, { id: string; name?: string; verifier: string; expires: number }>();
  constructor(private store: SettingsStore, readonly gateway?: GoogleMailboxGateway, private now = Date.now) {}
  available() { return Boolean(this.gateway); }
  async begin(id: string, name?: string) {
    if (!this.gateway) throw new MailboxOAuthError('管理员尚未配置 Google OAuth 客户端。QQ 和 iCloud 可使用邮箱授权码或应用专用密码。');
    for (const [key, flow] of this.flows) if (flow.expires <= this.now()) this.flows.delete(key);
    if (this.flows.size >= 100) throw new MailboxOAuthError('授权请求过多，请稍后再试。');
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url');
    this.flows.set(createHash('sha256').update(state).digest('hex'), { id, name, verifier, expires: this.now() + 600000 });
    return { url: this.gateway.authorization(state, createHash('sha256').update(verifier).digest('base64url')) };
  }
  async complete(state: string, code?: string, denied = false) {
    const key = createHash('sha256').update(state).digest('hex'), flow = this.flows.get(key);
    this.flows.delete(key);
    if (!flow || flow.expires <= this.now() || !this.gateway) throw new MailboxOAuthError('邮箱授权已过期或已使用，请从插件面板重新发起。');
    if (denied || !code) throw new MailboxOAuthError('已取消 Google 邮箱授权，原邮箱配置没有改变。');
    const grant = await this.gateway.exchange(code, flow.verifier);
    await this.store.saveGoogleAccount(flow.id, grant.email, grant, flow.name);
  }
}

export function mailboxOAuthRouter(oauth: MailboxOAuth, callbackPath: string) {
  const router = Router();
  router.get(callbackPath, async (req, res) => {
    let message = '邮箱已连接。请返回 ChatGPT 插件面板，点击“刷新邮箱列表”。';
    let status = 200;
    try {
      const state = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(req.query.state);
      const code = req.query.code === undefined ? undefined : z.string().min(1).max(8192).parse(req.query.code);
      await oauth.complete(state, code, req.query.error !== undefined);
    } catch (error) {
      status = 400;
      message = error instanceof MailboxOAuthError ? error.message : '邮箱授权请求无效，请从插件面板重新发起。';
    }
    // Only an authentication completion page, never a mailbox-management website.
    const safe = message.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
    res.status(status).set({ 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'Referrer-Policy': 'no-referrer' }).type('html').send(`<!doctype html><html lang="zh-CN"><meta name="viewport" content="width=device-width,initial-scale=1"><title>邮箱授权结果</title><style>body{font:16px system-ui;max-width:36rem;margin:15vh auto;padding:24px;line-height:1.8}</style><h1>${status === 200 ? '邮箱已连接' : '授权未完成'}</h1><p>${safe}</p><p>可以关闭此窗口，返回原插件面板。</p></html>`);
  });
  return router;
}
