import { readFile, writeFile } from 'node:fs/promises';
import { connectionConfig } from './connection.mjs';

const plugin = JSON.parse(await readFile(process.env.MAIL_PLUGIN_CONFIG || 'config/plugin.json', 'utf8'));
let address = {};
try { address = JSON.parse(await readFile('server/address.json', 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const mcp = connectionConfig(plugin, address);
await writeFile('mcp.json', JSON.stringify(mcp, null, 2) + '\n', { mode: 0o600 });
console.log('Configured remote OAuth connection in mcp.json. Login credentials are not included. Existing host registrations require separate verification.');
