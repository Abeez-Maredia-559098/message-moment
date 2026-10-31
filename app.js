const $ = id => document.getElementById(id);
let connection = null, editing = null, rows = [], polling = false, toastTimer;
function toast(text) { $('toast').textContent = text; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => $('toast').hidden = true, 5000); }
function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
async function api(route, method = 'GET', body) {
  if (!connection) throw new Error('Connect to your cloud sender first.');
  const response = await fetch(connection.url + '/api/' + route, { method, headers: { Authorization: 'Bearer ' + connection.token, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(12000) });
  const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Request failed'); return result;
}
function localTime(time) { const d = new Date(time); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16); }
function reset() { editing = null; $('message-form').reset(); $('when').value = localTime(Date.now() + 3600000); $('form-title').textContent = 'Schedule a message'; $('schedule').textContent = 'Schedule automatic send ↗'; $('cancel-edit').hidden = true; }
function render() {
  const attention = ['failed', 'uncertain', 'missed'];
  $('count-scheduled').textContent = rows.filter(x => ['scheduled', 'sending'].includes(x.status)).length;
  $('count-sent').textContent = rows.filter(x => x.status === 'sent').length;
  $('count-attention').textContent = rows.filter(x => attention.includes(x.status)).length;
  const filter = $('filter').value;
  const filtered = rows.filter(m => filter === 'all' || (filter === 'attention' ? attention.includes(m.status) : filter === 'scheduled' ? ['scheduled','sending'].includes(m.status) : m.status === filter)).sort((a,b) => a.scheduledAt - b.scheduledAt);
  const list = $('messages'); list.replaceChildren();
  if (!filtered.length) { list.append(node('div', 'No messages here yet. A little planning goes a long way.', 'empty')); return; }
  for (const m of filtered) {
    const item = node('article', undefined, 'item'), top = node('div', undefined, 'row'), who = node('div');
    who.append(node('div', m.name, 'person'), node('small', m.phone));
    top.append(who, node('span', m.status, 'badge ' + m.status));
    item.append(top, node('p', m.text, 'body'), node('small', new Date(m.scheduledAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })));
    if (m.error) item.append(node('p', m.error, 'error'));
    if (m.status === 'scheduled') {
      const actions = node('div', undefined, 'actions');
      const edit = node('button', 'Edit', 'quiet'); edit.onclick = () => { editing = m.id; $('name').value = m.name; $('phone').value = m.phone; $('text').value = m.text; $('when').value = localTime(m.scheduledAt); $('form-title').textContent = 'Edit message'; $('schedule').textContent = 'Save changes'; $('cancel-edit').hidden = false; $('name').focus(); };
      const cancel = node('button', 'Cancel send', 'quiet'); cancel.onclick = async () => { if (!confirm('Cancel this automatic send?')) return; try { await api('messages/' + m.id, 'DELETE'); if (editing === m.id) reset(); await refresh(); } catch (e) { toast(e.message); } };
      actions.append(edit, cancel); item.append(actions);
    }
    list.append(item);
  }
}
async function refresh() {
  if (!connection || polling) return; polling = true;
  try {
    const [status, messages] = await Promise.all([api('status'), api('messages')]); rows = messages;
    $('status').textContent = status.ready ? 'WhatsApp connected' : 'WhatsApp: ' + status.state.replaceAll('-', ' ');
    $('status-detail').textContent = status.ready ? 'Cloud sender is ready. You can close this app.' : 'Link WhatsApp to enable automatic sending.';
    $('dot').classList.toggle('connected', status.ready); $('whatsapp').hidden = status.ready;
    $('qr').hidden = !status.qr; if (status.qr) $('qr').src = status.qr;
    $('schedule').disabled = false; render();
  } catch (e) { $('status').textContent = 'Cloud sender unreachable'; $('status-detail').textContent = 'Free hosting may be waking up. Check your connection and try again.'; $('dot').classList.remove('connected'); $('schedule').disabled = true; }
  finally { polling = false; }
}
$('settings-button').onclick = () => $('settings').hidden = !$('settings').hidden;
$('show-key').onclick = () => { $('display-key').type = $('display-key').type === 'password' ? 'text' : 'password'; };
$('connection-form').onsubmit = async e => {
  e.preventDefault(); $('connect-error').textContent = '';
  try {
    const url = new URL($('server').value); if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1','localhost'].includes(url.hostname))) throw new Error('Use an HTTPS sender address.');
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Enter only the sender address and port.');
    const proposed = { url: url.origin, token: $('key').value.trim() }; const previous = connection; connection = proposed;
    try { await api('status'); } catch (e) { connection = previous; throw e; }
    try { localStorage.setItem('sender-url', proposed.url); } catch {}
    $('key').value = ''; $('settings').hidden = true; toast('Connected to your cloud sender.'); await refresh();
  } catch (e) { $('connect-error').textContent = e.message || 'Connection failed. Check HTTPS and your key.'; }
};
$('message-form').onsubmit = async e => {
  e.preventDefault(); $('form-error').textContent = ''; $('schedule').disabled = true;
  try { const scheduledAt = new Date($('when').value).getTime(); if (!Number.isFinite(scheduledAt) || scheduledAt <= Date.now()) throw new Error('Choose a date and time in the future.');
    await api('messages' + (editing ? '/' + editing : ''), editing ? 'PUT' : 'POST', { name: $('name').value, phone: $('phone').value, text: $('text').value, scheduledAt });
    reset(); toast('Saved on the sender. It will attempt to send at your chosen time.'); await refresh();
  } catch (e) { $('form-error').textContent = e.message; } finally { $('schedule').disabled = false; }
};
$('reconnect').onclick = async () => { $('reconnect').disabled = true; try { await api('connect','POST'); toast('Starting WhatsApp. The QR code may take a moment.'); } catch (e) { toast(e.message); } finally { setTimeout(() => $('reconnect').disabled = false, 10000); } };
$('filter').onchange = render; $('cancel-edit').onclick = reset;
$('timezone').textContent = 'Your time zone: ' + Intl.DateTimeFormat().resolvedOptions().timeZone;
reset(); $('schedule').disabled = true;
(async () => { if (window.desktop) connection = await window.desktop.connection(); if (connection) { $('desktop-key').hidden = false; $('display-key').value = connection.token; $('server').value = connection.url; await refresh(); } else { $('settings').hidden = false; $('status').textContent = 'Connect to cloud sender'; try { $('server').value = localStorage.getItem('sender-url') || (location.protocol === 'https:' ? location.origin : ''); } catch {} } })().catch(() => toast('Could not connect to the sender.'));
setInterval(() => { if (!document.hidden) refresh(); }, 15000); document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
if ('serviceWorker' in navigator && ['https:','http:'].includes(location.protocol) && !window.Capacitor) navigator.serviceWorker.register('/sw.js').catch(() => {});
