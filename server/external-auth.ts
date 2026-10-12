import { createHash } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';

const endpoint = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash;
}, 'Authentication endpoints must be HTTPS URLs without credentials, queries or fragments.');

export const externalAuthSchema = z.object({
  issuer: endpoint,
  jwksUrl: endpoint,
  resource: endpoint,
  clientId: z.string().min(1).max(512),
  // This is a personal mailbox service, not a shared mailbox pool for every IdP user.
  allowedSubjects: z.array(z.string().min(1).max(512)).min(1).max(10),
  accountNames: z.record(z.string(), z.string().trim().min(1).max(100)).optional(),
}).strict();
export type ExternalAuthConfig = z.infer<typeof externalAuthSchema>;

/** Validate the configured issuer's RFC 9068 access tokens; never accept an OIDC ID token. */
export class ExternalTokenVerifier {
  readonly config: ExternalAuthConfig;
  private readonly key: JWTVerifyGetKey;
  constructor(config: ExternalAuthConfig, key?: JWTVerifyGetKey) {
    this.config = externalAuthSchema.parse(config);
    this.key = key || createRemoteJWKSet(new URL(this.config.jwksUrl), {
      timeoutDuration: 5000, cooldownDuration: 30000, cacheMaxAge: 300000,
    });
  }
  async verifyAccessToken(token: string): Promise<AuthInfo> {
    let stage = 'signature_claims';
    try {
      if (!token || token.length > 16384) throw new Error();
      const { payload } = await jwtVerify(token, this.key, {
        algorithms: ['RS256'], typ: 'at+jwt', issuer: this.config.issuer,
        audience: this.config.resource,
        requiredClaims: ['sub', 'client_id', 'iat', 'exp', 'jti'],
        clockTolerance: 5,
      });
      stage = 'owner_client_scope';
      // Authelia emits scp as an array; RFC 9068 providers may emit scope as a string.
      const rawScopes = payload.scp === undefined
        ? (typeof payload.scope === 'string' ? payload.scope.split(/\s+/) : undefined)
        : (Array.isArray(payload.scp) && payload.scp.every(value => typeof value === 'string' && value.length > 0 && !/\s/.test(value)) ? payload.scp as string[] : undefined);
      if (!rawScopes || (payload.scp !== undefined && payload.scope !== undefined)) throw new Error();
      if (typeof payload.sub !== 'string' || !this.config.allowedSubjects.includes(payload.sub) ||
          payload.client_id !== this.config.clientId ||
          typeof payload.jti !== 'string' || !payload.jti ||
          !Number.isFinite(payload.iat) || !Number.isFinite(payload.exp) ||
          payload.exp! <= payload.iat! || payload.iat! > Date.now() / 1000 + 5) throw new Error();
      const scopes = [...new Set(rawScopes)].filter(scope => ['mail.read', 'mail.write'].includes(scope));
      if (!scopes.length) throw new Error();
      const ownerId = createHash('sha256').update(this.config.issuer + '\0' + payload.sub).digest('hex');
      return { token, clientId: this.config.clientId, scopes, expiresAt: payload.exp,
        resource: new URL(this.config.resource), extra: { ownerId,
          accountName: this.config.accountNames?.[payload.sub] || '服务器所有者' } };
    } catch (error) {
      // Fixed diagnostic categories only: never log tokens, claims or exception messages.
      const knownCodes = ['ERR_JWT_CLAIM_VALIDATION_FAILED', 'ERR_JWT_EXPIRED', 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED', 'ERR_JWKS_TIMEOUT', 'ERR_JWKS_NO_MATCHING_KEY'];
      const code = error && typeof error === 'object' && 'code' in error && knownCodes.includes(String(error.code)) ? String(error.code) : 'REJECTED';
      process.stderr.write(`OAuth verification failed: ${stage} ${code}\n`);
      // Do not echo JWT claims, tokens, private endpoints or library error details.
      throw new InvalidTokenError('Invalid or unauthorized access token.');
    }
  }
}
