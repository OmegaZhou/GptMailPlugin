import test from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error release helper is a plain JavaScript module
import { bindHostedApp } from '../scripts/package-binding.mjs';

test('private app binding injects the release link without leaking extra configuration', () => {
  const appId = 'asdk_app_' + 'a'.repeat(32);
  const manifest = { extensions: { 'com.openai': { interface: {}, mcpServers: './mcp.json' } } };
  const overlay = { interface: {}, mcpServers: './mcp.json' };
  const output = bindHostedApp(manifest, overlay, { apps: { 'gpt-mail': { id: appId, required: true } } });
  assert.deepEqual(output, { apps: { 'gpt-mail': { id: appId, required: true } } });
  assert.equal((overlay.interface as Record<string, string>).websiteURL, `https://chatgpt.com/mcp-app/${appId}/open_settings`);
  assert.ok(!('mcpServers' in overlay));
  for (const binding of [
    { apps: { 'gpt-mail': { id: appId, required: true, token: 'test-secret' } } },
    { apps: { 'gpt-mail': { id: '../bad', required: true } } },
    { apps: { 'gpt-mail': { id: appId, required: true } }, password: 'test-secret' },
  ]) assert.throws(() => bindHostedApp(manifest, overlay, binding));
});
