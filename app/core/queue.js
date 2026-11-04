import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Transform } from 'node:stream';
import { child, absolutePath, isWithin } from './paths.js';

const aborted = signal => { if (signal.aborted) throw new Error('Передачу скасовано.'); };
const signature = info => info ? `${info.type}:${info.size}:${info.modified}` : null;
export class TransferQueue {
  constructor({ local, emit, confirmOverwrite, onTransportFailure = () => {}, describeError = error => String(error.message) }) {
    this.local = local; this.emit = emit; this.confirmOverwrite = confirmOverwrite; this.onTransportFailure = onTransportFailure; this.describeError = describeError;
    this.jobs = []; this.running = false;
  }
  busy() { return this.running || this.jobs.some(job => job.status === 'pending'); }
  snapshot() { return this.jobs.map(({ session, ...job }) => ({ ...job })); }
  publish() { this.emit(this.snapshot()); }
  add({ direction, sourcePath, destinationPath }, session) {
    if (!session || !['upload', 'download'].includes(direction)) throw new Error('Спершу під’єднайтесь до сервера.');
    if (this.jobs.length >= 1000) { this.jobs = this.jobs.filter(job => ['pending', 'running'].includes(job.status)); if (this.jobs.length >= 1000) throw new Error('У черзі забагато завдань.'); }
    const sourceRemote = direction === 'download';
    const job = { id: randomUUID(), direction, sourcePath: absolutePath(sourcePath, sourceRemote), destinationPath: absolutePath(destinationPath, !sourceRemote), status: 'pending', bytes: 0, total: 0, files: 0, skipped: 0, error: '', session };
    this.jobs.push(job); this.publish();
    if (!this.running) void this.pump();
    return this.snapshot();
  }
  async pump() {
    if (this.running) return;
    this.running = true;
    try {
      for (;;) {
        const job = this.jobs.find(item => item.status === 'pending');
        if (!job) break;
        this.active = new AbortController(); job.status = 'running'; this.publish();
        try {
          await this.transfer(job, this.active.signal);
          aborted(this.active.signal);
          job.status = job.files === 0 && job.skipped > 0 ? 'skipped' : 'completed';
        } catch (error) {
          job.status = this.active.signal.aborted ? 'cancelled' : 'failed';
          job.error = this.active.signal.aborted ? 'Передачу скасовано. Завершені файли збережено; тимчасовий файл може залишитися на сервері.' : this.describeError(error);
          // A failed data channel can leave a protocol session unusable. Never replay pending work on a new connection.
          for (const pending of this.jobs) if (pending.status === 'pending') { pending.status = 'cancelled'; pending.error = 'Скасовано після помилки поточної передачі.'; }
          job.session.adapter.close(); this.onTransportFailure(job.session);
        } finally { this.active = null; this.publish(); }
      }
    } finally { this.running = false; this.publish(); }
  }
  cancel() {
    for (const job of this.jobs) if (job.status === 'pending') { job.status = 'cancelled'; job.error = 'Скасовано користувачем.'; }
    if (this.active) {
      this.active.abort();
      const job = this.jobs.find(item => item.status === 'running');
      if (job) { job.session.adapter.close(); this.onTransportFailure(job.session); }
    }
    this.publish(); return this.snapshot();
  }
  async transfer(job, signal) {
    const source = job.direction === 'upload' ? this.local : job.session.adapter;
    const destination = job.direction === 'upload' ? job.session.adapter : this.local;
    // This also makes the generic engine safe when tested with two local adapters.
    if (source === destination && isWithin(job.sourcePath, job.destinationPath, source.remote)) throw new Error('Не можна копіювати теку в себе.');
    const manifest = [];
    const scan = async (from, to, depth = 0) => {
      aborted(signal);
      if (depth > 128 || manifest.length > 100000) throw new Error('Перевищено безпечний обсяг однієї передачі.');
      const info = await source.stat(from);
      if (!info) throw new Error('Джерело передачі відсутнє.');
      if (info.type === 'symlink' || info.type === 'other') { job.skipped++; this.publish(); return; }
      manifest.push({ from, to, info });
      if (info.type === 'directory') {
        for (const item of await source.list(from)) await scan(child(from, item.name, source.remote), child(to, item.name, destination.remote), depth + 1);
      } else job.total += info.size;
    };
    await scan(job.sourcePath, job.destinationPath); this.publish();
    for (const item of manifest) {
      aborted(signal);
      if (item.info.type === 'directory') {
        const existing = await destination.stat(item.to);
        if (!existing) await destination.mkdir(item.to);
        else if (existing.type !== 'directory') throw new Error('Призначення теки зайняте файлом або посиланням.');
        continue;
      }
      let existing = await destination.stat(item.to);
      if (existing && existing.type !== 'file') throw new Error('Призначення файлу зайняте текою або посиланням.');
      if (existing && !await this.confirmOverwrite(item.to)) { job.skipped++; this.publish(); continue; }
      aborted(signal);
      const staging = child((destination.remote ? path.posix : path).dirname(item.to), `.hostharbor-${randomUUID()}.part`, destination.remote);
      let transferred = 0; let lastUpdate = 0;
      const stream = new Transform({ transform: (chunk, _encoding, callback) => {
        transferred += chunk.length; job.bytes += chunk.length;
        if (Date.now() - lastUpdate > 100) { lastUpdate = Date.now(); this.publish(); }
        callback(null, chunk);
      } });
      // Some protocol libraries resolve once their own side finishes; both sides must complete.
      stream.on('error', () => {});
      const abortStream = () => stream.destroy(new Error('Передачу скасовано.'));
      signal.addEventListener('abort', abortStream, { once: true });
      try {
        const write = destination.writeFrom(stream, staging, signal).catch(error => { stream.destroy(error); throw error; });
        const read = source.readTo(item.from, stream, signal).catch(error => { stream.destroy(error); throw error; });
        const results = await Promise.allSettled([write, read]);
        const rejected = results.find(result => result.status === 'rejected'); if (rejected) throw rejected.reason;
        aborted(signal);
        if (transferred !== item.info.size) throw new Error('Розмір джерела змінився під час передачі; файл не замінено.');
        const sourceNow = await source.stat(item.from);
        if (signature(sourceNow) !== signature(item.info)) throw new Error('Джерело змінилося під час передачі; файл не замінено.');
        const now = await destination.stat(item.to);
        if (now && now.type !== 'file') throw new Error('Призначення змінилося; файл не замінено.');
        if (now && signature(now) !== signature(existing) && !await this.confirmOverwrite(item.to)) { job.skipped++; continue; }
        aborted(signal); await destination.commit(staging, item.to); job.files++;
      } finally { signal.removeEventListener('abort', abortStream); stream.destroy(); await destination.cleanup(staging).catch(() => {}); }
      this.publish();
    }
  }
}
