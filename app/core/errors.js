import { safeError } from './paths.js';

// Diagnostics cross IPC only after secret redaction. Never infer a bad password from a timeout.
export function explainError(error, secrets = []) {
  const details = safeError(error, secrets);
  const code = String(error?.code ?? '').toUpperCase();
  let kind = 'unknown';
  let message = /^[А-ЯІЇЄҐа-яіїєґ]/u.test(details) ? details : 'Не вдалося виконати дію. Відкрийте технічні деталі; якщо помилка повторюється, зверніться до адміністратора.';
  if (code === 'ETIMEDOUT' || /^(?:Timeout \((?:control|data) socket\)|Timed out while waiting for handshake|Connection timed out)/iu.test(details)) {
    kind = 'timeout';
    message = 'Сервер не відповів вчасно. Перевірте адресу, порт, інтернет і потребу у VPN або доступі з вашої IP-адреси. Таймаут не означає, що пароль неправильний.';
  } else if (code === 'ECONNREFUSED') {
    kind = 'refused';
    message = 'З’єднання відхилено. Перевірте порт і чи запущена потрібна служба на сервері; за потреби зверніться до адміністратора.';
  } else if (['ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    kind = 'address';
    message = 'Не вдалося визначити адресу сервера. Перевірте назву сервера та інтернет-з’єднання; для тимчасової помилки DNS спробуйте пізніше.';
  } else if (['CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(code)) {
    kind = 'tls';
    message = 'Не вдалося перевірити TLS-сертифікат сервера. Перевірте адресу та дату на комп’ютері й зверніться до адміністратора. Захищене з’єднання не встановлено; перевірку сертифіката вимикати не потрібно.';
  } else if (code === '530' || /^All configured authentication methods failed/iu.test(details)) {
    kind = 'authentication';
    message = 'Сервер відхилив вхід. Перевірте ім’я користувача, пароль або SSH-ключ і право цього облікового запису на доступ. Це також може бути обмеження на сервері.';
  } else if (['ECONNRESET', 'EPIPE', 'ENOTCONN'].includes(code) || /^No response from server/iu.test(details)) {
    kind = 'disconnected';
    message = 'З’єднання із сервером перервано. Перевірте інтернет і під’єднайтеся знову. Перед повторною передачею перевірте її результат у черзі.';
  } else if (code === '550') {
    kind = 'remote-path';
    message = 'Сервер відхилив доступ до файлу або папки. Перевірте шлях та права облікового запису; файл також може бути відсутній.';
  }
  return { kind, message, details: message === details ? '' : details };
}
