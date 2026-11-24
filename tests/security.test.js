import assert from 'node:assert/strict';
import test from 'node:test';
import { createConfig } from '../src/config.js';
import {
  createSessionToken,
  decryptPrivateField,
  encryptPrivateField,
  hashPassword,
  lookupEmail,
  normalizeEmail,
  verifyPassword,
  verifySessionToken,
} from '../src/security.js';

const testConfig = createConfig({
  NODE_ENV: 'test',
  PORT: '8000',
  SESSION_SECRET: 'test-session-secret-is-long-enough-to-be-safe-001',
  EMAIL_LOOKUP_SECRET: 'test-email-lookup-key-is-long-enough-to-be-safe-002',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 42).toString('base64'),
});

test('email is normalized and matched with a keyed lookup value', () => {
  assert.equal(normalizeEmail('  AnimeDonghua@Example.COM '), 'animedonghua@example.com');
  assert.equal(
    lookupEmail(normalizeEmail('AnimeDonghua@Example.COM'), testConfig.emailLookupSecret),
    lookupEmail('animedonghua@example.com', testConfig.emailLookupSecret),
  );
});

test('private profile fields are authenticated AES-GCM ciphertext', () => {
  const ciphertext = encryptPrivateField('person@example.com', testConfig.dataEncryptionKey, 'email');
  assert.notEqual(ciphertext, 'person@example.com');
  assert.equal(decryptPrivateField(ciphertext, testConfig.dataEncryptionKey, 'email'), 'person@example.com');
  const tampered = ciphertext.split('.');
  tampered[3] = `${tampered[3][0] === 'A' ? 'B' : 'A'}${tampered[3].slice(1)}`;
  assert.throws(() => decryptPrivateField(tampered.join('.'), testConfig.dataEncryptionKey, 'email'));
  assert.throws(() => decryptPrivateField(ciphertext, testConfig.dataEncryptionKey, 'display-name'));
});

test('passwords are scrypt-hashed and verified without storing plaintext', async () => {
  const password = 'Correct-horse-battery-staple-24';
  const hash = await hashPassword(password);
  assert.match(hash, /^scrypt\$32768\$8\$1\$/);
  assert.notEqual(hash, password);
  assert.equal(await verifyPassword(password, hash), true);
  assert.equal(await verifyPassword('not-the-password', hash), false);
  assert.equal(await verifyPassword(password, null), false);
});

test('signed sessions reject tampering and expire', () => {
  const now = Date.now();
  const token = createSessionToken({ id: '1234567890abcdef', tokenVersion: 0 }, testConfig.sessionSecret, now);
  assert.equal(verifySessionToken(token, testConfig.sessionSecret, now)?.sub, '1234567890abcdef');
  assert.equal(verifySessionToken(`${token}x`, testConfig.sessionSecret, now), null);
  assert.equal(verifySessionToken(token, testConfig.sessionSecret, now + 8 * 24 * 60 * 60 * 1000), null);
});

test('production configuration requires durable storage, TLS, and persistent secrets', () => {
  assert.throws(() => createConfig({ NODE_ENV: 'production', PORT: '8000' }), /MONGODB_URI/);
  assert.throws(() => createConfig({
    NODE_ENV: 'production',
    PORT: '8000',
    MONGODB_URI: 'mongodb://user:pass@db.example/anime_donghua?tls=false',
  }), /TLS/);

  const production = createConfig({
    NODE_ENV: 'production',
    PORT: '8000',
    MONGODB_URI: 'mongodb+srv://user:pass@cluster.example/anime_donghua',
    SESSION_SECRET: 'production-session-secret-with-at-least-32-bytes',
    EMAIL_LOOKUP_SECRET: 'production-email-lookup-key-with-32-bytes-minimum',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 9).toString('base64'),
  });
  assert.equal(production.production, true);
  assert.equal(production.trustProxy, 1);
  assert.equal(production.animexinEnabled, true);
  assert.equal(production.sessionCookieName, '__Host-anime-donghua_session');
});

test('Telegram polling requires an admin allowlist and validates optional webhook secrets', () => {
  const base = {
    NODE_ENV: 'test',
    PORT: '8000',
    SESSION_SECRET: 'telegram-config-session-secret-long-enough-to-be-safe',
    EMAIL_LOOKUP_SECRET: 'telegram-config-email-secret-long-enough-to-be-safe',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'),
    TELEGRAM_BOT_TOKEN: '123456:placeholder-token',
  };
  assert.throws(() => createConfig(base), /TELEGRAM_ADMIN_IDS/);
  assert.throws(() => createConfig({ ...base, TELEGRAM_ADMIN_IDS: '123,wrong' }), /numeric Telegram user IDs/);
  assert.throws(() => createConfig({ ...base, TELEGRAM_ADMIN_IDS: '123', TELEGRAM_WEBHOOK_SECRET: 'too-short' }), /TELEGRAM_WEBHOOK_SECRET/);

  const config = createConfig({
    ...base,
    TELEGRAM_ADMIN_IDS: '123,456,123',
    TELEGRAM_WEBHOOK_SECRET: 'telegram-webhook-secret-long-enough-32-chars',
    ADMIN_LOGIN_CODE: 'publisher-code-123',
  });
  assert.deepEqual(config.telegramAdminIds, ['123', '456']);
  assert.equal(config.telegramPublisherLoginCode, 'publisher-code-123');
  assert.equal(config.posterSyncEnabled, false);
  assert.equal(config.animexinEnabled, true);
  assert.equal(createConfig({ ...base, TELEGRAM_ADMIN_IDS: '123', ANIMEXIN_ENABLED: 'false' }).animexinEnabled, false);
  assert.throws(() => createConfig({ ...base, TELEGRAM_ADMIN_IDS: '123', ADMIN_LOGIN_CODE: 'short' }), /ADMIN_LOGIN_CODE/);
  assert.equal(createConfig({ ...base, TELEGRAM_ADMIN_IDS: '123' }).animexinRefreshMinutes, 30);
  assert.equal(createConfig({ ...base, TELEGRAM_ADMIN_IDS: '123', ANIMEXIN_REFRESH_MINUTES: '90' }).animexinRefreshMinutes, 90);
  assert.throws(() => createConfig({ ...base, TELEGRAM_ADMIN_IDS: '123', ANIMEXIN_REFRESH_MINUTES: '2' }), /ANIMEXIN_REFRESH_MINUTES/);
  assert.throws(() => createConfig({ ...base, TELEGRAM_ADMIN_IDS: '123', ANIMEXIN_REFRESH_MINUTES: 'soon' }), /ANIMEXIN_REFRESH_MINUTES/);
});
