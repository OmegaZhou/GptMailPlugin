import { build } from 'esbuild';
await build({ entryPoints: ['src/index.ts'], outfile: 'dist/server.cjs', bundle: true,
  platform: 'node', target: 'node22', format: 'cjs', sourcemap: false, legalComments: 'external',
  banner: { js: '// GptMailPlugin — hosted HTTP mail API (Node.js >=22)' },
});
