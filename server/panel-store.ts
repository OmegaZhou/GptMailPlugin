import { createCipheriv, createDecipheriv, hkdfSync, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { accountSchema, configSchema, credentials, type Account, type Config } from './config.js';

const secret = z.string().max(8192).refine(s => !/[\r\n\0]/.test(s)).meta({ writeOnly: true });
const inputEndpoint = z.object({ host: z.string().trim().min(1).max(253).regex(/^[A-Za-z0-9._:-]+$/),
  port: z.number().int().min(1).max(65535), secure: z.boolean(), user: z.string().trim().min(1).max(320).optional(),
  credentialType: z.enum(['password', 'accessToken']).default('password'), secret: secret.optional() }).strict();
export const panelAccountSchema = z.object({ id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), email: z.email(), name: z.string().max(100).optional(),
  imap: inputEndpoint, smtp: inputEndpoint, folders: z.object({ drafts: z.string().max(1000), sent: z.string().max(1000),
    trash: z.string().max(1000), archive: z.string().max(1000) }).partial().default({}), saveSent: z.boolean().default(true) }).strict();
export const connectionSchema = z.object({ mcpUrl: z.url().max(2048).refine(value => {
  const u = new URL(value);
  return !u.username && !u.password && !u.search && !u.hash && (u.protocol === 'https:' ||
    (u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)));
}), authType: z.enum(['oauth', 'apiKey']) }).strict();
const managedSchema = z.object({ account: accountSchema, imap: z.object({ type: z.enum(['password', 'accessToken']), value: secret.min(1) }),
  smtp: z.object({ type: z.enum(['password', 'accessToken']), value: secret.min(1) }) }).strict();
const stateSchema = z.object({ version: z.literal(1), connection: connectionSchema.optional(), defaultAccount: z.string().optional(),
  accounts: z.array(managedSchema).max(100) }).strict().refine(s => new Set(s.accounts.map(a => a.account.id)).size === s.accounts.length);
const envelopeSchema = z.object({ version: z.literal(1), salt: z.string(), iv: z.string(), tag: z.string(), ciphertext: z.string() }).strict();
type State = z.infer<typeof stateSchema>;
export type PanelAccountInput = z.input<typeof panelAccountSchema>;
export class PanelError extends Error {}

// One process owns the state file. Credentials never enter the model's tools or server config.
export class PanelStore {
  private state: State = { version: 1, accounts: [] };
  private salt = randomBytes(32);
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private directory: string, private apiKey: string, private baseConfig: () => Promise<Config>) {}
  private encryptionKey() { return Buffer.from(hkdfSync('sha256', this.apiKey, this.salt, 'gpt-mail-panel-v1', 32)); }
  async init() {
    try {
      const envelope = envelopeSchema.parse(JSON.parse(await readFile(join(this.directory, 'settings.enc.json'), 'utf8')));
      this.salt = Buffer.from(envelope.salt, 'base64url');
      const iv = Buffer.from(envelope.iv, 'base64url'), tag = Buffer.from(envelope.tag, 'base64url');
      if (this.salt.length !== 32 || iv.length !== 12 || tag.length !== 16) throw new Error('Invalid encryption envelope');
      const decipher = createDecipheriv('aes-256-gcm', this.encryptionKey(), iv);
      decipher.setAAD(Buffer.from('gpt-mail-panel-v1')); decipher.setAuthTag(tag);
      this.state = stateSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64url')), decipher.final()]).toString('utf8')));
    } catch (error: any) {
      if (error.code !== 'ENOENT') throw new Error('Unable to decrypt panel configuration. Restore its matching server key and state; refusing to discard mailbox settings.');
    }
    return this;
  }
  private async transaction<T>(change: (state: State) => T | Promise<T>): Promise<T> {
    const operation = this.queue.then(async () => {
      const next = structuredClone(this.state);
      const result = await change(next);
      stateSchema.parse(next);
      const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', this.encryptionKey(), iv);
      cipher.setAAD(Buffer.from('gpt-mail-panel-v1'));
      const encrypted = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
      const envelope = { version: 1, salt: this.salt.toString('base64url'), iv: iv.toString('base64url'),
        tag: cipher.getAuthTag().toString('base64url'), ciphertext: encrypted.toString('base64url') };
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temp = join(this.directory, randomUUID() + '.tmp');
      try { await writeFile(temp, JSON.stringify(envelope) + '\n', { mode: 0o600 }); await rename(temp, join(this.directory, 'settings.enc.json')); }
      finally { await unlink(temp).catch(() => {}); }
      this.state = next;
      return result;
    });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async mail(): Promise<Config> {
    const base = configSchema.parse(await this.baseConfig());
    const managed = this.state.accounts.map(a => a.account);
    const accounts = [...base.accounts.filter(a => !managed.some(m => m.id === a.id)), ...managed];
    const preferred = this.state.defaultAccount || base.defaultAccount;
    return { ...base, accounts, defaultAccount: accounts.some(a => a.id === preferred) ? preferred : accounts[0]?.id };
  }
  credentials(account: Account, kind: 'imap' | 'smtp') {
    const managed = this.state.accounts.find(a => a.account.id === account.id);
    if (!managed) return credentials(account, kind);
    const value = managed[kind];
    return { user: account[kind].user || account.email, ...(value.type === 'accessToken' ? { accessToken: value.value } : { pass: value.value }) };
  }
  async view(defaultConnection: { mcpUrl: string; authType: 'oauth' | 'apiKey' }) {
    const config = await this.mail();
    return { connection: this.state.connection || defaultConnection, defaultAccount: config.defaultAccount || null,
      accounts: config.accounts.map(account => {
        const managed = this.state.accounts.find(a => a.account.id === account.id);
        const endpoint = (kind: 'imap' | 'smtp') => ({ host: account[kind].host, port: account[kind].port, secure: account[kind].secure,
          user: account[kind].user || account.email, credentialType: managed?.[kind].type || (account[kind].accessTokenEnv ? 'accessToken' : 'password'),
          hasSecret: managed ? true : Boolean(account[kind].passwordEnv || account[kind].accessTokenEnv) });
        return { id: account.id, email: account.email, name: account.name, imap: endpoint('imap'), smtp: endpoint('smtp'),
          folders: account.folders, saveSent: account.saveSent, editable: Boolean(managed), source: managed ? 'panel' : 'config' };
      }) };
  }
  async saveConnection(value: unknown) {
    const parsed = connectionSchema.parse(value);
    await this.transaction(state => { state.connection = parsed; });
  }
  private async prepare(value: unknown, state = this.state) {
    const input = panelAccountSchema.parse(value);
    const previous = state.accounts.find(a => a.account.id === input.id);
    const base = await this.baseConfig();
    if (!previous && base.accounts.some(a => a.id === input.id)) throw new PanelError('该账号由服务端配置文件管理，请使用新的账号 ID。');
    const values = (kind: 'imap' | 'smtp') => {
      const ep = input[kind], old = previous?.[kind], oldEp = previous?.account[kind];
      const sameTarget = oldEp && oldEp.host === ep.host && oldEp.port === ep.port && oldEp.secure === ep.secure &&
        (oldEp.user || previous!.account.email) === (ep.user || input.email) && old?.type === ep.credentialType;
      const value = ep.secret || (sameTarget ? old?.value : undefined);
      if (!value) throw new PanelError(`请填写 ${kind.toUpperCase()} 授权码或令牌；更换服务器、登录账号或认证方式后必须重新填写。`);
      return { type: ep.credentialType, value };
    };
    const endpoint = (kind: 'imap' | 'smtp') => { const { secret: _secret, credentialType: _type, ...ep } = input[kind]; return ep; };
    const account = accountSchema.parse({ id: input.id, email: input.email, name: input.name,
      imap: endpoint('imap'), smtp: endpoint('smtp'), folders: input.folders, saveSent: input.saveSent });
    return { account, imap: values('imap'), smtp: values('smtp') };
  }
  async saveAccount(value: unknown) {
    await this.transaction(async state => {
      const prepared = await this.prepare(value, state);
      state.accounts = [...state.accounts.filter(a => a.account.id !== prepared.account.id), prepared];
      state.defaultAccount ||= prepared.account.id;
    });
  }
  async deleteAccount(id: string) {
    await this.transaction(state => {
      if (!state.accounts.some(a => a.account.id === id)) throw new PanelError('只能通过面板移除面板添加的邮箱。');
      state.accounts = state.accounts.filter(a => a.account.id !== id);
      if (state.defaultAccount === id) state.defaultAccount = undefined;
    });
  }
  async setDefault(id: string) {
    await this.transaction(async state => {
      const base = await this.baseConfig();
      if (![...base.accounts, ...state.accounts.map(a => a.account)].some(a => a.id === id)) throw new PanelError('邮箱账号不存在。');
      state.defaultAccount = id;
    });
  }
  async testInput(value: unknown) {
    const prepared = await this.prepare(value);
    return { account: prepared.account, credentials: (kind: 'imap' | 'smtp') => {
      const credential = prepared[kind];
      return { user: prepared.account[kind].user || prepared.account.email,
        ...(credential.type === 'accessToken' ? { accessToken: credential.value } : { pass: credential.value }) };
    } };
  }
  async testSaved(id: string) {
    const account = (await this.mail()).accounts.find(a => a.id === id);
    if (!account) throw new PanelError('邮箱账号不存在。');
    return { account, credentials: (kind: 'imap' | 'smtp') => this.credentials(account, kind) };
  }
}
