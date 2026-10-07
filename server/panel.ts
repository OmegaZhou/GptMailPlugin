import express, { type Request, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomBytes } from 'node:crypto';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import { ZodError } from 'zod';
import type { Account, credentials } from './config.js';
import { keyMatches } from './oauth.js';
import { PanelError, PanelStore } from './panel-store.js';
import { panelAssets } from './panel-assets.js';

type MailboxTest = { account: Account; credentials: (kind: 'imap' | 'smtp') => ReturnType<typeof credentials> };
export type ConnectionVerifier = (input: MailboxTest) => Promise<{ imap: boolean; smtp: boolean }>;
export const verifyMailbox: ConnectionVerifier = async input => {
  const imap = async () => {
    let client: ImapFlow | undefined;
    try {
    const ep = input.account.imap;
    client = new ImapFlow({ host: ep.host, port: ep.port, secure: ep.secure, ...(ep.secure ? {} : { doSTARTTLS: true }),
      auth: input.credentials('imap'), logger: false, tls: { rejectUnauthorized: true }, disableAutoIdle: true,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    client.on('error', () => {});
    await client.connect(); return true;
    } catch { return false; }
    finally { client?.close(); }
  };
  const smtp = async () => {
    let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
    try {
    const ep = input.account.smtp, auth = input.credentials('smtp');
    transport = nodemailer.createTransport({ host: ep.host, port: ep.port, secure: ep.secure, requireTLS: !ep.secure,
      tls: { rejectUnauthorized: true }, auth: 'accessToken' in auth ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : auth,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, disableFileAccess: true, disableUrlAccess: true });
    return await transport.verify();
    } catch { return false; } finally { transport?.close(); }
  };
  const [imapResult, smtpResult] = await Promise.all([imap(), smtp()]);
  return { imap: imapResult, smtp: smtpResult };
};
const opaque = () => randomBytes(32).toString('base64url');
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
export function panelRouter(store: PanelStore, apiKey: string, prefix: string, publicOrigin: string | undefined,
  defaultMcpPath: string, authType: 'oauth' | 'apiKey', verify: ConnectionVerifier = verifyMailbox) {
  const router = express.Router(), path = `${prefix}/panel`, cookieName = 'gpt_mail_panel';
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const origin = (req: Request) => publicOrigin || `${req.protocol}://${req.get('host')}`;
  const cookie = (req: Request) => ({ httpOnly: true, sameSite: 'strict' as const, secure: new URL(origin(req)).protocol === 'https:', path: path + '/' });
  const sessionToken = (req: Request) => req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
  router.use((req, res, next) => {
    res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    if (req.method !== 'GET' && req.headers.origin !== origin(req)) { res.status(403).json({ error: '请在服务端面板中操作，当前请求来源不符。' }); return; }
    next();
  });
  router.get('/', (_req, res) => res.type('html').send(panelAssets.html));
  router.get('/panel.css', (_req, res) => res.type('css').send(panelAssets.css));
  router.get('/panel.js', (_req, res) => res.type('js').send(panelAssets.js));
  router.use('/api', express.json({ limit: '32kb' }));
  router.post('/api/session', rateLimit({ windowMs: 15 * 60000, limit: 10, standardHeaders: true, legacyHeaders: false }), (req, res) => {
    const value = req.body?.apiKey;
    if (typeof value !== 'string' || !value || !keyMatches(value, apiKey)) { res.status(401).json({ error: '服务端密钥不正确。' }); return; }
    for (const [key, entry] of sessions) if (entry.expires <= Date.now()) sessions.delete(key);
    if (sessions.size >= 100) { res.status(429).json({ error: '登录会话过多，请稍后再试。' }); return; }
    sessions.delete(hash(sessionToken(req)));
    const token = opaque(), csrf = opaque();
    sessions.set(hash(token), { csrf, expires: Date.now() + 3600000 });
    res.cookie(cookieName, token, { ...cookie(req), maxAge: 3600000 });
    res.json({ csrf });
  });
  router.use('/api', (req, res, next) => {
    const session = sessions.get(hash(sessionToken(req)));
    if (!session || session.expires <= Date.now()) { sessions.delete(hash(sessionToken(req))); res.status(401).json({ error: '请使用服务端密钥登录。' }); return; }
    if (req.method !== 'GET' && req.headers['x-panel-csrf'] !== session.csrf) { res.status(403).json({ error: '操作校验失效，请重新登录。' }); return; }
    res.locals.csrf = session.csrf;
    next();
  });
  const view = async (req: Request) => ({ ...(await store.view({ mcpUrl: new URL(defaultMcpPath, origin(req)).href, authType })),
    endpoints: { oauth: authType === 'oauth' ? new URL(defaultMcpPath, origin(req)).href : null,
      apiKey: new URL(`${prefix}/mcp`, origin(req)).href } });
  const action = (fn: (req: Request, res: Response) => Promise<void>) => async (req: Request, res: Response) => {
    try { await fn(req, res); }
    catch (error) { res.status(error instanceof ZodError || error instanceof PanelError ? 400 : 500)
      .json({ error: error instanceof PanelError ? error.message : error instanceof ZodError ? '配置格式不正确，请检查必填项和接口地址。' : '操作失败，请检查服务状态和私有状态目录。' }); }
  };
  router.get('/api/state', action(async (req, res) => { res.json({ ...(await view(req)), csrf: res.locals.csrf }); }));
  router.delete('/api/session', (_req, res) => {
    sessions.delete(hash(sessionToken(_req))); res.clearCookie(cookieName, cookie(_req)); res.json({ ok: true });
  });
  router.put('/api/connection', action(async (req, res) => { await store.saveConnection(req.body); res.json(await view(req)); }));
  router.post('/api/accounts', action(async (req, res) => { await store.saveAccount(req.body); res.json(await view(req)); }));
  router.delete('/api/accounts/:id', action(async (req, res) => { await store.deleteAccount(String(req.params.id)); res.json(await view(req)); }));
  router.put('/api/default', action(async (req, res) => { if (typeof req.body?.id !== 'string') throw new PanelError('请选择邮箱。');
    await store.setDefault(req.body.id); res.json(await view(req)); }));
  router.post('/api/test', rateLimit({ windowMs: 60000, limit: 6, standardHeaders: true, legacyHeaders: false }), action(async (req, res) => {
    const input = typeof req.body?.id === 'string' && !req.body?.account ? await store.testSaved(req.body.id) : await store.testInput(req.body?.account);
    res.json(await verify(input));
  }));
  router.use('/api', (_req, res) => { res.status(404).json({ error: '面板接口不存在。' }); });
  return router;
}
