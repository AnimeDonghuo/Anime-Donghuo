import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStore } from '../src/stores/memory-store.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { publishNewReleases, releasePublishReport } from '../src/release-publisher.js';

const config = { siteUrl: 'https://app.animedonghua.nx.kg', animexinEnabled: true };

function release(overrides = {}) {
  return {
    id: 'swallowed-star-episode-190',
    title: 'Swallowed Star Episode 190 English Sub',
    series: 'Swallowed Star',
    episode: 190,
    players: [
      { provider: 'Dailymotion', label: 'Hardsub English Dailymotion AX', embedUrl: 'https://www.dailymotion.com/embed/video/x8english', watchUrl: 'https://www.dailymotion.com/video/x8english', episode: 190 },
      { provider: 'Rumble', label: 'Hardsub English Rumble AX', embedUrl: 'https://rumble.com/embed/venglish/', watchUrl: 'https://rumble.com/venglish.html', episode: 190 },
    ],
    downloads: [],
    publishedAt: '2026-11-24T10:00:00.000Z',
    ...overrides,
  };
}

test('a new English release gets one catalog post with a Post ID, page, and announcement', async () => {
  const store = new MemoryStore();
  const repository = new MemoryCatalogRepository([]);
  await repository.init();
  await repository.addAnnouncementChannel({ channelId: '-1001234567890', title: 'Anime Donghua' });
  await store.saveAnimexinReleases([release()]);

  const sent = [];
  const bot = { telegram: { sendPhoto: async (channelId, url, options) => { sent.push({ channelId, url, options }); return { message_id: 71 }; } } };

  const result = await publishNewReleases({ store, repository, bot, config });
  assert.equal(result.published.length, 1);
  const entry = result.published[0];
  assert.equal(entry.created, true);
  assert.match(entry.adminId, /^SB-[A-F0-9]{10}$/);
  assert.equal(entry.slug, 'swallowed-star-episode-190');
  assert.equal(entry.websiteUrl, 'https://app.animedonghua.nx.kg/donghua/swallowed-star-episode-190');
  assert.equal(entry.announced, 1);
  assert.equal(sent.length, 1);
  assert.match(sent[0].options.caption, /Swallowed Star Episode 190/);

  const stored = await repository.findContentByAdminId(entry.adminId);
  assert.equal(stored.category, 'donghua');
  assert.equal(stored.title, 'Swallowed Star Episode 190');
  assert.equal(stored.stream.entries.length, 2);
  assert.deepEqual(stored.stream.entries.map((player) => player.provider), ['Dailymotion', 'Rumble']);

  // The release row remembers its Post ID.
  const [row] = await store.listAnimexinReleases(5);
  assert.equal(row.publishedAdminId, entry.adminId);

  // A second pass updates that card instead of publishing a duplicate.
  const second = await publishNewReleases({ store, repository, bot, config });
  assert.equal(second.published.length, 1);
  assert.equal(second.published[0].created, false);
  assert.equal(second.published[0].adminId, entry.adminId);
  const all = await repository.listContent({ limit: 50 });
  assert.equal(all.length, 1);
  await store.close();
});

test('a release without an English Dailymotion or Rumble server is never published', async () => {
  const store = new MemoryStore();
  const repository = new MemoryCatalogRepository([]);
  await repository.init();
  await store.saveAnimexinReleases([release({ id: 'no-english', players: [] })]);
  const result = await publishNewReleases({ store, repository, config });
  assert.equal(result.published.length, 0);
  assert.equal(result.skipped, 1);
  assert.equal((await repository.listContent({ limit: 10 })).length, 0);
  await store.close();
});

test('the publisher report names each new Post ID', () => {
  const report = releasePublishReport({
    published: [{ created: true, adminId: 'SB-3B00158B29', slug: 'swallowed-star-episode-190', announced: 1 }],
  });
  assert.match(report, /SB-3B00158B29/);
  assert.match(report, /swallowed-star-episode-190/);
  assert.equal(releasePublishReport({ published: [] }), null);
});
