import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { connectionSchema, panelAccountSchema } from '../server/panel-store.js';

export async function exportPanelApi() {
  const object = (properties: Record<string, unknown>, required: string[] = Object.keys(properties)) => ({ type: 'object', properties, required, additionalProperties: false });
  const body = (schema: unknown) => ({ required: true, content: { 'application/json': { schema } } });
  const json = (schema: unknown) => ({ description: 'Success; no mailbox credentials or server key in response', content: { 'application/json': { schema } } });
  const response = { 200: json({ type: 'object' }), 400: { description: 'Invalid configuration' }, 401: { description: 'Owner session required' },
    403: { description: 'Origin or CSRF validation failed' }, 429: { description: 'Rate limited' }, 500: { description: 'Safe generic server error' } };
  const csrf = { in: 'header', name: 'X-Panel-CSRF', required: true, schema: { type: 'string' } };
  const origin = { in: 'header', name: 'Origin', required: true, schema: { type: 'string' }, description: 'Exact panel origin' };
  const mutation = (operationId: string, summary: string, schema?: unknown, parameters: unknown[] = []) => ({ operationId, summary,
    parameters: [origin, csrf, ...parameters], ...(schema ? { requestBody: body(schema) } : {}), responses: response });
  const id = object({ id: { type: 'string' } });
  const testInput = { oneOf: [id, object({ account: { $ref: '#/components/schemas/PanelAccount' } })] };
  await writeFile('server/api/panel-openapi.json', JSON.stringify({ openapi: '3.1.0',
    info: { title: 'GptMail Owner Panel API', version: '0.3.0', description: 'Private browser administration. Relative base is prefixed by oauth.routePrefix at deployment. Credentials are never returned to clients or exposed as MCP tools.' },
    servers: [{ url: '/panel/api' }], security: [{ ownerSession: [] }],
    components: { securitySchemes: { ownerSession: { type: 'apiKey', in: 'cookie', name: 'gpt_mail_panel' } }, schemas: {
      PanelAccount: { ...z.toJSONSchema(panelAccountSchema), description: 'New accounts require secrets for both endpoints. Empty secrets on edits preserve credentials only when the target and credential type stay unchanged.' },
      Connection: z.toJSONSchema(connectionSchema),
    } }, paths: {
      '/session': { post: { operationId: 'panel_login', summary: 'Log in with the existing server key', security: [], parameters: [origin],
        requestBody: body(object({ apiKey: { type: 'string', minLength: 32, maxLength: 512, writeOnly: true } })),
        responses: { ...response, 200: json(object({ csrf: { type: 'string' } })) } },
        delete: mutation('panel_logout', 'End the owner session') },
      '/state': { get: { operationId: 'panel_state', summary: 'Get client settings, redacted accounts, endpoints and session CSRF value', responses: response } },
      '/connection': { put: mutation('panel_connection', 'Save client MCP URL and authentication mode', { $ref: '#/components/schemas/Connection' }) },
      '/accounts': { post: mutation('panel_save_account', 'Add or update a panel-managed mailbox without restarting', { $ref: '#/components/schemas/PanelAccount' }) },
      '/accounts/{id}': { delete: mutation('panel_delete_account', 'Remove a panel-managed connection without deleting mail', undefined,
        [{ in: 'path', name: 'id', required: true, schema: { type: 'string' } }]) },
      '/default': { put: mutation('panel_default', 'Select a default mailbox', id) },
      '/test': { post: { ...mutation('panel_test', 'Check IMAP and SMTP authentication; never send mail or persist input', testInput),
        responses: { ...response, 200: json(object({ imap: { type: 'boolean' }, smtp: { type: 'boolean' } })) } } },
    },
  }, null, 2) + '\n');
}
