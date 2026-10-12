import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { zipSync, unzipSync } from 'fflate';
import { connectionConfig } from './connection.mjs';
import { bindHostedApp } from './package-binding.mjs';

// Export a portable remote plugin. Runtime keys are deliberately excluded from exports.
const mcp = JSON.parse(await readFile('mcp.json', 'utf8'));
const endpoint = mcp.mcpServers?.['gpt-mail'];
if (endpoint?.type !== 'streamable-http' || !endpoint.url) throw new Error('Run npm run configure:plugin with your hosted endpoint first.');
const manifest = JSON.parse(await readFile('plugin.json', 'utf8'));
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(manifest.name) || manifest.name.length > 64 ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid plugin identity/version');
const { values, positionals } = parseArgs({
  options: { validation: { type: 'boolean', default: false }, 'hosted-app': { type: 'string' }, desktop: { type: 'boolean', default: false } }, allowPositionals: true,
});
if (positionals.length || Boolean(values['hosted-app']) === values.desktop)
  throw new Error('Choose --hosted-app config/app-binding.json for ChatGPT cloud use, or --desktop for an explicitly desktop-only archive.');
// A separate name is only for a clean-install test. Production identity stays stable.
if (values.validation) {
  manifest.name += values.desktop ? '-single-zip-check' : '-install-check';
  if (manifest.name.length > 64) throw new Error('Validation plugin name is too long');
  manifest.extensions['com.openai'].interface.displayName += values.desktop ? ' 单 ZIP 验证' : ' 安装验收';
}
// Cloud packages reference a verified existing service; direct MCP is an explicit desktop test.
delete manifest.extensions['com.openai'].apps;
delete manifest.extensions['com.openai'].mcpServers;
delete manifest.extensions['com.openai'].interface.websiteURL;
const binding = values['hosted-app'] ? bindHostedApp(manifest, JSON.parse(await readFile(values['hosted-app'], 'utf8'))) : null;
const archiveRoot = manifest.name;
const archivePath = path => `${archiveRoot}/${path}`;
if (manifest.extensions['com.openai'].interface.shortDescription.length > 30) throw new Error('Subtitle exceeds 30 characters');
const files = {};
const auth = endpoint.extensions?.['com.openai']?.auth;
const exportedEndpoint = connectionConfig({
  apiUrl: endpoint.url, issuer: auth?.authorizationServerBase, clientId: auth?.client?.clientId,
}).mcpServers['gpt-mail'];
const add = async path => { files[archivePath(path.replaceAll('\\', '/'))] = new Uint8Array(await readFile(path)); };
const walk = async path => { for (const entry of await readdir(path, { withFileTypes: true })) {
  const child = join(path, entry.name); if (entry.isSymbolicLink()) throw new Error('Symlinks are forbidden');
  if (entry.isDirectory()) await walk(child); else await add(child);
} };
for (const path of ['assets', 'skills']) await walk(path);
files[archivePath('plugin.json')] = new TextEncoder().encode(JSON.stringify(manifest, null, 2) + '\n');
if (binding) files[archivePath('.app.json')] = new TextEncoder().encode(JSON.stringify(binding, null, 2) + '\n');
else files[archivePath('mcp.json')] = new TextEncoder().encode(JSON.stringify({
  $schema: mcp.$schema, mcpServers: { 'gpt-mail': exportedEndpoint },
}, null, 2) + '\n');
files[archivePath('README.md')] = new TextEncoder().encode(binding
  ? '# GptMail\n\nThis package adds mail instructions and the mailbox panel entry to an existing ChatGPT cloud MCP service. Install the package, associate the required GptMail service, and sign in to AuthService once. If ChatGPT does not install the dependency automatically, install the GptMail service from its plugin page separately. The fixed service URL is maintained in that cloud registration. .app.json does not create a service registration. Mailbox configuration and Google refresh tokens are encrypted on the server. No passwords or tokens are included in this package.\n'
  : '# GptMail — desktop-only test\n\nThis ZIP directly declares a fixed HTTPS MCP endpoint and its public OAuth configuration. ChatGPT personal imports containing MCP declarations are desktop-only, including remote HTTPS services. This archive does not satisfy the multi-device delivery target. Passwords and tokens are excluded.\n');
await mkdir('artifacts', { recursive: true });
const path = `artifacts/${manifest.name}-${manifest.version}.zip`;
const zip = zipSync(files, { level: 6 });
const inspected = unzipSync(zip);
if (!inspected[archivePath('plugin.json')] || !inspected[archivePath('skills/mail/SKILL.md')] || !inspected[archivePath(binding ? '.app.json' : 'mcp.json')]) throw new Error('Incomplete archive');
if (Object.keys(inspected).some(p => /node_modules|accounts.json|\.env$|address.json|oauth.json|config\/plugin.json$|server\//.test(p))) throw new Error('Archive includes private server data');
await writeFile(path, zip);
console.log(`${path} (${Object.keys(inspected).length} files; ${binding ? 'existing ChatGPT cloud service, OAuth login required' : 'desktop-only MCP test'}; no credentials)`);
