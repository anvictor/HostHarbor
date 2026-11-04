import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { component, child, forbidRoot, profile, safeError } from '../app/core/paths.js';
import { ProfileStore } from '../app/core/store.js';
import { LocalAdapter } from '../app/adapters/local.js';
import { TransferQueue } from '../app/core/queue.js';

const temp = async t => { const p = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hostharbor-test-'))); t.after(() => fs.rm(p, { recursive: true, force: true })); return p; };
const data = { name: 'Test', protocol: 'sftp', host: 'localhost', username: 'user', port: 22 };
const encryption = { isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value).map(b => b ^ 91), decryptString: value => Buffer.from(value).map(b => b ^ 91).toString() };
function queued(local, remote, overwrite = async () => true) {
  const events = new EventEmitter();
  const queue = new TransferQueue({ local, emit: jobs => events.emit('update', jobs), confirmOverwrite: overwrite });
  const finished = () => new Promise(resolve => { const listen = jobs => { if (!queue.busy()) { events.off('update', listen); resolve(jobs); } }; events.on('update', listen); });
  return { queue, finished, session: { id: 'fixed-session', adapter: remote } };
}
test('single components reject traversal, protocol injection and absolute names', () => {
  for (const name of ['', '.', '..', '../a', '/etc', 'a/b', 'a\\b', 'a\nDELE x', '\0']) assert.throws(() => component(name));
  assert.equal(child('/safe', 'файл.txt', true), '/safe/файл.txt');
  assert.throws(() => forbidRoot('/a/..', true));
  assert.throws(() => profile({ ...data, port: 1.5 }, 'id'));
  assert.throws(() => profile({ ...data, host: 'ftp://server/x' }, 'id'));
});
test('errors redact active credentials', () => assert.equal(safeError(new Error('server echoed p@ss secret'), ['p@ss', 'secret']), 'server echoed [приховано] [приховано]'));
test('secret persistence is encrypted, restart decrypts, endpoint edits drop secrets', async t => {
  const dir = await temp(t); const store = new ProfileStore(dir, encryption); await store.load();
  const saved = await store.save(data, { password: 'very-sensitive-password' });
  assert.equal(store.publicProfiles()[0].hasSecret, true);
  assert.equal(JSON.stringify(store.publicProfiles()).includes('very-sensitive'), false);
  assert.equal((await fs.readFile(path.join(dir, 'connections.json'), 'utf8')).includes('very-sensitive'), false);
  const restarted = new ProfileStore(dir, encryption); await restarted.load();
  assert.equal(restarted.getSecret(saved.id).password, 'very-sensitive-password');
  await restarted.save({ ...saved, host: 'other-host' }); assert.deepEqual(restarted.getSecret(saved.id), {});
});
test('unavailable encryption blocks remembering without plaintext fallback', async t => {
  const dir = await temp(t); const store = new ProfileStore(dir, { isEncryptionAvailable: () => false }); await store.load();
  await assert.rejects(store.save(data, { password: 'secret' }), /недоступне/);
  assert.deepEqual(store.publicProfiles(), []);
  await store.save(data); assert.equal(store.publicProfiles().length, 1);
});
test('malformed store is preserved and not reset', async t => {
  const dir = await temp(t); await fs.writeFile(path.join(dir, 'connections.json'), 'bad-data');
  await assert.rejects(new ProfileStore(dir, encryption).load(), /без змін/);
  assert.equal(await fs.readFile(path.join(dir, 'connections.json'), 'utf8'), 'bad-data');
});
test('SSH first-use approval is remembered; changed key blocks without approval', async t => {
  const store = new ProfileStore(await temp(t), encryption); await store.load(); let approvals = 0;
  const approve = async () => { approvals++; return true; };
  await store.trustHost('localhost:22', 'fingerprint', approve); await store.trustHost('localhost:22', 'fingerprint', approve);
  await assert.rejects(store.trustHost('localhost:22', 'different', approve), /змінився/); assert.equal(approvals, 1);
});
test('local traversal through symlink is denied, listing displays link', async t => {
  const dir = await temp(t); const outside = await temp(t); await fs.symlink(outside, path.join(dir, 'link'));
  const local = new LocalAdapter(); assert.equal((await local.list(dir))[0].type, 'symlink');
  await assert.rejects(local.list(path.join(dir, 'link')), /посилання/);
  await assert.rejects(local.mkdir(path.join(dir, 'link', 'escape')), /посилання/);
  await assert.rejects(local.remove(path.join(dir, 'link')), /посилання/);
  await assert.rejects(local.remove('/'), /кореневою/);
});
test('recursive staged queue preserves bytes, empty dirs and skips symlinks', async t => {
  const src = await temp(t), dst = await temp(t); await fs.mkdir(path.join(src, 'tree')); await fs.mkdir(path.join(src, 'tree/empty'));
  const contents = Buffer.alloc(300000, 137); await fs.writeFile(path.join(src, 'tree/file.bin'), contents); await fs.symlink('/tmp', path.join(src, 'tree/link'));
  const remote = new LocalAdapter(); remote.close = () => {};
  const { queue, session, finished } = queued(new LocalAdapter(), remote); const done = finished();
  queue.add({ direction: 'upload', sourcePath: path.join(src, 'tree'), destinationPath: path.join(dst, 'tree') }, session);
  const [job] = await done; assert.equal(job.status, 'completed'); assert.equal(job.bytes, contents.length); assert.equal(job.skipped, 1); assert.equal(job.files, 1);
  assert.deepEqual(await fs.readFile(path.join(dst, 'tree/file.bin')), contents); assert.deepEqual(await fs.readdir(path.join(dst, 'tree/empty')), []);
  assert.deepEqual((await fs.readdir(path.join(dst, 'tree'))).sort(), ['empty', 'file.bin']);
});
test('declined overwrite preserves original file', async t => {
  const src = await temp(t), dst = await temp(t); await fs.writeFile(path.join(src, 'file'), 'new'); await fs.writeFile(path.join(dst, 'file'), 'original');
  const remote = new LocalAdapter(); remote.close = () => {};
  const { queue, session, finished } = queued(new LocalAdapter(), remote, async () => false); const done = finished();
  queue.add({ direction: 'upload', sourcePath: path.join(src, 'file'), destinationPath: path.join(dst, 'file') }, session);
  const [job] = await done; assert.equal(job.status, 'skipped'); assert.equal(await fs.readFile(path.join(dst, 'file'), 'utf8'), 'original');
});
test('transfer failure preserves original, cleans staging and cancels pending work', async t => {
  const src = await temp(t), dst = await temp(t); await fs.writeFile(path.join(src, 'file'), 'new'); await fs.writeFile(path.join(dst, 'file'), 'original');
  class Broken extends LocalAdapter { async readTo(p, writable) { writable.end('x'); throw new Error('network failed'); } }
  const remote = new LocalAdapter(); remote.close = () => {};
  const { queue, session, finished } = queued(new Broken(), remote); const done = finished();
  queue.add({ direction: 'upload', sourcePath: path.join(src, 'file'), destinationPath: path.join(dst, 'file') }, session);
  queue.add({ direction: 'upload', sourcePath: path.join(src, 'file'), destinationPath: path.join(dst, 'second') }, session);
  const jobs = await done; assert.equal(jobs[0].status, 'failed'); assert.equal(jobs[1].status, 'cancelled');
  assert.equal(await fs.readFile(path.join(dst, 'file'), 'utf8'), 'original'); assert.deepEqual(await fs.readdir(dst), ['file']);
});
test('cancellation closes bound session, aborts active job and never replays pending', async t => {
  const src = await temp(t), dst = await temp(t); await fs.writeFile(path.join(src, 'file'), 'new');
  let notifyStarted; const started = new Promise(resolve => { notifyStarted = resolve; });
  class Slow extends LocalAdapter { async readTo(_p, _writable, signal) { notifyStarted(); await new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); } }
  const remote = new LocalAdapter(); let closed = 0; remote.close = () => { closed++; };
  const { queue, session, finished } = queued(new Slow(), remote); const done = finished();
  queue.add({ direction: 'upload', sourcePath: path.join(src, 'file'), destinationPath: path.join(dst, 'file') }, session);
  queue.add({ direction: 'upload', sourcePath: path.join(src, 'file'), destinationPath: path.join(dst, 'next') }, session);
  await started; queue.cancel(); const jobs = await done;
  assert.ok(closed >= 1); assert.equal(jobs[0].status, 'cancelled'); assert.equal(jobs[1].status, 'cancelled'); assert.deepEqual(await fs.readdir(dst), []);
});
