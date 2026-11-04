import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { profile } from './paths.js';

export class ProfileStore {
  constructor(directory, encryption) { this.directory = directory; this.encryption = encryption; this.data = { version: 1, profiles: [], trust: {} }; }
  available() {
    return this.encryption.isEncryptionAvailable() && (!this.encryption.getSelectedStorageBackend || this.encryption.getSelectedStorageBackend() !== 'basic_text');
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    try {
      const data = JSON.parse(await fs.readFile(path.join(this.directory, 'connections.json'), 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.profiles) || !data.trust || typeof data.trust !== 'object') throw new Error('Некоректний формат сховища.');
      this.data = data;
    } catch (error) { if (error.code !== 'ENOENT') throw new Error('Не вдалося прочитати збережені з’єднання. Сховище залишено без змін.'); }
  }
  publicProfiles() { return this.data.profiles.map(({ secret, ...p }) => ({ ...p, hasSecret: Boolean(secret) })); }
  async persist(next) {
    const target = path.join(this.directory, 'connections.json');
    const staging = `${target}.${randomUUID()}.tmp`;
    try { await fs.writeFile(staging, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600, flag: 'wx' }); await fs.rename(staging, target); this.data = next; }
    finally { await fs.rm(staging, { force: true }).catch(() => {}); }
  }
  async save(input, secret) {
    const existing = input.id ? this.data.profiles.find(p => p.id === input.id) : null;
    if (input.id && !existing) throw new Error('З’єднання не знайдено.');
    const clean = profile(input, existing?.id || randomUUID());
    let encrypted = existing?.secret;
    // Credentials belong to this exact endpoint and identity; edits cannot silently reuse them elsewhere.
    if (existing && ['host', 'port', 'username', 'protocol', 'keyPath'].some(key => existing[key] !== clean[key])) encrypted = undefined;
    if (secret !== undefined) {
      if (secret === null) encrypted = undefined;
      else {
        if (!this.available()) throw new Error('Захищене сховище ОС недоступне. Секрет не збережено.');
        encrypted = this.encryption.encryptString(JSON.stringify(secret)).toString('base64');
      }
    }
    const saved = { ...clean, ...(encrypted ? { secret: encrypted } : {}) };
    await this.persist({ ...this.data, profiles: [...this.data.profiles.filter(p => p.id !== clean.id), saved] });
    return clean;
  }
  async remove(id) { await this.persist({ ...this.data, profiles: this.data.profiles.filter(p => p.id !== id) }); }
  getSecret(id) {
    const item = this.data.profiles.find(p => p.id === id);
    if (!item?.secret) return {};
    if (!this.available()) throw new Error('Захищене сховище ОС недоступне. Введіть пароль вручну.');
    try { return JSON.parse(this.encryption.decryptString(Buffer.from(item.secret, 'base64'))); }
    catch { throw new Error('Не вдалося розшифрувати секрет. Введіть пароль вручну.'); }
  }
  async trustHost(identity, fingerprint, approve) {
    const previous = Object.hasOwn(this.data.trust, identity) ? this.data.trust[identity] : undefined;
    if (previous && previous !== fingerprint) throw new Error('Ключ SSH сервера змінився. Підключення заблоковано; перевірте сервер і сховище довіри.');
    if (previous) return;
    if (!await approve(identity, fingerprint)) throw new Error('Ключ SSH не підтверджено.');
    await this.persist({ ...this.data, trust: { ...this.data.trust, [identity]: fingerprint } });
  }
}
