export function connectionConfig(
  plugin: { authType?: string; apiUrl?: string; apiKey?: string; clientSecret?: string; issuer?: string; clientId?: string },
  address?: { chatgptMcpUrl?: string },
): {
  $schema: string;
  mcpServers: { 'gpt-mail': { type: string; url: string; extensions: { 'com.openai': { auth: {
    type: 'oauth'; client: { mode: 'provided'; clientId: string; tokenEndpointAuthMethod: 'none' };
    authorizationServerBase: string; resource: string; oidcEnabled: true; oidcConfigurationUrl: string; baseScopes: string[];
  } } } } };
};
