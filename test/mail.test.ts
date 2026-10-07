import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { configSchema, credentials } from '../server/config.js';
import { encodeId, decodeId } from '../server/ids.js';
import { parseQuery } from '../server/query.js';
import { compose, parseMail, mailSchema } from '../server/message.js';
import { MailService } from '../server/service.js';
import { SendJournal } from '../server/journal.js';
import { FakeImap, config, account, rawMessage } from './helpers.js';

test('account selection/config rejects duplicate IDs and invalid default', () => {
  assert.throws(() => configSchema.parse({ ...config, accounts: [account, account] }));
  assert.throws(() => configSchema.parse({ ...config, defaultAccount: 'missing' }));
  assert.throws(() => credentials(account, 'imap'), /AUTH:/);
});
test('mail IDs bind account endpoint, UIDVALIDITY and folder', () => {
  const id = encodeId(account, '收件箱', 42n, 12);
  assert.equal(decodeId(id, account).mailbox, '收件箱');
  assert.throws(() => decodeId(id, { ...account, imap: { ...account.imap, host: 'other' } }), /ID:/);
  assert.throws(() => decodeId('12', account), /ID:/);
});
test('search parses quoted phrases and rejects unsupported/wrong-date queries', () => {
  const q = parseQuery('from:alice subject:"项目 更新" is:unread after:2026-09-01 in:inbox');
  assert.equal(q.search.subject, '项目 更新'); assert.equal(q.search.seen, false); assert.equal(q.mailbox, 'INBOX');
  for (const query of ['has:attachment', 'foo OR bar', 'before:2026-02-30', 'subject:"unclosed', 'from:a from:b']) assert.throws(() => parseQuery(query), /QUERY:/);
  assert.ok(parseQuery('alpha beta').search.not);
});
test('composition preserves UTF-8 attachments/reply headers; Bcc is hidden on send but retained in draft', async () => {
  const input = mailSchema.parse({ to: 'alice@example.com', bcc: 'hidden@example.com', subject: '项目', html: '<p>你好</p>', attachments: [{ filename: '报告.txt', content_type: 'text/plain', base64_url_content: Buffer.from('数据').toString('base64url') }] });
  const sent = await compose(account, input, config.maxMessageBytes, { messageId: '<original@example.com>' });
  const parsed = await parseMail(sent.raw);
  assert.equal(parsed.subject, '项目'); assert.equal(parsed.inReplyTo, '<original@example.com>'); assert.equal(parsed.bcc, undefined);
  assert.ok(sent.envelope.to.includes('hidden@example.com')); assert.equal(parsed.attachments[0].content.toString(), '数据');
  const draft = await parseMail((await compose(account, input, config.maxMessageBytes, undefined, true)).raw);
  assert.equal((draft.bcc as any).value[0].address, 'hidden@example.com');
  assert.throws(() => mailSchema.parse({ to: 'victim@example.com\r\nBcc: hidden@example.com' }));
});
test('message/attachment limits fail before transport', async () => {
  await assert.rejects(compose(account, mailSchema.parse({ to: 'a@example.com', text: 'x'.repeat(2000) }), 1024), /SIZE:/);
  await assert.rejects(compose(account, mailSchema.parse({ text: 'missing recipient' }), 1024), /RECIPIENT:/);
});
test('search paginates by UID and rejects a changed query cursor; reading uses read-only locks', async () => {
  const imap = new FakeImap(); for (const uid of [1, 3, 7]) imap.put('INBOX', uid, rawMessage());
  const service = new MailService(async () => config, () => imap.asClient());
  const first: any = await service.search({ query: '', limit: 2 });
  assert.deepEqual(first.messages.map((m: any) => decodeId(m.id, account).uid), [7, 3]);
  const next: any = await service.search({ query: '', limit: 2, cursor: first.next_cursor });
  assert.deepEqual(next.messages.map((m: any) => decodeId(m.id, account).uid), [1]);
  await assert.rejects(service.search({ query: 'from:a', limit: 2, cursor: first.next_cursor }), /CURSOR:/);
  await service.read(first.messages[0].id);
  assert.ok(imap.calls.filter(c => c[0] === 'lock').every(c => c[2].readOnly));
  assert.ok(imap.calls.filter(c => c[0] === 'fetchOne').every(c => c[3].uid));
  assert.equal(imap.data.get('INBOX')!.get(7)!.flags.has('\\Seen'), false);
});
test('stale IDs and oversized read are refused before loading source', async () => {
  const imap = new FakeImap(); imap.put('INBOX', 1, rawMessage()); const id = encodeId(account, 'INBOX', 41n, 1);
  const service = new MailService(async () => ({ ...config, maxMessageBytes: 10 }), () => imap.asClient());
  await assert.rejects(service.read(id), /STALE_ID:/);
  await assert.rejects(service.read(encodeId(account, 'INBOX', 42n, 1)), /SIZE:/);
  assert.equal(imap.calls.filter(c => c[0] === 'fetchOne' && c[2].source).length, 0);
});
test('threads use References and never group unrelated same-subject messages', async () => {
  const imap = new FakeImap(); imap.put('INBOX', 1, rawMessage('root'));
  imap.put('INBOX', 2, rawMessage('reply', 'In-Reply-To: <root@example.com>\r\nReferences: <root@example.com>\r\n'));
  imap.put('INBOX', 3, rawMessage('unrelated'));
  const service = new MailService(async () => config, () => imap.asClient());
  const result = await service.thread(encodeId(account, 'INBOX', 42n, 1), 20, 200);
  assert.equal(result.messages.length, 2); assert.equal(result.scan_truncated, false);
  const bounded = await service.thread(encodeId(account, 'INBOX', 42n, 1), 20, 1);
  assert.equal(bounded.scan_truncated, true);
});
test('draft sparse patches preserve attachments/Bcc and return a new ID; explicit [] clears attachments', async () => {
  const imap = new FakeImap(); const service = new MailService(async () => config, () => imap.asClient());
  const draft = await service.createDraft(mailSchema.parse({ to: 'a@example.com', bcc: 'b@example.com', text: 'before', attachments: [{ filename: 'x.txt', content_type: 'text/plain', base64_url_content: 'aGk' }] }));
  const next = await service.updateDraft(draft.draft_id!, { text: 'after' }); assert.notEqual(next.draft_id, draft.draft_id);
  const parsed = await parseMail(imap.data.get('Drafts')!.get(decodeId(next.draft_id!, account).uid)!.raw);
  assert.equal(parsed.attachments.length, 1); assert.equal(parsed.text?.trim(), 'after'); assert.ok(parsed.bcc);
  const empty = await service.updateDraft(next.draft_id!, { attachments: [] });
  const cleared = await parseMail(imap.data.get('Drafts')!.get(decodeId(empty.draft_id!, account).uid)!.raw);
  assert.equal(cleared.attachments.length, 0);
});
test('move-to-trash preserves original bytes, reports missing items and refuses broad EXPUNGE fallback', async () => {
  const imap = new FakeImap(); imap.put('INBOX', 1, rawMessage()); const service = new MailService(async () => config, () => imap.asClient());
  const result = await service.move([encodeId(account, 'INBOX', 42n, 1), encodeId(account, 'INBOX', 42n, 9)], 'trash');
  assert.deepEqual(result.results.map(r => r.status), ['moved', 'failed']); assert.equal(imap.data.get('Trash')!.size, 1);
  assert.equal(imap.calls.filter(c => c[0] === 'delete').length, 0);
  imap.capabilities.clear(); await assert.rejects(service.move([encodeId(account, 'Trash', 42n, 1)], 'archive'), /MOVE:/);
});
test('journal prevents duplicate SMTP calls across restart and rejects reused operation for different content', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'gpt-mail-journal-'));
  try {
    let calls = 0; const fn = async () => ({ sent: ++calls });
    assert.deepEqual(await new SendJournal(dir).run('op', 'mail-a', fn), { sent: 1 });
    assert.deepEqual(await new SendJournal(dir).run('op', 'mail-a', fn), { sent: 1 });
    await assert.rejects(new SendJournal(dir).run('op', 'mail-b', fn), /OPERATION:/);
    await assert.rejects(new SendJournal(dir).run('unknown', 'mail-a', async () => { throw new Error('SMTP disconnected'); }));
    await assert.rejects(new SendJournal(dir).run('unknown', 'mail-a', fn), /SEND_UNCERTAIN:/);
    assert.equal(calls, 1);
  } finally { assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep)); await rm(dir, { recursive: true, force: true }); }
});
