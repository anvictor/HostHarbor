import { app, BrowserWindow, Menu, ipcMain, dialog, safeStorage, nativeTheme } from 'electron';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ProfileStore } from './core/store.js';
import { absolutePath, child, component, forbidRoot, safeError } from './core/paths.js';
import { LocalAdapter } from './adapters/local.js';
import { SFTPAdapter, FTPAdapter } from './adapters/remote.js';
import { TransferQueue } from './core/queue.js';

if (process.env.HOSTHARBOR_USER_DATA) app.setPath('userData', absolutePath(process.env.HOSTHARBOR_USER_DATA));
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
const chosenKeys = new Set();
const directory = path.dirname(fileURLToPath(import.meta.url));
const rendererUrl = pathToFileURL(path.join(directory, 'renderer/index.html')).href;
let window, store, session = null, closing = false, credentialsInUse = [];
app.on('second-instance', () => {
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
});
const local = new LocalAdapter();
const emit = (channel, value) => { if (window && !window.isDestroyed()) window.webContents.send(`harbor:${channel}`, value); };
const confirm = async (message, detail, action = 'Продовжити') => {
  const result = await dialog.showMessageBox(window, { type: 'warning', message, detail, buttons: ['Скасувати', action], defaultId: 0, cancelId: 0, noLink: true });
  return result.response === 1;
};
const describeError = error => safeError(error, credentialsInUse);
function connectionLost(bound) { if (session === bound) { session = null; emit('connection', { connected: false }); } }
const queue = new TransferQueue({ local, emit: value => emit('queue', value), confirmOverwrite: target => confirm('Замінити наявний файл?', target, 'Замінити'), onTransportFailure: connectionLost, describeError });
function idle() { if (queue.busy()) throw new Error('Дочекайтесь завершення черги або скасуйте її.'); }
function adapter(side) { if (side === 'local') return local; if (side === 'remote' && session) return session.adapter; throw new Error('Немає активного з’єднання.'); }
async function listing(side, value) { const p = absolutePath(value, side === 'remote'); return { path: p, entries: await adapter(side).list(p) }; }
let commandTail = Promise.resolve();
function register(name, handler, concurrent = false) {
  ipcMain.handle(`harbor:${name}`, async (event, payload) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame || event.senderFrame.url !== rendererUrl) return { ok: false, error: 'Недозволене джерело запиту.' };
    const execute = async () => { try { return { ok: true, value: await handler(payload) }; } catch (error) { return { ok: false, error: describeError(error) }; } };
    if (concurrent) return execute();
    const result = commandTail.then(execute); commandTail = result.then(() => {}); return result;
  });
}
function registerHandlers() {
  register('bootstrap', async () => ({ profiles: store.publicProfiles(), localPath: os.homedir(), localEntries: await local.list(os.homedir()), secretStorageAvailable: store.available() }));
  register('list', async input => { idle(); if (!input || !['local', 'remote'].includes(input.side)) throw new Error('Некоректна панель.'); return listing(input.side, input.path); });
  register('saveProfile', async input => {
    idle();
    const previous = store.publicProfiles().find(p => p.id === input?.id);
    if (input?.keyPath && input.keyPath !== previous?.keyPath && !chosenKeys.has(input.keyPath)) throw new Error('Оберіть приватний ключ через системний діалог.');
    await store.save(input);
    if (session && session.profileId === input.id) { session.adapter.close(); session = null; emit('connection', { connected: false }); }
    return store.publicProfiles();
  });
  register('deleteProfile', async id => { idle(); if (typeof id !== 'string') throw new Error('Некоректне з’єднання.'); if (session?.profileId === id) { session.adapter.close(); session = null; emit('connection', { connected: false }); } await store.remove(id); return store.publicProfiles(); });
  register('chooseKey', async () => { const result = await dialog.showOpenDialog(window, { title: 'Приватний ключ SSH', properties: ['openFile', 'dontAddToRecent'] }); if (result.canceled) return null; chosenKeys.add(result.filePaths[0]); return result.filePaths[0]; });
  register('chooseLocalDirectory', async () => { const result = await dialog.showOpenDialog(window, { title: 'Локальна тека', properties: ['openDirectory', 'dontAddToRecent'] }); return result.canceled ? null : result.filePaths[0]; });
  register('connect', async input => {
    idle();
    if (!input || typeof input.profile?.id !== 'string') throw new Error('Спочатку збережіть з’єднання.');
    const saved = store.publicProfiles().find(profile => profile.id === input.profile.id);
    if (!saved) throw new Error('З’єднання не знайдено.');
    const secret = input.password || input.passphrase ? {} : store.getSecret(saved.id);
    const credentials = { password: input.password || secret.password || '', passphrase: input.passphrase || secret.passphrase || '' };
    for (const value of Object.values(credentials)) if (typeof value !== 'string' || value.length > 16384) throw new Error('Некоректний секрет.');
    credentialsInUse = Object.values(credentials).filter(Boolean);
    if (saved.protocol === 'ftp' && !await confirm('FTP передає пароль і файли відкритим текстом.', `Сервер: ${saved.host}:${saved.port}\nВикористовуйте лише в довіреній мережі.`, 'Під’єднатися через FTP')) throw new Error('З’єднання скасовано.');
    session?.adapter.close(); session = null; emit('connection', { connected: false });
    const remote = saved.protocol === 'sftp' ? new SFTPAdapter() : new FTPAdapter();
    const bound = { id: randomUUID(), profileId: saved.id, adapter: remote };
    try {
      await remote.connect(saved, credentials, (identity, fingerprint) => store.trustHost(identity, fingerprint, (host, key) => confirm('Довіряти ключу SSH сервера?', `${host}\n\nВідбиток ${key}\n\nЗвірте відбиток із адміністратором перед підтвердженням.`, 'Довіряти й під’єднатися')), () => connectionLost(bound));
      const entries = await remote.list(saved.remotePath);
      if (input.rememberSecret === true) await store.save(saved, credentials);
      session = bound; emit('connection', { connected: true, profileId: saved.id });
      return { profileId: saved.id, path: saved.remotePath, entries };
    } catch (error) { remote.close(); throw error; }
  });
  register('disconnect', async () => { idle(); session?.adapter.close(); session = null; credentialsInUse = []; emit('connection', { connected: false }); });
  register('mutate', async input => {
    idle(); if (!input || !['local', 'remote'].includes(input.side)) throw new Error('Некоректна панель.');
    const remote = input.side === 'remote'; const api = remote ? path.posix : path; const target = adapter(input.side);
    const p = absolutePath(input.path, remote);
    if (input.operation === 'mkdir') await target.mkdir(child(p, component(input.name), remote));
    else if (input.operation === 'rename') await target.rename(forbidRoot(p, remote), child(api.dirname(p), component(input.name), remote));
    else if (input.operation === 'delete') {
      forbidRoot(p, remote); const info = await target.stat(p); if (!info) throw new Error('Файл відсутній.');
      if (info.type !== 'file' && info.type !== 'directory') throw new Error('Операція з посиланням або спеціальним файлом заборонена.');
      if (!await confirm(info.type === 'directory' ? 'Видалити теку та весь її вміст?' : 'Видалити файл?', `${p}\n\nВидалення остаточне. Уже видалені елементи не відновлюються, якщо операція завершиться частково.`, 'Видалити')) return listing(input.side, api.dirname(p));
      await target.remove(p);
    } else throw new Error('Непідтримувана операція.');
    return listing(input.side, input.operation === 'mkdir' ? p : api.dirname(p));
  });
  register('enqueue', async input => { if (!session) throw new Error('Спершу під’єднайтесь до сервера.'); return queue.add(input, session); });
  register('getQueue', async () => queue.snapshot(), true);
  register('cancelQueue', async () => queue.cancel(), true);
}
async function createWindow() {
  closing = false;
  window = new BrowserWindow({ width: 1320, height: 840, minWidth: 980, minHeight: 620, title: 'HostHarbor', backgroundColor: nativeTheme.shouldUseDarkColors ? '#111827' : '#f5f7fb', webPreferences: { preload: path.join(directory, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true, allowRunningInsecureContent: false } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-attach-webview', event => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  window.on('close', event => {
    if (closing || !queue.busy()) return;
    event.preventDefault();
    void confirm('Скасувати чергу й закрити HostHarbor?', 'Передачі буде перервано. Завершені файли збережуться; на сервері може залишитися прихований тимчасовий файл.', 'Закрити').then(approved => { if (approved) { closing = true; queue.cancel(); window.close(); } });
  });
  await window.loadURL(rendererUrl);
}
app.whenReady().then(async () => {
  if (!primaryInstance) return;
  store = new ProfileStore(app.getPath('userData'), safeStorage); await store.load(); registerHandlers();
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'HostHarbor', submenu: [{ role: 'about' }, { type: 'separator' }, { role: 'hide' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] }, { label: 'Правка', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] }, { label: 'Вікно', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'togglefullscreen' }] }]));
  await createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(); });
}).catch(error => { dialog.showErrorBox('HostHarbor', safeError(error)); app.quit(); });
app.on('window-all-closed', () => { session?.adapter.close(); session = null; if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => { if (!queue.busy()) session?.adapter.close(); });
