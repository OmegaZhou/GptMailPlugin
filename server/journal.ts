import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

// A pending record deliberately survives a crash: SMTP cannot guarantee exactly-once delivery.
export class SendJournal {
  constructor(private directory: string) {}
  async run<T>(key: string, fingerprint: string, send: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const dir = join(this.directory, createHash('sha256').update(key).digest('hex'));
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      let record: any;
      try { record = JSON.parse(await readFile(join(dir, 'result.json'), 'utf8')); }
      catch { throw new Error('SEND_UNCERTAIN: This operation is pending or its previous result is unknown. Check the mailbox before retrying with a new operation_id.'); }
      if (record.fingerprint !== fingerprint) throw new Error('OPERATION: operation_id was already used for different mail content.');
      return record.result;
    }
    const result = await send();
    const temp = join(dir, randomUUID() + '.tmp');
    await writeFile(temp, JSON.stringify({ fingerprint, result }), { mode: 0o600 });
    await rename(temp, join(dir, 'result.json'));
    return result;
  }
}
