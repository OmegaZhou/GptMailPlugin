import test from 'node:test';
import assert from 'node:assert/strict';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { ExternalTokenVerifier } from '../server/external-auth.js';

test('external authentication validates resource, account, client and token type across refresh', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const wrong = await generateKeyPair('RS256');
  const config = { issuer: 'https://auth.example.com/mailauth', jwksUrl: 'https://auth.example.com/mailauth/jwks',
    resource: 'https://mail.example.com/mail-mcp', clientId: 'gptmail-chatgpt', allowedSubjects: ['owner-id'], accountNames: { 'owner-id': 'Private owner name' } };
  const verifier = new ExternalTokenVerifier(config, createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] }));
  const now = Math.floor(Date.now() / 1000);
  const issue = (claims: Record<string, unknown> = {}, typ = 'at+jwt', signingKey = privateKey) =>
    new SignJWT({ iss: config.issuer, aud: config.resource, sub: 'owner-id', client_id: config.clientId,
      scope: 'openid profile mail.read mail.write', iat: now, exp: now + 3600, jti: 'first', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'test', typ }).sign(signingKey);
  const first = await verifier.verifyAccessToken(await issue());
  const refreshed = await verifier.verifyAccessToken(await issue({ jti: 'refreshed', exp: now + 7200 }));
  assert.deepEqual(first.scopes, ['mail.read', 'mail.write']);
  assert.equal(first.extra?.accountName, 'Private owner name');
  assert.equal((await verifier.verifyAccessToken(await issue({ accountName: 'Untrusted override' }))).extra?.accountName, 'Private owner name');
  const authelia = await verifier.verifyAccessToken(await issue({ scope: undefined, scp: ['openid', 'offline_access', 'mail.read', 'mail.write'] }));
  assert.deepEqual(authelia.scopes, first.scopes);
  assert.equal(authelia.extra?.ownerId, first.extra?.ownerId);
  assert.equal(first.extra?.ownerId, refreshed.extra?.ownerId);
  assert.ok(!JSON.stringify(first.extra).includes('owner-id'));
  assert.deepEqual((await verifier.verifyAccessToken(await issue({ scope: 'mail.read' }))).scopes, ['mail.read']);
  for (const claims of [
    { iss: 'https://other.example.com' }, { aud: 'https://other.example.com/mcp' },
    { sub: 'another-user' }, { client_id: 'another-client' }, { exp: now - 60 },
    { scope: 'openid profile' }, { exp: undefined }, { jti: undefined },
    { iat: now + 100 }, { nbf: now + 100 },
    { scope: undefined, scp: 'mail.read' }, { scope: undefined, scp: ['mail.read', 7] },
    { scope: undefined, scp: ['mail.read mail.write'] }, { scp: ['mail.write'] },
  ]) await assert.rejects(verifier.verifyAccessToken(await issue(claims)), /Invalid or unauthorized/);
  await assert.rejects(verifier.verifyAccessToken(await issue({}, 'JWT')), /Invalid or unauthorized/);
  await assert.rejects(verifier.verifyAccessToken(await issue({}, 'at+jwt', wrong.privateKey)), /Invalid or unauthorized/);
  await assert.rejects(verifier.verifyAccessToken('not-a-token'), /Invalid or unauthorized/);
  assert.throws(() => new ExternalTokenVerifier({ ...config, allowedSubjects: [] }));
  assert.throws(() => new ExternalTokenVerifier({ ...config, jwksUrl: 'http://auth.example.com/jwks' }));
});
