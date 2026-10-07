import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
const panelAssets = Object.fromEntries(await Promise.all([['html', 'index.html'], ['css', 'style.css'], ['js', 'client.js']]
  .map(async ([key, file]) => [key, await readFile('server/panel/' + file, 'utf8')])));
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/server.cjs', bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', sourcemap: false, legalComments: 'external',
  banner: { js: '// GptMailPlugin — hosted HTTP mail API (Node.js >=22)' },
  define: { __MAIL_PANEL_ASSETS__: JSON.stringify(panelAssets) },
});
