import test from 'node:test';
import assert from 'node:assert/strict';
import { SMTPServer } from 'smtp-server';
import nodemailer from 'nodemailer';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { MailService } from '../server/service.js';
import { SendJournal } from '../server/journal.js';
import { mailSchema, parseMail } from '../server/message.js';
import { FakeImap, config, account, rawMessage } from './helpers.js';
import { encodeId } from '../server/ids.js';

test('SMTP on a loopback fixture sends once, hides Bcc, preserves forwarded originals and cleans drafts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'gpt-mail-smtp-'));
  const received: Buffer[] = [];
  const smtp = new SMTPServer({ authOptional: true, disabledCommands: ['AUTH', 'STARTTLS'], logger: false,
    onRcptTo(address, _session, callback) { callback(address.address === 'reject@example.com' ? new Error('Rejected fixture recipient') : undefined); },
    onData(stream, _session, callback) { const chunks: Buffer[] = []; stream.on('data', c => chunks.push(c)); stream.on('end', () => { received.push(Buffer.concat(chunks)); callback(); }); },
  });
  const port = await new Promise<number>(resolve => smtp.listen(0, '127.0.0.1', () => resolve((smtp.server.address() as any).port)));
  const imap = new FakeImap();
  // Plain SMTP is confined to this test fixture. Production transport requires TLS.
  const service = new MailService(async () => config, () => imap.asClient(),
    () => nodemailer.createTransport({ host: '127.0.0.1', port, secure: false, ignoreTLS: true }), new SendJournal(directory));
  try {
    const input = mailSchema.parse({ to: 'alice@example.com', bcc: 'hidden@example.com', subject: 'Hello', text: '测试' });
    const receipt = await service.send(input, 'send-once'); assert.equal(receipt.status, 'accepted');
    await service.send(input, 'send-once'); assert.equal(received.length, 1);
    assert.equal((await parseMail(received[0])).bcc, undefined); assert.equal(imap.data.get('Sent')!.size, 1);
    assert.ok((await parseMail(imap.data.get('Sent')!.get(1)!.raw)).bcc);
    const partial = await service.send(mailSchema.parse({ to: 'alice@example.com, reject@example.com', text: 'partial' }), 'partial');
    assert.equal(partial.status, 'partially_accepted'); assert.ok(partial.rejected.includes('reject@example.com'));
    const draft = await service.createDraft(input); await service.sendDraft(draft.draft_id!, 'draft-once');
    assert.equal(imap.data.get('Drafts')!.size, 0);
    const before = received.length; await service.sendDraft(draft.draft_id!, 'draft-once'); assert.equal(received.length, before);
    imap.put('INBOX', 1, rawMessage('forward', '', 'original attachment content'));
    await service.forward([encodeId(account, 'INBOX', 42n, 1)], mailSchema.parse({ to: 'alice@example.com', text: 'forward note' }), 'forward-once');
    const forwarded = await parseMail(received.at(-1)!);
    assert.equal(forwarded.attachments[0].contentType, 'message/rfc822');
    assert.ok(forwarded.attachments[0].content.toString().includes('original attachment content'));
  } finally {
    await new Promise<void>(resolve => smtp.close(() => resolve()));
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep)); await rm(directory, { recursive: true, force: true });
  }
});
