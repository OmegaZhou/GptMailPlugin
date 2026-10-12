import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { zipSync, unzipSync } from 'fflate';
import { connectionConfig } from './connection.mjs';
import { bindHostedApp } from './package-binding.mjs';

// Export a portable remote plugin. Runtime keys are deliberately excluded from exports.
const mcp = JSON.parse(await readFile('mcp.json', 'utf8'));
const endpoint = mcp.mcpServers?.['gpt-mail'];
if (endpoint?.type !== 'streamable-http' || !endpoint.url) throw new Error('Run npm run configure:plugin with your hosted endpoint first.');
const manifest = JSON.parse(await readFile('plugin.json', 'utf8'));
if (manifest.name !== 'gpt-mail' || !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid plugin identity/version');
if (manifest.extensions['com.openai'].interface.shortDescription.length > 30) throw new Error('Subtitle exceeds 30 characters');
const files = {};
const appBindingPath = process.argv[2];
const appBinding = appBindingPath ? JSON.parse(await readFile(appBindingPath, 'utf8')) : null;
const auth = endpoint.extensions?.['com.openai']?.auth;
const exportedEndpoint = appBinding ? null : connectionConfig({
  apiUrl: endpoint.url, issuer: auth?.authorizationServerBase, clientId: auth?.client?.clientId,
}).mcpServers['gpt-mail'];
const add = async path => { files[`gpt-mail/${path.replaceAll('\\', '/')}`] = new Uint8Array(await readFile(path)); };
const walk = async path => { for (const entry of await readdir(path, { withFileTypes: true })) {
  const child = join(path, entry.name); if (entry.isSymbolicLink()) throw new Error('Symlinks are forbidden');
  if (entry.isDirectory()) await walk(child); else await add(child);
} };
for (const path of ['plugin.json', '.codex-plugin/plugin.json', 'README.md', 'config/plugin.example.json', 'config/plugin.oauth.example.json', 'scripts/connection.mjs', 'scripts/configure-plugin.mjs']) await add(path);
files['gpt-mail/docs/chatgpt.md'] = new Uint8Array(await readFile('server/chatgpt.md'));
files['gpt-mail/docs/deployment.md'] = new Uint8Array(await readFile('deploy/README.md'));
files['gpt-mail/docs/settings.md'] = new Uint8Array(await readFile('docs/settings.md'));
files['gpt-mail/docs/panel-source-research.md'] = new Uint8Array(await readFile('docs/panel-source-research.md'));
await add('ui/settings.html');
files['gpt-mail/docs/api/plugin-tools.json'] = new Uint8Array(await readFile('server/api/chatgpt-tools.json'));
for (const path of ['assets', 'skills']) await walk(path);
files['gpt-mail/mcp.json'] = new TextEncoder().encode(JSON.stringify({
  $schema: mcp.$schema, mcpServers: { 'gpt-mail': exportedEndpoint },
}, null, 2) + '\n');
files['gpt-mail/SETUP.md'] = new TextEncoder().encode('This plugin uses a pre-registered public OAuth client and the external authentication server. Sign in with your server account during connection. No password or API key is included. Packaging does not update an existing ChatGPT app registration; verify its OAuth configuration separately.\n');
if (appBinding) {
  const encode = value => new TextEncoder().encode(JSON.stringify(value, null, 2) + '\n');
  const overlay = JSON.parse(await readFile('.codex-plugin/plugin.json', 'utf8'));
  const exportedBinding = bindHostedApp(manifest, overlay, appBinding);
  files['gpt-mail/plugin.json'] = encode(manifest);
  files['gpt-mail/.codex-plugin/plugin.json'] = encode(overlay);
  files['gpt-mail/.app.json'] = encode(exportedBinding);
  delete files['gpt-mail/mcp.json'];
  files['gpt-mail/SETUP.md'] = new TextEncoder().encode('Connect the hosted service once through OAuth. Manage mailboxes in the plugin app panel; adding a mailbox does not require another OAuth connection. This private package uses the existing hosted app connection. No local process or API key is included.\n');
}
await mkdir('artifacts', { recursive: true });
const path = `artifacts/gpt-mail-${manifest.version}.zip`;
const zip = zipSync(files, { level: 6 });
const inspected = unzipSync(zip);
if (!inspected['gpt-mail/plugin.json'] || !inspected['gpt-mail/skills/mail/SKILL.md'] || !(appBinding ? inspected['gpt-mail/.app.json'] : inspected['gpt-mail/mcp.json'])) throw new Error('Incomplete archive');
if (Object.keys(inspected).some(p => /node_modules|accounts.json|\.env$|address.json|oauth.json|config\/plugin.json$|server\//.test(p))) throw new Error('Archive includes private server data');
await writeFile(path, zip);
console.log(`${path} (${Object.keys(inspected).length} files; API key excluded; configure authentication before installation)`);
