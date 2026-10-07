import { EventEmitter } from 'node:events';
import type { ImapFlow } from 'imapflow';
import type { Config } from '../server/config.js';
export const config: Config = {
  accounts: [{ id: 'test', email: 'owner@example.com', imap: { host: 'imap.example.com', port: 993, secure: true, passwordEnv: 'TEST_PASSWORD' },
    smtp: { host: 'smtp.example.com', port: 465, secure: true, passwordEnv: 'TEST_PASSWORD' }, folders: { drafts: 'Drafts', sent: 'Sent', trash: 'Trash', archive: 'Archive' }, saveSent: true }],
  maxMessageBytes: 25 * 1024 * 1024,
};
export const account = config.accounts[0];
export class FakeImap extends EventEmitter {
  mailbox: any;
  capabilities = new Set(['MOVE', 'UIDPLUS']);
  calls: any[] = [];
  validity = 42n;
  data = new Map<string, Map<number, { raw: Buffer; flags: Set<string> }>>();
  constructor() { super(); for (const path of ['INBOX', 'Drafts', 'Sent', 'Trash', 'Archive']) this.data.set(path, new Map()); }
  put(path: string, uid: number, raw: string | Buffer, flags: string[] = []) { this.data.get(path)!.set(uid, { raw: Buffer.from(raw), flags: new Set(flags) }); }
  asClient() { return this as unknown as ImapFlow; }
  async connect() { this.calls.push(['connect']); }
  async logout() { this.calls.push(['logout']); }
  close() {}
  async getMailboxLock(path: string, options: any) {
    this.calls.push(['lock', path, options]);
    if (!this.data.has(path)) throw new Error('missing folder');
    this.mailbox = { path, uidValidity: this.validity };
    return { release: () => this.calls.push(['release']) };
  }
  async list() { return [...this.data].map(([path, data]) => ({ path, name: path, flags: new Set(), status: { messages: data.size, unseen: [...data.values()].filter(m => !m.flags.has('\\Seen')).length } })); }
  async mailboxCreate(path: string) { this.data.set(path, new Map()); return { path, created: true }; }
  async search(query: any, options: any) {
    this.calls.push(['search', query, options]);
    return [...this.data.get(this.mailbox.path)!].filter(([, m]) => query.seen === undefined || m.flags.has('\\Seen') === query.seen).map(([uid]) => uid);
  }
  async fetchOne(uid: number, query: any, options: any) {
    this.calls.push(['fetchOne', uid, query, options]);
    const m = this.data.get(this.mailbox.path)!.get(uid); if (!m) return false;
    return { uid, size: m.raw.length, flags: m.flags, source: query.source ? m.raw.subarray(0, query.source.maxLength || m.raw.length) : undefined,
      headers: query.headers ? m.raw.subarray(0, m.raw.indexOf('\r\n\r\n') + 4) : undefined,
      envelope: { subject: /Subject: (.*)/i.exec(m.raw.toString())?.[1], messageId: /Message-ID: (.*)/i.exec(m.raw.toString())?.[1], date: new Date('2026-10-01') } };
  }
  async fetchAll(uids: number[], query: any, options: any) { return Promise.all(uids.map(uid => this.fetchOne(uid, query, options))); }
  async append(path: string, raw: Buffer, flags: string[]) {
    this.calls.push(['append', path, flags]);
    const uid = Math.max(0, ...this.data.get(path)!.keys()) + 1; this.put(path, uid, raw, flags);
    return { uid, uidValidity: this.validity };
  }
  async messageDelete(uid: number, options: any) { this.calls.push(['delete', uid, options]); return this.data.get(this.mailbox.path)!.delete(uid); }
  async messageMove(uid: number, destination: string, options: any) {
    this.calls.push(['move', uid, destination, options]);
    const source = this.data.get(this.mailbox.path)!; const mail = source.get(uid)!;
    await this.append(destination, mail.raw, [...mail.flags]); source.delete(uid); return { destination };
  }
  async messageFlagsAdd(uid: number, flags: string[], options: any) { this.calls.push(['add', uid, flags, options]); flags.forEach(f => this.data.get(this.mailbox.path)!.get(uid)!.flags.add(f)); return true; }
  async messageFlagsRemove(uid: number, flags: string[], options: any) { this.calls.push(['remove', uid, flags, options]); flags.forEach(f => this.data.get(this.mailbox.path)!.get(uid)!.flags.delete(f)); return true; }
}
export const rawMessage = (id = 'first', extra = '', body = 'Hello') => `From: sender@example.com\r\nTo: owner@example.com\r\nSubject: Test\r\nMessage-ID: <${id}@example.com>\r\n${extra}\r\n${body}`;
