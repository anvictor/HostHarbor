import test from 'node:test';
import assert from 'node:assert/strict';
import { explainError } from '../app/core/errors.js';
const error = (code, message = 'Server failure') => Object.assign(new Error(message), { code });
test('timeout gives next steps, preserves diagnostic, never diagnoses password', () => {
  for (const value of [error('ETIMEDOUT'), new Error('Timeout (control socket)'), new Error('Timeout (data socket)'), new Error('Timed out while waiting for handshake')]) {
    const report = explainError(value); assert.equal(report.kind, 'timeout'); assert.match(report.message, /VPN/); assert.match(report.message, /не означає/); assert.equal(report.details, value.message);
  }
});
test('network, authentication and TLS failures remain distinct', () => {
  for (const [code, kind] of [['ECONNREFUSED','refused'],['ENOTFOUND','address'],['EAI_AGAIN','address'],['ECONNRESET','disconnected'],['EPIPE','disconnected'],[530,'authentication'],['ERR_TLS_CERT_ALTNAME_INVALID','tls'],['CERT_HAS_EXPIRED','tls'],['DEPTH_ZERO_SELF_SIGNED_CERT','tls'],[550,'remote-path']]) assert.equal(explainError(error(code)).kind, kind);
  assert.equal(explainError(new Error('All configured authentication methods failed')).kind,'authentication');
});
test('help and details redact secrets before crossing IPC including truncation boundaries', () => {
  const secret = 'synthetic-sensitive-password';
  const report = explainError(error('ETIMEDOUT','x'.repeat(1590)+secret),[secret]);
  assert.equal(JSON.stringify(report).includes('synthetic-'),false); assert(report.details.length<=1600);
  assert.equal(explainError(new Error('password=private-token')).details.includes('private-token'),false);
});
test('localized validation and cancellation remain intact; filenames do not become timeout diagnoses', () => {
  for (const message of ['Передачу скасовано.','Некоректний шлях.','Ключ SSH сервера змінився.']) { const report=explainError(new Error(message)); assert.equal(report.message,message);assert.equal(report.details,''); }
  const report=explainError(error('ENOENT','ENOENT /folder/timeout.txt'));assert.equal(report.kind,'unknown');assert.match(report.message,/Не вдалося/);assert.match(report.details,/timeout.txt/);
});
