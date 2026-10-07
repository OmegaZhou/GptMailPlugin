import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { once } from 'node:events';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../server/http.js';
import { MailOAuthProvider } from '../server/oauth.js';
import { MailService } from '../server/service.js';
import { FakeImap, config } from './helpers.js';
import { connectionConfig } from '../scripts/connection.mjs';

const key = 'test-api-key-' + 'x'.repeat(40);
const redirectUri = 'https://chatgpt.com/connector/oauth/test-callback';
const json = (body: unknown) => ({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
async function fixture(authMethod: 'none' | 'client_secret_post' = 'none', mcpPath = '/chatgpt/mcp', prefix = '', mail = config) {
  const directory = await mkdtemp(join(tmpdir(), 'gpt-mail-oauth-'));
  const http = createHttpServer(); http.listen(0, '127.0.0.1'); await once(http, 'listening');
  const url = `http://127.0.0.1:${(http.address() as { port: number }).port}`;
  const imap = new FakeImap(); const service = new MailService(async () => mail, () => imap.asClient());
  try {
    const { app, oauth } = await createHttpApp({ apiKey: key, http: { publicUrl: url, bindHost: '127.0.0.1', port: 3000, trustProxy: 0, allowedOrigins: [] },
      oauth: { enabled: true, mcpPath, routePrefix: prefix, redirectOrigins: ['https://chatgpt.com'] }, mail }, service, directory);
    http.on('request', app);
    const request = async (path: string, data: Record<string, string>) => fetch(url + prefix + path, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data) });
    const clientInfo: any = await (await fetch(url + prefix + '/register', json({ redirect_uris: [redirectUri], token_endpoint_auth_method: authMethod, client_name: '<test>', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] }))).json();
    assert.ok(clientInfo.client_id, JSON.stringify(clientInfo));
    async function authorize(scope = 'mail.read', overrides: Record<string, string> = {}) {
      const verifier = randomBytes(32).toString('base64url');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      const params = { client_id: clientInfo.client_id, redirect_uri: redirectUri, response_type: 'code', code_challenge_method: 'S256', code_challenge: challenge, scope, state: 'state value', resource: url + mcpPath, ...overrides };
      const response = await fetch(url + prefix + '/authorize?' + new URLSearchParams(params), { redirect: 'manual' });
      const html = await response.text();
      const nonce = /name="nonce" value="([^"]+)"/.exec(html)?.[1] || '';
      const cookie = response.headers.get('set-cookie')?.split(';')[0] || '';
      return { verifier, response, html, nonce, cookie };
    }
    async function approve(auth: Awaited<ReturnType<typeof authorize>>, data: Record<string, string> = {}, headers: Record<string, string> = {}) {
      return fetch(url + prefix + '/oauth/approve', { method: 'POST', redirect: 'manual', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Cookie: auth.cookie, Origin: url, ...headers }, body: new URLSearchParams({ nonce: auth.nonce, apiKey: key, decision: 'approve', ...data }) });
    }
    async function grant(scope = 'mail.read') {
      const auth = await authorize(scope); assert.equal(auth.response.status, 200);
      const consent = await approve(auth); assert.equal(consent.status, 303);
      const location = new URL(consent.headers.get('location')!); assert.equal(location.searchParams.get('state'), 'state value');
      const code = location.searchParams.get('code')!;
      const exchange = { client_id: clientInfo.client_id, grant_type: 'authorization_code', code, code_verifier: auth.verifier, redirect_uri: redirectUri, resource: url + mcpPath };
      const response = await request('/token', exchange); assert.equal(response.status, 200);
      const tokens: any = await response.json(); assert.ok(tokens.access_token); assert.ok(tokens.refresh_token);
      return { tokens, exchange };
    }
    return { url, imap, oauth: oauth!, directory, clientInfo, authorize, approve, grant, request,
      async close() { http.closeAllConnections(); await new Promise<void>((done, reject) => http.close(e => e ? reject(e) : done()));
        assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) {
    http.closeAllConnections(); await new Promise<void>(done => http.close(() => done()));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); throw error;
  }
}
async function mcp(url: string, token: string, path = '/chatgpt/mcp') {
  const client = new Client({ name: 'chatgpt-adapter-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(url + path), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
  return client;
}

test('OAuth discovery advertises PKCE, DCR and protected resource; API keys cannot enter ChatGPT route', async () => {
  const f = await fixture();
  try {
    for (const token of ['', key, 'wrong']) {
      const response = await fetch(f.url + '/chatgpt/mcp', { ...json({}), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' } });
      assert.equal(response.status, 401); assert.ok(response.headers.get('www-authenticate')?.includes('/.well-known/oauth-protected-resource/chatgpt/mcp'));
    }
    const metadata: any = await (await fetch(f.url + '/.well-known/oauth-protected-resource/chatgpt/mcp')).json();
    assert.equal(metadata.resource, f.url + '/chatgpt/mcp'); assert.deepEqual(metadata.scopes_supported, ['mail.read', 'mail.write']);
    const issuer: any = await (await fetch(f.url + '/.well-known/oauth-authorization-server')).json();
    assert.deepEqual(issuer.code_challenge_methods_supported, ['S256']); assert.equal(issuer.registration_endpoint, f.url + '/register');
    assert.equal((await fetch(f.url + '/register', json({ redirect_uris: ['https://attacker.example/callback'], token_endpoint_auth_method: 'none' }))).status, 400);
    assert.equal((await fetch(f.url + '/authorize?client_id=__proto__')).status, 400);
    const confidential: any = await (await fetch(f.url + '/register', json({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'client_secret_post' }))).json();
    assert.ok(confidential.client_secret); assert.equal(confidential.client_secret_expires_at, 0);
  } finally { await f.close(); }
});

test('OAuth consent escapes names, rejects wrong key/CSRF/origin and preserves state on denial', async () => {
  const f = await fixture();
  try {
    const auth = await f.authorize(); assert.equal(auth.response.status, 200); assert.ok(auth.html.includes('&lt;test&gt;'));
    assert.ok(!auth.html.includes(key)); assert.ok(auth.response.headers.get('content-security-policy')?.includes("frame-ancestors 'none'"));
    assert.equal((await f.approve(auth, { apiKey: 'wrong' })).status, 403);
    assert.equal((await f.approve(auth, { nonce: 'wrong' })).status, 403);
    assert.equal((await f.approve(auth, {}, { Cookie: '' })).status, 403);
    assert.equal((await f.approve(auth, {}, { Origin: 'https://attacker.example' })).status, 403);
    const denied = await f.approve(auth, { decision: 'deny', apiKey: '' });
    assert.equal(denied.status, 303); const location = new URL(denied.headers.get('location')!);
    assert.equal(location.searchParams.get('error'), 'access_denied'); assert.equal(location.searchParams.get('state'), 'state value'); assert.equal(location.searchParams.get('code'), null);
    assert.equal((await f.approve(auth)).status, 403);
    const wrongResource = await f.authorize('mail.read', { resource: f.url + '/mcp' });
    assert.equal(new URL(wrongResource.response.headers.get('location')!).searchParams.get('error'), 'invalid_target');
    assert.equal((await f.authorize('mail.read', { redirect_uri: 'https://chatgpt.com/unregistered' })).response.status, 400);
  } finally { await f.close(); }
});

test('OAuth code requires PKCE and audience, is single use; read scope gates write tools before IMAP', async () => {
  const f = await fixture();
  let client: Client | undefined;
  try {
    const auth = await f.authorize(); const approved = await f.approve(auth);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const exchange = { client_id: f.clientInfo.client_id, grant_type: 'authorization_code', code, code_verifier: auth.verifier, redirect_uri: redirectUri, resource: f.url + '/chatgpt/mcp' };
    assert.equal((await f.request('/token', { ...exchange, code_verifier: 'x'.repeat(43) })).status, 400);
    assert.equal((await f.request('/token', { ...exchange, code_verifier: 'x' })).status, 400);
    assert.equal((await f.request('/token', { ...exchange, resource: f.url + '/mcp' })).status, 400);
    assert.equal((await f.request('/token', { ...exchange, redirect_uri: redirectUri + 'wrong' })).status, 400);
    const other: any = await (await fetch(f.url + '/register', json({ redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }))).json();
    assert.equal((await f.request('/token', { ...exchange, client_id: other.client_id })).status, 400);
    const tokens: any = await (await f.request('/token', exchange)).json(); assert.ok(tokens.access_token);
    assert.equal((await f.request('/token', exchange)).status, 400);
    client = await mcp(f.url, tokens.access_token);
    const { tools } = await client.listTools(); assert.equal(tools.length, 21);
    const write: any = tools.find(t => t.name === 'create_label');
    assert.deepEqual(write._meta.securitySchemes, [{ type: 'oauth2', scopes: ['mail.write'] }]);
    // SDK 1.x clients strip unknown top-level fields; verify the actual wire response used by ChatGPT.
    const wire: any = await (await fetch(f.url + '/chatgpt/mcp', { ...json({ jsonrpc: '2.0', id: 42, method: 'tools/list' }),
      headers: { Authorization: 'Bearer ' + tokens.access_token, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' } })).json();
    assert.deepEqual(wire.result.tools.find((t: any) => t.name === 'create_label').securitySchemes, write._meta.securitySchemes);
    const profile: any = await client.callTool({ name: 'get_profile', arguments: {} }); assert.equal(profile.structuredContent.email, 'owner@example.com');
    const blocked: any = await client.callTool({ name: 'create_label', arguments: { name: 'Blocked' } });
    assert.equal(blocked.isError, true); assert.ok(blocked._meta['mcp/www_authenticate'][0].includes('scope="mail.write"')); assert.ok(!f.imap.data.has('Blocked'));
    assert.equal((await fetch(f.url + '/api/v1/tools', { headers: { Authorization: 'Bearer ' + tokens.access_token } })).status, 401);
    await client.close(); client = undefined;
    const full = await f.grant('mail.read mail.write'); client = await mcp(f.url, full.tokens.access_token);
    const created: any = await client.callTool({ name: 'create_label', arguments: { name: 'Allowed' } }); assert.ok(!created.isError); assert.ok(f.imap.data.has('Allowed'));
  } finally { await client?.close(); await f.close(); }
});

test('OAuth refresh rotates tokens, prevents scope expansion and revokes family on replay or explicit revocation', async () => {
  const f = await fixture();
  try {
    const { tokens } = await f.grant();
    const refresh = { client_id: f.clientInfo.client_id, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: f.url + '/chatgpt/mcp' };
    assert.equal((await f.request('/token', { ...refresh, scope: 'mail.read mail.write' })).status, 400);
    assert.equal((await f.request('/token', { ...refresh, resource: f.url + '/mcp' })).status, 400);
    const rotated: any = await (await f.request('/token', refresh)).json(); assert.ok(rotated.refresh_token); assert.notEqual(rotated.refresh_token, tokens.refresh_token);
    await f.oauth.verifyAccessToken(rotated.access_token);
    assert.equal((await f.request('/token', refresh)).status, 400);
    await assert.rejects(f.oauth.verifyAccessToken(rotated.access_token)); await assert.rejects(f.oauth.verifyAccessToken(tokens.access_token));
    assert.equal((await f.request('/token', { ...refresh, refresh_token: rotated.refresh_token })).status, 400);
    const fresh = await f.grant();
    assert.equal((await f.request('/revoke', { client_id: f.clientInfo.client_id, token: fresh.tokens.refresh_token })).status, 200);
    await assert.rejects(f.oauth.verifyAccessToken(fresh.tokens.access_token));
  } finally { await f.close(); }
});

test('OAuth grants and clients survive restart; stored token hashes, expiry and key rotation are enforced', async () => {
  const f = await fixture();
  try {
    const { tokens } = await f.grant();
    const state = await readFile(join(f.directory, 'state.json'), 'utf8');
    for (const secret of [key, tokens.access_token, tokens.refresh_token]) assert.ok(!state.includes(secret));
    const restarted = await new MailOAuthProvider(new URL(f.url), key, ['https://chatgpt.com'], f.directory).init();
    assert.equal(restarted.clientsStore.getClient(f.clientInfo.client_id)?.client_id, f.clientInfo.client_id);
    assert.equal((await restarted.verifyAccessToken(tokens.access_token)).scopes[0], 'mail.read');
    const now = Math.floor(Date.now() / 1000);
    const expired = await new MailOAuthProvider(new URL(f.url), key, ['https://chatgpt.com'], f.directory, () => now + 3601).init();
    await assert.rejects(expired.verifyAccessToken(tokens.access_token));
    const fresh = await f.grant();
    const rotated = await new MailOAuthProvider(new URL(f.url), key + '-rotated', ['https://chatgpt.com'], f.directory).init();
    await assert.rejects(rotated.verifyAccessToken(fresh.tokens.access_token));
    assert.ok(rotated.clientsStore.getClient(f.clientInfo.client_id));
    await assert.rejects(rotated.exchangeRefreshToken(f.clientInfo, fresh.tokens.refresh_token, undefined, rotated.resource));
  } finally { await f.close(); }
});

test('OAuth plugin config uses a remote URL without API key headers; invalid authentication mode is rejected', () => {
  const mcp = connectionConfig({ authType: 'oauth', apiKey: key }, { chatgptMcpUrl: 'https://mail.example/chatgpt/mcp' });
  assert.equal(mcp.mcpServers['gpt-mail'].url, 'https://mail.example/chatgpt/mcp'); assert.equal(mcp.mcpServers['gpt-mail'].headers, undefined);
  assert.ok(!JSON.stringify(mcp).includes(key));
  assert.throws(() => connectionConfig({ authType: 'unknown' }));
});

test('Confidential OAuth clients require their persistent client secret for code exchange and refresh', async () => {
  const f = await fixture('client_secret_post');
  try {
    const auth = await f.authorize(); const approved = await f.approve(auth);
    const code = new URL(approved.headers.get('location')!).searchParams.get('code')!;
    const exchange = { client_id: f.clientInfo.client_id, grant_type: 'authorization_code', code, code_verifier: auth.verifier, redirect_uri: redirectUri, resource: f.url + '/chatgpt/mcp' };
    assert.ok(!(await f.request('/token', exchange)).ok);
    assert.ok(!(await f.request('/token', { ...exchange, client_secret: 'wrong' })).ok);
    const response = await f.request('/token', { ...exchange, client_secret: f.clientInfo.client_secret }); assert.equal(response.status, 200);
    const tokens: any = await response.json(); await f.oauth.verifyAccessToken(tokens.access_token);
    const restarted = await new MailOAuthProvider(new URL(f.url), key, ['https://chatgpt.com'], f.directory).init();
    assert.equal(restarted.clientsStore.getClient(f.clientInfo.client_id)?.client_secret, f.clientInfo.client_secret);
    const refreshed = await f.request('/token', { client_id: f.clientInfo.client_id, client_secret: f.clientInfo.client_secret, grant_type: 'refresh_token', refresh_token: tokens.refresh_token, resource: f.url + '/chatgpt/mcp' });
    assert.equal(refreshed.status, 200);
  } finally { await f.close(); }
});

test('Configurable ChatGPT MCP paths update discovery, token audience and the live tool endpoint', async () => {
  const path = '/integrations/mail'; const f = await fixture('none', path);
  let client: Client | undefined;
  try {
    const response = await fetch(f.url + path, json({})); assert.equal(response.status, 401);
    assert.ok(response.headers.get('www-authenticate')?.includes('/.well-known/oauth-protected-resource' + path));
    const metadata: any = await (await fetch(f.url + '/.well-known/oauth-protected-resource' + path)).json(); assert.equal(metadata.resource, f.url + path);
    const { tokens } = await f.grant(); client = await mcp(f.url, tokens.access_token, path);
    const profile: any = await client.callTool({ name: 'get_profile', arguments: {} }); assert.equal(profile.structuredContent.email, 'owner@example.com');
  } finally { await client?.close(); await f.close(); }
});

test('Site-prefix OAuth discovers its issuer and completes consent; an unconfigured service reports no accounts', async () => {
  const prefix = '/mail-mcp'; const f = await fixture('client_secret_post', prefix, prefix, { accounts: [], maxMessageBytes: config.maxMessageBytes });
  let client: Client | undefined;
  try {
    const issuer: any = await (await fetch(f.url + '/.well-known/oauth-authorization-server' + prefix)).json();
    assert.equal(issuer.issuer, f.url + prefix); assert.equal(issuer.authorization_endpoint, f.url + prefix + '/authorize');
    assert.equal(issuer.token_endpoint, f.url + prefix + '/token'); assert.equal(issuer.registration_endpoint, f.url + prefix + '/register');
    const resource: any = await (await fetch(f.url + '/.well-known/oauth-protected-resource' + prefix)).json();
    assert.deepEqual(resource.authorization_servers, [f.url + prefix]);
    const auth = await f.authorize(); assert.ok(auth.html.includes('action="/mail-mcp/oauth/approve"'));
    assert.ok(auth.response.headers.get('set-cookie')?.includes('Path=/mail-mcp/oauth/approve'));
    const consent = await f.approve(auth); assert.equal(consent.status, 303);
    const code = new URL(consent.headers.get('location')!).searchParams.get('code')!;
    const exchanged = await f.request('/token', { client_id: f.clientInfo.client_id, client_secret: f.clientInfo.client_secret, grant_type: 'authorization_code', code, code_verifier: auth.verifier, redirect_uri: redirectUri, resource: f.url + prefix });
    assert.equal(exchanged.status, 200); const tokens: any = await exchanged.json();
    client = await mcp(f.url, tokens.access_token, prefix);
    const accounts: any = await client.callTool({ name: 'list_accounts', arguments: {} }); assert.deepEqual(accounts.structuredContent.accounts, []);
    const profile: any = await client.callTool({ name: 'get_profile', arguments: {} }); assert.equal(profile.isError, true); assert.ok(profile.content[0].text.includes('No mailbox configured'));
    assert.equal(f.imap.calls.length, 0);
    assert.equal((await fetch(f.url + prefix + '/healthz')).status, 200);
    const rest: any = await (await fetch(f.url + prefix + '/api/v1/tools/list_accounts', { ...json({}), headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key } })).json();
    assert.deepEqual(rest.structuredContent.accounts, []);
  } finally { await client?.close(); await f.close(); }
});
