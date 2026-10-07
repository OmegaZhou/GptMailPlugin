import express from 'express';
import { createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { MailOAuthProvider, mailScopes } from './oauth.js';

// RFC 8414 inserts /.well-known before an issuer's path; auth endpoints can share a site prefix.
export function mailOAuthRouter(provider: MailOAuthProvider, prefix: string) {
  const router = express.Router();
  const endpoint = (name: string) => new URL(`${prefix}/${name}`, provider.issuer).href;
  const metadata = { ...createOAuthMetadata({ provider, issuerUrl: provider.issuer, scopesSupported: mailScopes }),
    authorization_endpoint: endpoint('authorize'), token_endpoint: endpoint('token'),
    registration_endpoint: endpoint('register'), revocation_endpoint: endpoint('revoke'),
    revocation_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  };
  router.get(`/.well-known/oauth-authorization-server${prefix}`, (_req, res) => res.json(metadata));
  if (prefix) router.get(`${prefix}/.well-known/oauth-authorization-server`, (_req, res) => res.json(metadata));
  router.get(new URL(getOAuthProtectedResourceMetadataUrl(provider.resource)).pathname, (_req, res) => res.json({
    resource: provider.resource.href, authorization_servers: [provider.issuer.href],
    scopes_supported: mailScopes, resource_name: 'GptMail', bearer_methods_supported: ['header'],
  }));
  router.use(`${prefix}/authorize`, authorizationHandler({ provider }));
  router.use(`${prefix}/token`, tokenHandler({ provider }));
  router.use(`${prefix}/register`, clientRegistrationHandler({ clientsStore: provider.clientsStore, clientSecretExpirySeconds: 0 }));
  router.use(`${prefix}/revoke`, revocationHandler({ provider }));
  router.use(provider.consentRouter());
  return router;
}
