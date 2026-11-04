const $ = (id) => document.getElementById(id);
const api = window.harbor;
const state = {
  profiles: [], local: { path: '', entries: [], selected: new Set(), anchor: -1, request: 0 },
  remote: { path: '', entries: [], selected: new Set(), anchor: -1, request: 0 },
  localHome: '', remoteHome: '/', connected: false, profileId: null, secretStorageAvailable: false,
  queue: [], queueRevision: 0, busy: false, nameOperation: null, refreshAfterWork: false,
};
const profileDialog = $('profile-dialog');
const nameDialog = $('name-dialog');
const queueActive = () => state.queue.some((job) => ['pending', 'running'].includes(job.status));
const locked = () => state.busy || queueActive();
const selectedEntries = (side) => state[side].entries.filter((entry) => state[side].selected.has(entry.path));
const byteFormat = new Intl.NumberFormat('uk-UA', { maximumFractionDigits: 1 });
const dateFormat = new Intl.DateTimeFormat('uk-UA', { day: '2-digit', month: '2-digit', year: '2-digit' });
function bytes(value) {
  if (!Number.isFinite(Number(value)) || value === null) return '—';
  let amount = Number(value); let unit = 0;
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++; }
  return `${byteFormat.format(amount)} ${units[unit]}`;
}
function errorMessage(error) {
  let message = typeof error === 'string' ? error : error?.message || 'Не вдалося виконати дію. Спробуйте ще раз.';
  for (const id of ['profile-password', 'profile-passphrase']) {
    const secret = $(id).value;
    if (secret) message = message.split(secret).join('••••');
  }
  return message;
}
async function call(method, argument) {
  if (!api || typeof api[method] !== 'function') throw new Error('Не вдалося завантажити зв’язок із програмою. Перезапустіть HostHarbor.');
  const result = argument === undefined ? await api[method]() : await api[method](argument);
  if (!result?.ok) { const error = new Error(errorMessage(result?.error)); error.details = errorMessage(result?.errorDetails || ''); if (!result?.errorDetails) error.details = ''; throw error; }
  return result.value;
}
function showDetails(id, details = '') {
  const element = $(id); if (!element) return;
  element.hidden = !details; element.open = false;
  element.querySelector('pre').textContent = details;
}
function notice(message, details = '') { $('notice-text').textContent = message; showDetails('notice-details', details); $('notice').hidden = false; }
async function perform(action, { formError } = {}) {
  if (state.busy) return;
  state.busy = true; refreshControls();
  try { await action(); }
  catch (error) {
    const message = errorMessage(error);
    if (formError) { $(formError).textContent = message; $(formError).hidden = false; showDetails(`${formError}-details`, error.details); }
    else notice(message, error.details);
  } finally {
    state.busy = false; refreshControls();
    if (state.refreshAfterWork && !queueActive()) { state.refreshAfterWork = false; refreshPanes(); }
  }
}
function sorted(entries) {
  return [...(entries || [])].sort((a, b) => (a.type === 'directory' ? 0 : 1) - (b.type === 'directory' ? 0 : 1) || a.name.localeCompare(b.name, 'uk', { numeric: true }));
}
function applyListing(side, listing) {
  state[side].path = listing.path;
  state[side].entries = sorted(listing.entries);
  state[side].selected.clear(); state[side].anchor = -1;
  renderPane(side);
}
function leaf(path) { return String(path).replace(/[\\/]$/, '').split(/[\\/]/).pop() || path; }
function joinPath(side, parent, name) {
  const separator = side === 'local' && /^[A-Za-z]:\\|^\\\\/.test(parent) ? '\\' : '/';
  return `${parent.replace(/[\\/]+$/, '')}${separator}${name}`;
}
function parentPath(side, path) {
  if (side === 'local' && /^[A-Za-z]:[\\/]/.test(path)) {
    const separator = path.includes('\\') ? '\\' : '/';
    const trimmed = path.replace(/[\\/]+$/, '');
    const end = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
    return end <= 2 ? `${path.slice(0, 2)}${separator}` : trimmed.slice(0, end);
  }
  const trimmed = path.replace(/\/+$/, '');
  return trimmed.slice(0, trimmed.lastIndexOf('/')) || '/';
}
async function navigate(side, path) {
  if (locked() || (side === 'remote' && !state.connected) || !path) return;
  await perform(async () => {
    const request = ++state[side].request;
    const connection = state.profileId;
    const listing = await call('list', { side, path });
    if (request === state[side].request && (side === 'local' || (state.connected && connection === state.profileId))) applyListing(side, listing);
  });
}
async function refreshPanes() {
  if (locked()) { state.refreshAfterWork = true; return; }
  await perform(async () => {
    const results = await Promise.allSettled(['local', ...(state.connected ? ['remote'] : [])].map(async (side) => {
      const connection = state.profileId;
      const listing = await call('list', { side, path: state[side].path });
      if (side === 'local' || (state.connected && state.profileId === connection)) applyListing(side, listing);
    }));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) notice(errorMessage(failure.reason));
  });
}
function renderProfiles() {
  const container = $('profiles'); container.replaceChildren();
  if (!state.profiles.length) {
    const hint = document.createElement('p'); hint.className = 'profiles-empty';
    hint.textContent = 'Додайте перший сервер кнопкою +. Підключення зберігатимуться тут.'; container.append(hint);
  }
  for (const profile of state.profiles) {
    const row = document.createElement('div'); row.className = `profile-row${state.connected && profile.id === state.profileId ? ' active' : ''}`;
    const button = document.createElement('button'); button.className = 'profile-main'; button.disabled = locked();
    button.title = `${profile.name} · ${profile.host}`;
    const icon = document.createElement('span'); icon.className = 'profile-icon'; icon.textContent = '☷'; icon.setAttribute('aria-hidden', 'true');
    const copy = document.createElement('span'); copy.className = 'profile-copy';
    const title = document.createElement('span'); title.className = 'profile-name'; title.textContent = profile.name;
    const host = document.createElement('span'); host.className = 'profile-host'; host.textContent = `${profile.protocol.toUpperCase()} · ${profile.host}`;
    copy.append(title, host); button.append(icon, copy); button.addEventListener('click', () => openProfile(profile));
    const edit = document.createElement('button'); edit.className = 'icon-button profile-edit'; edit.textContent = '⋯'; edit.disabled = locked();
    edit.setAttribute('aria-label', `Редагувати ${profile.name}`); edit.title = 'Налаштування підключення'; edit.addEventListener('click', () => openProfile(profile));
    row.append(button, edit); container.append(row);
  }
}
function renderPane(side) {
  const pane = state[side]; const tbody = $(`${side}-files`); tbody.replaceChildren();
  $(`${side}-path`).value = pane.path;
  pane.entries.forEach((entry, index) => {
    const row = document.createElement('tr'); row.className = 'file-row'; row.tabIndex = 0;
    row.setAttribute('aria-label', `${entry.type === 'directory' ? 'Папка' : entry.type === 'symlink' ? 'Символічне посилання' : 'Файл'}: ${entry.name}`);
    row.dataset.path = entry.path;
    const nameCell = document.createElement('td');
    const content = document.createElement('div'); content.className = 'file-name';
    const icon = document.createElement('span'); icon.className = `file-icon ${entry.type}`; icon.textContent = entry.type === 'directory' ? '▰' : entry.type === 'symlink' ? '↗' : '▤'; icon.setAttribute('aria-hidden', 'true');
    const name = document.createElement('span'); name.textContent = entry.name; name.title = entry.name;
    content.append(icon, name); nameCell.append(content);
    const size = document.createElement('td'); size.textContent = entry.type === 'directory' ? '—' : bytes(entry.size);
    const modified = document.createElement('td');
    const date = entry.modified ? new Date(entry.modified) : null;
    modified.textContent = date && !Number.isNaN(date.getTime()) ? dateFormat.format(date) : '—';
    row.append(nameCell, size, modified);
    row.addEventListener('click', (event) => select(side, index, event));
    row.addEventListener('dblclick', () => { if (entry.type === 'directory') navigate(side, entry.path); });
    row.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') { event.preventDefault(); if (entry.type === 'directory') navigate(side, entry.path); else select(side, index, event); }
      if (event.key === ' ') { event.preventDefault(); select(side, index, { ctrlKey: true, shiftKey: event.shiftKey }); }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'a') { event.preventDefault(); pane.selected = new Set(pane.entries.map((item) => item.path)); updateSelection(side); }
      if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
        event.preventDefault(); const next = Math.min(pane.entries.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)));
        select(side, next, event); tbody.children[next]?.focus();
      }
    });
    tbody.append(row);
  });
  const empty = $(`${side}-empty`);
  if (side === 'local' || state.connected) {
    empty.replaceChildren(); empty.textContent = 'У цій папці поки немає файлів.'; empty.hidden = pane.entries.length > 0;
  }
  $(`${side}-count`).textContent = side === 'remote' && !state.connected ? 'Немає підключення' : `${pane.entries.length} елементів`;
  updateSelection(side);
}
function select(side, index, event) {
  const pane = state[side]; const entry = pane.entries[index]; if (!entry) return;
  if (event.shiftKey && pane.anchor >= 0) {
    if (!event.ctrlKey && !event.metaKey) pane.selected.clear();
    const start = Math.min(pane.anchor, index); const end = Math.max(pane.anchor, index);
    for (let cursor = start; cursor <= end; cursor++) pane.selected.add(pane.entries[cursor].path);
  } else if (event.ctrlKey || event.metaKey) {
    if (pane.selected.has(entry.path)) pane.selected.delete(entry.path); else pane.selected.add(entry.path);
    pane.anchor = index;
  } else { pane.selected = new Set([entry.path]); pane.anchor = index; }
  updateSelection(side);
}
function updateSelection(side) {
  for (const row of $(`${side}-files`).children) {
    const selected = state[side].selected.has(row.dataset.path); row.classList.toggle('selected', selected); row.setAttribute('aria-selected', String(selected));
  }
  const count = state[side].selected.size;
  $(`${side}-selection`).textContent = count ? `Вибрано: ${count}` : '';
  refreshControls();
}
function refreshControls() {
  const blocked = locked();
  for (const side of ['local', 'remote']) {
    const unavailable = blocked || (side === 'remote' && !state.connected) || !state[side].path;
    for (const suffix of ['path', 'up', 'home', 'refresh', 'mkdir']) $(`${side}-${suffix}`).disabled = unavailable;
    $(`${side}-path-form`).querySelector('[type="submit"]').disabled = unavailable;
    $(`${side}-rename`).disabled = unavailable || state[side].selected.size !== 1;
    $(`${side}-delete`).disabled = unavailable || state[side].selected.size === 0;
  }
  $('local-browse').disabled = blocked;
  $('disconnect').disabled = blocked || !state.connected;
  $('add-profile').disabled = blocked; $('empty-connect') && ($('empty-connect').disabled = blocked);
  $('upload').disabled = blocked || !state.connected || !state.local.selected.size;
  $('download').disabled = blocked || !state.connected || !state.remote.selected.size;
  $('cancel-queue').disabled = !queueActive() || state.busy;
  $('activity-label').textContent = state.busy ? 'Виконання…' : queueActive() ? 'Передача файлів…' : 'Готово до роботи';
  $('activity-dot').classList.toggle('working', state.busy || queueActive());
  for (const button of $('profiles').querySelectorAll('button')) button.disabled = blocked;
  for (const element of $('profile-form').elements) element.disabled = state.busy;
  $('profile-remember').disabled = state.busy || !state.secretStorageAvailable;
  for (const element of $('name-form').elements) element.disabled = state.busy;
}
function renderConnection() {
  const profile = state.profiles.find((item) => item.id === state.profileId);
  $('connection-state').classList.toggle('connected', state.connected);
  $('connection-label').textContent = state.connected ? profile?.name || 'Під’єднано' : 'Не під’єднано';
  $('remote-title').textContent = state.connected ? profile?.name || 'Віддалений сервер' : 'Віддалений сервер';
  $('remote-subtitle').textContent = state.connected ? `${profile?.username || ''}@${profile?.host || ''}` : 'Оберіть підключення';
  $('protocol-badge').hidden = !state.connected;
  $('protocol-badge').textContent = profile?.protocol?.toUpperCase() || '';
  if (!state.connected) {
    state.remote.path = ''; state.remote.entries = []; state.remote.selected.clear(); state.remote.request++;
    renderPane('remote');
    const empty = $('remote-empty'); empty.hidden = false; empty.replaceChildren();
    const icon = document.createElement('span'); icon.className = 'empty-symbol'; icon.textContent = '⇄'; icon.setAttribute('aria-hidden', 'true');
    const title = document.createElement('h3'); title.textContent = 'Під’єднайте свій сервер';
    const text = document.createElement('p'); text.textContent = 'SFTP, FTP або захищений FTPS. Ваші файли з’являться тут.';
    const button = document.createElement('button'); button.id = 'empty-connect'; button.className = 'button primary'; button.textContent = 'Нове підключення'; button.addEventListener('click', () => openProfile());
    empty.append(icon, title, text, button);
  }
  renderProfiles(); refreshControls();
}
function clearSecrets() { $('profile-password').value = ''; $('profile-passphrase').value = ''; }
function openProfile(profile = null) {
  if (locked()) return;
  $('profile-form').reset(); clearSecrets();
  $('profile-id').value = profile?.id || '';
  $('profile-dialog-title').textContent = profile ? 'Налаштування сервера' : 'Новий сервер';
  for (const [field, value] of Object.entries({ name: profile?.name || '', protocol: profile?.protocol || 'sftp', host: profile?.host || '', port: profile?.port || 22, username: profile?.username || '', 'remote-path': profile?.remotePath || '/', key: profile?.keyPath || '' })) $(`profile-${field}`).value = value;
  $('profile-password').placeholder = profile?.hasSecret ? 'Збережений пароль доступний · залиште порожнім' : 'Введіть пароль';
  $('secret-hint').textContent = state.secretStorageAvailable ? 'Збережені секрети не показуються у формі. Залиште поля порожніми, щоб використати збережені.' : 'Захищене сховище ОС недоступне. Можна під’єднатись без збереження секретів.';
  $('delete-profile').hidden = !profile;
  $('profile-error').hidden = true; showDetails('profile-error-details'); updateProtocol(); refreshControls();
  profileDialog.showModal(); $('profile-name').focus();
}
function updateProtocol() {
  const protocol = $('profile-protocol').value;
  $('key-fields').hidden = protocol !== 'sftp'; $('ftp-warning').hidden = protocol !== 'ftp';
}
function readProfile() {
  const profile = { name: $('profile-name').value.trim(), protocol: $('profile-protocol').value, host: $('profile-host').value.trim(), port: Number($('profile-port').value), username: $('profile-username').value.trim(), remotePath: $('profile-remote-path').value.trim() || '/', keyPath: $('profile-protocol').value === 'sftp' ? $('profile-key').value : '' };
  if ($('profile-id').value) profile.id = $('profile-id').value;
  return profile;
}
async function saveProfile(connect) {
  if (locked() || !$('profile-form').reportValidity()) return;
  $('profile-error').hidden = true; showDetails('profile-error-details');
  await perform(async () => {
    const input = readProfile();
    if (state.connected && input.id === state.profileId) {
      await call('disconnect'); state.connected = false; state.profileId = null; renderConnection();
    }
    state.profiles = await call('saveProfile', input);
    const saved = input.id ? state.profiles.find((profile) => profile.id === input.id) : state.profiles.at(-1);
    if (!saved) throw new Error('Не вдалося зберегти профіль.');
    $('profile-id').value = saved.id; renderProfiles();
    if (connect) {
      const connection = await call('connect', { profile: saved, password: $('profile-password').value || undefined, passphrase: saved.protocol === 'sftp' ? $('profile-passphrase').value || undefined : undefined, rememberSecret: $('profile-remember').checked && state.secretStorageAvailable });
      state.connected = true; state.profileId = connection.profileId; state.remoteHome = saved.remotePath || '/';
      renderConnection(); applyListing('remote', connection);
    }
    profileDialog.close(); clearSecrets();
    if (!connect) notice('Підключення збережено.');
  }, { formError: 'profile-error' });
  clearSecrets();
}
function openNameDialog(side, operation) {
  if (locked() || (side === 'remote' && !state.connected)) return;
  const entry = selectedEntries(side)[0]; if (operation === 'rename' && state[side].selected.size !== 1) return;
  state.nameOperation = { side, operation, path: operation === 'rename' ? entry.path : state[side].path };
  $('name-title').textContent = operation === 'rename' ? 'Перейменувати' : 'Нова папка';
  $('entry-name').value = operation === 'rename' ? entry.name : ''; $('name-error').hidden = true;
  nameDialog.showModal(); $('entry-name').focus(); $('entry-name').select();
}
async function transfer(direction) {
  if (locked() || !state.connected) return;
  const source = direction === 'upload' ? 'local' : 'remote'; const destination = source === 'local' ? 'remote' : 'local';
  const entries = selectedEntries(source); const destinationPath = state[destination].path;
  await perform(async () => {
    for (const entry of entries) {
      const revision = state.queueRevision;
      const queue = await call('enqueue', { direction, sourcePath: entry.path, destinationPath: joinPath(destination, destinationPath, entry.name) });
      if (revision === state.queueRevision) state.queue = queue;
      renderQueue();
    }
  });
}
const statuses = { pending: 'Очікування', running: 'Передача…', completed: 'Завершено', failed: 'Помилка', cancelled: 'Скасовано', skipped: 'Пропущено' };
function renderQueue() {
  const list = $('queue-list'); list.replaceChildren();
  if (!state.queue.length) {
    const empty = document.createElement('div'); empty.className = 'queue-empty'; empty.textContent = 'Виберіть файли та натисніть стрілку між панелями, щоб розпочати передачу.'; list.append(empty);
  }
  for (const job of state.queue) {
    const row = document.createElement('div'); row.className = 'queue-job';
    const direction = document.createElement('span'); direction.className = 'job-direction'; direction.textContent = job.direction === 'upload' ? '↑' : '↓'; direction.title = job.direction === 'upload' ? 'На сервер' : 'На комп’ютер';
    const info = document.createElement('div'); info.className = 'job-info';
    const name = document.createElement('div'); name.className = 'job-name'; name.textContent = leaf(job.sourcePath); name.title = job.sourcePath;
    const path = document.createElement('div'); path.className = 'job-path'; path.textContent = job.destinationPath; path.title = job.destinationPath;
    info.append(name, path);
    const progressArea = document.createElement('div'); progressArea.className = 'job-progress';
    const progress = document.createElement('progress'); progress.max = Math.max(1, Number(job.total) || 0);
    progress.setAttribute('aria-label', `Передача ${leaf(job.sourcePath)}`);
    if (Number(job.total) > 0) progress.value = Math.min(Number(job.bytes) || 0, Number(job.total));
    else if (job.status !== 'running') progress.value = 0;
    const size = document.createElement('div'); size.className = 'job-size'; size.textContent = Number(job.total) > 0 ? `${bytes(job.bytes || 0)} / ${bytes(job.total)}` : bytes(job.bytes || 0);
    progressArea.append(progress, size);
    const status = document.createElement('span'); status.className = `job-status ${job.status === 'failed' ? 'failed' : ''}`; status.textContent = statuses[job.status] || job.status;
    if (job.skipped) status.textContent += ` · пропущено: ${job.skipped}`;
    row.append(direction, info, progressArea, status);
    if (job.error) { const error = document.createElement('div'); error.className = 'job-error'; error.textContent = errorMessage(job.error); row.append(error); }
    list.append(row);
  }
  const active = state.queue.filter((job) => ['pending', 'running'].includes(job.status)).length;
  const completed = state.queue.filter((job) => job.status === 'completed').length;
  const failed = state.queue.filter((job) => job.status === 'failed').length;
  $('queue-summary').textContent = state.queue.length ? `${active ? `У роботі: ${active} · ` : ''}Завершено: ${completed} з ${state.queue.length}${failed ? ` · помилок: ${failed}` : ''}` : 'Готово до роботи';
  refreshControls();
}
for (const side of ['local', 'remote']) {
  $(`${side}-path-form`).addEventListener('submit', (event) => { event.preventDefault(); navigate(side, $(`${side}-path`).value.trim()); });
  $(`${side}-up`).addEventListener('click', () => navigate(side, parentPath(side, state[side].path)));
  $(`${side}-home`).addEventListener('click', () => navigate(side, side === 'local' ? state.localHome : state.remoteHome));
  $(`${side}-refresh`).addEventListener('click', () => navigate(side, state[side].path));
  $(`${side}-mkdir`).addEventListener('click', () => openNameDialog(side, 'mkdir'));
  $(`${side}-rename`).addEventListener('click', () => openNameDialog(side, 'rename'));
  $(`${side}-delete`).addEventListener('click', () => {
    if (locked()) return;
    const entries = selectedEntries(side);
    perform(async () => {
      for (const entry of entries) {
        const listing = await call('mutate', { side, operation: 'delete', path: entry.path });
        if (listing) applyListing(side, listing);
      }
    });
  });
}
$('local-browse').addEventListener('click', () => {
  if (locked()) return;
  perform(async () => { const path = await call('chooseLocalDirectory'); if (path) applyListing('local', await call('list', { side: 'local', path })); });
});
$('add-profile').addEventListener('click', () => openProfile());
$('empty-connect').addEventListener('click', () => openProfile());
$('dismiss-notice').addEventListener('click', () => { $('notice').hidden = true; });
$('upload').addEventListener('click', () => transfer('upload'));
$('download').addEventListener('click', () => transfer('download'));
$('disconnect').addEventListener('click', () => { if (!locked()) perform(async () => { await call('disconnect'); state.connected = false; state.profileId = null; renderConnection(); }); });
$('cancel-queue').addEventListener('click', () => perform(async () => { await call('cancelQueue'); state.queue = await call('getQueue'); renderQueue(); }));
$('profile-form').addEventListener('submit', (event) => { event.preventDefault(); saveProfile(true); });
$('save-profile').addEventListener('click', () => saveProfile(false));
$('close-profile').addEventListener('click', () => { if (!state.busy) profileDialog.close(); });
profileDialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
profileDialog.addEventListener('close', clearSecrets);
$('profile-protocol').addEventListener('change', () => { $('profile-port').value = $('profile-protocol').value === 'sftp' ? 22 : 21; updateProtocol(); });
$('choose-key').addEventListener('click', () => perform(async () => { const key = await call('chooseKey'); if (key) $('profile-key').value = key; }, { formError: 'profile-error' }));
$('clear-key').addEventListener('click', () => { $('profile-key').value = ''; $('profile-passphrase').value = ''; });
$('delete-profile').addEventListener('click', () => {
  if (locked()) return;
  const id = $('profile-id').value;
  perform(async () => { state.profiles = await call('deleteProfile', id); renderProfiles(); profileDialog.close(); notice('Профіль прибрано. Файли сервера не змінено.'); }, { formError: 'profile-error' });
});
for (const id of ['close-name', 'cancel-name']) $(id).addEventListener('click', () => { if (!state.busy) nameDialog.close(); });
nameDialog.addEventListener('cancel', (event) => { if (state.busy) event.preventDefault(); });
$('name-form').addEventListener('submit', (event) => {
  event.preventDefault(); if (locked() || !state.nameOperation) return;
  const name = $('entry-name').value;
  if (!name || name === '.' || name === '..' || /[\\/\x00-\x1f]/.test(name)) { $('name-error').textContent = 'Введіть одне ім’я без слешів або керівних символів.'; $('name-error').hidden = false; return; }
  const operation = { ...state.nameOperation, name };
  perform(async () => { applyListing(operation.side, await call('mutate', operation)); nameDialog.close(); }, { formError: 'name-error' });
});
async function initialize() {
  await perform(async () => {
    const bootstrap = await call('bootstrap'); state.profiles = bootstrap.profiles || [];
    state.secretStorageAvailable = Boolean(bootstrap.secretStorageAvailable); state.localHome = bootstrap.localPath;
    applyListing('local', { path: bootstrap.localPath, entries: bootstrap.localEntries || [] });
    state.queue = await call('getQueue'); renderQueue(); renderConnection();
    api.onQueue((queue) => {
      const wasActive = queueActive(); state.queueRevision++; state.queue = queue; renderQueue();
      if (wasActive && !queueActive()) { state.refreshAfterWork = true; if (!state.busy) { state.refreshAfterWork = false; refreshPanes(); } }
    });
    api.onConnection((connection) => {
      state.connected = Boolean(connection.connected); state.profileId = connection.profileId || null;
      renderConnection(); if (connection.error) notice(errorMessage(connection.error));
    });
  });
}
initialize();
