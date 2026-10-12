import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { execFileSync } from 'node:child_process';

test('mail redeployment preserves independent auth includes in the canonical HTTPS vhost', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-nginx-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  const site = join(directory, 'site.conf'), old = join(directory, 'previous.conf');
  const unrelated = 'server {\n    listen 443 ssl;\n    server_name other.example.com;\n}\n';
  await writeFile(site, unrelated + 'server {\n    listen 443 ssl;\n    server_name mail.example.com;\n    include /etc/nginx/snippets/gpt-mail.conf;\n}\n');
  await writeFile(old, '# Independently deployed authentication\ninclude /etc/nginx/snippets/account-service.conf;\nlocation /mail-mcp {\n include /etc/nginx/snippets/gpt-mail-proxy.conf;\n}\n');
  const script = resolve('deploy/install-nginx-include.py');
  execFileSync('python', [script, site, 'mail.example.com', old]);
  const result = (await readFile(site, 'utf8')).replaceAll('\r\n', '\n');
  assert.ok(result.startsWith(unrelated));
  assert.equal(result.match(/include \/etc\/nginx\/snippets\/account-service.conf;/g)?.length, 1);
  assert.ok(!result.includes('gpt-mail-proxy.conf'));
  execFileSync('python', [script, site, 'mail.example.com', old]);
  assert.equal((await readFile(site, 'utf8')).replaceAll('\r\n', '\n'), result);
});
