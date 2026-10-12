export function connectionConfig(plugin, address = {}) {
  if (plugin.authType && plugin.authType !== 'oauth') throw new Error('Only server-account OAuth is supported');
  if (plugin.apiKey || plugin.clientSecret) throw new Error('Do not put login credentials in plugin configuration');
  const apiUrl = plugin.apiUrl || address.chatgptMcpUrl;
  let url;
  try { url = new URL(apiUrl); } catch { throw new Error('Configure apiUrl in config/plugin.json or chatgptMcpUrl in server/address.json'); }
  if (url.username || url.password || url.hash || url.search || (url.protocol !== 'https:' &&
    !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) throw new Error('API URL must use HTTPS; HTTP is permitted only for loopback tests.');
  if (typeof plugin.clientId !== 'string' || !plugin.clientId.trim() || /[\r\n\0]/.test(plugin.clientId))
    throw new Error('Configure the clientId registered with the authentication server');
  let issuer;
  try { issuer = new URL(plugin.issuer); } catch { throw new Error('Configure the authentication server issuer'); }
  if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash)
    throw new Error('Issuer must be an HTTPS URL without credentials, query or fragment');
  return { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
    mcpServers: { 'gpt-mail': { type: 'streamable-http', url: url.href,
      extensions: { 'com.openai': { auth: {
        type: 'oauth', client: { mode: 'provided', clientId: plugin.clientId, tokenEndpointAuthMethod: 'none' },
        authorizationServerBase: issuer.href.replace(/\/$/, ''), resource: url.href,
        oidcEnabled: true, oidcConfigurationUrl: issuer.href.replace(/\/$/, '') + '/.well-known/openid-configuration',
        baseScopes: ['openid', 'offline_access', 'mail.read', 'mail.write'],
      } } } } } };
}
