import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { testAuth } from './auth-helper.js';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createHttpApp } from '../server/http.js';
import { MailService } from '../server/service.js';
import { FakeImap, config } from './helpers.js';

const key = 'test-api-key-' + 'x'.repeat(40);
async function fixture() {
  const auth = await testAuth();
  const directory = await mkdtemp(join(tmpdir(), 'mail-http-'));
  const imap = new FakeImap(); const service = new MailService(async () => config, () => imap.asClient());
  const { app } = await createHttpApp({ storageKey: key, oauth: auth.oauth, http: { publicUrl: 'https://mail.example.com', bindHost: '127.0.0.1', port: 3000, trustProxy: 0, allowedOrigins: [] }, mail: config }, service, directory, undefined, auth.resolver);
  const http = createHttpServer((req, res) => { req.headers.host = 'mail.example.com'; for (let i = 0; i < req.rawHeaders.length; i += 2) if (req.rawHeaders[i].toLowerCase() === 'host') req.rawHeaders[i + 1] = 'mail.example.com'; app(req, res); }).listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address() as { port: number };
  return { http, token: auth.token, directory, url: `http://127.0.0.1:${address.port}` };
}
const close = (http: Server) => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
test('REST requires an authentication-service token; missing/wrong keys cannot list tools or invoke mail', async () => {
  const { http, url, token, directory } = await fixture();
  try {
    for (const path of ['/mcp', '/api/v1/tools', '/api/v1/tools/get_profile']) {
      const response = await fetch(url + path, { method: path.includes('get_profile') || path === '/mcp' ? 'POST' : 'GET' });
      assert.equal(response.status, 401); assert.ok(response.headers.get('www-authenticate')?.includes('Bearer'));
    }
    assert.equal((await fetch(url + '/api/v1/tools', { headers: { Authorization: 'Bearer wrong-key' } })).status, 401);
    const response = await fetch(url + '/api/v1/tools', { headers: { Authorization: 'Bearer ' + token } });
    assert.equal(response.status, 200); assert.equal((await response.json() as any).tools.length, 21);
    const profile = await fetch(url + '/api/v1/tools/get_profile', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await profile.json() as any).structuredContent.email, 'owner@example.com');
    const invalid = await fetch(url + '/api/v1/tools/read_email', { method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}' });
    const result: any = await invalid.json();
    assert.ok(invalid.status === 400 || result.isError === true);
    assert.equal((await fetch(url + '/api/v1/tools', { headers: { Authorization: 'Bearer ' + token, Origin: 'https://attacker.example' } })).status, 403);
  } finally { await close(http); await rm(directory, { recursive: true, force: true }); }
});
test('remote MCP supports initialize, discovery and harmless tool calls using header authentication', async () => {
  const { http, url, token, directory } = await fixture();
  const client = new Client({ name: 'remote-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } }));
    const tools = await client.listTools(); assert.equal(tools.tools.filter(t => !t.name.startsWith('settings_') && t.name !== 'open_settings' && t.name !== 'get_connection_profile').length, 21);
    const result: any = await client.callTool({ name: 'list_accounts', arguments: {} });
    assert.equal(result.structuredContent.accounts[0].account_id, 'test');
    assert.ok(!JSON.stringify(result).includes('passwordEnv')); assert.ok(!JSON.stringify(result).includes(key));
  } finally { await client.close(); await close(http); await rm(directory, { recursive: true, force: true }); }
});
test('plugin configuration CLI generates remote OAuth without credentials or a local command', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gpt-mail-plugin-'));
  try {
    const path = join(directory, 'plugin.json');
    await writeFile(path, JSON.stringify({ apiUrl: 'https://mail.example.com/custom/mcp', issuer: 'https://mail.example.com/mailauth', clientId: 'test-client' }));
    const script = resolve('scripts/configure-plugin.mjs');
    const child = spawn(process.execPath, [script], { cwd: directory, env: { ...process.env, MAIL_PLUGIN_CONFIG: path } });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const [code] = await once(child, 'exit'); assert.equal(code, 0, output); assert.ok(!output.includes(key));
    const mcp = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers['gpt-mail'].type, 'streamable-http'); assert.equal(mcp.mcpServers['gpt-mail'].url, 'https://mail.example.com/custom/mcp');
    assert.equal(mcp.mcpServers['gpt-mail'].headers, undefined); assert.equal(mcp.mcpServers['gpt-mail'].command, undefined);
    const auth = mcp.mcpServers['gpt-mail'].extensions['com.openai'].auth;
    assert.equal(auth.type, 'oauth'); assert.equal(auth.client.clientId, 'test-client');
    assert.equal(auth.authorizationServerBase, 'https://mail.example.com/mailauth');
  } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
});
