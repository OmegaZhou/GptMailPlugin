import type { SearchObject } from 'imapflow';

export function parseQuery(query: string, now = new Date()): { search: SearchObject; mailbox?: string } {
  const search: SearchObject = {};
  let mailbox: string | undefined;
  const tokens = query.match(/(?:[^\s"']|"[^"]*"|'[^']*')+/g) || [];
  if ((query.match(/"/g)?.length || 0) % 2 || (query.match(/'/g)?.length || 0) % 2) throw new Error('QUERY: Unclosed quotation mark.');
  const texts: string[] = [];
  for (const token of tokens) {
    const colon = token.indexOf(':');
    if (colon < 0) {
      if (/^(OR|AND|NOT)$/.test(token) || /[()]/.test(token)) throw new Error('QUERY: Boolean/grouped expressions are unsupported.');
      texts.push(token.replace(/^["']|["']$/g, '')); continue;
    }
    const key = token.slice(0, colon); const value = token.slice(colon + 1).replace(/^["']|["']$/g, '');
    if (!value) throw new Error('QUERY: Empty search value.');
    if (['from', 'to', 'cc', 'bcc', 'subject', 'body'].includes(key)) {
      if (key in search) throw new Error('QUERY: Repeated field is unsupported.');
      Object.assign(search, { [key]: value });
    } else if (key === 'in' || key === 'label') {
      if (mailbox) throw new Error('QUERY: Only one folder filter is supported.');
      mailbox = value === 'inbox' ? 'INBOX' : value;
    } else if (key === 'is') {
      if (value === 'unread') search.seen = false;
      else if (value === 'read') search.seen = true;
      else if (value === 'starred') search.flagged = true;
      else if (value === 'draft') search.draft = true;
      else throw new Error('QUERY: Unsupported is: value.');
    } else if (key === 'after' || key === 'before') {
      if (!/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(value)) throw new Error('QUERY: Dates must be YYYY-MM-DD.');
      const normalized = value.replaceAll('/', '-'); const date = new Date(normalized + 'T00:00:00Z');
      if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) throw new Error('QUERY: Invalid date.');
      Object.assign(search, { [key === 'after' ? 'since' : 'before']: date });
    } else if (key === 'newer_than') {
      const match = /^(\d{1,5})([dw])$/.exec(value);
      if (!match) throw new Error('QUERY: newer_than supports Nd or Nw.');
      search.since = new Date(now.getTime() - Number(match[1]) * (match[2] === 'w' ? 7 : 1) * 86400000);
    } else throw new Error(`QUERY: Unsupported operator ${key}; use supported search fields instead.`);
  }
  if (texts.length === 1 && !search.body) search.body = texts[0];
  else if (texts.length) search.not = { or: texts.map(text => ({ not: { body: text } })) };
  if (!Object.keys(search).length) search.all = true;
  return { search, mailbox };
}
