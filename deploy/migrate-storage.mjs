import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Called only by the deployment transaction while the service is stopped.
export function migrateStorage(config, envelope) {
  if (config.storageKey) {
    if (config.apiKey || config.storageKey.length < 32) throw new Error('Ambiguous or invalid storage configuration');
    return { config, envelope };
  }
  if (typeof config.apiKey !== 'string' || config.apiKey.length < 32) throw new Error('Missing legacy encryption key');
  const storageKey = randomBytes(32).toString('base64url');
  let migrated;
  if (envelope) {
    const decode = name => Buffer.from(envelope[name], 'base64url');
    if (envelope.version !== 1 || decode('salt').length !== 32 || decode('iv').length !== 12 || decode('tag').length !== 16)
      throw new Error('Invalid storage envelope');
    const context = Buffer.from('gpt-mail-panel-v1');
    const decipher = createDecipheriv('aes-256-gcm', hkdfSync('sha256', config.apiKey, decode('salt'), context, 32), decode('iv'));
    decipher.setAAD(context); decipher.setAuthTag(decode('tag'));
    const plain = Buffer.concat([decipher.update(decode('ciphertext')), decipher.final()]);
    JSON.parse(plain.toString('utf8'));
    const salt = randomBytes(32), iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', hkdfSync('sha256', storageKey, salt, context, 32), iv);
    cipher.setAAD(context);
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    migrated = { version: 1, salt: salt.toString('base64url'), iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), ciphertext: ciphertext.toString('base64url') };
  }
  const { apiKey, ...rest } = config;
  return { config: { ...rest, storageKey }, envelope: migrated };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [configPath, statePath] = process.argv.slice(2);
    const read = async path => { try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; } };
    const config = await read(configPath);
    if (config) {
      const result = migrateStorage(config, await read(statePath));
      const save = async (path, value) => { await writeFile(path + '.migrating', JSON.stringify(value) + '\n', { mode: 0o600 }); await rename(path + '.migrating', path); };
      if (result.envelope) await save(statePath, result.envelope);
      await save(configPath, result.config);
    }
  } catch { console.error('Storage migration failed; deployment must restore configuration and state together.'); process.exitCode = 1; }
}
