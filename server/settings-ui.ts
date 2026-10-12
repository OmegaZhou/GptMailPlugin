import { createHash, randomBytes } from 'node:crypto';
import { z, ZodError } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { createSettings, type OpenAIUiToolMetadata, type OpenAIUiResourceMetadata } from '@openai/mcp-extensions/server';
import { SettingsStoreError, SettingsStore, settingsAccountSchema } from './settings-store.js';
import { verifyMailbox, type ConnectionVerifier } from './mailbox-verifier.js';
import { settingsHtml } from '../ui/resource.js';

export const SETTINGS_URI = 'ui://gpt-mail/settings-v1.html';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const tokenSchema = z.string().min(40).max(64);
const idSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
export type SettingsIdentity = { binding: string; canWrite: boolean; verifiedOwner?: boolean; accountName?: string };
type Identity = SettingsIdentity;
class SettingsError extends Error { constructor(message: string, readonly status = 400) { super(message); } }

// Shared by the stateless MCP request servers; no cookies, browser HTTP endpoints or credential logging.
export class SettingsController {
  private sessions = new Map<string, { binding: string; expires: number }>();
  private limits = new Map<string, { count: number; expires: number }>();
  constructor(readonly store: SettingsStore,
    private origin: string, private mcpPath: string,
    private authType: 'oauth', private verify: ConnectionVerifier = verifyMailbox,
    private now: () => number = Date.now) {}
  private limit(bucket: string, maximum: number, period: number) {
    for (const [key, entry] of this.limits) if (entry.expires <= this.now()) this.limits.delete(key);
    const entry = this.limits.get(bucket) || { count: 0, expires: this.now() + period };
    if (entry.count >= maximum || (!this.limits.has(bucket) && this.limits.size >= 1000))
      throw new SettingsError('请求过于频繁，请稍后再试。', 429);
    entry.count++; this.limits.set(bucket, entry);
  }
  connectionInfo() {
    return { mcpUrl: new URL(this.mcpPath, this.origin).href, authType: this.authType };
  }
  private async beginSession(identity: Identity) {
    for (const [key, entry] of this.sessions) if (entry.expires <= this.now()) this.sessions.delete(key);
    if (this.sessions.size >= 100) throw new SettingsError('登录会话过多，请稍后再试。', 429);
    const session = randomBytes(32).toString('base64url');
    this.sessions.set(hash(session), { binding: identity.binding, expires: this.now() + 3600000 });
    return { session, state: await this.view(identity) };
  }
  async view(identity?: Identity) {
    return { ...(await this.store.view()), activeConnection: { ...this.connectionInfo(), authenticated: true,
      accountName: identity?.accountName || '服务器所有者' } };
  }
  async execute(action: string, args: any, identity: Identity) {
    if (action === 'bootstrap') {
      const connection = this.connectionInfo();
      if (!identity.verifiedOwner || !identity.canWrite) return { connection, authenticated: false };
      this.limit('bootstrap:' + identity.binding, 20, 60000);
      return { connection, authenticated: true, ...await this.beginSession(identity) };
    }
    if (!identity.verifiedOwner || !identity.canWrite) throw new SettingsError('配置邮箱需要有效的账号授权和写入权限。', 403);
    const session = this.sessions.get(hash(args.session));
    if (!session || session.expires <= this.now() || session.binding !== identity.binding)
      throw new SettingsError('面板会话已失效，请恢复服务连接。', 401);
    switch (action) {
      case 'logout': this.sessions.delete(hash(args.session)); return { ok: true };
      case 'state': return this.view(identity);
      case 'save_account': await this.store.saveAccount(args.account); break;
      case 'delete_account': await this.store.deleteAccount(args.id); break;
      case 'default': await this.store.setDefault(args.id); break;
      case 'test': {
        this.limit('test:global', 12, 60000); this.limit('test:' + identity.binding, 6, 60000);
        return this.verify(args.id ? await this.store.testSaved(args.id) : await this.store.testInput(args.account));
      }
      default: throw new SettingsError('未知配置操作。');
    }
    return this.view(identity);
  }
}

export function registerSettingsUi(server: McpServer, controller: SettingsController, identity: Identity) {
  const resourceMeta = { ui: { csp: { connectDomains: [], resourceDomains: [], frameDomains: [] } },
    'openai/ui': { preferredDisplayMode: 'fullscreen', availableDisplayModes: ['inline', 'fullscreen'] } satisfies OpenAIUiResourceMetadata };
  registerAppResource(server, '邮箱与连接配置', SETTINGS_URI, { _meta: resourceMeta }, async () => ({
    contents: [{ uri: SETTINGS_URI, mimeType: RESOURCE_MIME_TYPE, text: settingsHtml, _meta: resourceMeta }],
  }));
  registerAppTool(server, 'open_settings', { title: '配置连接与邮箱',
    description: 'Open mailbox management using the authenticated service connection. Never ask for credentials in chat.',
    inputSchema: z.object({}).strict(), annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    _meta: { ui: { resourceUri: SETTINGS_URI, visibility: ['app', 'model'] },
      'openai/ui': { entrypoints: [{ type: 'global' }, { type: 'thread' }] } satisfies OpenAIUiToolMetadata },
  }, async () => ({ content: [{ type: 'text', text: '请在插件面板中管理邮箱。' }],
    _meta: { settings: { connected: true, connection: controller.connectionInfo() } } }));
  // Match OpenAI's Bits & Bolts: capability -> read tool -> native button -> MCP App.
  // Credentials are not primitive native settings; the modal keeps them in password controls.
  createSettings(server).register({
    readTool: 'settings_read', updateTool: 'settings_update', fields: {},
    layout: [{ kind: 'group', title: '邮箱与连接', items: [{ kind: 'tool', tool: 'open_settings',
      title: '配置连接与邮箱', description: '使用已授权的账号添加和管理邮箱。' }] }],
    read: async () => ({}), update: async () => ({}),
  });
  const definitions: [string, z.ZodRawShape, boolean][] = [
    ['bootstrap', {}, true],
    ['state', { session: tokenSchema }, true], ['logout', { session: tokenSchema }, false],
    ['save_account', { session: tokenSchema, account: settingsAccountSchema }, false],
    ['delete_account', { session: tokenSchema, id: idSchema }, false],
    ['default', { session: tokenSchema, id: idSchema }, false],
    ['test', { session: tokenSchema, id: idSchema.optional(), account: settingsAccountSchema.optional() }, true],
  ];
  for (const [action, shape, readOnly] of definitions) server.registerTool('settings_' + action, {
    inputSchema: z.object(shape).strict(), annotations: { readOnlyHint: readOnly,
      destructiveHint: action === 'delete_account', openWorldHint: action === 'test' },
    _meta: { ui: { visibility: ['app'] }, 'openai/visibility': 'private' },
  }, async args => {
    try {
      const result = await controller.execute(action, args, identity);
      // _meta is delivered to the component, never copied into model-readable content/structuredContent.
      return { content: [], _meta: { settings: result } };
    } catch (error) {
      const message = error instanceof SettingsError || error instanceof SettingsStoreError ? error.message
        : error instanceof ZodError ? '配置格式不正确，请检查必填项。' : '操作失败，请检查服务状态。';
      return { isError: true, content: [{ type: 'text', text: message }],
        _meta: { settings: { error: message, status: error instanceof SettingsError ? error.status : 400 } } };
    }
  });
}
