import fs from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { absolutePath, component, forbidRoot } from '../core/paths.js';

const entry = (name, p, info) => ({ name, path: p, type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size, modified: info.mtimeMs });
export class LocalAdapter {
  remote = false;
  async guard(value, allowLeafLink = false) {
    const p = absolutePath(value);
    let cursor = path.parse(p).root;
    const parts = p.slice(cursor.length).split(path.sep).filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      try {
        const info = await fs.lstat(cursor);
        if (info.isSymbolicLink() && !(allowLeafLink && i === parts.length - 1)) throw new Error('Перехід через символічне посилання заборонено.');
      } catch (error) { if (error.code === 'ENOENT') break; throw error; }
    }
    return p;
  }
  async list(p) {
    p = await this.guard(p);
    const names = await fs.readdir(p);
    const entries = await Promise.all(names.map(async name => {
      try { component(name); return entry(name, path.join(p, name), await fs.lstat(path.join(p, name))); }
      catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    }));
    return entries.filter(Boolean);
  }
  async stat(p) { p = await this.guard(p, true); try { return entry(path.basename(p), p, await fs.lstat(p)); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
  async mkdir(p) { await this.guard(p); await fs.mkdir(p); }
  async rename(from, to) { await this.guard(from); await this.guard(to); if (await this.stat(to)) throw new Error('Назва вже існує.'); await fs.rename(from, to); }
  async remove(p) {
    p = forbidRoot(p); await this.guard(p);
    const info = await this.stat(p);
    if (!info) throw new Error('Файл уже відсутній.');
    if (info.type === 'directory') {
      for (const item of await this.list(p)) { if (item.type === 'symlink' || item.type === 'other') throw new Error('Тека містить посилання або спеціальний файл; рекурсивне видалення припинено.'); await this.remove(item.path); }
      await fs.rmdir(p);
    } else if (info.type === 'file') await fs.unlink(p);
    else throw new Error('Операція з посиланням або спеціальним файлом заборонена.');
  }
  async readTo(p, writable, signal) { await this.guard(p); await pipeline(createReadStream(p), writable, { signal }); }
  async writeFrom(readable, p, signal) { await this.guard(p); await pipeline(readable, createWriteStream(p, { flags: 'wx', mode: 0o600 }), { signal }); }
  async commit(from, to) { await this.guard(from); await this.guard(to); await fs.rename(from, to); }
  async cleanup(p) { await this.guard(p); await fs.unlink(p).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
}
