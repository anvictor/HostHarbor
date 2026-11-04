import path from 'node:path';

export function component(value) {
  if (typeof value !== 'string' || !value || value.length > 255 || value === '.' || value === '..' || /[\/\\\x00-\x1f\x7f]/u.test(value)) {
    throw new Error('Назва має бути одним компонентом без роздільників і керівних символів.');
  }
  return value;
}
export function absolutePath(value, remote = false) {
  if (typeof value !== 'string' || !value || value.length > 8192 || /[\x00-\x1f\x7f]/u.test(value)) throw new Error('Некоректний шлях.');
  const api = remote ? path.posix : path;
  if (!api.isAbsolute(value)) throw new Error('Потрібен абсолютний шлях.');
  return api.normalize(value);
}
export function child(parent, name, remote = false) {
  return (remote ? path.posix : path).join(absolutePath(parent, remote), component(name));
}
export function forbidRoot(value, remote = false) {
  const p = absolutePath(value, remote);
  if (p === (remote ? '/' : path.parse(p).root)) throw new Error('Операція з кореневою текою заборонена.');
  return p;
}
export function isWithin(parent, target, remote = false) {
  const api = remote ? path.posix : path;
  const relative = api.relative(absolutePath(parent, remote), absolutePath(target, remote));
  return !relative || (!relative.startsWith(`..${api.sep}`) && relative !== '..' && !api.isAbsolute(relative));
}
export function profile(input, id) {
  if (!input || typeof input !== 'object') throw new Error('Некоректне з’єднання.');
  const protocol = input.protocol;
  if (!['sftp', 'ftp', 'ftps'].includes(protocol)) throw new Error('Непідтримуваний протокол.');
  const clean = (value, max, label) => {
    if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x1f\x7f]/u.test(value)) throw new Error(`Некоректне поле: ${label}.`);
    return value.trim();
  };
  const port = Number(input.port || (protocol === 'sftp' ? 22 : 21));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт має бути від 1 до 65535.');
  const host = clean(input.host, 253, 'сервер');
  if (/[\s/@\\]/u.test(host)) throw new Error('Вкажіть адресу сервера без URL і шляху.');
  return {
    id, name: clean(input.name, 120, 'назва'), protocol, host, port,
    username: clean(input.username, 256, 'користувач'),
    remotePath: absolutePath(input.remotePath || '/', true),
    keyPath: protocol === 'sftp' && input.keyPath ? absolutePath(input.keyPath) : ''
  };
}
export function safeError(error, secrets = []) {
  let message = String(error?.message || error || 'Невідома помилка.');
  for (const secret of secrets.filter(value => typeof value === 'string' && value).sort((a, b) => b.length - a.length)) message = message.split(secret).join('[приховано]');
  return message.replace(/(password|passphrase|authorization)\s*[:=]\s*[^\s,;]+/giu, '$1=[приховано]').slice(0, 1600);
}
