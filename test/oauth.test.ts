import { request as httpRequest } from 'node:http';
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { httpConfigSchema, createHttpApp } from '../server/http.js';
import { MailService } from '../server/service.js';
import { FakeImap } from './helpers.js';
import type { Config } from '../server/config.js';

const provider = { issuer: 'https://mail.example.com/mailauth', jwksUrl: 'https://mail.example.com/mailauth/jwks.json',
  resource: 'https://mail.example.com/mail-mcp', clientId: 'gptmail-chatgpt', allowedSubjects: ['owner-id'], accountNames: { 'owner-id': 'Private owner name' } };
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'gptmail-external-'));
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const mail = { accounts: [], maxMessageBytes: 26214400 };
  let readConfig: () => Promise<Config> = async () => mail;
  const service = new MailService(() => readConfig(), () => new FakeImap().asClient());
  const key = 'storage-and-rest-secret-' + 'x'.repeat(40);
  const { app, settingsStore } = await createHttpApp({ storageKey: key, mail,
    http: { publicUrl: 'https://mail.example.com', port: 3000, bindHost: '127.0.0.1', trustProxy: 0, allowedOrigins: [] },
    oauth: { enabled: true, mcpPath: '/mail-mcp', routePrefix: '/mail-mcp', provider } }, service, directory, undefined,
    createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] }));
  readConfig = () => settingsStore.mail();
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const base = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const token = (claims: Record<string, unknown> = {}) => new SignJWT({ iss: provider.issuer, aud: provider.resource,
    sub: 'owner-id', client_id: provider.clientId, scope: 'openid profile mail.read mail.write', ...claims })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'test' }).setIssuedAt().setExpirationTime('1h').setJti(randomUUID()).sign(privateKey);
  const request = (path: string, access?: string, body?: unknown): Promise<Response> => new Promise((resolve, reject) => {
    const req = httpRequest(base + path, { method: body ? 'POST' : 'GET', headers: {
      Host: 'mail.example.com', Accept: 'application/json, text/event-stream',
      ...(access ? { Authorization: 'Bearer ' + access } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    } }, res => {
      const chunks: Buffer[] = [];
      res.on('data', chunk => chunks.push(chunk)); res.on('error', reject);
      res.on('end', () => resolve(new Response(Buffer.concat(chunks), {
        status: res.statusCode!, headers: Object.fromEntries(Object.entries(res.headers).filter(([,v]) => v !== undefined).map(([k,v]) => [k, Array.isArray(v) ? v.join(', ') : v!])),
      })));
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  const call = async (access: string, name: string, args = {}) => {
    const response = await request('/mail-mcp', access, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } });
    assert.equal(response.status, 200); return (await response.json() as any).result;
  };
  return { key, token, request, call, dispose: async () => {
    await new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  } };
}

test('HTTP MCP discovers external authorization and rejects wrong credentials without exposing a local login', async () => {
  const f = await fixture();
  try {
    const metadata = await (await f.request('/.well-known/oauth-protected-resource/mail-mcp')).json() as any;
    assert.deepEqual(metadata.authorization_servers, [provider.issuer]); assert.equal(metadata.resource, provider.resource);
    for (const access of [undefined, f.key, await f.token({ sub: 'other-user' }), await f.token({ aud: 'https://other.example.com/mcp' })]) {
      const response = await f.request('/mail-mcp', access, { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
      assert.equal(response.status, 401); assert.ok(response.headers.get('www-authenticate')?.includes('resource_metadata'));
    }
    for (const path of ['/authorize', '/token', '/register', '/revoke', '/oauth/approve', '/panel/'])
      assert.equal((await f.request('/mail-mcp' + path)).status, 404);
    const access = await f.token({ scope: 'mail.read' });
    const view = await f.call(access, 'settings_bootstrap');
    assert.equal(view._meta.settings.authenticated, false);
    const denied = await f.call(access, 'settings_save_account', { session: 'x'.repeat(43), account: mailbox('denied') });
    assert.equal(denied.isError, true); assert.equal(denied._meta.settings.status, 403);
  } finally { await f.dispose(); }
});

const mailbox = (id: string) => ({ id, email: `${id}@example.com`,
  imap: { host: 'imap.example.com', port: 993, secure: true, credentialType: 'password', secret: 'test-only-mail-password' },
  smtp: { host: 'smtp.example.com', port: 465, secure: true, credentialType: 'password', secret: 'test-only-mail-password' } });

test('one authenticated owner adds two mailboxes and keeps the panel session after token refresh', async () => {
  const f = await fixture();
  try {
    const access = await f.token();
    const bootstrap = await f.call(access, 'settings_bootstrap');
    assert.equal(bootstrap._meta.settings.authenticated, true);
    assert.deepEqual(bootstrap.content, []); assert.equal(bootstrap.structuredContent, undefined);
    assert.equal(bootstrap._meta.settings.state.activeConnection.accountName, 'Private owner name');
    assert.ok(!JSON.stringify(bootstrap).includes(f.key));
    const session = bootstrap._meta.settings.session;
    for (const id of ['first', 'second']) {
      const response = await f.call(access, 'settings_save_account', { session, account: mailbox(id) });
      assert.ok(!response.isError); assert.ok(!JSON.stringify(response).includes('test-only-mail-password'));
    }
    const list = await f.call(access, 'list_accounts');
    assert.equal(list.structuredContent.accounts.length, 2);
    const refreshed = await f.token();
    const state = await f.call(refreshed, 'settings_state', { session });
    assert.equal(state._meta.settings.accounts.length, 2);
    assert.equal(state._meta.settings.activeConnection.accountName, 'Private owner name');
    const profile = await f.call(access, 'get_connection_profile');
    const nextProfile = await f.call(refreshed, 'get_connection_profile');
    assert.deepEqual(profile.structuredContent, nextProfile.structuredContent);
    assert.ok(!JSON.stringify(profile).includes('owner-id'));
    assert.ok(!JSON.stringify(profile).includes('Private owner name'));
  } finally { await f.dispose(); }
});


test('all REST and MCP aliases reject fixed keys and enforce token scopes', async () => {
  const f = await fixture();
  try {
    for (const path of ['/api/v1/tools', '/mail-mcp/api/v1/tools', '/mcp', '/mail-mcp/mcp']) {
      for (const token of [undefined, f.key, await f.token({ aud: 'https://other.example.com/mcp' })])
        assert.equal((await f.request(path, token, path.endsWith('/mcp') ? { jsonrpc: '2.0', id: 1, method: 'tools/list' } : undefined)).status, 401);
    }
    const read = await f.token({ scope: 'mail.read' });
    const write = await f.token({ scope: 'mail.write' });
    const args = { account_id: 'missing', to: 'test@example.com', subject: 'test', text: 'test', operation_id: randomUUID() };
    for (const prefix of ['', '/mail-mcp']) {
      assert.equal((await f.request(prefix + '/api/v1/tools', read)).status, 200);
      const result: any = await (await f.request(prefix + '/api/v1/tools/send_email', read, args)).json();
      assert.equal(result.isError, true);
      assert.match(JSON.stringify(result._meta), /insufficient_scope/);
      const noRead: any = await (await f.request(prefix + '/api/v1/tools/list_accounts', write, {})).json();
      assert.equal(noRead.isError, true); assert.match(JSON.stringify(noRead._meta), /insufficient_scope/);
    }
    for (const path of ['/mcp', '/mail-mcp/mcp']) {
      const response = await f.request(path, read, { jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'send_email', arguments: args } });
      const result: any = await response.json();
      assert.equal(result.result.isError, true); assert.match(JSON.stringify(result.result._meta), /insufficient_scope/);
    }
    assert.equal(httpConfigSchema.safeParse({ storageKey: f.key, mail: { accounts: [] } }).success, false);
    assert.equal(httpConfigSchema.safeParse({ apiKey: f.key, mail: { accounts: [] }, oauth: { enabled: false } }).success, false);
  } finally { await f.dispose(); }
});
