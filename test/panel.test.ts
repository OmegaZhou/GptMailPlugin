import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import type { Server } from 'node:http';
import { createHttpApp } from '../server/http.js';
import { PanelStore } from '../server/panel-store.js';
import { verifyMailbox } from '../server/panel.js';
import { config } from './helpers.js';

const key = 'panel-test-key-' + 'x'.repeat(40);
const mailbox = (id = 'personal') => ({ id, email: `${id}@example.com`, name: '个人邮箱', saveSent: true,
  imap: { host: 'imap.example.com', port: 993, secure: true, credentialType: 'password', secret: 'private-mailbox-password' },
  smtp: { host: 'smtp.example.com', port: 465, secure: true, credentialType: 'password', secret: 'private-mailbox-password' } });
const close = (http: Server) => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'mail-panel-'));
  const tested: any[] = [];
  const base = { accounts: [], maxMessageBytes: 25 * 1024 * 1024 };
  const { app, panelStore } = await createHttpApp({ apiKey: key, mail: base, http: { bindHost: '127.0.0.1', port: 3000,
    allowedOrigins: [], trustProxy: 0 }, oauth: { enabled: false, routePrefix: '/mail-mcp', redirectOrigins: ['https://chatgpt.com'] } },
    undefined, undefined, { directory, verify: async input => {
      tested.push({ account: input.account, imap: input.credentials('imap'), smtp: input.credentials('smtp') });
      return { imap: true, smtp: false };
    } });
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  let cookie = '', csrf = '';
  const request = (path: string, method = 'GET', body?: unknown, extra: Record<string, string> = {}) => fetch(url + '/mail-mcp/panel/api/' + path,
    { method, headers: { Origin: url, ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-Panel-CSRF': csrf } : {}),
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const login = async () => {
    const response = await request('session', 'POST', { apiKey: key }); assert.equal(response.status, 200);
    const header = response.headers.get('set-cookie')!; assert.match(header, /HttpOnly/); assert.match(header, /SameSite=Strict/); assert.match(header, /Path=\/mail-mcp\/panel\//);
    cookie = header.split(';')[0]; csrf = (await response.json() as any).csrf;
  };
  return { directory, panelStore, base, http, url, tested, request, login,
    csrf: () => csrf, cookie: () => cookie,
    dispose: async () => { await close(http); assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); } };
}
test('panel protects account administration with owner session, exact origin and CSRF; assets disclose no settings', async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.url + '/mail-mcp/panel/'); assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const html = await response.text(); assert.ok(!html.includes(key)); assert.match(html, /MCP 连接配置/);
    assert.equal((await fetch(f.url + '/mail-mcp/panel', { redirect: 'manual' })).headers.get('location'), '/mail-mcp/panel/');
    assert.equal((await f.request('state')).status, 401);
    assert.equal((await f.request('state', 'GET', undefined, { Authorization: 'Bearer ' + key })).status, 401);
    assert.equal((await f.request('session', 'POST', { apiKey: key }, { Origin: 'https://chatgpt.com' })).status, 403);
    assert.equal((await f.request('session', 'POST', { apiKey: 'wrong-key' })).status, 401);
    await f.login();
    assert.equal((await f.request('accounts', 'POST', mailbox(), { 'X-Panel-CSRF': '' })).status, 403);
    assert.equal((await f.request('accounts', 'POST', mailbox(), { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await f.request('session', 'DELETE')).status, 200);
    assert.equal((await f.request('state')).status, 401);
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
    const list = await fetch(f.url + '/mail-mcp/api/v1/tools/list_accounts', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await list.json() as any).structuredContent.accounts[0].email, 'personal@example.com');
    const changed = mailbox(); changed.name = '<img src=x onerror=alert(1)>'; changed.imap.secret = ''; changed.smtp.secret = '';
    assert.equal((await f.request('accounts', 'POST', changed)).status, 200);
    assert.deepEqual(f.panelStore.credentials((await f.panelStore.mail()).accounts[0], 'imap'), { user: 'personal@example.com', pass: 'private-mailbox-password' });
    changed.imap.host = 'other.example.com';
    assert.equal((await f.request('accounts', 'POST', changed)).status, 400);
    assert.equal((await f.panelStore.mail()).accounts[0].imap.host, 'imap.example.com');
    const restarted = await new PanelStore(f.directory, key, async () => f.base).init();
    assert.deepEqual(restarted.credentials((await restarted.mail()).accounts[0], 'smtp'), { user: 'personal@example.com', pass: 'private-mailbox-password' });
    await assert.rejects(new PanelStore(f.directory, key + '-rotated', async () => f.base).init(), /refusing to discard/);
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
test('connection URL validation, concurrent account saves, default selection and removal survive restart', async () => {
  const f = await fixture();
  try {
    await f.login();
    for (const mcpUrl of ['http://mail.example.com/mcp', 'https://user:secret@mail.example.com/mcp', 'https://mail.example.com/mcp?key=secret'])
      assert.equal((await f.request('connection', 'PUT', { mcpUrl, authType: 'apiKey' })).status, 400);
    const mcpUrl = 'https://mail.example.com/custom/mcp';
    assert.equal((await f.request('connection', 'PUT', { mcpUrl, authType: 'oauth' })).status, 200);
    const responses = await Promise.all([f.request('accounts', 'POST', mailbox('first')), f.request('accounts', 'POST', mailbox('second'))]);
    responses.forEach(r => assert.equal(r.status, 200)); assert.equal((await f.panelStore.mail()).accounts.length, 2);
    await f.request('default', 'PUT', { id: 'second' }); assert.equal((await f.panelStore.mail()).defaultAccount, 'second');
    assert.equal((await f.request('accounts/second', 'DELETE')).status, 200);
    assert.equal((await f.panelStore.mail()).defaultAccount, 'first');
    const restarted = await new PanelStore(f.directory, key, async () => f.base).init();
    assert.equal((await restarted.view({ mcpUrl: f.url, authType: 'apiKey' })).connection.mcpUrl, mcpUrl);
    assert.equal((await restarted.mail()).accounts.length, 1);
    assert.equal((await f.request('default', 'PUT', { id: 'missing' })).status, 400);
  } finally { await f.dispose(); }
});
test('panel includes existing config accounts, does not override their credentials or delete them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-panel-config-'));
  try {
    const store = await new PanelStore(directory, key, async () => config).init();
    const view = await store.view({ mcpUrl: 'https://mail.example.com/mcp', authType: 'apiKey' });
    assert.equal(view.accounts[0].editable, false);
    await assert.rejects(store.saveAccount(mailbox('test')), /新的账号 ID/);
    await assert.rejects(store.deleteAccount('test'), /配置|面板/);
    assert.equal((await store.mail()).accounts[0].imap.passwordEnv, 'TEST_PASSWORD');
  } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
});
test('connection verifier handles missing credentials safely before contacting a server', async () => {
  const result = await verifyMailbox({ account: config.accounts[0], credentials: () => { throw new Error('private-mailbox-password'); } });
  assert.deepEqual(result, { imap: false, smtp: false });
});
