import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, strFromU8 } from 'fflate';
import { connectionConfig } from '../scripts/connection.mjs';

test('explicit desktop test carries its endpoint and public OAuth configuration without secrets', async t => {
  const prefix = join(tmpdir(), 'gpt-mail-package-');
  const directory = await mkdtemp(prefix);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(prefix)));
    await rm(directory, { recursive: true, force: true });
  });
  const config = { apiUrl: 'https://mail.example.com/mail-mcp', issuer: 'https://mail.example.com/mailauth', clientId: 'public-test-client' };
  const manifest = {
    name: 'gpt-mail', version: '0.5.11',
    extensions: { 'com.openai': {
      apps: './.app.json', mcpServers: './mcp.json',
      interface: { displayName: 'GptMail', shortDescription: 'Mailbox', websiteURL: 'https://chatgpt.com/mcp-app/old-app/open_settings' },
    } },
  };
  await mkdir(join(directory, 'skills/mail'), { recursive: true });
  await mkdir(join(directory, 'assets'));
  await mkdir(join(directory, 'server'));
  await writeFile(join(directory, 'plugin.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'mcp.json'), JSON.stringify(connectionConfig(config)));
  await writeFile(join(directory, 'skills/mail/SKILL.md'), '---\nname: mail\ndescription: Manage mail\n---\n');
  await writeFile(join(directory, 'assets/icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  // These local files must never be swept into the archive.
  await writeFile(join(directory, '.app.json'), '{"id":"old-app"}');
  await writeFile(join(directory, '.env'), 'PASSWORD=fixture-private-password');
  await writeFile(join(directory, 'server/config.json'), '{"password":"fixture-private-password"}');
  const script = fileURLToPath(new URL('../scripts/package.mjs', import.meta.url));
  execFileSync(process.execPath, [script, '--validation', '--desktop'], { cwd: directory });
  const root = 'gpt-mail-single-zip-check';
  const files = unzipSync(await readFile(join(directory, `artifacts/${root}-0.5.11.zip`)));
  const packaged = JSON.parse(strFromU8(files[`${root}/plugin.json`]));
  const connection = JSON.parse(strFromU8(files[`${root}/mcp.json`]));
  assert.equal(packaged.name, root);
  assert.equal(connection.mcpServers['gpt-mail'].url, config.apiUrl);
  assert.equal(connection.mcpServers['gpt-mail'].extensions['com.openai'].auth.authorizationServerBase, config.issuer);
  assert.equal(connection.mcpServers['gpt-mail'].extensions['com.openai'].auth.client.clientId, config.clientId);
  assert.ok(!('apps' in packaged.extensions['com.openai']));
  assert.ok(!('mcpServers' in packaged.extensions['com.openai']));
  assert.ok(!('websiteURL' in packaged.extensions['com.openai'].interface));
  assert.deepEqual(Object.keys(files).sort(), [
    `${root}/README.md`, `${root}/assets/icon.svg`, `${root}/mcp.json`, `${root}/plugin.json`, `${root}/skills/mail/SKILL.md`,
  ]);
  assert.ok(!Object.values(files).some(bytes => strFromU8(bytes).includes('fixture-private-password')));
  assert.throws(() => execFileSync(process.execPath, [script, 'config/app-binding.json'], { cwd: directory, stdio: 'pipe' }));
  assert.throws(() => execFileSync(process.execPath, [script], { cwd: directory, stdio: 'pipe' }));
  const appId = 'asdk_app_' + 'a'.repeat(32);
  await writeFile(join(directory, 'binding.json'), JSON.stringify({ apps: { 'gpt-mail': { id: appId, required: true } } }));
  execFileSync(process.execPath, [script, '--hosted-app', 'binding.json', '--validation'], { cwd: directory });
  const cloudRoot = 'gpt-mail-install-check';
  const cloud = unzipSync(await readFile(join(directory, `artifacts/${cloudRoot}-0.5.11.zip`)));
  assert.equal(cloud[`${cloudRoot}/mcp.json`], undefined);
  assert.equal(JSON.parse(strFromU8(cloud[`${cloudRoot}/.app.json`])).apps['gpt-mail'].id, appId);
  assert.equal(JSON.parse(strFromU8(cloud[`${cloudRoot}/plugin.json`])).extensions['com.openai'].interface.websiteURL,
    `https://chatgpt.com/mcp-app/${appId}/open_settings`);
  assert.ok(!Object.values(cloud).some(bytes => strFromU8(bytes).includes('fixture-private-password')));
  assert.equal(JSON.parse(await readFile(join(directory, 'plugin.json'), 'utf8')).name, manifest.name);
});
