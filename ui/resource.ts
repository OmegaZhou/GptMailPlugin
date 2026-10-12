import { readFileSync } from 'node:fs';
import { join } from 'node:path';
declare const __MAIL_SETTINGS_HTML__: string;
// This is an MCP resource, not a publicly served web page.
export const settingsHtml = typeof __MAIL_SETTINGS_HTML__ !== 'undefined' ? __MAIL_SETTINGS_HTML__
  : readFileSync(join(process.cwd(), 'ui/settings.html'), 'utf8');
