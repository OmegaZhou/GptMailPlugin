import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { testAuth } from './auth-helper.js';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createHttpApp } from '../server/http.js';
import { SettingsStore } from '../server/settings-store.js';
import { verifyMailbox } from '../server/mailbox-verifier.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SettingsController, SETTINGS_URI } from '../server/settings-ui.js';
import { OpenAISettingsCapabilitySchema, OpenAISettingsReadResultSchema } from '@openai/mcp-extensions/server';
import { config } from './helpers.js';

const key = 'panel-test-key-' + 'x'.repeat(40);
const mailbox = (id = 'personal') => ({ id, email: `${id}@example.com`, name: '个人邮箱', saveSent: true,
  imap: { host: 'imap.example.com', port: 993, secure: true, credentialType: 'password', secret: 'private-mailbox-password' },
  smtp: { host: 'smtp.example.com', port: 465, secure: true, credentialType: 'password', secret: 'private-mailbox-password' } });
const close = (http: Server) => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mail-panel-'));
  const tested: any[] = [];
  const auth = await testAuth();
  const base = { accounts: [], maxMessageBytes: 25 * 1024 * 1024 };
  const { app, settingsStore: panelStore } = await createHttpApp({ storageKey: key, mail: base, http: { publicUrl: 'https://mail.example.com', bindHost: '127.0.0.1', port: 3000,
    allowedOrigins: [], trustProxy: 0 }, oauth: auth.oauth },
    undefined, undefined, { directory, verify: async input => {
      tested.push({ account: input.account, imap: input.credentials('imap'), smtp: input.credentials('smtp') });
      return { imap: true, smtp: false };
    } }, auth.resolver);
  const http = createHttpServer((req, res) => { req.headers.host = 'mail.example.com'; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'host') req.rawHeaders[i + 1] = 'mail.example.com'; app(req, res); }).listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const client = new Client({ name: 'settings-test', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mail-mcp/mcp'), {
    requestInit: { headers: { Authorization: 'Bearer ' + auth.token } } }));
  let session = '';
  const request = async (path: string, method = 'GET', body?: any) => {
    let action = path, args: any = { session, ...(body || {}) };
    if (path === 'session') { action = method === 'POST' ? 'bootstrap' : 'logout'; if (action === 'bootstrap') args = {}; }
    else if (path === 'accounts') { action = 'save_account'; args = { session, account: body }; }
    else if (path.startsWith('accounts/')) { action = 'delete_account'; args = { session, id: path.slice(9) }; }
    const result: any = await client.callTool({ name: 'settings_' + action, arguments: args });
    const data = result._meta?.settings;
    assert.ok(!JSON.stringify(result.content).includes('private-mailbox-password'));
    assert.equal(result.structuredContent, undefined);
    if (action === 'bootstrap' && !result.isError) session = data.session;
    return { status: result.isError ? data?.status || 400 : 200, json: async () => data };
  };
  const login = async () => { assert.equal((await request('session', 'POST')).status, 200); };
  return { token: auth.token, directory, panelStore, base, http, url, tested, request, login, client,
    dispose: async () => { await client.close(); await close(http); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); } };
}
test('plugin settings discover native entrypoints and a self-contained MCP resource; no server panel routes', async () => {
  const f = await fixture();
  try {
    const capabilities: any = f.client.getServerCapabilities();
    assert.equal(capabilities.extensions['openai/settings'].readTool, 'settings_read');
    const tools = (await f.client.listTools()).tools;
    const opener: any = tools.find(t => t.name === 'open_settings');
    assert.equal(opener._meta.ui.resourceUri, SETTINGS_URI);
    assert.deepEqual(opener._meta['openai/ui'].entrypoints, [{ type: 'global' }, { type: 'thread' }]);
    for (const tool of tools.filter(t => t.name.startsWith('settings_') && !['settings_read', 'settings_update'].includes(t.name)))
      assert.deepEqual((tool._meta as any).ui.visibility, ['app']);
    const settings: any = await f.client.callTool({ name: 'settings_read', arguments: {} });
    assert.equal(settings.structuredContent.layout[0].items[0].tool, 'open_settings');
    const resource = await f.client.readResource({ uri: SETTINGS_URI });
    const html: any = resource.contents[0];
    assert.equal(html.mimeType, 'text/html;profile=mcp-app');
    assert.match(html.text, /当前服务连接/); assert.ok(!html.text.includes(key));
    assert.ok(!html.text.includes('./api/')); assert.ok(!html.text.includes('panel.js'));
    assert.deepEqual(html._meta['openai/ui'].availableDisplayModes, ['inline', 'fullscreen']);
    for (const path of ['/mail-mcp/panel/', '/mail-mcp/panel/api/state', '/panel/'])
      assert.equal((await fetch(f.url + path)).status, 404);
    assert.ok(!tools.some(t => ['settings_login', 'settings_connection'].includes(t.name)));
    assert.ok(!html.text.includes('login-key')); assert.ok(!html.text.includes('export-config'));
    await f.login();
    assert.equal((await f.request('session', 'DELETE')).status, 200);
    assert.equal((await f.request('state')).status, 401);
  } finally { await f.dispose(); }
});

test('native settings discovery follows the SDK contract through the button to the UI resource', async () => {
  const f = await fixture();
  try {
    const capabilities: any = f.client.getServerCapabilities();
    const discovery = OpenAISettingsCapabilitySchema.parse(capabilities.extensions['openai/settings']);
    assert.deepEqual(capabilities.experimental['openai/settings'], discovery);
    const tools = (await f.client.listTools()).tools;
    for (const name of [discovery.readTool, discovery.updateTool]) {
      const tool = tools.find(t => t.name === name)!;
      assert.ok(tool.outputSchema);
      // Native settings discovery must not depend on the component already being open.
      assert.equal((tool._meta?.ui as any)?.visibility, undefined);
    }
    const result = await f.client.callTool({ name: discovery.readTool, arguments: {} });
    const settings = OpenAISettingsReadResultSchema.parse(result.structuredContent);
    assert.deepEqual(settings.schema.properties, {});
    assert.deepEqual(settings.values, {});
    for (const group of settings.layout!) for (const item of group.items) {
      assert.equal(item.kind, 'tool');
      if (item.kind !== 'tool') continue;
      const action = tools.find(t => t.name === item.tool)!;
      assert.equal(action.title, '配置连接与邮箱');
      const opened = await f.client.callTool({ name: action.name, arguments: {} });
      assert.ok(!opened.isError);
      const resource = await f.client.readResource({ uri: (action._meta!.ui as any).resourceUri });
      assert.equal(resource.contents[0].mimeType, 'text/html;profile=mcp-app');
    }
    // Empty updates used to succeed silently; unknown settings must not store secrets.
    for (const set of [{}, { apiKey: 'never-a-native-setting' }]) {
      const response = await f.client.callTool({ name: discovery.updateTool, arguments: { set } });
      assert.equal(response.isError, true);
    }
    await assert.rejects(readFile(join(f.directory, 'settings.enc.json')), { code: 'ENOENT' });
  } finally { await f.dispose(); }
});

test('panel accounts persist encrypted, take effect in tools immediately and preserve credentials on metadata edits', async () => {
  const f = await fixture();
  try {
    await f.login();
    const response = await f.request('accounts', 'POST', mailbox()); assert.equal(response.status, 200);
    const view: any = await response.json();
    assert.equal(view.defaultAccount, 'personal'); assert.equal(view.accounts[0].imap.hasSecret, true);
    const serialized = JSON.stringify(view); assert.ok(!serialized.includes('private-mailbox-password')); assert.ok(!serialized.includes(key));
    const disk = await readFile(join(f.directory, 'settings.enc.json'), 'utf8');
    assert.ok(!disk.includes('private-mailbox-password')); assert.ok(!disk.includes('personal@example.com')); assert.ok(!disk.includes(key));
    assert.equal(f.base.accounts.length, 0);
    const list = await fetch(f.url + '/mail-mcp/api/v1/tools/list_accounts', { method: 'POST', headers: { Authorization: 'Bearer ' + f.token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await list.json() as any).structuredContent.accounts[0].email, 'personal@example.com');
    const changed = mailbox(); changed.name = '<img src=x onerror=alert(1)>'; changed.imap.secret = ''; changed.smtp.secret = '';
    assert.equal((await f.request('accounts', 'POST', changed)).status, 200);
    assert.deepEqual(f.panelStore.credentials((await f.panelStore.mail()).accounts[0], 'imap'), { user: 'personal@example.com', pass: 'private-mailbox-password' });
    changed.imap.host = 'other.example.com';
    assert.equal((await f.request('accounts', 'POST', changed)).status, 400);
    assert.equal((await f.panelStore.mail()).accounts[0].imap.host, 'imap.example.com');
    const restarted = await new SettingsStore(f.directory, key, async () => f.base).init();
    assert.deepEqual(restarted.credentials((await restarted.mail()).accounts[0], 'smtp'), { user: 'personal@example.com', pass: 'private-mailbox-password' });
    await assert.rejects(new SettingsStore(f.directory, key + '-rotated', async () => f.base).init(), /refusing to discard/);
  } finally { await f.dispose(); }
});
test('connection testing uses supplied or stored credentials without saving changes and never includes them in responses', async () => {
  const f = await fixture();
  try {
    await f.login();
    const result = await f.request('test', 'POST', { account: mailbox() });
    assert.deepEqual(await result.json(), { imap: true, smtp: false });
    assert.equal(f.tested[0].imap.pass, 'private-mailbox-password'); assert.equal(f.tested[0].smtp.pass, 'private-mailbox-password');
    assert.equal((await f.panelStore.mail()).accounts.length, 0);
    await assert.rejects(readFile(join(f.directory, 'settings.enc.json')), { code: 'ENOENT' });
    await f.request('accounts', 'POST', mailbox());
    await f.request('test', 'POST', { id: 'personal' });
    assert.equal(f.tested.length, 2); assert.equal(f.tested[1].imap.user, 'personal@example.com');
  } finally { await f.dispose(); }
});
test('concurrent account saves, default selection and removal survive restart', async () => {
  const f = await fixture();
  try {
    await f.login();
    const connectionState = await (await f.request('state')).json();
    assert.equal(connectionState.activeConnection.authType, 'oauth');
    assert.equal(connectionState.activeConnection.authenticated, true);
    assert.equal(connectionState.connection, undefined);
    const responses = await Promise.all([f.request('accounts', 'POST', mailbox('first')), f.request('accounts', 'POST', mailbox('second'))]);
    responses.forEach(r => assert.equal(r.status, 200)); assert.equal((await f.panelStore.mail()).accounts.length, 2);
    await f.request('default', 'PUT', { id: 'second' }); assert.equal((await f.panelStore.mail()).defaultAccount, 'second');
    assert.equal((await f.request('accounts/second', 'DELETE')).status, 200);
    assert.equal((await f.panelStore.mail()).defaultAccount, 'first');
    const restarted = await new SettingsStore(f.directory, key, async () => f.base).init();
    assert.equal('connection' in await restarted.view(), false);
    assert.equal((await restarted.mail()).accounts.length, 1);
    assert.equal((await f.request('default', 'PUT', { id: 'missing' })).status, 400);
  } finally { await f.dispose(); }
});
test('panel includes existing config accounts, does not override their credentials or delete them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-panel-config-'));
  try {
    const store = await new SettingsStore(directory, key, async () => config).init();
    const view = await store.view();
    assert.equal(view.accounts[0].editable, false);
    await assert.rejects(store.saveAccount(mailbox('test')), /新的账号 ID/);
    await assert.rejects(store.deleteAccount('test'), /配置|插件/);
    assert.equal((await store.mail()).accounts[0].imap.passwordEnv, 'TEST_PASSWORD');
  } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
});
test('connection verifier handles missing credentials safely before contacting a server', async () => {
  const result = await verifyMailbox({ account: config.accounts[0], credentials: () => { throw new Error('private-mailbox-password'); } });
  assert.deepEqual(result, { imap: false, smtp: false });
});

test('owner management sessions require verified identity and write scope; expire, restore and rate-limit', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-settings-auth-'));
  try {
    const store = await new SettingsStore(directory, key, async () => ({ accounts: [], maxMessageBytes: 26214400 })).init();
    let now = 0;
    const controller = new SettingsController(store, 'https://mail.example.com', '/mcp', 'oauth', undefined, () => now);
    const owner = { binding: 'owner', canWrite: true, verifiedOwner: true };
    await assert.rejects(controller.execute('state', { session: 'x'.repeat(43) }, { binding: 'reader', canWrite: false, verifiedOwner: true }), /写入权限/);
    const login: any = await controller.execute('bootstrap', {}, owner);
    assert.ok(!JSON.stringify(login.state).includes(key));
    await assert.rejects(controller.execute('save_account', { session: login.session, account: mailbox() }, { binding: 'other', canWrite: true, verifiedOwner: true }), /失效/);
    await assert.rejects(controller.execute('state', { session: 'x'.repeat(43) }, owner), /失效/);
    for (let i = 0; i < 19; i++) await controller.execute('bootstrap', {}, owner);
    await assert.rejects(controller.execute('bootstrap', {}, owner), /频繁/);
    now += 3600001;
    await assert.rejects(controller.execute('state', { session: login.session }, owner), /失效/);
    const restarted = new SettingsController(store, 'https://mail.example.com', '/mcp', 'oauth');
    await assert.rejects(restarted.execute('state', { session: login.session }, owner), /失效/);
    const unverified: any = await restarted.execute('bootstrap', {}, { ...owner, verifiedOwner: false });
    assert.equal(unverified.authenticated, false);
    assert.equal(unverified.session, undefined);
    assert.equal(unverified.connection.mcpUrl, 'https://mail.example.com/mcp');
    const reader: any = await restarted.execute('bootstrap', {}, { binding: 'reader', canWrite: false, verifiedOwner: true });
    assert.equal(reader.session, undefined);
    const restored: any = await restarted.execute('bootstrap', {}, { ...owner, verifiedOwner: true });
    assert.equal(restored.authenticated, true);
    assert.ok(!JSON.stringify(restored).includes(key));
    const secondDevice = { binding: 'other-device-token', canWrite: true, verifiedOwner: true };
    const another: any = await restarted.execute('bootstrap', {}, secondDevice);
    await restarted.execute('state', { session: another.session }, secondDevice);
    await assert.rejects(restarted.execute('state', { session: restored.session }, secondDevice), /失效/);
  } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
});
