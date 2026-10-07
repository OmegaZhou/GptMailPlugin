import { writeFile, mkdir } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../server/server.js';

const server = createServer(); const client = new Client({ name: 'api-export', version: '0.2.1' });
const [left, right] = InMemoryTransport.createLinkedPair();
await server.connect(right); await client.connect(left);
try {
  const { tools } = await client.listTools();
  await mkdir('server/api', { recursive: true });
  await writeFile('server/api/tools.json', JSON.stringify({ version: '0.2.1', tools }, null, 2) + '\n');
  const response = { description: 'MCP CallToolResult: success structuredContent, or isError:true with safe error text. A write may be partially complete; inspect returned per-item results.', content: {
    'application/json': { schema: { type: 'object', properties: { isError: { type: 'boolean' }, content: { type: 'array', items: { type: 'object' } }, structuredContent: { type: 'object', additionalProperties: true } } } },
  } };
  const paths: Record<string, any> = {
    '/tools': { get: { operationId: 'list_tools', summary: 'List tools after API-key authentication', responses: { 200: { description: 'Tools with input JSON schemas and annotations' }, 401: { description: 'Missing/invalid API key' } } } },
  };
  for (const tool of tools) paths['/tools/' + tool.name] = { post: {
    operationId: tool.name, summary: tool.description,
    requestBody: { required: true, content: { 'application/json': { schema: tool.inputSchema } } },
    responses: { 200: response, 400: { description: 'Invalid arguments or unavailable tool' }, 401: { description: 'Missing/invalid API key' } },
  } };
  await writeFile('server/api/openapi.json', JSON.stringify({
    openapi: '3.1.0', info: { title: 'GptMail Hosted API', version: '0.2.1', description: 'Configurable single-owner IMAP/SMTP mail service. Base URL is supplied by the caller; no hardcoded production endpoint.' },
    // Relative server preserves configurability; callers set server/address.json apiBaseUrl.
    servers: [{ url: '/api/v1' }], security: [{ bearerAuth: [] }],
    components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key from server/config.json; configured separately per plugin/client.' } } }, paths,
  }, null, 2) + '\n');
} finally { await client.close(); await server.close(); }

// Schemas for the OAuth endpoint, without any configured issuer or credentials.
const oauthServer = createServer(undefined, { scopes: [], metadataUrl: '' });
const oauthClient = new Client({ name: 'oauth-api-export', version: '0.2.1' });
const [oauthLeft, oauthRight] = InMemoryTransport.createLinkedPair();
await oauthServer.connect(oauthRight); await oauthClient.connect(oauthLeft);
try {
  const { tools } = await oauthClient.listTools();
  await writeFile('server/api/chatgpt-tools.json', JSON.stringify({ version: '0.2.1', tools: tools.map(tool => ({ ...tool, securitySchemes: tool._meta?.securitySchemes })) }, null, 2) + '\n');
} finally { await oauthClient.close(); await oauthServer.close(); }
