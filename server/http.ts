import express, { type ErrorRequestHandler } from 'express';
import { rateLimit } from 'express-rate-limit';
import { timingSafeEqual, createHash } from 'node:crypto';
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
import { PanelStore } from './panel-store.js';
import { panelRouter, type ConnectionVerifier } from './panel.js';
import { MailOAuthProvider, oauthConfigSchema } from './oauth.js';
import { mailOAuthRouter } from './oauth-router.js';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';

export const httpConfigSchema = z.object({
  apiKey: z.string().min(32).max(512).refine(key => !/[\r\n\0]/.test(key), 'Key must be a valid Authorization header value'),
  http: z.object({
    bindHost: z.string().default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(3000),
    publicUrl: z.url().optional(), trustProxy: z.union([z.literal(0), z.literal(1)]).default(0),
    allowedOrigins: z.array(z.url()).default([]),
  }).default({ bindHost: '127.0.0.1', port: 3000, trustProxy: 0, allowedOrigins: [] }),
  mail: configSchema,
  oauth: oauthConfigSchema.optional(),
}).strict();
export type HttpOptions = z.infer<typeof httpConfigSchema>;
const digest = (key: string) => createHash('sha256').update(key).digest();

export async function createHttpApp(options: HttpOptions, service?: MailService, oauthStateDirectory?: string,
  panelOptions?: { directory?: string; baseConfig?: () => Promise<Config>; verify?: ConnectionVerifier }) {
  const settings = httpConfigSchema.parse(options);
  const { http } = settings;
  const prefix = settings.oauth?.routePrefix || '';
  const base = http.publicUrl ? new URL(http.publicUrl) : undefined;
  if (base && (base.pathname !== '/' || base.search || base.hash || base.username || base.password ||
    (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))))) throw new Error('publicUrl must be an HTTPS origin (HTTP only on loopback).');
  const app = express(); app.disable('x-powered-by');
  const panelStore = await new PanelStore(panelOptions?.directory || join(oauthStateDirectory ||
    process.env.MAIL_STATE_DIR || join(homedir(), '.config', 'gpt-mail', 'state'), 'panel'), settings.apiKey,
    panelOptions?.baseConfig || (async () => settings.mail)).init();
  service ||= new MailService(() => panelStore.mail(), undefined, undefined, undefined, (account, kind) => panelStore.credentials(account, kind));
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
  app.get(`${prefix}/panel`, (req, res, next) => { if (req.path === `${prefix}/panel`) res.redirect(303, `${prefix}/panel/`); else next(); });
  app.use(`${prefix}/panel/`, panelRouter(panelStore, settings.apiKey, prefix, base?.origin,
    settings.oauth?.enabled ? settings.oauth.mcpPath || '/chatgpt/mcp' : `${prefix}/mcp`, settings.oauth?.enabled ? 'oauth' : 'apiKey', panelOptions?.verify));
  async function handleMcp(req: express.Request, res: express.Response, oauth?: { scopes: string[]; metadataUrl: string }) {
    if (req.method !== 'POST') { res.status(405).setHeader('Allow', 'POST'); res.end(); return; }
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true,
      ...(base ? { enableDnsRebindingProtection: true, allowedHosts: [base.host], allowedOrigins: [base.origin, ...http.allowedOrigins] } : {}) });
    const server = createServer(service!, oauth);
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(500).json({ error: 'MCP request failed' }); }
  }
  let oauth: MailOAuthProvider | undefined;
  if (settings.oauth?.enabled) {
    if (!base) throw new Error('OAuth requires http.publicUrl: the publicly reachable HTTPS origin.');
    const issuer = new URL(prefix || '/', base);
    oauth = await new MailOAuthProvider(issuer, settings.apiKey, settings.oauth.redirectOrigins, oauthStateDirectory, undefined, settings.oauth.mcpPath, prefix).init();
    const metadataUrl = getOAuthProtectedResourceMetadataUrl(oauth.resource);
    app.use(mailOAuthRouter(oauth, prefix));
    app.all(oauth.resource.pathname, requireBearerAuth({ verifier: oauth, expectedResource: oauth.resource, resourceMetadataUrl: metadataUrl }),
      express.json({ limit: '40mb' }), (req, res) => handleMcp(req, res, { scopes: req.auth!.scopes, metadataUrl }));
  } else app.all(settings.oauth?.mcpPath || '/chatgpt/mcp', (_req, res) => { res.status(404).json({ error: 'ChatGPT adapter is disabled' }); });
  // Authenticate before parsing potentially large email bodies.
  const expected = digest(settings.apiKey);
  app.use((req, res, next) => {
    const header = req.headers.authorization;
    const key = header?.startsWith('Bearer ') ? header.slice(7) : '';
    if (!key || key.length > 512 || !timingSafeEqual(digest(key), expected)) {
      res.status(401).setHeader('WWW-Authenticate', 'Bearer realm="GptMail"'); res.json({ error: 'unauthorized' }); return;
    }
    next();
  });
  app.use(express.json({ limit: '40mb' }));
  app.all(['/mcp', ...(prefix ? [prefix + '/mcp'] : [])], (req, res) => handleMcp(req, res));
  // REST uses the exact same MCP validation and handlers; no duplicate mail semantics.
  async function rest(name?: string, args?: Record<string, unknown>) {
    const server = createServer(service); const client = new Client({ name: 'gpt-mail-rest', version: '0.3.0' });
    const [left, right] = InMemoryTransport.createLinkedPair();
    try {
      await server.connect(right); await client.connect(left);
      return name ? await client.callTool({ name, arguments: args }) : await client.listTools();
    } finally { await client.close(); await server.close(); }
  }
  app.get(['/api/v1/tools', ...(prefix ? [prefix + '/api/v1/tools'] : [])], async (_req, res) => {
    try { res.json(await rest()); }
    catch { res.status(500).json({ error: 'Tool discovery failed' }); }
  });
  app.post(['/api/v1/tools/:name', ...(prefix ? [prefix + '/api/v1/tools/:name'] : [])], async (req, res) => {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) { res.status(400).json({ error: 'Supply a JSON arguments object' }); return; }
    try { res.json(await rest(String(req.params.name), req.body)); }
    catch { res.status(400).json({ error: 'Unknown tool or invalid arguments' }); }
  });
  const errors: ErrorRequestHandler = (_error, _req, res, _next) => { if (!res.headersSent) res.status(400).json({ error: 'Invalid request' }); };
  app.use(errors);
  return { app, oauth, panelStore };
}

export async function startHttp() {
  const path = process.env.MAIL_SERVER_CONFIG || join(process.cwd(), 'server', 'config.json');
  const settings = httpConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
  const { app } = await createHttpApp(settings, undefined, undefined, { baseConfig: async () => configSchema.parse(JSON.parse(await readFile(path, 'utf8')).mail) });
  const port = Number(process.env.PORT || settings.http.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid PORT.');
  app.listen(port, process.env.MAIL_BIND_HOST || settings.http.bindHost, () => process.stderr.write(`GptMail HTTP listening on port ${port}\n`));
}
