import express, { type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer } from './server.js';
import { MailService } from './service.js';
import { configSchema } from './config.js';
import type { Config } from './config.js';
import { SettingsStore } from './settings-store.js';
import type { ConnectionVerifier } from './mailbox-verifier.js';
import { SettingsController } from './settings-ui.js';
import { oauthConfigSchema } from './oauth.js';
import { ExternalTokenVerifier } from './external-auth.js';
import type { JWTVerifyGetKey } from 'jose';
import { mailOAuthRouter } from './oauth-router.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { GoogleMailboxClient, MailboxOAuth, googleMailboxConfigSchema, mailboxOAuthRouter } from './mailbox-oauth.js';
import { serviceInfoRouter } from './service-info.js';

export const httpConfigSchema = z.object({
  storageKey: z.string().min(32).max(512),
  http: z.object({
    bindHost: z.string().default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(3000),
    publicUrl: z.url().optional(), trustProxy: z.union([z.literal(0), z.literal(1)]).default(0),
    allowedOrigins: z.array(z.url()).default([]),
  }).default({ bindHost: '127.0.0.1', port: 3000, trustProxy: 0, allowedOrigins: [] }),
  mail: configSchema,
  oauth: oauthConfigSchema,
  googleMailbox: googleMailboxConfigSchema.optional(),
}).strict();
export type HttpOptions = z.infer<typeof httpConfigSchema>;


export async function createHttpApp(options: HttpOptions, service?: MailService, oauthStateDirectory?: string,
  settingsOptions?: { directory?: string; baseConfig?: () => Promise<Config>; verify?: ConnectionVerifier },
  authKeyResolver?: JWTVerifyGetKey) {
  const settings = httpConfigSchema.parse(options);
  const { http } = settings;
  const prefix = settings.oauth?.routePrefix || '';
  const base = http.publicUrl ? new URL(http.publicUrl) : undefined;
  if (base && (base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))))) throw new Error('publicUrl must be an HTTPS origin (HTTP only on loopback).');
  const app = express(); app.disable('x-powered-by');
  const settingsStore = await new SettingsStore(settingsOptions?.directory || join(oauthStateDirectory ||
    process.env.MAIL_STATE_DIR || join(homedir(), '.config', 'gpt-mail', 'state'), 'panel'), settings.storageKey,
    settingsOptions?.baseConfig || (async () => settings.mail)).init();
  const googleSecret = settings.googleMailbox && process.env[settings.googleMailbox.clientSecretEnv];
  const callbackPath = `${prefix}/mailbox-oauth/google/callback`;
  const google = settings.googleMailbox && googleSecret && base
    ? new GoogleMailboxClient(settings.googleMailbox, new URL(callbackPath, base).href, googleSecret) : undefined;
  settingsStore.useGoogle(google);
  const mailboxOAuth = new MailboxOAuth(settingsStore, google);
  service ||= new MailService(() => settingsStore.mail(), undefined, undefined, undefined, (account, kind) => settingsStore.resolveCredentials(account, kind));
  if (http.trustProxy) app.set('trust proxy', http.trustProxy);
  app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); res.setHeader('X-Content-Type-Options', 'nosniff');
    if (base && req.headers.host !== base.host) { res.status(421).json({ error: 'Unrecognized host' }); return; }
    const origin = req.headers.origin;
    const localOrigin = !base && ['localhost', '127.0.0.1', '[::1]'].includes(req.hostname) ? `${req.protocol}://${req.get('host')}` : undefined;
    const origins = [...(base ? [base.origin] : localOrigin ? [localOrigin] : []), ...http.allowedOrigins];
    if (origin && !origins.includes(origin)) { res.status(403).json({ error: 'Unrecognized origin' }); return; }
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, MCP-Protocol-Version, MCP-Session-Id');
      res.setHeader('Access-Control-Allow-Methods', 'POST, GET, DELETE, OPTIONS');
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, MCP-Session-Id');
    }
    if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
    next();
  });
  app.get(['/healthz', ...(prefix ? [prefix + '/healthz'] : [])], (_req, res) => res.json({ status: 'ok' }));
  app.use(rateLimit({ windowMs: 60000, limit: 120, standardHeaders: true, legacyHeaders: false }));
  app.use(serviceInfoRouter(prefix));
  // Management remains an MCP App inside the plugin; public disclosures have no form.
  app.use((req, res, next) => {
    if (/^(?:\/mail-mcp)?\/panel(?:\/|$)/.test(req.path) || req.path === `${prefix}/panel` || req.path.startsWith(`${prefix}/panel/`)) {
      res.status(404).json({ error: 'Not found' }); return;
    }
    next();
  });
  const settingsUi = new SettingsController(settingsStore, base?.origin || `http://localhost:${http.port}`,
    settings.oauth.mcpPath || '/chatgpt/mcp',
    'oauth', settingsOptions?.verify, undefined, mailboxOAuth);
  async function handleMcp(req: express.Request, res: express.Response, oauth: { scopes: string[]; metadataUrl: string }) {
    if (req.method !== 'POST') { res.status(405).setHeader('Allow', 'POST'); res.end(); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
      ...(base ? { enableDnsRebindingProtection: true, allowedHosts: [base.host], allowedOrigins: [base.origin, ...http.allowedOrigins] } : {}) });
    const ownerId = String(req.auth!.extra!.ownerId);
    const server = createServer(service!, { ...oauth, profile: async () => ({ id: 'owner_' + ownerId, name: 'GptMail', nickname: '在插件面板中管理邮箱' }) }, { controller: settingsUi,
      identity: { binding: ownerId, canWrite: oauth.scopes.includes('mail.write'), verifiedOwner: true,
        accountName: String(req.auth!.extra!.accountName) } });
    // SDK 1.x omits unknown tool fields; preserve the OAuth compatibility metadata on the wire.
    const send = transport.send.bind(transport);
    transport.send = async (message, options) => {
      if ('result' in message && message.result && typeof message.result === 'object' && 'tools' in message.result && Array.isArray(message.result.tools))
        message.result.tools = message.result.tools.map((tool: any) => tool._meta?.securitySchemes ? { ...tool, securitySchemes: tool._meta.securitySchemes } : tool);
      await send(message, options);
    };
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' }); }
  }
  if (!base) throw new Error('Authentication requires http.publicUrl.');
  const provider = settings.oauth.provider;
  const resource = new URL(settings.oauth.mcpPath || '/chatgpt/mcp', base);
  if (provider.resource !== resource.href) throw new Error('OAuth resource must match the public MCP endpoint.');
  const oauth = new ExternalTokenVerifier(provider, authKeyResolver);
  const metadataUrl = getOAuthProtectedResourceMetadataUrl(resource);
  app.use(mailOAuthRouter(provider));
  app.use(mailboxOAuthRouter(mailboxOAuth, callbackPath));
  app.all([`${prefix}/authorize`, `${prefix}/token`, `${prefix}/register`, `${prefix}/revoke`, `${prefix}/oauth/approve`],
    (_req, res) => { res.status(404).json({ error: 'Authentication is provided by the configured account service.' }); });
  // All protected routes share token verification, before parsing email bodies.
  app.use(requireBearerAuth({ verifier: oauth, expectedResource: resource, resourceMetadataUrl: metadataUrl }));
  app.use(express.json({ limit: '40mb' }));
  app.all([resource.pathname, '/mcp', ...(prefix ? [prefix + '/mcp'] : [])], (req, res) => handleMcp(req, res, { scopes: req.auth!.scopes, metadataUrl }));
  // REST uses the exact same MCP validation and handlers; no duplicate mail semantics.
  async function rest(req: express.Request, name?: string, args?: Record<string, unknown>) {
    const server = createServer(service, { scopes: req.auth!.scopes, metadataUrl }); const client = new Client({ name: 'gpt-mail-rest', version: '0.5.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(right); await client.connect(left);
      return name ? await client.callTool({ name, arguments: args }) : await client.listTools();
    } finally { await client.close(); await server.close(); }
  }
  app.get(['/api/v1/tools', ...(prefix ? [prefix + '/api/v1/tools'] : [])], async (req, res) => {
    try { res.json(await rest(req)); }
    catch { res.status(500).json({ error: 'Tool discovery failed' }); }
  });
  app.post(['/api/v1/tools/:name', ...(prefix ? [prefix + '/api/v1/tools/:name'] : [])], async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) { res.status(400).json({ error: 'Supply a JSON arguments object' }); return; }
    try { res.json(await rest(req, String(req.params.name), req.body)); }
    catch { res.status(400).json({ error: 'Unknown tool or invalid arguments' }); }
  });
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => { if (!res.headersSent) res.status(400).json({ error: 'Invalid request' }); };
  app.use(errors);
  return { app, oauth, settingsStore };
}

export async function startHttp() {
  const path = process.env.MAIL_SERVER_CONFIG || join(process.cwd(), 'server', 'config.json');
  const settings = httpConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const { app } = await createHttpApp(settings, undefined, undefined, { baseConfig: async () => configSchema.parse(JSON.parse(await readFile(path, 'utf8')).mail) });
  const port = Number(process.env.PORT || settings.http.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  app.listen(port, process.env.MAIL_BIND_HOST || settings.http.bindHost, () => process.stderr.write(`GptMail HTTP listening on port ${port}\n`));
}
