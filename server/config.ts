import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

const endpoint = z.object({
  host: z.string().min(1), port: z.number().int().min(1).max(65535),
  secure: z.boolean().default(true),
  user: z.string().min(1).optional(),
  passwordEnv: z.string().min(1).optional(), accessTokenEnv: z.string().min(1).optional(),
}).strict();
const accountSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/), email: z.email(), name: z.string().optional(),
  imap: endpoint, smtp: endpoint,
  folders: z.object({ drafts: z.string(), sent: z.string(), trash: z.string(), archive: z.string() }).partial().default({}),
  saveSent: z.boolean().default(true),
}).strict();
export const configSchema = z.object({
  defaultAccount: z.string().optional(), accounts: z.array(accountSchema),
  maxMessageBytes: z.number().int().min(1024).max(100 * 1024 * 1024).default(25 * 1024 * 1024),
}).strict().superRefine((v, ctx) => {
  if (new Set(v.accounts.map(a => a.id)).size !== v.accounts.length) ctx.addIssue({ code: 'custom', message: 'Duplicate account IDs' });
  if (v.defaultAccount && !v.accounts.some(a => a.id === v.defaultAccount)) ctx.addIssue({ code: 'custom', message: 'Unknown defaultAccount' });
});
export type Account = z.infer<typeof accountSchema>;
export type Config = z.infer<typeof configSchema>;
export async function loadConfig(): Promise<Config> {
  const path = process.env.MAIL_SERVER_CONFIG || join(process.cwd(), 'server', 'config.json');
  let data: unknown;
  try { data = JSON.parse(await readFile(path, 'utf8')).mail; }
  catch { throw new Error('CONFIG: Set MAIL_SERVER_CONFIG to a valid server/config.json file.'); }
  const parsed = configSchema.safeParse(data);
  if (!parsed.success) throw new Error('CONFIG: Invalid account configuration; check the documented schema.');
  return parsed.data;
}
export function selectAccount(config: Config, id?: string): Account {
  if (!config.accounts.length) throw new Error('ACCOUNT: No mailbox configured. Add mail.accounts to the private server configuration.');
  const chosen = id || config.defaultAccount || (config.accounts.length === 1 ? config.accounts[0].id : undefined);
  const account = config.accounts.find(a => a.id === chosen);
  if (!account) throw new Error('ACCOUNT: Supply an account_id from list_accounts.');
  return account;
}
export function credentials(account: Account, kind: 'imap' | 'smtp') {
  const ep = account[kind];
  const password = ep.passwordEnv && process.env[ep.passwordEnv];
  const accessToken = ep.accessTokenEnv && process.env[ep.accessTokenEnv];
  if (Boolean(password) === Boolean(accessToken)) throw new Error(`AUTH: Configure exactly one non-empty passwordEnv or accessTokenEnv for ${kind}.`);
  return { user: ep.user || account.email, ...(accessToken ? { accessToken } : { pass: password! }) };
}
