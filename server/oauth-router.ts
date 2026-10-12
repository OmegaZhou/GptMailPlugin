import express from 'express';
import { getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { mailScopes } from './oauth.js';
import type { ExternalAuthConfig } from './external-auth.js';

// Login, grants and refresh belong to the external account service.
export function mailOAuthRouter(config: ExternalAuthConfig) {
  const router = express.Router();
  const resource = new URL(config.resource);
  router.get(new URL(getOAuthProtectedResourceMetadataUrl(resource)).pathname, (_req, res) => res.json({
    resource: resource.href, authorization_servers: [config.issuer],
    scopes_supported: ['openid', 'offline_access', ...mailScopes], resource_name: 'GptMail', bearer_methods_supported: ['header'],
  }));
  return router;
}
