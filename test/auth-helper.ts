import { generateKeyPair, createLocalJWKSet, exportJWK, SignJWT } from 'jose';
import { randomUUID } from 'node:crypto';
export async function testAuth() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const provider = { issuer: 'https://mail.example.com/auth', jwksUrl: 'https://mail.example.com/auth/jwks', resource: 'https://mail.example.com/mail-mcp', clientId: 'test', allowedSubjects: ['owner'] };
  const token = await new SignJWT({ sub: 'owner', client_id: 'test', scp: ['mail.read', 'mail.write'] })
    .setProtectedHeader({ alg: 'RS256', typ: 'at+jwt', kid: 'test' }).setIssuer(provider.issuer).setAudience(provider.resource)
    .setIssuedAt().setExpirationTime('1h').setJti(randomUUID()).sign(privateKey);
  return { token, oauth: { enabled: true as const, mcpPath: '/mail-mcp', routePrefix: '/mail-mcp', provider },
    resolver: createLocalJWKSet({ keys: [{ ...await exportJWK(publicKey), kid: 'test', alg: 'RS256' }] }) };
}
