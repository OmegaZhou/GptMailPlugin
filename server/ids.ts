import { createHash } from 'node:crypto';
import type { Account } from './config.js';
export type MessageRef = { account: string; mailbox: string; validity: string; uid: number };
export function accountKey(a: Account) {
  return createHash('sha256').update(JSON.stringify([a.id, a.imap.host, a.imap.port, a.imap.user || a.email])).digest('hex').slice(0, 24);
}
export function encodeId(a: Account, mailbox: string, validity: bigint | string, uid: number) {
  return 'mail_' + Buffer.from(JSON.stringify({ account: accountKey(a), mailbox, validity: String(validity), uid })).toString('base64url');
}
export function decodeId(id: string, account: Account): MessageRef {
  try {
    if (!/^mail_[A-Za-z0-9_-]+$/.test(id) || id.length > 4096) throw new Error();
    const v = JSON.parse(Buffer.from(id.slice(5), 'base64url').toString('utf8'));
    if (v.account !== accountKey(account) || typeof v.mailbox !== 'string' || !v.mailbox || typeof v.validity !== 'string' || !/^\d+$/.test(v.validity) || !Number.isInteger(v.uid) || v.uid < 1 || v.uid > 4294967295) throw new Error();
    return v;
  } catch { throw new Error('ID: Use an exact message ID returned for this account by search/read tools.'); }
}
