import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { lookupEmail } from '../src/security.js';

const config = createConfig({
  NODE_ENV: 'test',
  PORT: '8000',
  SESSION_SECRET: 'integration-session-secret-long-enough-to-be-safe-101',
  EMAIL_LOOKUP_SECRET: 'integration-email-lookup-secret-long-enough-202',
  DATA_ENCRYPTION_KEY: Buffer.alloc(32, 81).toString('base64'),
});
const store = new MemoryStore();
let server;
let baseUrl;
let csrfCookie;
let csrfToken;
let sessionCookie;

before(async () => {
  server = createApp({ store, config }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  await store.close();
});

test('health, readiness, and homepage are served safely', async () => {
  const [healthResponse, readyResponse, homeResponse] = await Promise.all([
    fetch(`${baseUrl}/healthz`),
    fetch(`${baseUrl}/readyz`),
    fetch(`${baseUrl}/`),
  ]);
  assert.equal(healthResponse.status, 200);
  assert.deepEqual(await healthResponse.json(), { status: 'ok' });
  assert.equal(readyResponse.status, 200);
  assert.match(homeResponse.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(homeResponse.headers.get('x-powered-by'), null);
  assert.match(await homeResponse.text(), /Perfect<br>World/);
});

test('catalogue supports bounded filters and returns only public fields', async () => {
  const response = await fetch(`${baseUrl}/api/catalog?type=donghua&section=trending&limit=48`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.items.some((item) => item.id === 'perfect-world'));
  assert.ok(payload.items.every((item) => item.type === 'donghua'));
  assert.equal('watchUrl' in payload.items[0], false);

  const ongoingResponse = await fetch(`${baseUrl}/api/catalog?status=ongoing&limit=48`);
  const ongoingPayload = await ongoingResponse.json();
  assert.ok(ongoingPayload.items.length > 0);
  assert.ok(ongoingPayload.items.every((item) => item.status === 'ongoing'));
  const moviesResponse = await fetch(`${baseUrl}/api/catalog?format=movie&limit=48`);
  assert.ok((await moviesResponse.json()).items.length >= 3);

  const invalid = await fetch(`${baseUrl}/api/catalog?type=pirate`);
  assert.equal(invalid.status, 400);
});

test('account creation requires CSRF, stores encrypted profile values, and supports saved titles', async () => {
  const csrfResponse = await fetch(`${baseUrl}/api/csrf`);
  assert.equal(csrfResponse.status, 200);
  const csrfPayload = await csrfResponse.json();
  csrfToken = csrfPayload.csrfToken;
  csrfCookie = csrfResponse.headers.get('set-cookie').split(';', 1)[0];

  const registerBody = {
    email: 'viewer@example.com',
    password: 'A-long-secure-passphrase-8492',
    displayName: 'Sky Viewer',
  };
  const blocked = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: { Cookie: csrfCookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(registerBody),
  });
  assert.equal(blocked.status, 403);

  const crossOrigin = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      Cookie: csrfCookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Origin: 'https://attacker.example',
    },
    body: JSON.stringify(registerBody),
  });
  assert.equal(crossOrigin.status, 403);

  const registerResponse = await fetch(`${baseUrl}/api/auth/register`, {
    method: 'POST',
    headers: {
      Cookie: csrfCookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
      Origin: `https://${new URL(baseUrl).host}`,
    },
    body: JSON.stringify(registerBody),
  });
  assert.equal(registerResponse.status, 201);
  const registerPayload = await registerResponse.json();
  assert.equal(registerPayload.user.email, 'viewer@example.com');
  assert.equal(registerPayload.user.displayName, 'Sky Viewer');
  assert.equal('passwordHash' in registerPayload.user, false);
  const sessionSetCookie = registerResponse.headers.get('set-cookie');
  sessionCookie = sessionSetCookie.split(';', 1)[0];
  assert.match(sessionSetCookie, /HttpOnly/);
  assert.match(sessionSetCookie, /Secure/);

  const storedUser = await store.findUserByEmailLookup(lookupEmail('viewer@example.com', config.emailLookupSecret));
  assert.equal(storedUser.emailCiphertext.includes('viewer@example.com'), false);
  assert.equal(storedUser.displayNameCiphertext.includes('Sky Viewer'), false);
  assert.equal(storedUser.passwordHash.includes(registerBody.password), false);

  const combinedCookie = `${csrfCookie}; ${sessionCookie}`;
  const meResponse = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: combinedCookie } });
  assert.equal(meResponse.status, 200);
  assert.equal((await meResponse.json()).user.email, 'viewer@example.com');

  const favoriteResponse = await fetch(`${baseUrl}/api/me/favorites`, {
    method: 'POST',
    headers: {
      Cookie: combinedCookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
    body: JSON.stringify({ titleId: 'perfect-world' }),
  });
  assert.equal(favoriteResponse.status, 200);
  assert.deepEqual((await favoriteResponse.json()).favorites, ['perfect-world']);

  const listResponse = await fetch(`${baseUrl}/api/me/favorites`, { headers: { Cookie: combinedCookie } });
  assert.deepEqual((await listResponse.json()).favorites, ['perfect-world']);

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: {
      Cookie: combinedCookie,
      'Content-Type': 'application/json',
      'X-CSRF-Token': csrfToken,
    },
  });
  assert.equal(logoutResponse.status, 200);
  const afterLogout = await fetch(`${baseUrl}/api/auth/me`, { headers: { Cookie: combinedCookie } });
  assert.equal(afterLogout.status, 401);
});
