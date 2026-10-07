export function connectionConfig(plugin, address = {}) {
  const authType = plugin.authType || 'apiKey';
  if (!['apiKey', 'oauth'].includes(authType)) throw new Error('authType must be apiKey or oauth');
  const apiUrl = plugin.apiUrl || (authType === 'oauth' ? address.chatgptMcpUrl : address.mcpUrl);
  let url;
  try { url = new URL(apiUrl); } catch { throw new Error('Configure apiUrl in config/plugin.json or ' + (authType === 'oauth' ? 'chatgptMcpUrl' : 'mcpUrl') + ' in server/address.json'); }
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('API URL must use HTTPS; HTTP is permitted only for loopback tests.');
  if (authType === 'apiKey' && (typeof plugin.apiKey !== 'string' || plugin.apiKey.length < 32 || plugin.apiKey.length > 512 || /[\r\n\0]/.test(plugin.apiKey))) throw new Error('Configure apiKey (32–512 characters) in config/plugin.json');
  return { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { 'gpt-mail': { type: 'streamable-http', url: url.href,
      ...(authType === 'apiKey' ? { headers: { Authorization: 'Bearer ' + plugin.apiKey } } : {}) } } };
}
