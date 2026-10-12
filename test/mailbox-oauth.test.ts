import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { SettingsStore } from '../server/settings-store.js';
import { MailboxOAuth, type GoogleMailboxGateway } from '../server/mailbox-oauth.js';

async function fixture(t: any) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-google-'));
  t.after(async () => { assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true }); });
  const base = async () => ({ accounts: [], maxMessageBytes: 1024 * 1024 });
  const key = 'google-test-storage-key-' + 'x'.repeat(32);
  const store = await new SettingsStore(directory, key, base).init();
  return { directory, store, key, base };
}
const grant = (expiresAt = Date.now() + 3600000) => ({ accessToken: 'private-google-access', refreshToken: 'private-google-refresh', expiresAt });

test('Google authorization consumes state once, verifies PKCE and saves only the provider email', async t => {
  const { store, directory } = await fixture(t);
  let state = '', challenge = '', exchanges = 0, now = Date.now();
  const gateway: GoogleMailboxGateway = {
    authorization: (s, c) => { state = s; challenge = c; return 'https://accounts.google.com/o/oauth2/v2/auth?state=' + s; },
    exchange: async (_code, verifier) => {
      exchanges++;
      const { createHash } = await import('node:crypto');
      assert.equal(createHash('sha256').update(verifier).digest('base64url'), challenge);
      return { ...grant(), email: 'verified@example.com' };
    }, refresh: async value => value,
  };
  const oauth = new MailboxOAuth(store, gateway, () => now);
  await oauth.begin('google', 'Personal');
  await assert.rejects(oauth.complete('invented-state', 'code'));
  await oauth.complete(state, 'code');
  await assert.rejects(oauth.complete(state, 'code'));
  assert.equal(exchanges, 1);
  const view = await store.view();
  assert.equal(view.accounts[0].email, 'verified@example.com');
  assert.equal(view.accounts[0].autoRefresh, true);
  assert.ok(!JSON.stringify(view).includes('private-google-'));
  assert.ok(!(await readFile(join(directory, 'settings.enc.json'), 'utf8')).includes('private-google-'));
  await oauth.begin('cancelled');
  await assert.rejects(oauth.complete(state, undefined, true));
  await oauth.begin('expired'); now += 600001;
  await assert.rejects(oauth.complete(state, 'code'));
  assert.equal((await store.view()).accounts.length, 1);
  assert.equal(exchanges, 1);
});

test('expired Google grants refresh once across IMAP and SMTP and persist encrypted across restart', async t => {
  const { store, directory, key, base } = await fixture(t);
  await store.saveGoogleAccount('google', 'owner@example.com', grant(Date.now() - 1000));
  let refreshes = 0;
  store.useGoogle({ authorization: () => '', exchange: async () => { throw new Error(); }, refresh: async () => {
    refreshes++; await new Promise(resolve => setTimeout(resolve, 5));
    return { ...grant(), accessToken: 'private-refreshed-access' };
  } });
  const account = (await store.mail()).accounts[0];
  const values = await Promise.all([store.resolveCredentials(account, 'imap'), store.resolveCredentials(account, 'smtp')]);
  assert.equal(refreshes, 1);
  assert.ok('accessToken' in values[0]);
  assert.equal(values[0].accessToken, 'private-refreshed-access');
  assert.deepEqual(values[0], values[1]);
  const restarted = await new SettingsStore(directory, key, base).init();
  restarted.useGoogle({ authorization: () => '', exchange: async () => { throw new Error(); }, refresh: async () => { throw new Error('Unexpected refresh'); } });
  const resumed = await restarted.resolveCredentials(account, 'imap');
  assert.ok('accessToken' in resumed);
  assert.equal(resumed.accessToken, 'private-refreshed-access');
  await assert.rejects(store.saveGoogleAccount('google', 'different@example.com', grant()));
});

test('removing a mailbox while refresh is pending cannot resurrect its credentials', async t => {
  const { store } = await fixture(t);
  await store.saveGoogleAccount('google', 'owner@example.com', grant(Date.now() - 1000));
  let finish!: () => void;
  const waiting = new Promise<void>(resolve => { finish = resolve; });
  store.useGoogle({ authorization: () => '', exchange: async () => { throw new Error(); }, refresh: async () => { await waiting; return grant(); } });
  const account = (await store.mail()).accounts[0];
  const pending = store.resolveCredentials(account, 'imap');
  await store.deleteAccount('google'); finish();
  await assert.rejects(pending);
  assert.equal((await store.view()).accounts.length, 0);
});
