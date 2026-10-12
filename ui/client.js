'use strict';
import { App, applyDocumentTheme, applyHostStyleVariables } from '@modelcontextprotocol/ext-apps';
const app = new App({ name: 'GptMail settings', version: '0.5.0' }, { availableDisplayModes: ['inline', 'fullscreen'] });
const $ = id => document.getElementById(id);
let session = '', pending = false;
const notice = (message, error = false) => { $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = false; };
function lock(value) { pending = value; document.querySelectorAll('button').forEach(button => { button.disabled = value; }); }
function signedOut() {
  session = '';
  $('connection-card').hidden = false; $('workspace').hidden = true; $('session-status').textContent = '连接未恢复';
  $('account-form').reset(); $('accounts').replaceChildren(); $('editor').hidden = true;
  $('active-account').textContent = ''; $('active-url').value = ''; $('active-auth').textContent = ''; $('auth-status').textContent = ''; $('service-test-status').textContent = '';
}
async function call(action, args) {
  const response = await app.callServerTool({ name: 'settings_' + action, arguments: args });
  const result = response._meta?.settings;
  if (response.isError || !result) {
    const error = new Error(result?.error || '请求失败，请检查服务连接。'); error.status = result?.status; throw error;
  }
  return result;
}
async function restore() {
  const result = await call('bootstrap', {});
  if (!result.authenticated) throw new Error('当前服务连接没有邮箱管理权限，请在插件连接设置中完成账号授权。');
  session = result.session; render(result.state);
}
async function api(path, method = 'GET', body, retry = true) {
  let action = path, args = { session, ...(body || {}) };
  if (path === 'accounts') { action = 'save_account'; args = { session, account: body }; }
  else if (path.startsWith('accounts/')) { action = 'delete_account'; args = { session, id: decodeURIComponent(path.slice(9)) }; }
  try { return await call(action, args); }
  catch (error) {
    // Only a server-confirmed expired management session is retried. Transport failures
    // can have an unknown mutation outcome and must never be automatically replayed.
    if (error.status === 401 && retry) { await restore(); return api(path, method, body, false); }
    throw error;
  }
}
async function run(operation) {
  if (pending) return;
  lock(true);
  try { await operation(); } catch (error) { notice(error.message || '操作失败。', true); } finally { lock(false); }
}
function text(tag, value, className) { const node = document.createElement(tag); node.textContent = value; if (className) node.className = className; return node; }
function render(value) {
  $('connection-card').hidden = true; $('workspace').hidden = false; $('session-status').textContent = '已授权';
  $('active-url').value = value.activeConnection?.mcpUrl || '';
  $('active-auth').textContent = 'OAuth';
  $('auth-status').textContent = '当前连接已验证';
  $('active-account').textContent = value.activeConnection?.accountName || '服务器所有者';
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
    const button = (label, fn, className = 'secondary') => { const node = text('button', label, className); node.type = 'button'; node.addEventListener('click', () => run(() => fn(node))); actions.append(node); };
    button('测试', async () => { const result = await api('test', 'POST', { id: account.id }); notice(testMessage(result), !result.imap || !result.smtp); });
    if (account.id !== value.defaultAccount) button('设为默认', async () => { render(await api('default', 'PUT', { id: account.id })); notice('默认邮箱已更新。'); });
    if (account.editable) {
      button('编辑', async () => openEditor(account));
      let removing = false;
      button('移除', async node => {
        if (!removing) { removing = true; node.textContent = '确认移除'; notice('再次点击确认移除此邮箱连接，邮箱中的邮件会保留。'); return; }
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
$('restore-connection').addEventListener('click', () => run(restore));
$('test-service').addEventListener('click', () => run(async () => {
  $('service-test-status').textContent = '正在测试当前服务连接…';
  try { render(await api('state')); $('service-test-status').textContent = '连接正常 · ' + new Date().toLocaleTimeString(); }
  catch (error) { $('service-test-status').textContent = '连接失败，请检查服务状态或插件账号授权。'; throw error; }
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
function theme(context) {
  if (context?.theme) applyDocumentTheme(context.theme);
  if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
}
app.onhostcontextchanged = theme;
app.onteardown = async () => {
  const closing = session; signedOut();
  if (closing) await call('logout', { session: closing }).catch(() => {});
  return {};
};
lock(true);
app.connect().then(async () => {
  theme(app.getHostContext()); signedOut(); await restore(); lock(false);
}).catch(() => {
  signedOut(); lock(false); notice('无法恢复已保存的连接。可重试；若授权已撤销，请在插件连接设置中重新登录。', true);
});
