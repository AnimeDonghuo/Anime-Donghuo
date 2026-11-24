import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { catalogItems, publicTitle } from '../src/catalog.js';
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
  const homeHtml = await homeResponse.text();
  assert.match(homeHtml, /<title>Anime Donghua/);
  assert.match(homeHtml, /aria-label="Anime Donghua home"/);
  assert.match(homeHtml, /<span class="logo-anime">Anime<\/span><span>Donghua<\/span>/);
  assert.match(homeHtml, /Perfect<br>World/);
  assert.match(homeHtml, /anime-donghua-mark\.jpg/);
  assert.match(homeHtml, /anime-donghua-blue-dragon\.png/);
  const heroAsset = await fetch(`${baseUrl}/assets/anime-donghua-blue-dragon.png`);
  assert.equal(heroAsset.status, 200);
  assert.match(heroAsset.headers.get('content-type'), /image\/png/);
  assert.match(homeHtml, /app\.css\?v=anime-donghua-v2/);
  assert.match(homeHtml, /app\.js\?v=anime-donghua-v2/);
  assert.match(homeResponse.headers.get('content-security-policy'), /img-src[^;]*https:\/\/i\.ibb\.co/);
  assert.match(homeResponse.headers.get('content-security-policy'), /frame-src[^;]*https:\/\/.*dailymotion\.com/);
  assert.match(homeResponse.headers.get('content-security-policy'), /frame-src[^;]*https:\/\/.*rumble\.com/);
  assert.equal(homeResponse.headers.get('cross-origin-resource-policy'), 'same-origin');
  assert.match(homeHtml, /<button class="avatar"[^>]*>AD<\/button>/);
  assert.match(homeHtml, /width:100vw!important;max-width:none!important/);
  assert.match(homeHtml, /No saved playback progress yet/);
  assert.doesNotMatch(homeHtml, /EP\s?\d+|hours ago|★ 9\.4|200\+ eps/);
  assert.doesNotMatch(homeHtml, /<span class="rank">/);
  assert.doesNotMatch(homeHtml, /\son(?:click|input)=/);
});

test('versioned frontend assets bypass stale browser cache', async () => {
  const [cssResponse, jsResponse] = await Promise.all([
    fetch(`${baseUrl}/app.css?v=anime-donghua-v2`),
    fetch(`${baseUrl}/app.js?v=anime-donghua-v2`),
  ]);
  assert.equal(cssResponse.status, 200);
  assert.equal(jsResponse.status, 200);
  assert.match(cssResponse.headers.get('cache-control'), /no-cache/);
  assert.match(jsResponse.headers.get('cache-control'), /no-cache/);
  assert.match(await jsResponse.text(), /function renderFeatured/);
});

test('navigation destinations work when opened directly as separate pages', async () => {
  const paths = ['/trending', '/updates', '/donghua', '/anime', '/ongoing', '/movies', '/categories', '/continue-watching', '/my-list', '/profile', '/discover', '/schedule', '/title/perfect-world', '/watch/perfect-world', '/genre/action'];
  const responses = await Promise.all(paths.map((path) => fetch(`${baseUrl}${path}`)));
  for (const response of responses) {
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /text\/html/);
    assert.match(await response.text(), /id="routeMain"/);
  }
  const [unknown, unknownTitle] = await Promise.all([
    fetch(`${baseUrl}/not-a-page`),
    fetch(`${baseUrl}/title/not-a-title`),
  ]);
  assert.equal(unknown.status, 404);
  assert.equal(unknownTitle.status, 404);
});

test('public catalogue titles retain safe artwork and verified metadata only', () => {
  const mapped = publicTitle({
    ...catalogItems[0],
    imageUrl: '/assets/perfect-world-poster.jpg',
    addedAt: '2026-11-24T10:00:00.000Z',
    upcomingReleaseAt: '2026-12-01T10:00:00.000Z',
    year: 2024,
    alternativeTitles: ['  Alias  ', '<script>unsafe</script>'],
    languages: ['Chinese', 'English'],
    subtitles: ['English'],
    episodeCount: 12,
    rating: 8.4,
    latestEpisode: { number: 4, season: 1, title: 'Episode title', releaseAt: '2026-11-23T00:00:00.000Z' },
    releaseSchedule: [
      { day: 'monday', time: '18:30 CST', episode: 5 },
      { day: 'Notaday', time: '25:99', episode: 6 },
    ],
    watchUrl: 'https://untrusted.example/video',
  });
  assert.equal(mapped.imageUrl, '/assets/perfect-world-poster.jpg');
  const overridden = publicTitle(catalogItems[0], {
    imageUrl: 'https://i.ibb.co/abc/perfect-world.jpg',
    artworkSource: 'telegram',
    downloadUrl: 'https://www.mediafire.com/file/abc/perfect-world.zip',
  });
  assert.equal(overridden.imageUrl, 'https://i.ibb.co/abc/perfect-world.jpg');
  assert.equal(overridden.artworkSource, 'telegram');
  assert.equal(overridden.downloadUrl, 'https://www.mediafire.com/file/abc/perfect-world.zip');
  const withPlayers = publicTitle(catalogItems[0], { players: [
    { provider: 'Dailymotion', embedUrl: 'https://www.dailymotion.com/video/x123456', watchUrl: 'https://www.dailymotion.com/video/x123456' },
    { provider: 'Rumble', embedUrl: 'https://rumble.com/vabcde-title.html', watchUrl: 'https://rumble.com/vabcde-title.html' },
    { provider: 'Rumble', embedUrl: 'https://evil.example/embed/bad', watchUrl: 'https://evil.example/video/bad' },
    { provider: 'Dailymotion', embedUrl: 'http://www.dailymotion.com/video/x000000', watchUrl: 'http://www.dailymotion.com/video/x000000' },
  ] });
  assert.equal(withPlayers.players.length, 2);
  assert.equal(withPlayers.players[0].provider, 'Dailymotion');
  assert.match(withPlayers.players[0].embedUrl, /^https:\/\/www\.dailymotion\.com\/embed\/video\/x123456\?/);
  assert.deepEqual(withPlayers.players[1], {
    provider: 'Rumble',
    label: 'Rumble',
    embedUrl: 'https://rumble.com/embed/vabcde/',
    watchUrl: 'https://rumble.com/vabcde-title.html',
  });
  assert.equal('downloadUrl' in publicTitle(catalogItems[0], { downloadUrl: 'https://example.org/file.zip' }), false);
  assert.equal('downloadUrl' in publicTitle(catalogItems[0], { downloadUrl: 'https://www.mediafire.com:444/file/abc/file.zip' }), false);
  assert.equal(mapped.addedAt, '2026-11-24T10:00:00.000Z');
  assert.equal(mapped.upcomingReleaseAt, '2026-12-01T10:00:00.000Z');
  assert.equal(mapped.year, 2024);
  assert.deepEqual(mapped.alternativeTitles, ['Alias', '<script>unsafe</script>']);
  assert.deepEqual(mapped.languages, ['Chinese', 'English']);
  assert.deepEqual(mapped.subtitles, ['English']);
  assert.equal(mapped.episodeCount, 12);
  assert.equal(mapped.rating, 8.4);
  assert.deepEqual(mapped.latestEpisode, { number: 4, season: 1, title: 'Episode title', releaseAt: '2026-11-23T00:00:00.000Z' });
  assert.deepEqual(mapped.releaseSchedule, [{ day: 'Monday', time: '18:30 CST', episode: 5 }]);
  assert.equal('watchUrl' in mapped, false);
  assert.equal('rating' in publicTitle({ ...catalogItems[0], rating: 100 }), false);
  assert.equal('episodeCount' in publicTitle({ ...catalogItems[0], episodeCount: -1 }), false);
});

test('catalogue supports bounded filters and returns only public fields', async () => {
  const response = await fetch(`${baseUrl}/api/catalog?type=donghua&section=trending&limit=48`);
  assert.equal(response.status, 200);
  const payload = await response.json();
  assert.ok(payload.items.some((item) => item.id === 'perfect-world'));
  assert.ok(payload.items.every((item) => item.type === 'donghua'));
  assert.ok(payload.items.every((item) => !('rating' in item) && !('episodeCount' in item)));
  assert.equal('watchUrl' in payload.items[0], false);

  const ongoingResponse = await fetch(`${baseUrl}/api/catalog?status=ongoing&limit=48`);
  const ongoingPayload = await ongoingResponse.json();
  assert.ok(ongoingPayload.items.length > 0);
  assert.ok(ongoingPayload.items.every((item) => item.status === 'ongoing'));
  const moviesResponse = await fetch(`${baseUrl}/api/catalog?format=movie&limit=48`);
  assert.ok((await moviesResponse.json()).items.length >= 3);
  const newestResponse = await fetch(`${baseUrl}/api/catalog?sort=newest&limit=5`);
  assert.equal(newestResponse.status, 200);
  assert.equal((await newestResponse.json()).items.length, 5);
  const yearResponse = await fetch(`${baseUrl}/api/catalog?year=2024`);
  assert.equal(yearResponse.status, 200);
  assert.deepEqual((await yearResponse.json()).items, []);
  const searchResponse = await fetch(`${baseUrl}/api/catalog?q=perfect`);
  assert.ok((await searchResponse.json()).items.some((item) => item.id === 'perfect-world'));

  const invalid = await fetch(`${baseUrl}/api/catalog?type=pirate`);
  assert.equal(invalid.status, 400);
  const invalidSort = await fetch(`${baseUrl}/api/catalog?sort=oldest`);
  assert.equal(invalidSort.status, 400);
  const invalidYear = await fetch(`${baseUrl}/api/catalog?year=1899`);
  assert.equal(invalidYear.status, 400);
  const malformedYear = await fetch(`${baseUrl}/api/catalog?year=20xx`);
  assert.equal(malformedYear.status, 400);
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
