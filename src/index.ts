import { startHttp } from '../server/http.js';

async function main() {
  await startHttp();
}
main().catch(() => { process.stderr.write('GptMail startup failed. Check server/config.json, authentication provider, storageKey, and state directory.\n'); process.exitCode = 1; });
