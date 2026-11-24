import assert from 'node:assert/strict';
import test from 'node:test';
import { checkAnimexin, checkAnimexinReport, isJunkCard } from '../src/animexin-check.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { clearAnimexinReleaseCache } from '../src/animexin-feed.js';

const SITE = 'https://app.animedonghua.nx.kg';

function baseConfig(overrides = {}) {
  return {
    animexinEnabled: true,
    animexinBaseUrl: 'https://animexin.dev',
    siteUrl: SITE,
    telegram: { botUsername: 'demo_bot', adminIds: ['1'] },
    telegramBotUsername: 'demo_bot',
    streaming: {},
    playback: {},
    ...overrides,
  };
}

function page({ title, episode, pageUrl, players }) {
  const buttons = players
    .map(([host, id, label]) => {
      const url = host === 'dailymotion'
        ? `https://www.dailymotion.com/video/${id}`
        : `https://rumble.com/${id}-english.html`;
      return `<button class="player-option" data-src="${url}" data-name="${label}">${label}</button>`;
    })
    .join('');
  return `<!doctype html><html><head>
  <meta property="og:title" content="${title} Episode ${episode} English Sub">
  <meta property="og:image" content="https://cdn.animexin.dev/${episode}.jpg">
  <link rel="canonical" href="${pageUrl}" /></head>
  <body><h1>${title} Episode ${episode} English Sub</h1>
  <div class="player-options">${buttons}</div></body></html>`;
}

function feedHtml(items) {
  const entries = items
    .map(
      (item) => `<item><title>${item.title} Episode ${item.episode}</title><link>${item.pageUrl}</link>
      <pubDate>Tue, 24 Nov 2026 10:00:00 +0000</pubDate>
      <description><![CDATA[<img src="${item.thumbnailUrl}" />]]></description></item>`,
    )
    .join('');
  return `<?xml version="1.0"?><rss version="2.0"><channel><title>Animexin</title>${entries}</channel></rss>`;
}

function stubFetch(pages) {
  return async (url) => {
    const target = String(url);
    const isFeed = new URL(target).pathname === '/feed/' || new URL(target).pathname === '/';
    const body = isFeed ? pages.feed : pages.byUrl.get(target);
    if (!body) {
      return new Response('Not found', { status: 404, headers: { 'content-type': 'text/html' } });
    }
    return new Response(body, {
      status: 200,
      headers: { 'content-type': isFeed ? 'application/rss+xml; charset=utf-8' : 'text/html; charset=utf-8' },
    });
  };
}

function release(pageUrl, title, episode) {
  return {
    title,
    episode,
    pageUrl,
    thumbnailUrl: 'https://animexin.dev/wp-content/uploads/thumb.jpg',
  };
}

test('/checkanimexin publishes an episode with no card and links the real page', async () => {
  clearAnimexinReleaseCache();
  const store = new MemoryStore();
  const repository = new MemoryCatalogRepository([]);
  await repository.init();
  const items = [release('https://animexin.dev/battle-through-the-heavens-episode-7/', 'Battle Through The Heavens', 7)];
  const pages = {
    feed: feedHtml(items),
    byUrl: new Map([
      [
        items[0].pageUrl,
        page({
          title: 'Battle Through The Heavens',
          episode: 7,
          pageUrl: items[0].pageUrl,
          players: [['dailymotion', 'k9AbCdEf', 'Dailymotion English'], ['rumble', 'v1abcd', 'Rumble English']],
        }),
      ],
    ]),
  };

  const result = await checkAnimexin({ config: baseConfig(), store, repository, fetchImpl: stubFetch(pages) });
  assert.equal(result.enabled, true);
  assert.equal(result.scanned, 1);
  assert.equal(result.playable, 1);
  assert.equal(result.published.length, 1);
  assert.match(result.published[0].adminId, /^SB-/);
  assert.equal(result.published[0].slug, 'battle-through-the-heavens-episode-7');

  const saved = await repository.findContentByAdminId(result.published[0].adminId);
  assert.equal(saved.published, true);
  const providers = saved.stream.entries.map((entry) => entry.provider).sort();
  assert.deepEqual(providers.filter((provider) => provider === 'Dailymotion' || provider === 'Rumble'), ['Dailymotion', 'Rumble']);

  const report = checkAnimexinReport(result);
  assert.match(report, /Published 1 new post/);
  assert.match(report, /\/donghua\/battle-through-the-heavens-episode-7/);
});

test('/checkanimexin attaches English players to an existing manual post instead of duplicating it', async () => {
  clearAnimexinReleaseCache();
  const store = new MemoryStore();
  const repository = new MemoryCatalogRepository([]);
  await repository.init();
  const manual = await repository.createContent({
    title: 'Swallowed Star Episode 190',
    category: 'donghua',
    published: true,
    status: 'Ongoing',
    year: 2026,
    description: 'Manual upload',
    stream: null,
    files: [],
  });

  const items = [release('https://animexin.dev/swallowed-star-episode-190/', 'Swallowed Star', 190)];
  const pages = {
    feed: feedHtml(items),
    byUrl: new Map([
      [
        items[0].pageUrl,
        page({
          title: 'Swallowed Star',
          episode: 190,
          pageUrl: items[0].pageUrl,
          players: [['dailymotion', 'xYz12345', 'Dailymotion English']],
        }),
      ],
    ]),
  };

  const result = await checkAnimexin({ config: baseConfig(), store, repository, fetchImpl: stubFetch(pages) });
  assert.equal(result.published.length, 0);
  assert.equal(result.updated.length, 1);
  assert.equal(result.updated[0].adminId, manual.adminId);

  const total = await repository.listContent({ limit: 50 });
  const rows = Array.isArray(total) ? total : total.items;
  assert.equal(rows.length, 1, 'no duplicate post is created');

  const updated = await repository.findContentByAdminId(manual.adminId);
  assert.equal(updated.stream.entries.length, 1);
  assert.equal(updated.stream.entries[0].provider, 'Dailymotion');

  const releases = await store.listAnimexinReleases(5);
  assert.equal(releases[0].publishedAdminId, manual.adminId);
});

test('/checkanimexin reports releases it cannot publish and stays a no-op when disabled', async () => {
  clearAnimexinReleaseCache();
  const store = new MemoryStore();
  const repository = new MemoryCatalogRepository([]);
  await repository.init();
  const items = [release('https://animexin.dev/odyssey-fan-episode-1/', 'Odyssey Fan', 1)];
  const pages = {
    feed: feedHtml(items),
    byUrl: new Map([
      [items[0].pageUrl, page({ title: 'Odyssey Fan', episode: 1, pageUrl: items[0].pageUrl, players: [] })],
    ]),
  };

  const result = await checkAnimexin({ config: baseConfig(), store, repository, fetchImpl: stubFetch(pages) });
  assert.equal(result.published.length, 0);
  assert.equal(result.unmatched.length, 1);
  assert.match(checkAnimexinReport(result), /Left alone/);

  const disabled = await checkAnimexin({ config: baseConfig({ animexinEnabled: false }), store, repository, fetchImpl: stubFetch(pages) });
  assert.equal(disabled.enabled, false);
  assert.match(checkAnimexinReport(disabled), /disabled/);
});

test('/checkanimexin removes non-episode menu cards and mirrors the poster', async () => {
  clearAnimexinReleaseCache();
  const store = new MemoryStore();
  const repository = new MemoryCatalogRepository([]);
  await repository.init();
  // The menu cards an earlier homepage scan published, plus a real post with no artwork.
  const genreCard = await repository.createContent({ title: 'Genres', category: 'donghua', published: true, description: '', files: [] });
  const dateCard = await repository.createContent({ title: 'Release Date', category: 'donghua', published: true, description: '', files: [] });
  const realCard = await repository.createContent({
    title: 'Swallowed Star Season 5 Episode 191',
    category: 'donghua',
    published: true,
    description: 'x',
    files: [],
    posterUrl: null,
  });
  assert.equal(isJunkCard(genreCard), true);
  assert.equal(isJunkCard(dateCard), true);
  assert.equal(isJunkCard(realCard), false);

  const items = [release('https://animexin.dev/swallowed-star-season-5-episode-191/', 'Swallowed Star', 191)];
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8cfc000000301010018dd8db00000000049454e44ae426082', 'hex');
  const pages = {
    feed: feedHtml(items),
    byUrl: new Map([
      [
        items[0].pageUrl,
        `<html><head><meta property="og:image" content="https://i0.wp.com/animexin.dev/ss191.jpg"></head><body>
        <h1>Swallowed Star Episode 191 English Sub</h1>
        <div class="player-options">
          <button class="player-option" data-src="https://www.dailymotion.com/video/x8e191" data-name="Hardsub English Dailymotion AX">A</button>
          <button class="player-option" data-src="https://rumble.com/v6abc12.html" data-name="Rumble">B</button>
        </div></body></html>`,
      ],
    ]),
  };
  const base = stubFetch(pages);
  const fetchImpl = async (url) => {
    const target = String(url);
    if (new URL(target).hostname === 'api.imgbb.com') {
      return new Response(JSON.stringify({ success: true, data: { url: 'https://i.ibb.co/hosted/ss191.png' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (target.includes('i0.wp.com')) {
      return new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    }
    return base(url);
  };

  const result = await checkAnimexin({
    config: baseConfig({ imgbbApiKey: 'test-key' }),
    store,
    repository,
    fetchImpl,
  });

  assert.deepEqual(result.removed.map((entry) => entry.title).sort(), ['Genres', 'Release Date']);
  assert.equal(result.updated.length, 1);
  assert.equal(result.updated[0].adminId, realCard.adminId);
  assert.equal(result.updated[0].players, 2, 'both Dailymotion and Rumble are attached');

  const rows = await repository.listContent({ limit: 20 });
  assert.deepEqual(rows.map((row) => row.title), ['Swallowed Star Season 5 Episode 191']);
  const saved = await repository.findContentByAdminId(realCard.adminId);
  assert.equal(saved.posterUrl, 'https://i.ibb.co/hosted/ss191.png', 'the scraped image is re-hosted on ImgBB');
  assert.equal(saved.stream.entries.length, 2);

  const report = checkAnimexinReport(result);
  assert.match(report, /Removed 2 non-episode cards/);
});
