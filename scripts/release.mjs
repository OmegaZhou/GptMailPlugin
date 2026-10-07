import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

const version = JSON.parse(await readFile('package.json', 'utf8')).version;
const directory = join('artifacts', 'server-release-' + new Date().toISOString().replace(/[-:.]/g, ''));
await mkdir(directory, { recursive: true });
const files = ['dist/server.cjs', 'dist/server.cjs.LEGAL.txt', 'server/config.example.json',
  'deploy/deploy.sh', 'deploy/gpt-mail.service', 'deploy/nginx-gpt-mail.conf',
  'deploy/nginx-gpt-mail-proxy.conf', 'deploy/install-nginx-include.py'];
const hashes = {};
for (const file of files) {
  const name = file.split('/').at(-1);
  await copyFile(file, join(directory, name));
  hashes[name] = createHash('sha256').update(await readFile(file)).digest('hex');
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version, files: hashes }, null, 2) + '\n');
console.log(directory);
