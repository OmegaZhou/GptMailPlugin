// Deployment instance identifiers belong only in private release artifacts.
export function bindHostedApp(manifest, overlay, binding) {
  if (!binding || Object.keys(binding).length !== 1 || !binding.apps ||
      Object.keys(binding.apps).length !== 1) throw new Error('Supply only the GptMail app binding');
  const app = binding.apps['gpt-mail'];
  if (!app || Object.keys(app).some(key => !['id', 'required'].includes(key)) ||
      !/^asdk_app_[a-f0-9]{32}$/.test(app.id) || app.required !== true)
    throw new Error('Supply a verified required GptMail app binding without extra fields');
  const websiteURL = `https://chatgpt.com/mcp-app/${app.id}/open_settings`;
  manifest.extensions['com.openai'].interface.websiteURL = websiteURL;
  overlay.interface.websiteURL = websiteURL;
  manifest.extensions['com.openai'].apps = './.app.json';
  delete manifest.extensions['com.openai'].mcpServers;
  overlay.apps = './.app.json';
  delete overlay.mcpServers;
  return { apps: { 'gpt-mail': { id: app.id, required: true } } };
}
