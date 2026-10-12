import { z } from 'zod';
import { externalAuthSchema } from './external-auth.js';

export const mailScopes = ['mail.read', 'mail.write'];
const mcpPathSchema = z.string().max(200).regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/)
  .refine(path => !['/mcp', '/healthz'].includes(path) && !['/panel', '/authorize', '/token', '/register', '/revoke', '/oauth', '/api/v1/tools'].some(reserved => path === reserved || path.startsWith(reserved + '/')), 'OAuth MCP path conflicts with an existing endpoint');
export const oauthConfigSchema = z.object({
  enabled: z.literal(true),
  mcpPath: mcpPathSchema.optional(),
  routePrefix: z.union([z.literal(''), z.string().max(200).regex(/^\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+$/)]).optional(),
  provider: externalAuthSchema,
}).strict().superRefine((value, ctx) => {
  if (value.enabled && !value.provider) ctx.addIssue({ code: 'custom', message: 'Enabled OAuth requires an external account provider.', path: ['provider'] });
});
