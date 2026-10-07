import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, unzipSync } from 'fflate';

// Export a portable remote plugin. Runtime keys are deliberately excluded from exports.
const mcp = JSON.parse(await readFile('mcp.json', 'utf8'));
const endpoint = mcp.mcpServers?.['gpt-mail'];
if (endpoint?.type !== 'streamable-http' || !endpoint.url) throw new Error('Run npm run configure:plugin with your hosted endpoint first.');
const manifest = JSON.parse(await readFile('plugin.json', 'utf8'));
if (manifest.name !== 'gpt-mail' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid plugin identity/version');
if (manifest.extensions['com.openai'].interface.shortDescription.length > 30) throw new Error('Subtitle exceeds 30 characters');
const files = {};
const add = async path => { files[`gpt-mail/${path.replaceAll('\\', '/')}`] = new Uint8Array(await readFile(path)); };
const walk = async path => { for (const entry of await readdir(path, { withFileTypes: true })) {
  const child = join(path, entry.name); if (entry.isSymbolicLink()) throw new Error('Symlinks are forbidden');
  if (entry.isDirectory()) await walk(child); else await add(child);
} };
for (const path of ['plugin.json', '.codex-plugin/plugin.json', 'README.md', 'config/plugin.example.json', 'config/plugin.oauth.example.json', 'scripts/connection.mjs', 'scripts/configure-plugin.mjs']) await add(path);
files['gpt-mail/docs/chatgpt.md'] = new Uint8Array(await readFile('server/chatgpt.md'));
files['gpt-mail/docs/deployment.md'] = new Uint8Array(await readFile('deploy/README.md'));
for (const path of ['assets', 'skills']) await walk(path);
files['gpt-mail/mcp.json'] = new TextEncoder().encode(JSON.stringify({
  $schema: mcp.$schema, mcpServers: { 'gpt-mail': { type: 'streamable-http', url: endpoint.url } },
}, null, 2) + '\n');
files['gpt-mail/SETUP.md'] = new TextEncoder().encode(endpoint.headers?.Authorization
  ? 'This export excludes the API key. Before installation, copy config/plugin.example.json to config/plugin.json, set authType: apiKey, apiUrl and apiKey, then run node scripts/configure-plugin.mjs. A host must support custom Authorization headers. Never share a configured mcp.json.\n'
  : 'This plugin uses remote OAuth. The host must support MCP OAuth discovery and dynamic client registration. Connect the MCP URL, sign in on your server and approve mail access. For ChatGPT setup, see docs/chatgpt.md. No API key is embedded in this export.\n');
await mkdir('artifacts', { recursive: true });
const path = `artifacts/gpt-mail-${manifest.version}.zip`;
const zip = zipSync(files, { level: 6 });
const inspected = unzipSync(zip);
if (!inspected['gpt-mail/plugin.json'] || !inspected['gpt-mail/skills/mail/SKILL.md'] || !inspected['gpt-mail/mcp.json']) throw new Error('Incomplete archive');
if (Object.keys(inspected).some(p => /node_modules|accounts.json|\.env$|address.json|oauth.json|config\/plugin.json$|server\//.test(p))) throw new Error('Archive includes private server data');
await writeFile(path, zip);
console.log(`${path} (${Object.keys(inspected).length} files; API key excluded; configure authentication before installation)`);
