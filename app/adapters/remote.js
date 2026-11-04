import { Client as SSHClient } from 'ssh2';
import { Client as FTPClient } from 'basic-ftp';
import fs from 'node:fs/promises';
import { isIP } from 'node:net';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { absolutePath, component, forbidRoot } from '../core/paths.js';

const call = (target, method, ...args) => new Promise((resolve, reject) => target[method](...args, (error, value) => error ? reject(error) : resolve(value)));
const sshEntry = (name, p, a) => ({ name, path: p, type: a.isSymbolicLink() ? 'symlink' : a.isDirectory() ? 'directory' : a.isFile() ? 'file' : 'other', size: a.size, modified: a.mtime * 1000 });
export class SFTPAdapter {
  remote = true;
  constructor() { this.client = new SSHClient(); this.closed = false; this.client.on('error', () => {}); }
  async connect(profile, credentials, trust, onClose) {
    const privateKey = profile.keyPath ? await fs.readFile(profile.keyPath) : undefined;
    await new Promise((resolve, reject) => {
      const earlyClose = () => reject(new Error('Сервер закрив SSH-з’єднання до автентифікації.'));
      this.client.once('ready', () => { this.client.off('close', earlyClose); resolve(); }); this.client.once('error', reject); this.client.once('close', earlyClose);
      this.client.connect({
        host: profile.host, port: profile.port, username: profile.username,
        password: credentials.password || undefined, privateKey, passphrase: credentials.passphrase || undefined,
        readyTimeout: 20000, keepaliveInterval: 15000, keepaliveCountMax: 2,
        hostHash: 'sha256', hostVerifier: (hash, callback) => { trust(`${profile.host}:${profile.port}`, `SHA256:${Buffer.from(hash, 'hex').toString('base64').replace(/=+$/, '')}`).then(() => callback(true), error => { this.trustError = error; callback(false); }); }
      });
    }).catch(error => { throw this.trustError || error; });
    this.sftp = await call(this.client, 'sftp');
    this.client.on('close', () => { this.closed = true; onClose?.(); });
  }
  async guard(value, allowLeafLink = false) {
    const p = absolutePath(value, true);
    let cursor = '';
    const parts = p.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      cursor += `/${parts[i]}`;
      try {
        const info = await call(this.sftp, 'lstat', cursor);
        if (info.isSymbolicLink() && !(allowLeafLink && i === parts.length - 1)) throw new Error('Перехід через символічне посилання заборонено.');
      } catch (error) { if (error.code === 2) break; throw error; }
    }
    return p;
  }
  async list(p) {
    p = await this.guard(p);
    return (await call(this.sftp, 'readdir', p)).filter(item => item.filename !== '.' && item.filename !== '..').map(item => sshEntry(component(item.filename), path.posix.join(p, item.filename), item.attrs));
  }
  async stat(p) { p = await this.guard(p, true); try { return sshEntry(path.posix.basename(p), p, await call(this.sftp, 'lstat', p)); } catch (error) { if (error.code === 2) return null; throw error; } }
  async mkdir(p) { await this.guard(p); await call(this.sftp, 'mkdir', p); }
  async rename(from, to) { await this.guard(from); await this.guard(to); if (await this.stat(to)) throw new Error('Назва вже існує.'); await call(this.sftp, 'rename', from, to); }
  async remove(p) {
    p = forbidRoot(p, true); await this.guard(p);
    const info = await this.stat(p); if (!info) throw new Error('Файл уже відсутній.');
    if (info.type === 'directory') {
      for (const item of await this.list(p)) { if (item.type === 'symlink' || item.type === 'other') throw new Error('Тека містить посилання або спеціальний файл; видалення припинено.'); await this.remove(item.path); }
      await call(this.sftp, 'rmdir', p);
    } else if (info.type === 'file') await call(this.sftp, 'unlink', p);
    else throw new Error('Операція з посиланням або спеціальним файлом заборонена.');
  }
  async readTo(p, writable, signal) { await this.guard(p); await pipeline(this.sftp.createReadStream(p), writable, { signal }); }
  async writeFrom(readable, p, signal) { await this.guard(p); await pipeline(readable, this.sftp.createWriteStream(p, { flags: 'wx', mode: 0o600 }), { signal }); }
  async commit(from, to) {
    await this.guard(from); await this.guard(to);
    try { await call(this.sftp, 'ext_openssh_rename', from, to); }
    catch (error) { if (error.code !== 8 && error.message !== 'Server does not support this extended request') throw error; await call(this.sftp, 'rename', from, to); }
  }
  async cleanup(p) { if (!this.closed) await call(this.sftp, 'unlink', p).catch(() => {}); }
  close() { this.closed = true; this.client.destroy(); }
}

export class FTPAdapter {
  remote = true;
  constructor({ ca } = {}) { this.client = new FTPClient(20000); this.closed = false; this.ca = ca; }
  async connect(profile, credentials, _trust, _onClose) {
    await this.client.access({ host: profile.host, port: profile.port, user: profile.username, password: credentials.password || '', secure: profile.protocol === 'ftps', secureOptions: { rejectUnauthorized: true, ...(isIP(profile.host) ? {} : { servername: profile.host }), ...(this.ca ? { ca: this.ca } : {}) } });
    await this.client.send('TYPE I');
    this.client.ftp.socket.once('close', () => { this.closed = true; _onClose?.(); });
  }
  async listRaw(p) {
    return (await this.client.list(absolutePath(p, true))).filter(item => item.name !== '.' && item.name !== '..').map(item => ({ name: component(item.name), path: path.posix.join(p, item.name), type: item.isSymbolicLink ? 'symlink' : item.isDirectory ? 'directory' : item.isFile ? 'file' : 'other', size: item.size, modified: item.modifiedAt?.getTime() || null }));
  }
  async guard(value, allowLeafLink = false) {
    const p = absolutePath(value, true); const parts = p.split('/').filter(Boolean); let cursor = '/';
    for (let i = 0; i < parts.length; i++) {
      const item = (await this.listRaw(cursor)).find(item => item.name === parts[i]);
      if (!item) break;
      if (item.type === 'symlink' && !(allowLeafLink && i === parts.length - 1)) throw new Error('Перехід через символічне посилання заборонено.');
      cursor = path.posix.join(cursor, parts[i]);
    }
    return p;
  }
  async list(p) { p = await this.guard(p); return this.listRaw(p); }
  async stat(p) { p = await this.guard(p, true); if (p === '/') return { name: '/', path: '/', type: 'directory', size: 0 }; return (await this.listRaw(path.posix.dirname(p))).find(item => item.path === p) || null; }
  async mkdir(p) { p = await this.guard(p); await this.client.send(`MKD ${p}`); }
  async rename(from, to) { await this.guard(from); await this.guard(to); if (await this.stat(to)) throw new Error('Назва вже існує.'); await this.client.rename(from, to); }
  async remove(p) {
    p = forbidRoot(p, true); await this.guard(p);
    const info = await this.stat(p); if (!info) throw new Error('Файл уже відсутній.');
    if (info.type === 'directory') {
      for (const item of await this.list(p)) { if (item.type === 'symlink' || item.type === 'other') throw new Error('Тека містить посилання або спеціальний файл; видалення припинено.'); await this.remove(item.path); }
      await this.client.send(`RMD ${p}`);
    } else if (info.type === 'file') await this.client.remove(p);
    else throw new Error('Операція з посиланням або спеціальним файлом заборонена.');
  }
  async readTo(p, writable, signal) { await this.guard(p); if (signal.aborted) throw new Error('Передачу скасовано.'); await this.client.downloadTo(writable, p); }
  async writeFrom(readable, p, signal) { await this.guard(p); if (signal.aborted) throw new Error('Передачу скасовано.'); if (await this.stat(p)) throw new Error('Тимчасовий файл уже існує.'); await this.client.uploadFrom(readable, p); }
  async commit(from, to) { await this.guard(from); await this.guard(to); await this.client.rename(from, to); }
  async cleanup(p) { if (!this.closed && !this.client.closed) await this.client.remove(p).catch(() => {}); }
  close() { this.closed = true; this.client.close(); }
}
