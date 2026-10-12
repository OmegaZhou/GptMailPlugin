// Instance IDs belong only in ignored deployment configuration and private archives.
export function bindHostedApp(manifest, binding) {
  if (!binding || Object.keys(binding).length !== 1 || !binding.apps || Object.keys(binding.apps).length !== 1)
    throw new Error('Supply exactly one verified GptMail hosted app binding');
  const app = binding.apps['gpt-mail'];
  if (!app || Object.keys(app).some(key => !['id', 'required'].includes(key)) ||
      !/^asdk_app_[a-f0-9]{32}$/.test(app.id) || app.required !== true)
    throw new Error('Supply the existing required GptMail cloud app ID');
  const extension = manifest.extensions['com.openai'];
  extension.apps = './.app.json';
  extension.interface.websiteURL = `https://chatgpt.com/mcp-app/${app.id}/open_settings`;
  delete extension.mcpServers;
  return { apps: { 'gpt-mail': { id: app.id, required: true } } };
}
