import { ImapFlow, type FetchMessageObject } from 'imapflow';
import nodemailer from 'nodemailer';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { credentials, loadConfig, selectAccount, type Account, type Config } from './config.js';
import { decodeId, encodeId, accountKey } from './ids.js';
import { parseQuery } from './query.js';
import { compose, parseMail, parsedInput, type MailInput } from './message.js';
import { SendJournal } from './journal.js';

export class MailService {
  constructor(
    private config: () => Promise<Config> = loadConfig,
    private imapFactory: (a: Account) => ImapFlow = a => {
      const ep = a.imap;
      return new ImapFlow({ host: ep.host, port: ep.port, secure: ep.secure,
        ...(ep.secure ? {} : { doSTARTTLS: true }), auth: this.credentialProvider(a, 'imap'), logger: false,
        tls: { rejectUnauthorized: true }, disableAutoIdle: true,
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 });
    },
    private smtpFactory = (a: Account) => {
      const ep = a.smtp; const auth = this.credentialProvider(a, 'smtp');
      return nodemailer.createTransport({ host: ep.host, port: ep.port, secure: ep.secure,
        requireTLS: !ep.secure, tls: { rejectUnauthorized: true },
        auth: 'accessToken' in auth ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : auth,
        connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
        disableFileAccess: true, disableUrlAccess: true });
    },
    private journal = new SendJournal(process.env.MAIL_STATE_DIR || join(homedir(), '.config', 'gpt-mail', 'state')),
    private credentialProvider: typeof credentials = credentials,
  ) {}
  async accounts() {
    const c = await this.config();
    return { default_account: c.defaultAccount || (c.accounts.length === 1 ? c.accounts[0].id : null),
      accounts: c.accounts.map(a => ({ account_id: a.id, email: a.email, name: a.name })) };
  }
  async profile(id?: string) {
    const a = selectAccount(await this.config(), id);
    return { account_id: a.id, email: a.email, name: a.name, protocol: 'IMAP/SMTP', labels_mode: 'folders', thread_mode: 'bounded RFC Message-ID/References matching' };
  }
  private async connected<T>(id: string | undefined, fn: (c: ImapFlow, a: Account, config: Config) => Promise<T>): Promise<T> {
    const config = await this.config(); const a = selectAccount(config, id); const c = this.imapFactory(a);
    c.on('error', () => {}); // Rejecting IMAP commands report errors; never print auth/server responses.
    try { await c.connect(); return await fn(c, a, config); }
    finally { try { await c.logout(); } catch { c.close(); } }
  }
  private async folder(c: ImapFlow, a: Account, kind: keyof Account['folders']) {
    if (a.folders[kind]) return a.folders[kind]!;
    const use = { drafts: '\\Drafts', sent: '\\Sent', trash: '\\Trash', archive: '\\Archive' }[kind];
    const match = (await c.list()).find(f => f.specialUse === use);
    if (!match) throw new Error(`FOLDER: Configure folders.${kind} using an existing folder from list_labels.`);
    return match.path;
  }
  private async selected<T>(c: ImapFlow, mailbox: string, fn: () => Promise<T>, readOnly = true) {
    const lock = await c.getMailboxLock(mailbox, { readOnly });
    try { return await fn(); } finally { lock.release(); }
  }
  private validity(c: ImapFlow) {
    if (!c.mailbox) throw new Error('MAILBOX: No mailbox selected.');
    return c.mailbox.uidValidity;
  }
  private async withMessage<T>(c: ImapFlow, a: Account, id: string, fn: (uid: number) => Promise<T>, readOnly = true) {
    const ref = decodeId(id, a);
    return this.selected(c, ref.mailbox, async () => {
      if (String(this.validity(c)) !== ref.validity) throw new Error('STALE_ID: Folder UIDVALIDITY changed; search again.');
      const exists = await c.fetchOne(ref.uid, { uid: true }, { uid: true });
      if (!exists) throw new Error('NOT_FOUND: Message was removed or moved; search again.');
      return fn(ref.uid);
    }, readOnly);
  }
  private summary(c: ImapFlow, a: Account, path: string, m: FetchMessageObject) {
    return { id: encodeId(a, path, this.validity(c), m.uid), mailbox: path, subject: m.envelope?.subject,
      from: m.envelope?.from, to: m.envelope?.to, date: m.envelope?.date ? new Date(m.envelope.date).toISOString() : undefined,
      message_id_header: m.envelope?.messageId, flags: [...(m.flags || [])], size: m.size };
  }
  private async source(c: ImapFlow, uid: number, max: number) {
    const meta = await c.fetchOne(uid, { size: true }, { uid: true });
    if (!meta) throw new Error('NOT_FOUND: Message no longer exists.');
    if (!meta.size || meta.size > max) throw new Error('SIZE: Message exceeds maxMessageBytes or server omitted its size.');
    const data = await c.fetchOne(uid, { source: { start: 0, maxLength: max + 1 } }, { uid: true });
    if (!data || !data.source || data.source.length > max || data.source.length < meta.size) throw new Error('SIZE: Incomplete or oversized message source.');
    return data.source;
  }
  async labels(id?: string) {
    return this.connected(id, async c => ({ labels: (await c.list({ statusQuery: { messages: true, unseen: true } })).map(f => ({
      id: f.path, name: f.name, special_use: f.specialUse, messages_total: f.status?.messages,
      messages_unread: f.status?.unseen, selectable: !f.flags.has('\\Noselect'),
    })), labels_mode: 'folders' }));
  }
  async createLabel(name: string, id?: string) {
    return this.connected(id, async c => {
      const existing = (await c.list()).find(f => f.path === name);
      if (existing) return { id: existing.path, created: false };
      return c.mailboxCreate(name);
    });
  }
  async search(args: { account_id?: string; query: string; mailbox?: string; limit: number; cursor?: string }, idsOnly = false) {
    const parsed = parseQuery(args.query);
    if (args.mailbox && parsed.mailbox && args.mailbox !== parsed.mailbox) throw new Error('QUERY: Conflicting mailbox filters.');
    const path = args.mailbox || parsed.mailbox || 'INBOX';
    return this.connected(args.account_id, (c, a) => this.selected(c, path, async () => {
      const fingerprint = createHash('sha256').update(JSON.stringify([accountKey(a), path, args.query, String(this.validity(c))])).digest('hex');
      let before = Infinity;
      if (args.cursor) {
        try {
          const cursor = JSON.parse(Buffer.from(args.cursor, 'base64url').toString());
          if (cursor.fingerprint !== fingerprint || !Number.isInteger(cursor.before) || cursor.before < 1) throw new Error();
          before = cursor.before;
        } catch { throw new Error('CURSOR: Invalid or stale cursor; restart search.'); }
      }
      const all = (await c.search({ ...parsed.search, deleted: false }, { uid: true })) || [];
      const eligible = all.filter(uid => uid < before).sort((x, y) => y - x);
      const page = eligible.slice(0, args.limit);
      const next_cursor = eligible.length > page.length ? Buffer.from(JSON.stringify({ fingerprint, before: page.at(-1) })).toString('base64url') : null;
      if (idsOnly) return { message_ids: page.map(uid => encodeId(a, path, this.validity(c), uid)), next_cursor, total_matching: all.length };
      const fetched = page.length ? await c.fetchAll(page, { envelope: true, flags: true, size: true, uid: true }, { uid: true }) : [];
      const messages = page.flatMap(uid => { const m = fetched.find(m => m.uid === uid); return m ? [this.summary(c, a, path, m)] : []; });
      return { messages, next_cursor, total_matching: all.length, order: 'descending mailbox UID', mailbox: path };
    }));
  }
  async read(messageId: string, id?: string, format: 'full' | 'metadata' | 'raw' = 'full') {
    return this.connected(id, (c, a, config) => this.withMessage(c, a, messageId, async uid => {
      const meta = await c.fetchOne(uid, { envelope: true, flags: true, size: true, uid: true }, { uid: true });
      if (!meta) throw new Error('NOT_FOUND: Message no longer exists.');
      const summary = this.summary(c, a, decodeId(messageId, a).mailbox, meta);
      if (format === 'metadata') return summary;
      const raw = await this.source(c, uid, config.maxMessageBytes);
      if (format === 'raw') return { ...summary, raw_base64_url: raw.toString('base64url') };
      const parsed = await parseMail(raw);
      return { ...summary, text: parsed.text, html: parsed.html || undefined,
        reply_to: parsed.replyTo?.text, references: parsed.references, in_reply_to: parsed.inReplyTo,
        attachments: parsed.attachments.map((at, i) => ({ attachment_id: String(i), filename: at.filename,
          content_type: at.contentType, size: at.size, content_id: at.cid, disposition: at.contentDisposition })) };
    }));
  }
  async batchRead(messageIds: string[], id?: string) {
    const results = [];
    for (const messageId of messageIds) results.push(await this.read(messageId, id));
    return { messages: results };
  }
  async attachment(messageId: string, attachmentId: string, id?: string) {
    return this.connected(id, (c, a, config) => this.withMessage(c, a, messageId, async uid => {
      const mail = await parseMail(await this.source(c, uid, config.maxMessageBytes));
      const at = mail.attachments[Number(attachmentId)];
      if (!at) throw new Error('ATTACHMENT: Use an attachment_id returned by read_email.');
      if (at.size > 5 * 1024 * 1024) throw new Error('SIZE: Inline attachment reads are limited to 5 MiB.');
      return { filename: at.filename, content_type: at.contentType, size: at.size, base64_url_content: at.content.toString('base64url') };
    }));
  }
  async thread(messageId: string, max: number, scanLimit: number, id?: string) {
    return this.connected(id, (c, a, config) => this.withMessage(c, a, messageId, async uid => {
      const anchor = await parseMail(await this.source(c, uid, config.maxMessageBytes));
      const refs = (m: typeof anchor) => [m.messageId, m.inReplyTo, ...(Array.isArray(m.references) ? m.references : m.references ? [m.references] : [])].filter(Boolean) as string[];
      const related = new Set(refs(anchor));
      const all = ((await c.search({ all: true, deleted: false }, { uid: true })) || []).sort((x, y) => y - x);
      const page = [...new Set([uid, ...all.slice(0, scanLimit)])];
      const metadata = await c.fetchAll(page, { headers: ['message-id', 'in-reply-to', 'references'], envelope: true, flags: true, size: true, uid: true }, { uid: true });
      const candidates = await Promise.all(metadata.map(async m => ({ m, refs: refs(await parseMail(m.headers || Buffer.alloc(0))) })));
      const picked = new Set<number>([uid]);
      let changed = true;
      while (changed) { changed = false; for (const { m, refs } of candidates) if (!picked.has(m.uid) && refs.some(r => related.has(r))) {
        picked.add(m.uid); refs.forEach(r => related.add(r)); changed = true;
      } }
      const messages = metadata.filter(m => picked.has(m.uid)).sort((x, y) => x.uid - y.uid);
      return { messages: messages.slice(-max).map(m => this.summary(c, a, decodeId(messageId, a).mailbox, m)),
        truncated: messages.length > max, scan_truncated: all.length > scanLimit,
        scope: 'same mailbox; RFC Message-ID/References; newest scan_limit messages plus anchor' };
    }));
  }
  async modify(messageIds: string[], add: string[], remove: string[], id?: string) {
    const allowed = ['\\Seen', '\\Flagged', '\\Answered'];
    if ([...add, ...remove].some(v => !allowed.includes(v)) || add.some(v => remove.includes(v))) throw new Error('FLAGS: Use only \\Seen, \\Flagged, \\Answered; additions/removals cannot overlap.');
    return this.connected(id, async (c, a) => {
      const results = [];
      for (const messageId of [...new Set(messageIds)]) {
        try { await this.withMessage(c, a, messageId, async uid => {
          if (add.length && !await c.messageFlagsAdd(uid, add, { uid: true })) throw new Error('FLAGS: Add failed.');
          if (remove.length && !await c.messageFlagsRemove(uid, remove, { uid: true })) throw new Error('FLAGS: Remove failed.');
        }, false); results.push({ id: messageId, status: 'updated' }); }
        catch { results.push({ id: messageId, status: 'failed', warning: 'Some flag changes may have completed; re-read before retrying.' }); }
      }
      return { results };
    });
  }
  async move(messageIds: string[], destination: string | 'archive' | 'trash', id?: string) {
    return this.connected(id, async (c, a) => {
      if (!c.capabilities.has('MOVE') && !c.capabilities.has('UIDPLUS')) throw new Error('MOVE: Server needs MOVE or UIDPLUS for safe targeted moves.');
      const path = ['archive', 'trash'].includes(destination) ? await this.folder(c, a, destination as 'archive' | 'trash') : destination;
      const results = [];
      for (const messageId of [...new Set(messageIds)]) {
        try { const moved = await this.withMessage(c, a, messageId, uid => {
          if (decodeId(messageId, a).mailbox === path) throw new Error('MOVE: Source and destination are the same.');
          return c.messageMove(uid, path, { uid: true });
        }, false);
          if (!moved) throw new Error('MOVE: Server did not move message.');
          results.push({ id: messageId, status: 'moved', destination: path });
        } catch { results.push({ id: messageId, status: 'failed', warning: 'Move result may be partial; search the source and destination before retrying.' }); }
      }
      return { results, warning: 'Moved message IDs are no longer valid; search the destination for new IDs.' };
    });
  }
  async drafts(id?: string, limit = 20) {
    const path = await this.connected(id, (c, a) => this.folder(c, a, 'drafts'));
    return this.search({ account_id: id, mailbox: path, query: '', limit });
  }
  private async reply(c: ImapFlow, a: Account, messageId: string | undefined, max: number) {
    if (!messageId) return undefined;
    return this.withMessage(c, a, messageId, async uid => {
      const mail = await parseMail(await this.source(c, uid, max));
      return { messageId: mail.messageId, references: mail.references, subject: mail.subject, replyTo: mail.replyTo?.text || mail.from?.text };
    });
  }
  private async appendDraft(c: ImapFlow, a: Account, raw: Buffer) {
    const path = await this.folder(c, a, 'drafts');
    const result = await c.append(path, raw, ['\\Draft']);
    if (!result) throw new Error('DRAFT: Server did not save the draft.');
    return { draft_id: result.uid && result.uidValidity ? encodeId(a, path, result.uidValidity, result.uid) : null,
      mailbox: path, warning: result.uid ? undefined : 'Server omitted APPENDUID; use list_drafts to find the saved draft.' };
  }
  async createDraft(input: MailInput, id?: string) {
    return this.connected(id, async (c, a, config) => {
      const built = await compose(a, input, config.maxMessageBytes, await this.reply(c, a, input.reply_message_id, config.maxMessageBytes), true);
      return this.appendDraft(c, a, built.raw);
    });
  }
  async updateDraft(draftId: string, patch: Partial<MailInput>, id?: string) {
    return this.connected(id, async (c, a, config) => {
      const path = await this.folder(c, a, 'drafts');
      if (decodeId(draftId, a).mailbox !== path) throw new Error('DRAFT: ID must refer to the Drafts folder.');
      const old = await this.withMessage(c, a, draftId, async uid => parseMail(await this.source(c, uid, config.maxMessageBytes)));
      const merged = { ...parsedInput(old), ...patch };
      const reply = patch.reply_message_id ? await this.reply(c, a, patch.reply_message_id, config.maxMessageBytes) : { messageId: old.inReplyTo, references: old.references };
      const built = await compose(a, merged, config.maxMessageBytes, reply, true);
      const saved = await this.appendDraft(c, a, built.raw);
      try {
        if (!c.capabilities.has('UIDPLUS')) throw new Error();
        await this.withMessage(c, a, draftId, async uid => { if (!await c.messageDelete(uid, { uid: true })) throw new Error(); }, false);
      }
      catch { return { ...saved, warning: 'Replacement saved, but old draft cleanup failed; both drafts may exist.' }; }
      return saved;
    });
  }
  private async deliver(c: ImapFlow, a: Account, input: MailInput, max: number, operation: string, extra: any[] = [], replyOverride?: any) {
    const fingerprint = createHash('sha256').update(JSON.stringify([input, extra.map(e => ({ filename: e.filename, hash: createHash('sha256').update(e.content).digest('hex') }))])).digest('hex');
    return this.journal.run(accountKey(a) + ':' + operation, fingerprint, async () => {
      const built = await compose(a, input, max, replyOverride || await this.reply(c, a, input.reply_message_id, max), false, extra);
      const smtp = this.smtpFactory(a);
      let receipt;
      try { receipt = await smtp.sendMail({ envelope: built.envelope, raw: built.raw }); }
      finally { smtp.close(); }
      const warnings: string[] = [];
      if (a.saveSent) {
        try { if (!await c.append(await this.folder(c, a, 'sent'), built.savedRaw, ['\\Seen'])) throw new Error(); }
        catch { warnings.push('SMTP accepted mail, but saving the Sent copy failed. Do not resend.'); }
      }
      return { status: receipt.rejected?.length ? 'partially_accepted' : 'accepted',
        message_id_header: built.messageId, accepted: receipt.accepted, rejected: receipt.rejected,
        warnings, operation_id: operation };
    });
  }
  async send(input: MailInput, operation: string, id?: string) {
    return this.connected(id, (c, a, config) => this.deliver(c, a, input, config.maxMessageBytes, operation));
  }
  async sendDraft(draftId: string, operation: string, id?: string) {
    return this.connected(id, (c, a, config) => this.journal.run(
      accountKey(a) + ':draft:' + operation,
      createHash('sha256').update(draftId).digest('hex'), async () => {
      if (decodeId(draftId, a).mailbox !== await this.folder(c, a, 'drafts')) throw new Error('DRAFT: ID must refer to the Drafts folder.');
      const mail = await this.withMessage(c, a, draftId, async uid => parseMail(await this.source(c, uid, config.maxMessageBytes)));
      const sent = await this.deliver(c, a, parsedInput(mail), config.maxMessageBytes, operation + ':draft-send', [], { messageId: mail.inReplyTo, references: mail.references });
      // Keep the draft on partial recipient acceptance so the user can review rejected recipients.
      if (sent.status === 'accepted') {
        try {
          if (!c.capabilities.has('UIDPLUS')) throw new Error();
          await this.withMessage(c, a, draftId, async uid => { if (!await c.messageDelete(uid, { uid: true })) throw new Error(); }, false);
        }
        catch { return { ...sent, warnings: [...sent.warnings, 'Mail accepted, but draft cleanup failed. Do not resend.'] }; }
      }
      return sent;
    }));
  }
  async forward(messageIds: string[], input: MailInput, operation: string, id?: string) {
    return this.connected(id, async (c, a, config) => {
      const results = [];
      for (const messageId of [...new Set(messageIds)]) {
        const raw = await this.withMessage(c, a, messageId, uid => this.source(c, uid, config.maxMessageBytes));
        const original = await parseMail(raw);
        const item = { ...input, subject: input.subject || 'Fwd: ' + (original.subject || '') };
        results.push(await this.deliver(c, a, item, config.maxMessageBytes, operation + ':' + messageId,
          [{ filename: 'forwarded.eml', contentType: 'message/rfc822', contentDisposition: 'attachment', content: raw }]));
      }
      return { results };
    });
  }
}
