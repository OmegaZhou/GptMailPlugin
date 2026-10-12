import { build } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
const component = await build({ entryPoints: ['ui/client.js'], bundle: true, write: false,
  platform: 'browser', target: 'es2022', format: 'iife', legalComments: 'inline', minify: true });
const html = (await readFile('ui/index.html', 'utf8'))
  .replace('/* SETTINGS_CSS */', await readFile('ui/style.css', 'utf8'))
  .replace('/* SETTINGS_JS */', () => component.outputFiles[0].text.replaceAll('</script', '<\\/script'));
await writeFile('ui/settings.html', html);
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/server.cjs', bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', sourcemap: false, legalComments: 'external',
  banner: { js: '// GptMailPlugin — hosted HTTP mail API (Node.js >=22)' },
  define: { __MAIL_SETTINGS_HTML__: JSON.stringify(html) },
});
