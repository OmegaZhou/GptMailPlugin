import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SettingsStore } from '../server/settings-store.js';
// Deployment migration is deliberately independent of the runtime server.
// @ts-expect-error JavaScript deployment utility
import { migrateStorage } from '../deploy/migrate-storage.mjs';
test('legacy encrypted mailboxes migrate to an independent key without losing credentials', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-migration-'));
  const oldKey = 'legacy-key-' + 'x'.repeat(40);
  const base = async () => ({ accounts: [], maxMessageBytes: 26214400 });
  try {
    const store = await new SettingsStore(directory, oldKey, base).init();
    const endpoint = { host: 'mail.example.com', port: 993, secure: true, credentialType: 'password' as const, secret: 'test-private-password' };
    await store.saveAccount({ id: 'owner', email: 'owner@example.com', imap: endpoint, smtp: endpoint, folders: {}, saveSent: true });
    const envelope = JSON.parse(await readFile(join(directory, 'settings.enc.json'), 'utf8'));
    const migrated = migrateStorage({ apiKey: oldKey }, envelope);
    assert.equal(migrated.config.apiKey, undefined); assert.notEqual(migrated.config.storageKey, oldKey);
    assert.throws(() => migrateStorage({ apiKey: oldKey + 'wrong' }, envelope));
    await writeFile(join(directory, 'settings.enc.json'), JSON.stringify(migrated.envelope));
    const restored = await new SettingsStore(directory, migrated.config.storageKey, base).init();
    assert.deepEqual(restored.credentials((await restored.mail()).accounts[0], 'imap'), { user: 'owner@example.com', pass: endpoint.secret });
    await assert.rejects(new SettingsStore(directory, oldKey, base).init());
    assert.deepEqual(migrateStorage(migrated.config, migrated.envelope), migrated);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
