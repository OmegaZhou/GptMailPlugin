export function connectionConfig(
  plugin: { authType?: string; apiUrl?: string; apiKey?: string },
  address?: { mcpUrl?: string; chatgptMcpUrl?: string },
): {
  $schema: string;
  mcpServers: { 'gpt-mail': { type: string; url: string; headers?: { Authorization: string } } };
};
