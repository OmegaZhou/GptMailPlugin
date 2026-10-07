'use strict';
const $ = id => document.getElementById(id);
let csrf = '', loginKey = '', state = null, pending = false;
const notice = (message, error = false) => { $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = false; };
function lock(value) { pending = value; document.querySelectorAll('button').forEach(button => { button.disabled = value; }); }
function signedOut() {
  csrf = ''; loginKey = ''; state = null;
  $('login-card').hidden = false; $('workspace').hidden = true; $('logout').hidden = true; $('session-status').textContent = '未登录';
  $('login-key').value = ''; $('account-form').reset(); $('connection-form').reset(); $('accounts').replaceChildren(); $('editor').hidden = true;
}
async function api(path, method = 'GET', body) {
  const response = await fetch('./api/' + path, { method, credentials: 'same-origin', redirect: 'error', headers: {
    ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(csrf ? { 'X-Panel-CSRF': csrf } : {})
  }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok) { if (response.status === 401 && path !== 'session') signedOut(); const error = new Error(result.error || '操作失败，请稍后再试。'); error.status = response.status; throw error; }
  return result;
}
async function run(operation) {
  if (pending) return;
  lock(true);
  try { await operation(); } catch (error) { notice(error.message || '操作失败。', true); } finally { lock(false); }
}
function authHelp() {
  $('auth-help').textContent = $('auth-type').value === 'oauth'
    ? 'ChatGPT 使用 OAuth，连接时在服务授权页验证。导出配置不包含服务端密钥。'
    : 'API Key 客户端携带 Bearer 密钥。导出文件包含本次登录使用的密钥，请仅私有保存。';
}
function text(tag, value, className) { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; }
function render(value) {
  state = value; if (value.csrf) csrf = value.csrf;
  $('login-card').hidden = true; $('workspace').hidden = false; $('logout').hidden = false; $('session-status').textContent = '已验证 · 私有管理';
  $('mcp-url').value = value.connection.mcpUrl; $('auth-type').value = value.connection.authType; authHelp();
  $('account-count').textContent = value.accounts.length;
  const list = $('accounts'); list.replaceChildren();
  if (!value.accounts.length) {
    const empty = text('div', '', 'empty'); empty.append(text('strong', '还没有配置邮箱'), text('p', '添加一个邮箱，测试连接后即可开始使用。')); list.append(empty);
  }
  for (const account of value.accounts) {
    const item = text('div', '', 'account-item'), info = text('div', ''), title = text('div', '', 'account-title');
    title.append(text('strong', account.name || account.id));
    if (account.id === value.defaultAccount) title.append(text('span', '默认', 'badge'));
    info.append(title, text('div', account.email, 'account-email'));
    if (!account.editable) info.append(text('small', '由服务端配置文件管理'));
    const actions = text('div', '', 'account-actions');
    const button = (label, fn, className = 'secondary') => { const node = text('button', label, className); node.type = 'button'; node.addEventListener('click', () => run(fn)); actions.append(node); };
    button('测试', async () => { const result = await api('test', 'POST', { id: account.id }); notice(testMessage(result), !result.imap || !result.smtp); });
    if (account.id !== value.defaultAccount) button('设为默认', async () => { render(await api('default', 'PUT', { id: account.id })); notice('默认邮箱已更新。'); });
    if (account.editable) {
      button('编辑', async () => openEditor(account));
      button('移除', async () => {
        if (!window.confirm('移除这个邮箱的连接？邮箱中的邮件不会删除。')) return;
        render(await api('accounts/' + encodeURIComponent(account.id), 'DELETE')); notice('邮箱连接已移除。');
      }, 'danger');
    }
    item.append(info, actions); list.append(item);
  }
}
function testMessage(result) {
  return 'IMAP 收件：' + (result.imap ? '连接成功' : '连接失败') + '；SMTP 发件：' + (result.smtp ? '连接成功' : '连接失败') +
    ((!result.imap || !result.smtp) ? '。请检查服务器、端口、TLS 和授权码。' : '。未发送邮件。');
}
function openEditor(account) {
  $('account-form').reset(); $('account-id').disabled = Boolean(account); $('editor').hidden = false; $('test-result').hidden = true;
  $('editor-title').textContent = account ? '编辑邮箱' : '添加邮箱';
  $('account-id').value = account?.id || ''; $('email').value = account?.email || ''; $('account-name').value = account?.name || '';
  $('save-sent').checked = account?.saveSent ?? true;
  for (const kind of ['imap', 'smtp']) {
    const ep = account?.[kind];
    $(kind + '-host').value = ep?.host || ''; $(kind + '-port').value = ep?.port || (kind === 'imap' ? 993 : 465);
    $(kind + '-tls').value = String(ep?.secure ?? true); $(kind + '-user').value = ep?.user || '';
    $(kind + '-type').value = ep?.credentialType || 'password'; $(kind + '-secret').value = '';
    $(kind + '-secret').placeholder = account ? '留空保留原凭据' : '输入邮箱授权码';
  }
  for (const kind of ['drafts', 'sent', 'trash', 'archive']) $('folder-' + kind).value = account?.folders?.[kind] || '';
  $('secret-help').textContent = account ? '凭据不会回显。留空保留原凭据；更换服务器、登录账号或认证方式后需重新填写。'
    : '新邮箱需填写收件和发件凭据。已有 token 需自行更新，服务不自动刷新邮箱供应商 token。';
  $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function closeEditor() { $('editor').hidden = true; $('account-form').reset(); $('test-result').textContent = ''; }
function accountInput() {
  const endpoint = kind => ({ host: $(kind + '-host').value.trim(), port: Number($(kind + '-port').value), secure: $(kind + '-tls').value === 'true',
    ...($(kind + '-user').value.trim() ? { user: $(kind + '-user').value.trim() } : {}), credentialType: $(kind + '-type').value,
    ...($(kind + '-secret').value ? { secret: $(kind + '-secret').value } : {}) });
  const folders = {};
  for (const kind of ['drafts', 'sent', 'trash', 'archive']) if ($('folder-' + kind).value.trim()) folders[kind] = $('folder-' + kind).value.trim();
  return { id: $('account-id').value.trim(), email: $('email').value.trim(), name: $('account-name').value.trim(),
    imap: endpoint('imap'), smtp: endpoint('smtp'), folders, saveSent: $('save-sent').checked };
}
function connectionInput() {
  const mcpUrl = new URL($('mcp-url').value.trim());
  if (mcpUrl.username || mcpUrl.password || mcpUrl.search || mcpUrl.hash ||
    (mcpUrl.protocol !== 'https:' && !(mcpUrl.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(mcpUrl.hostname)))) throw new Error('接口地址必须使用 HTTPS，不能包含密钥、查询参数或片段。');
  return { mcpUrl: mcpUrl.href, authType: $('auth-type').value };
}
$('login-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  const candidate = $('login-key').value;
  const result = await api('session', 'POST', { apiKey: candidate }); csrf = result.csrf;
  loginKey = candidate; $('login-key').value = ''; render(await api('state')); notice('验证成功，可以配置连接和邮箱。');
}); });
$('logout').addEventListener('click', () => run(async () => { await api('session', 'DELETE'); signedOut(); notice('已退出登录。'); }));
$('auth-type').addEventListener('change', () => {
  authHelp();
  if (state && Object.values(state.endpoints).includes($('mcp-url').value)) {
    const target = state.endpoints[$('auth-type').value];
    if (target) $('mcp-url').value = target;
    else notice('此服务尚未启用 OAuth，请先配置服务端 OAuth 或填写另一个服务的地址。', true);
  }
});
$('use-current').addEventListener('click', () => { const target = state.endpoints[$('auth-type').value];
  if (!target) { notice('此服务尚未启用 OAuth。', true); return; } $('mcp-url').value = target; });
$('connection-form').addEventListener('submit', event => { event.preventDefault(); run(async () => { render(await api('connection', 'PUT', connectionInput())); notice('客户端连接设置已保存。'); }); });
$('copy-url').addEventListener('click', () => run(async () => { await navigator.clipboard.writeText(connectionInput().mcpUrl); notice('MCP 接口地址已复制。'); }));
$('export-config').addEventListener('click', () => run(async () => {
  const connection = connectionInput();
  if (connection.authType === 'apiKey' && !loginKey) throw new Error('为导出含密钥的配置，请退出后重新输入密钥登录。');
  const config = { $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json', mcpServers: { 'gpt-mail': {
    type: 'streamable-http', url: connection.mcpUrl, ...(connection.authType === 'apiKey' ? { headers: { Authorization: 'Bearer ' + loginKey } } : {}) } } };
  const blob = new Blob([JSON.stringify(config, null, 2) + '\n'], { type: 'application/json' }), url = URL.createObjectURL(blob);
  const link = document.createElement('a'); link.href = url; link.download = 'mcp.json'; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); notice(connection.authType === 'apiKey' ? '配置已下载，文件含密钥，请私有保存。' : 'OAuth 配置已下载，不含服务端密钥。');
}));
$('add-account').addEventListener('click', () => openEditor());
$('close-editor').addEventListener('click', closeEditor); $('cancel-editor').addEventListener('click', closeEditor);
$('same-secret').addEventListener('click', () => { $('smtp-secret').value = $('imap-secret').value; $('smtp-type').value = $('imap-type').value; $('smtp-user').value = $('imap-user').value; });
$('provider').addEventListener('change', () => { const provider = $('provider').value; if (provider === 'custom') return;
  for (const kind of ['imap', 'smtp']) { $(kind + '-host').value = kind + '.' + provider + '.com'; $(kind + '-port').value = kind === 'imap' ? 993 : 465;
    $(kind + '-tls').value = 'true'; $(kind + '-type').value = 'password'; } });
$('test-input').addEventListener('click', () => { if (!$('account-form').reportValidity()) return; run(async () => {
  $('test-result').textContent = '正在验证 IMAP 和 SMTP 登录，请稍候…'; $('test-result').hidden = false;
  try { const result = await api('test', 'POST', { account: accountInput() }); $('test-result').textContent = testMessage(result); }
  catch (error) { $('test-result').textContent = error.message; throw error; }
}); });
$('account-form').addEventListener('submit', event => { event.preventDefault(); run(async () => {
  render(await api('accounts', 'POST', accountInput())); closeEditor(); notice('邮箱已保存，立即生效。');
}); });
run(async () => { try { render(await api('state')); } catch (error) { if (error.status === 401) signedOut(); else throw error; } });
