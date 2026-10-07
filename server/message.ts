import MailComposer from 'nodemailer/lib/mail-composer';
import { simpleParser } from 'mailparser';
import { z } from 'zod';
import type { Account } from './config.js';

const header = z.string().max(8000).refine(v => !/[\r\n\0]/.test(v), 'Header cannot contain newlines');
export const attachmentSchema = z.object({
  filename: header.min(1), content_type: z.string().regex(/^[\w.+-]+\/[\w.+-]+$/).default('application/octet-stream'),
  base64_url_content: z.string().max(35 * 1024 * 1024).regex(/^[A-Za-z0-9_-]*$/),
  content_id: header.optional(),
}).strict().refine(a => Buffer.from(a.base64_url_content, 'base64url').toString('base64url') === a.base64_url_content, 'Use canonical unpadded base64url');
export const mailFields = {
  to: header.optional(), cc: header.optional(), bcc: header.optional(), subject: header.default(''),
  text: z.string().max(5 * 1024 * 1024).optional(), html: z.string().max(5 * 1024 * 1024).optional(),
  attachments: z.array(attachmentSchema).max(50).default([]),
  reply_message_id: z.string().max(4096).optional(),
};
export const mailSchema = z.object(mailFields).strict();
export type MailInput = z.infer<typeof mailSchema>;
export type ReplyContext = { messageId?: string; references?: string | string[]; subject?: string; replyTo?: string; };
export async function compose(account: Account, input: MailInput, maxBytes: number, reply?: ReplyContext, draft = false, extra: any[] = []) {
  const attachments = input.attachments.map(a => ({
    filename: a.filename, contentType: a.content_type, content: Buffer.from(a.base64_url_content, 'base64url'), cid: a.content_id,
  }));
  if (attachments.reduce((sum, a) => sum + a.content.length, 0) > maxBytes) throw new Error('SIZE: Attachments exceed maxMessageBytes.');
  const to = input.to !== undefined ? input.to : reply?.replyTo;
  if (!draft && ![to, input.cc, input.bcc].some(v => v?.trim())) throw new Error('RECIPIENT: Supply to, cc, or bcc.');
  const references = reply ? [...(Array.isArray(reply.references) ? reply.references : reply.references ? [reply.references] : []), ...(reply.messageId ? [reply.messageId] : [])] : undefined;
  const built = new MailComposer({
    from: { name: account.name || '', address: account.email }, to, cc: input.cc, bcc: input.bcc,
    subject: input.subject || (reply?.subject ? (/^re:/i.test(reply.subject) ? reply.subject : 'Re: ' + reply.subject) : ''),
    text: input.text, html: input.html, attachments: [...attachments, ...extra],
    inReplyTo: reply?.messageId, references,
    disableFileAccess: true, disableUrlAccess: true,
  }).compile();
  (built as typeof built & { keepBcc: boolean }).keepBcc = draft;
  const raw = await new Promise<Buffer>((resolve, reject) => built.build((error, data) => error ? reject(error) : resolve(data)));
  if (raw.length > maxBytes) throw new Error('SIZE: Composed message exceeds maxMessageBytes.');
  let savedRaw = raw;
  if (!draft && input.bcc) {
    (built as typeof built & { keepBcc: boolean }).keepBcc = true;
    savedRaw = await new Promise<Buffer>((resolve, reject) => built.build((error, data) => error ? reject(error) : resolve(data)));
    if (savedRaw.length > maxBytes) throw new Error('SIZE: Sent copy exceeds maxMessageBytes.');
  }
  return { raw, savedRaw, envelope: built.getEnvelope(), messageId: built.messageId() };
}
export async function parseMail(raw: Buffer) {
  return simpleParser(raw, { skipImageLinks: true, skipTextToHtml: true, maxHtmlLengthToParse: 5 * 1024 * 1024 });
}
export function parsedInput(mail: Awaited<ReturnType<typeof parseMail>>): MailInput {
  const address = (v: typeof mail.to) => Array.isArray(v) ? v.map(a => a.text).join(', ') : v?.text;
  return {
    to: address(mail.to), cc: address(mail.cc), bcc: address(mail.bcc), subject: mail.subject || '',
    text: mail.text, html: mail.html || undefined,
    attachments: mail.attachments.map(a => ({ filename: a.filename || 'attachment', content_type: a.contentType, base64_url_content: a.content.toString('base64url'), content_id: a.cid })),
  };
}
