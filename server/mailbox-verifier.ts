import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';
import type { Account, credentials } from './config.js';

type MailboxTest = { account: Account; credentials: (kind: 'imap' | 'smtp') => ReturnType<typeof credentials> | Promise<ReturnType<typeof credentials>> };
export type ConnectionVerifier = (input: MailboxTest) => Promise<{ imap: boolean; smtp: boolean }>;
export const verifyMailbox: ConnectionVerifier = async input => {
  const imap = async () => {
    let client: ImapFlow | undefined;
    try {
    const ep = input.account.imap;
    client = new ImapFlow({ host: ep.host, port: ep.port, secure: ep.secure, ...(ep.secure ? {} : { doSTARTTLS: true }),
      auth: await input.credentials('imap'), logger: false, tls: { rejectUnauthorized: true }, disableAutoIdle: true,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000 });
    client.on('error', () => {});
    await client.connect(); return true;
    } catch { return false; }
    finally { client?.close(); }
  };
  const smtp = async () => {
    let transport: ReturnType<typeof nodemailer.createTransport> | undefined;
    try {
    const ep = input.account.smtp, auth = await input.credentials('smtp');
    transport = nodemailer.createTransport({ host: ep.host, port: ep.port, secure: ep.secure, requireTLS: !ep.secure,
      tls: { rejectUnauthorized: true }, auth: 'accessToken' in auth ? { type: 'OAuth2', user: auth.user, accessToken: auth.accessToken } : auth,
      connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, disableFileAccess: true, disableUrlAccess: true });
    return await transport.verify();
    } catch { return false; } finally { transport?.close(); }
  };
  const [imapResult, smtpResult] = await Promise.all([imap(), smtp()]);
  return { imap: imapResult, smtp: smtpResult };
};
