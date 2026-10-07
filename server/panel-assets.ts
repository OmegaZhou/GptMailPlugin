import { readFileSync } from 'node:fs';
import { join } from 'node:path';
type Assets = { html: string; css: string; js: string };
declare const __MAIL_PANEL_ASSETS__: Assets;
// Build embeds the assets so the existing single-file server release remains self-contained.
export const panelAssets: Assets = typeof __MAIL_PANEL_ASSETS__ !== 'undefined' ? __MAIL_PANEL_ASSETS__ : {
  html: readFileSync(join(process.cwd(), 'server/panel/index.html'), 'utf8'),
  css: readFileSync(join(process.cwd(), 'server/panel/style.css'), 'utf8'),
  js: readFileSync(join(process.cwd(), 'server/panel/client.js'), 'utf8'),
};
