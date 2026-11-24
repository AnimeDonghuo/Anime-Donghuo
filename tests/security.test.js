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
  assert.throws(() => decryptPrivateField(`${ciphertext.slice(0, -1)}A`, testConfig.dataEncryptionKey, 'email'));
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
  assert.equal(production.sessionCookieName, '__Host-anime-donghua_session');
});
