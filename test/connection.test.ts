import test from 'node:test';
import assert from 'node:assert/strict';
import { connectionConfig } from '../scripts/connection.mjs';

const config = { apiUrl: 'https://mail.example.com/mail-mcp', issuer: 'https://mail.example.com/mailauth', clientId: 'test-client' };
test('portable connection declares the external registered OAuth client and persistent scopes', () => {
  const server = connectionConfig(config).mcpServers['gpt-mail'];
  assert.equal(server.url, config.apiUrl);
  assert.ok(!('headers' in server));
  assert.deepEqual(server.extensions['com.openai'].auth.client, { mode: 'provided', clientId: 'test-client', tokenEndpointAuthMethod: 'none' });
  assert.deepEqual(server.extensions['com.openai'].auth.baseScopes, ['openid', 'offline_access', 'mail.read', 'mail.write']);
  assert.equal(server.extensions['com.openai'].auth.oidcConfigurationUrl, config.issuer + '/.well-known/openid-configuration');
});
test('connection generator rejects embedded credentials, legacy keys and missing registration', () => {
  for (const change of [ { apiKey: 'secret' }, { clientSecret: 'secret' }, { authType: 'apiKey' },
    { clientId: '' }, { issuer: 'http://mail.example.com' }, { issuer: 'https://user:secret@mail.example.com' },
    { apiUrl: 'https://user:secret@mail.example.com/mail-mcp' }, { apiUrl: 'https://mail.example.com/mail-mcp?token=secret' } ])
    assert.throws(() => connectionConfig({ ...config, ...change }));
});
