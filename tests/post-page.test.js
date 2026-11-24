import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';

const config = createConfig({
  NODE_ENV: 'test',
  PUBLIC_SITE_URL: 'https://app.animedonghua.nx.kg',
  TELEGRAM_BOT_USERNAME: 'demo_bot',
  TELEGRAM_ADMIN_IDS: '123456789',
  SESSION_SECRET: 'post-page-session-secret-long-enough-to-be-safe-303',
  EMAIL_LOOKUP_SECRET: 'post-page-email-secret-long-enough-to-be-safe-404',
});
const store = new MemoryStore();
const repository = new MemoryCatalogRepository([]);
let server;
let baseUrl;
let published;
let draft;

before(async () => {
  await repository.init();
  published = await repository.createContent({
    title: 'Battle Through The Heavens: The Battle of Two Emperors',
    category: 'donghua',
    published: true,
    status: 'Ongoing',
    year: 2026,
    description: 'Two emperors clash.',
    posterUrl: 'https://i.ibb.co/example/poster.jpg',
    stream: {
      provider: 'Dailymotion',
      entries: [
        { provider: 'Dailymotion', label: 'Dailymotion English', server: 'Dailymotion English', embedUrl: 'https://www.dailymotion.com/embed/video/x8english', watchUrl: 'https://www.dailymotion.com/video/x8english' },
        { provider: 'Rumble', label: 'Rumble English', server: 'Rumble English', embedUrl: 'https://rumble.com/embed/venglish/', watchUrl: 'https://rumble.com/venglish.html' },
      ],
      updatedAt: new Date().toISOString(),
    },
    files: [1, 2, 3, 4].map((episode) => ({
      messageId: 1000 + episode,
      sourceLabel: `Episode ${episode} 1080p`,
      fileName: `Episode ${episode} 1080p.mp4`,
      quality: '1080p',
      size: 900_000,
      kind: 'video',
    })),
  });
  draft = await repository.createContent({
    title: 'Unpublished Draft Episode',
    category: 'donghua',
    published: false,
    description: 'Not ready yet.',
    files: [],
  });
  server = createApp({ store, config, catalogRepository: repository }).listen(0, '127.0.0.1');
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

test('a published post opens by slug, by Post ID, and by /post link', async () => {
  // The failure the user hit: the bot printed a link that rendered "Post not available".
  for (const path of [
    `/api/catalog/${published.slug}`,
    `/api/catalog/${published.adminId}`,
    `/post/${published.adminId}`,
    `/p/${published.adminId}`,
    `/donghua/${published.slug}`,
    `/title/${published.adminId}`,
    `/watch/${published.adminId}`,
  ]) {
    const response = await fetch(`${baseUrl}${path}`);
    assert.equal(response.status, 200, `${path} should be served`);
    const body = await response.text();
    assert.doesNotMatch(body, /Post not available/, `${path} must not render the not-available page`);
  }
});

test('a post detail carries its English players and its delivery files', async () => {
  const response = await fetch(`${baseUrl}/api/catalog/${published.adminId}`);
  const { item } = await response.json();
  assert.equal(item.id, published.slug);
  assert.equal(item.publisherAdminId, published.adminId);
  assert.deepEqual(item.players.map((player) => player.provider).sort(), ['Dailymotion', 'Rumble']);
  assert.equal(item.filesCount, 4);
  assert.equal(item.fileChoices.length, 4);
  assert.ok(item.fileChoices.every((choice) => choice.telegramUrl?.startsWith('https://t.me/demo_bot')), 'delivery stays on Telegram');
  assert.ok(item.telegramUrl, 'the visitor is given a delivery entry point');
});

test('an unpublished draft is not public and the home shells stay dynamic', async () => {
  const listing = await (await fetch(`${baseUrl}/api/catalog?limit=48&sort=newest`)).json();
  const listed = listing.items.find((item) => item.publisherAdminId === published.adminId);
  assert.ok(listed, 'the published post is listed');
  assert.ok(!('fileChoices' in listed), 'listings stay lean');
  assert.ok(!listing.items.some((item) => item.title === draft.title), 'a draft never reaches a shelf');

  assert.equal((await fetch(`${baseUrl}/api/catalog/${draft.adminId}`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/donghua/${draft.slug}`)).status, 404);

  const home = await (await fetch(`${baseUrl}/`)).text();
  assert.doesNotMatch(home, /Perfect World|Soul Land|Jujutsu Kaisen/);
  for (const shelf of ['trending', 'donghua', 'anime', 'latest']) {
    assert.match(home, new RegExp(`data-shelf="${shelf}"`), `${shelf} is filled by the client`);
  }
});
