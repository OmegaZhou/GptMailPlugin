import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import express, { type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { OAuthClientInformationFullSchema } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidScopeError, InvalidTargetError, InvalidTokenError, ServerError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { z } from 'zod';

export const mailScopes = ['mail.read', 'mail.write'];
const mcpPathSchema = z.string().max(200).regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/)
  .refine(path => !['/mcp', '/healthz'].includes(path) && !['/authorize', '/token', '/register', '/revoke', '/oauth', '/api/v1/tools'].some(reserved => path === reserved || path.startsWith(reserved + '/')), 'OAuth MCP path conflicts with an existing endpoint');
export const oauthConfigSchema = z.object({
  enabled: z.boolean().default(false),
  mcpPath: mcpPathSchema.optional(),
  routePrefix: z.union([z.literal(''), z.string().max(200).regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/)]).optional(),
  redirectOrigins: z.array(z.url()).min(1).max(20).default(['https://chatgpt.com', 'https://chat.openai.com']),
}).strict();
const opaque = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const keyMatches = (value: string, key: string) => value.length <= 512 && timingSafeEqual(Buffer.from(hash(value), 'hex'), Buffer.from(hash(key), 'hex'));
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const grantSchema = z.object({ clientId: z.string(), scopes: z.array(z.enum(['mail.read', 'mail.write'])), family: z.string(), expires: z.number(), used: z.boolean().optional() });
const stateSchema = z.object({ version: z.literal(1), binding: z.string(), clients: z.record(z.string(), OAuthClientInformationFullSchema), access: z.record(z.string().regex(/^[a-f0-9]{64}$/), grantSchema), refresh: z.record(z.string().regex(/^[a-f0-9]{64}$/), grantSchema) });
type State = z.infer<typeof stateSchema>;
type Grant = z.infer<typeof grantSchema>;
type Pending = { client: OAuthClientInformationFull; params: AuthorizationParams; scopes: string[]; expires: number };

// Single-owner OAuth bridge. Only token hashes are persisted; the configured API key is never issued as a token.
// One process must own this state directory. Use an external OAuth provider/shared transactional store to scale out.
export class MailOAuthProvider implements OAuthServerProvider {
  private state!: State;
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Pending>();
  readonly resource: URL;
  readonly consentPath: string;
  // SDK's local check does not enforce RFC 7636 verifier length; validate both syntax and S256 below.
  readonly skipLocalPkceValidation = true;
  readonly clientsStore = {
    getClient: (id: string): OAuthClientInformationFull | undefined => Object.hasOwn(this.state.clients, id) ? this.state.clients[id] : undefined,
    registerClient: async (client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): Promise<OAuthClientInformationFull> => {
      if (Buffer.byteLength(JSON.stringify(client)) > 16384 || !['none', 'client_secret_post'].includes(client.token_endpoint_auth_method || 'client_secret_post') ||
        client.grant_types?.some(type => !['authorization_code', 'refresh_token'].includes(type)) || client.response_types?.some(type => type !== 'code')) throw new InvalidClientMetadataError('Unsupported or oversized client metadata.');
      if (!client.redirect_uris.length || client.redirect_uris.length > 10) throw new InvalidClientMetadataError('Supply 1–10 redirect URIs.');
      for (const uri of client.redirect_uris) {
        let url: URL; try { url = new URL(uri); } catch { throw new InvalidClientMetadataError('Invalid redirect URI.'); }
        if (url.username || url.password || url.hash || !this.redirectOrigins.includes(url.origin) ||
          (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)))) {
          throw new InvalidClientMetadataError('Redirect origin is not configured.');
        }
      }
      if (client.scope) this.validateScopes(client.scope.split(' '));
      const info = { ...client, client_id: (client as OAuthClientInformationFull).client_id || randomUUID(), client_id_issued_at: this.now() };
      return this.transaction(() => {
        if (Object.keys(this.state.clients).length >= 1000) throw new InvalidClientMetadataError('Client limit reached.');
        this.state.clients[info.client_id] = info; return info;
      });
    },
  };
  constructor(readonly issuer: URL, private apiKey: string, private redirectOrigins: string[],
    private directory = join(process.env.MAIL_STATE_DIR || join(homedir(), '.config', 'gpt-mail', 'state'), 'oauth'),
    private now = () => Math.floor(Date.now() / 1000), mcpPath = '/chatgpt/mcp', routePrefix = '') {
    this.resource = new URL(mcpPathSchema.parse(mcpPath), issuer);
    this.consentPath = `${routePrefix}/oauth/approve`;
    for (const origin of redirectOrigins) {
      const url = new URL(origin);
      if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('OAuth redirectOrigins must be HTTPS origins (HTTP only on loopback).');
    }
  }
  async init() {
    const binding = hash(this.apiKey + '\0' + this.resource.href + '\0' + this.issuer.href);
    try { this.state = stateSchema.parse(JSON.parse(await readFile(join(this.directory, 'state.json'), 'utf8'))); }
    catch (error: any) {
      if (error.code !== 'ENOENT') throw new Error('Unable to read OAuth state. Refusing to reset existing grants.');
      this.state = { version: 1, binding, clients: {}, access: {}, refresh: {} };
    }
    // Key rotation or issuer changes invalidate every grant, but keep registered client IDs/secrets stable.
    if (this.state.binding !== binding) { this.state.binding = binding; this.state.access = {}; this.state.refresh = {}; }
    await this.transaction(() => {});
    return this;
  }
  private async transaction<T>(fn: () => T): Promise<T> {
    const operation = this.queue.then(async () => {
      const before = structuredClone(this.state);
      try {
        for (const table of [this.state.access, this.state.refresh]) for (const [id, grant] of Object.entries(table)) if (grant.expires <= this.now()) delete table[id];
        const result = fn();
        await mkdir(this.directory, { recursive: true, mode: 0o700 });
        const temp = join(this.directory, randomUUID() + '.tmp');
        await writeFile(temp, JSON.stringify(this.state), { mode: 0o600 });
        await rename(temp, join(this.directory, 'state.json'));
        return result;
      } catch (error) { this.state = before; throw error; }
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  private validateScopes(scopes: string[]) {
    if (!scopes.length || scopes.some(scope => !mailScopes.includes(scope))) throw new InvalidScopeError('Supported scopes: mail.read mail.write.');
  }
  private validateResource(resource?: URL) {
    if (!resource || resource.href !== this.resource.href) throw new InvalidTargetError('Supply the exact ChatGPT MCP resource URL.');
  }
  private prunePending() {
    for (const map of [this.pending, this.codes]) for (const [id, p] of map) if (p.expires <= this.now()) map.delete(id);
  }
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response) {
    this.validateResource(params.resource);
    if (!this.redirectOrigins.includes(new URL(params.redirectUri).origin)) throw new InvalidClientMetadataError('Redirect origin is no longer configured.');
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge)) throw new InvalidGrantError('Supply a PKCE S256 challenge.');
    const scopes = [...new Set(params.scopes?.length ? params.scopes : mailScopes)]; this.validateScopes(scopes);
    this.prunePending();
    if (this.pending.size + this.codes.size >= 1000) throw new ServerError('Too many pending authorizations.');
    const nonce = opaque(); this.pending.set(nonce, { client, params, scopes, expires: this.now() + 300 });
    res.cookie('gpt_mail_consent', nonce, { httpOnly: true, sameSite: 'strict', secure: this.issuer.protocol === 'https:', path: this.consentPath, maxAge: 300000 });
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.type('html').send(`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>GptMail 授权</title><h1>连接 GptMail 邮箱</h1><p>应用：${escape(client.client_name || 'MCP 客户端')}</p><p>回调地址：${escape(params.redirectUri)}</p><p>权限：${escape(scopes.join(', '))}。授权范围包含服务端配置的全部邮箱账号。</p><p>仅在你自己的服务器域名下输入服务端 API 密钥；不要把密钥发到聊天窗口。</p><form method="post" action="${escape(this.consentPath)}"><input type="hidden" name="nonce" value="${nonce}"><label>服务端 API 密钥 <input type="password" name="apiKey" autocomplete="off" required maxlength="512"></label><p><button name="decision" value="approve">验证并授权</button> <button name="decision" value="deny" formnovalidate>取消</button></p></form></html>`);
  }
  consentRouter() {
    const router = express.Router();
    router.post(this.consentPath, rateLimit({ windowMs: 60000, limit: 10, standardHeaders: true, legacyHeaders: false }), express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
      const nonce = typeof req.body?.nonce === 'string' ? req.body.nonce : '';
      const cookie = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith('gpt_mail_consent='))?.slice('gpt_mail_consent='.length);
      const p = this.pending.get(nonce);
      if (!p || p.expires <= this.now() || nonce !== cookie || req.headers.origin !== this.issuer.origin) { res.status(403).send('授权已失效或请求来源不符，请重新连接。'); return; }
      if (req.body.decision !== 'deny' && (req.body.decision !== 'approve' || typeof req.body.apiKey !== 'string' || !keyMatches(req.body.apiKey, this.apiKey))) { res.status(403).send('密钥错误，请返回重新输入。'); return; }
      this.pending.delete(nonce); res.clearCookie('gpt_mail_consent', { path: this.consentPath });
      const redirect = new URL(p.params.redirectUri);
      if (p.params.state !== undefined) redirect.searchParams.set('state', p.params.state);
      if (req.body.decision === 'deny') redirect.searchParams.set('error', 'access_denied');
      else { const code = opaque(); this.codes.set(hash(code), p); redirect.searchParams.set('code', code); }
      res.redirect(303, redirect.href);
    });
    return router;
  }
  private code(client: OAuthClientInformationFull, code: string) {
    const p = this.codes.get(hash(code));
    if (!p || p.expires <= this.now() || p.client.client_id !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code.');
    return p;
  }
  async challengeForAuthorizationCode(client: OAuthClientInformationFull, code: string) { return this.code(client, code).params.codeChallenge; }
  private issue(clientId: string, scopes: string[], family = opaque(), refreshExpiry = this.now() + 30 * 86400): OAuthTokens {
    if (Object.keys(this.state.access).length + Object.keys(this.state.refresh).length >= 10000) throw new ServerError('Grant limit reached.');
    const access = opaque(), refresh = opaque();
    this.validateScopes(scopes);
    const granted = scopes as Grant['scopes'];
    this.state.access[hash(access)] = { clientId, scopes: granted, family, expires: this.now() + 3600 };
    this.state.refresh[hash(refresh)] = { clientId, scopes: granted, family, expires: refreshExpiry };
    return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: 3600, scope: scopes.join(' ') };
  }
  async exchangeAuthorizationCode(client: OAuthClientInformationFull, code: string, verifier?: string, redirectUri?: string, resource?: URL) {
    this.validateResource(resource); const p = this.code(client, code);
    if (redirectUri !== p.params.redirectUri) throw new InvalidGrantError('Redirect URI does not match.');
    if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !timingSafeEqual(Buffer.from(createHash('sha256').update(verifier).digest('base64url')), Buffer.from(p.params.codeChallenge))) throw new InvalidGrantError('Invalid PKCE verifier.');
    this.codes.delete(hash(code));
    return this.transaction(() => this.issue(client.client_id, p.scopes));
  }
  private revokeFamily(family: string) {
    for (const table of [this.state.access, this.state.refresh]) for (const [id, grant] of Object.entries(table)) if (grant.family === family) delete table[id];
  }
  async exchangeRefreshToken(client: OAuthClientInformationFull, refresh: string, scopes?: string[], resource?: URL) {
    this.validateResource(resource);
    const result = await this.transaction(() => {
      const grant = this.state.refresh[hash(refresh)];
      if (!grant || grant.clientId !== client.client_id) return undefined;
      if (grant.used) { this.revokeFamily(grant.family); return undefined; }
      const selected = scopes ?? grant.scopes;
      this.validateScopes(selected);
      if (selected.some(scope => !grant.scopes.some(allowed => allowed === scope))) throw new InvalidScopeError('Cannot expand a grant during refresh.');
      grant.used = true;
      return this.issue(client.client_id, selected, grant.family, grant.expires);
    });
    if (!result) throw new InvalidGrantError('Invalid, expired or replayed refresh token.');
    return result;
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    await this.queue;
    const grant = token.length <= 512 ? this.state.access[hash(token)] : undefined;
    if (!grant || grant.expires <= this.now()) throw new InvalidTokenError('Invalid or expired access token.');
    return { token, clientId: grant.clientId, scopes: [...grant.scopes], expiresAt: grant.expires, resource: this.resource };
  }
  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest) {
    await this.transaction(() => {
      const grant: Grant | undefined = this.state.access[hash(request.token)] || this.state.refresh[hash(request.token)];
      if (grant?.clientId === client.client_id) this.revokeFamily(grant.family);
    });
  }
}
