import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, generateKeyPairSync } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import ssh2 from 'ssh2';
const { Server: SSHServer, utils } = ssh2;
import FTPServer from 'ftp-srv';
import { SFTPAdapter, FTPAdapter } from '../app/adapters/remote.js';
import { LocalAdapter } from '../app/adapters/local.js';
import { TransferQueue } from '../app/core/queue.js';
import { ProfileStore } from '../app/core/store.js';

// All services bind only loopback, use ephemeral control ports and disposable files.
// This is a protocol integration fixture, not a server shipped with HostHarbor.
const { STATUS_CODE: STATUS, flagsToString } = utils.sftp;
const credentials = { password: 'disposable-integration-password' };
async function temporary(t) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hostharbor-protocol-')));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}
function attrs(info) {
  return { mode: info.mode, uid: info.uid, gid: info.gid, size: info.size, atime: Math.floor(info.atimeMs / 1000), mtime: Math.floor(info.mtimeMs / 1000) };
}
function installSFTP(stream, root) {
  const handles = new Map(); let sequence = 0;
  const resolve = value => {
    const target = path.resolve(root, `.${path.posix.normalize(`/${value}`)}`);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error('Fixture path escape');
    return target;
  };
  const failure = (request, error) => {
    try { stream.status(request, error.code === 'ENOENT' ? STATUS.NO_SUCH_FILE : STATUS.FAILURE, 'Fixture operation failed'); } catch { /* peer closed */ }
  };
  const on = (name, handler) => stream.on(name, (request, ...args) => {
    Promise.resolve().then(() => handler(request, ...args)).catch(error => failure(request, error));
  });
  const addHandle = value => { const handle = Buffer.alloc(4); handle.writeUInt32BE(++sequence); handles.set(handle.toString('hex'), value); return handle; };
  const getHandle = value => { const found = handles.get(value.toString('hex')); if (!found) throw new Error('Invalid fixture handle'); return found; };
  for (const operation of ['STAT', 'LSTAT']) on(operation, async (request, p) => stream.attrs(request, attrs(await (operation === 'STAT' ? fs.stat : fs.lstat)(resolve(p)))));
  on('FSTAT', async (request, handle) => stream.attrs(request, attrs(await getHandle(handle).file.stat())));
  on('REALPATH', async (request, p) => stream.name(request, [{ filename: path.posix.resolve('/', p), longname: '', attrs: attrs(await fs.stat(resolve(p))) }]));
  on('OPENDIR', async (request, p) => {
    const files = await fs.readdir(resolve(p));
    const entries = await Promise.all(files.map(async name => ({ filename: name, longname: name, attrs: attrs(await fs.lstat(path.join(resolve(p), name))) })));
    stream.handle(request, addHandle({ entries }));
  });
  on('READDIR', async (request, handle) => {
    const directory = getHandle(handle);
    if (!directory.entries.length) stream.status(request, STATUS.EOF);
    else stream.name(request, directory.entries.splice(0));
  });
  on('OPEN', async (request, p, flags, attributes) => {
    const mode = flagsToString(flags); if (!mode) throw new Error('Unsupported fixture flags');
    const file = await fs.open(resolve(p), mode, attributes.mode || 0o600);
    stream.handle(request, addHandle({ file }));
  });
  on('READ', async (request, handle, position, length) => {
    const buffer = Buffer.alloc(Math.min(length, 256 * 1024));
    const { bytesRead } = await getHandle(handle).file.read(buffer, 0, buffer.length, position);
    if (bytesRead) stream.data(request, buffer.subarray(0, bytesRead)); else stream.status(request, STATUS.EOF);
  });
  on('WRITE', async (request, handle, position, buffer) => {
    let offset = 0;
    while (offset < buffer.length) { const { bytesWritten } = await getHandle(handle).file.write(buffer, offset, buffer.length - offset, position + offset); offset += bytesWritten; }
    stream.status(request, STATUS.OK);
  });
  on('CLOSE', async (request, handle) => {
    const value = getHandle(handle); handles.delete(handle.toString('hex'));
    if (value.file) await value.file.close(); stream.status(request, STATUS.OK);
  });
  on('MKDIR', async (request, p) => { await fs.mkdir(resolve(p)); stream.status(request, STATUS.OK); });
  on('REMOVE', async (request, p) => { await fs.unlink(resolve(p)); stream.status(request, STATUS.OK); });
  on('RMDIR', async (request, p) => { await fs.rmdir(resolve(p)); stream.status(request, STATUS.OK); });
  on('RENAME', async (request, from, to) => { await fs.rename(resolve(from), resolve(to)); stream.status(request, STATUS.OK); });
  on('EXTENDED', async request => stream.status(request, STATUS.OP_UNSUPPORTED));
  stream.on('close', () => { for (const value of handles.values()) void value.file?.close().catch(() => {}); handles.clear(); });
}
async function startSSH(t, root) {
  const key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });
  const clients = new Set(); let passwordAttempts = 0;
  const server = new SSHServer({ hostKeys: [key] }, client => {
    clients.add(client); client.on('error', () => {}); client.on('close', () => clients.delete(client));
    client.on('authentication', context => {
      if (context.method === 'password') passwordAttempts++;
      if (context.method === 'password' && context.username === 'test-user' && context.password === credentials.password) context.accept(); else context.reject(['password']);
    });
    client.on('ready', () => client.on('session', accept => accept().on('sftp', acceptSFTP => installSFTP(acceptSFTP(), root))));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(async () => { for (const client of clients) client.end(); await new Promise(resolve => server.close(resolve)); });
  return { profile: { protocol: 'sftp', host: '127.0.0.1', port: server.address().port, username: 'test-user' }, passwordAttempts: () => passwordAttempts };
}
const logger = { child() { return this; }, trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };
async function startFTP(t, root, tls) {
  const server = new FTPServer({ url: 'ftp://127.0.0.1:0', anonymous: false, pasv_url: '127.0.0.1', log: logger, ...(tls ? { tls } : {}) });
  server.on('login', ({ username, password }, resolve, reject) => username === 'test-user' && password === credentials.password ? resolve({ root }) : reject(new Error('Denied')));
  server.on('client-error', () => {}); server.on('server-error', () => {});
  await server.listen(); t.after(() => server.close());
  return { protocol: tls ? 'ftps' : 'ftp', host: '127.0.0.1', port: server.server.address().port, username: 'test-user' };
}
async function certificate(directory) {
  const keyPath = path.join(directory, 'tls-key.pem'), certPath = path.join(directory, 'tls-cert.pem');
  const configPath = path.join(directory, 'tls.cnf');
  await fs.writeFile(configPath, '[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=localhost\n[extensions]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', configPath, '-keyout', keyPath, '-out', certPath], { stdio: 'ignore', timeout: 20000 });
  return { key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) };
}
async function runQueue(remote, direction, sourcePath, destinationPath, approve = async () => true) {
  let complete;
  const done = new Promise(resolve => { complete = resolve; });
  const queue = new TransferQueue({ local: new LocalAdapter(), confirmOverwrite: approve, emit: jobs => { if (!queue.busy()) complete(jobs); } });
  queue.add({ direction, sourcePath, destinationPath }, { id: 'integration-fixed-session', adapter: remote });
  const [job] = await done;
  assert.equal(job.status, 'completed', job.error);
  return job;
}
async function roundtrip(t, remote, root) {
  t.after(() => remote.close());
  const workspace = await temporary(t), source = path.join(workspace, 'source'), download = path.join(workspace, 'download');
  await fs.mkdir(path.join(source, 'nested'), { recursive: true }); await fs.mkdir(path.join(source, 'empty'));
  const bytes = randomBytes(270013); await fs.writeFile(path.join(source, 'nested', 'binary.dat'), bytes); await fs.writeFile(path.join(source, 'zero.bin'), Buffer.alloc(0));
  const upload = await runQueue(remote, 'upload', source, '/uploaded');
  assert.equal(upload.bytes, bytes.length); assert.equal(upload.files, 2); assert.equal(upload.skipped, 0);
  assert.deepEqual(await fs.readFile(path.join(root, 'uploaded', 'nested', 'binary.dat')), bytes);
  assert.deepEqual(await fs.readdir(path.join(root, 'uploaded', 'empty')), []);
  assert.equal((await fs.stat(path.join(root, 'uploaded', 'zero.bin'))).size, 0);
  // Replacing an existing file requires exactly one explicit approval and commits staged bytes.
  bytes[0] ^= 255; await fs.writeFile(path.join(source, 'nested', 'binary.dat'), bytes);
  let overwrites = 0;
  await runQueue(remote, 'upload', path.join(source, 'nested', 'binary.dat'), '/uploaded/nested/binary.dat', async target => { assert.equal(target, '/uploaded/nested/binary.dat'); overwrites++; return true; });
  assert.equal(overwrites, 1); assert.deepEqual(await fs.readFile(path.join(root, 'uploaded', 'nested', 'binary.dat')), bytes);
  const downloaded = await runQueue(remote, 'download', '/uploaded', download);
  assert.equal(downloaded.bytes, bytes.length); assert.deepEqual(await fs.readFile(path.join(download, 'nested', 'binary.dat')), bytes);
  assert.deepEqual(await fs.readdir(path.join(download, 'empty')), []); assert.equal((await fs.stat(path.join(download, 'zero.bin'))).size, 0);
  // Roundtrips exercise staged commit; the final tree must contain no orphan .part files.
  const inspect = async directory => { for (const item of await fs.readdir(directory, { withFileTypes: true })) { assert.equal(item.name.endsWith('.part'), false); if (item.isDirectory()) await inspect(path.join(directory, item.name)); } };
  await inspect(root); await inspect(download);
  await remote.rename('/uploaded/zero.bin', '/uploaded/renamed.bin');
  assert.equal((await remote.stat('/uploaded/renamed.bin')).type, 'file');
  await assert.rejects(remote.rename('/uploaded/renamed.bin', '/uploaded/nested/binary.dat'), /існує/);
  await assert.rejects(remote.remove('/'), /кореневою/);
  await remote.remove('/uploaded'); assert.equal(await remote.stat('/uploaded'), null);
}

test('SFTP: genuine nested binary and zero-byte roundtrip, staged commit, rename and recursive delete', { timeout: 60000 }, async t => {
  const root = await temporary(t); const server = await startSSH(t, root); const remote = new SFTPAdapter();
  let approved = 0;
  await remote.connect(server.profile, credentials, async (identity, fingerprint) => { assert.equal(identity, `127.0.0.1:${server.profile.port}`); assert.match(fingerprint, /^SHA256:[A-Za-z0-9+/]{43}$/); approved++; });
  assert.equal(approved, 1); assert.equal(server.passwordAttempts(), 1);
  await roundtrip(t, remote, root);
});
test('SFTP: declined first-use host key rejects before password authentication', { timeout: 15000 }, async t => {
  const server = await startSSH(t, await temporary(t)); const remote = new SFTPAdapter(); t.after(() => remote.close());
  await assert.rejects(remote.connect(server.profile, credentials, async () => { throw new Error('Host key declined'); }), /Host key declined/);
  assert.equal(server.passwordAttempts(), 0);
});
test('SFTP: changed host key is blocked by persistent trust before password authentication', { timeout: 15000 }, async t => {
  const directory = await temporary(t), server = await startSSH(t, directory);
  const store = new ProfileStore(path.join(directory, 'trust-store'), { isEncryptionAvailable: () => false }); await store.load();
  await store.trustHost(`127.0.0.1:${server.profile.port}`, 'SHA256:old-key', async () => true);
  const remote = new SFTPAdapter(); t.after(() => remote.close()); let approvals = 0;
  await assert.rejects(remote.connect(server.profile, credentials, (identity, fingerprint) => store.trustHost(identity, fingerprint, async () => { approvals++; return true; })), /змінився/);
  assert.equal(approvals, 0); assert.equal(server.passwordAttempts(), 0);
});
test('FTP: genuine nested binary and zero-byte roundtrip, staged commit and mutations', { timeout: 60000 }, async t => {
  const root = await temporary(t), profile = await startFTP(t, root); const remote = new FTPAdapter();
  await remote.connect(profile, credentials); await roundtrip(t, remote, root);
});
test('Explicit FTPS: untrusted certificate rejected; trusted certificate encrypts genuine roundtrip', { timeout: 60000 }, async t => {
  const root = await temporary(t), tls = await certificate(await temporary(t)), profile = await startFTP(t, root, tls);
  const untrusted = new FTPAdapter(); t.after(() => untrusted.close());
  await assert.rejects(untrusted.connect(profile, credentials), /self.signed|certificate|unable to verify/iu);
  untrusted.close();
  // Trusted test CA is injected into adapter only; production main always uses system roots.
  const trusted = new FTPAdapter({ ca: tls.cert }); await trusted.connect(profile, credentials);
  assert.equal(trusted.client.ftp.socket.encrypted, true); assert.equal(trusted.client.ftp.socket.authorized, true);
  await roundtrip(t, trusted, root);
});
