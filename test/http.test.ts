import test from 'node:test';
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
  const imap = new FakeImap(); const service = new MailService(async () => config, () => imap.asClient());
  const { app } = await createHttpApp({ apiKey: key, http: { bindHost: '127.0.0.1', port: 3000, trustProxy: 0, allowedOrigins: [] }, mail: config }, service);
  const http = app.listen(0, '127.0.0.1'); await once(http, 'listening');
  const address = http.address() as { port: number };
  return { http, url: `http://127.0.0.1:${address.port}` };
}
const close = (http: Server) => new Promise<void>((resolve, reject) => http.close(error => error ? reject(error) : resolve()));
test('REST requires Bearer API key; missing/wrong keys cannot list tools or invoke mail', async () => {
  const { http, url } = await fixture();
  try {
    for (const path of ['/mcp', '/api/v1/tools', '/api/v1/tools/get_profile']) {
      const response = await fetch(url + path, { method: path.includes('get_profile') || path === '/mcp' ? 'POST' : 'GET' });
      assert.equal(response.status, 401); assert.ok(response.headers.get('www-authenticate')?.includes('Bearer'));
    }
    assert.equal((await fetch(url + '/api/v1/tools', { headers: { Authorization: 'Bearer wrong-key' } })).status, 401);
    const response = await fetch(url + '/api/v1/tools', { headers: { Authorization: 'Bearer ' + key } });
    assert.equal(response.status, 200); assert.equal((await response.json() as any).tools.length, 21);
    const profile = await fetch(url + '/api/v1/tools/get_profile', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal((await profile.json() as any).structuredContent.email, 'owner@example.com');
    const invalid = await fetch(url + '/api/v1/tools/read_email', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: '{}' });
    const result: any = await invalid.json();
    assert.ok(invalid.status === 400 || result.isError === true);
    assert.equal((await fetch(url + '/api/v1/tools', { headers: { Authorization: 'Bearer ' + key, Origin: 'https://attacker.example' } })).status, 403);
  } finally { await close(http); }
});
test('remote MCP supports initialize, discovery and harmless tool calls using header authentication', async () => {
  const { http, url } = await fixture();
  const client = new Client({ name: 'remote-test', version: '1.0.0' });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + key } } }));
    const tools = await client.listTools(); assert.equal(tools.tools.length, 21);
    const result: any = await client.callTool({ name: 'list_accounts', arguments: {} });
    assert.equal(result.structuredContent.accounts[0].account_id, 'test');
    assert.ok(!JSON.stringify(result).includes('passwordEnv')); assert.ok(!JSON.stringify(result).includes(key));
  } finally { await client.close(); await close(http); }
});
test('plugin configuration generates only a remote endpoint and a Bearer header', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gpt-mail-plugin-'));
  try {
    const path = join(directory, 'plugin.json');
    await writeFile(path, JSON.stringify({ apiUrl: 'https://mail.example.com/custom/mcp', apiKey: key }));
    const script = resolve('scripts/configure-plugin.mjs');
    const child = spawn(process.execPath, [script], { cwd: directory, env: { ...process.env, MAIL_PLUGIN_CONFIG: path } });
    let output = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data);
    const [code] = await once(child, 'exit'); assert.equal(code, 0, output); assert.ok(!output.includes(key));
    const mcp = JSON.parse(await readFile(join(directory, 'mcp.json'), 'utf8'));
    assert.equal(mcp.mcpServers['gpt-mail'].type, 'streamable-http'); assert.equal(mcp.mcpServers['gpt-mail'].url, 'https://mail.example.com/custom/mcp');
    assert.equal(mcp.mcpServers['gpt-mail'].headers.Authorization, 'Bearer ' + key); assert.equal(mcp.mcpServers['gpt-mail'].command, undefined);
  } finally { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); }
});
