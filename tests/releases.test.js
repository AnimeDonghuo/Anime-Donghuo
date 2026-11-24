import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearAnimexinReleaseCache,
  createAnimexinReleaseFeed,
  parseAnimexinFeed,
  parseAnimexinRelease,
  parseAnimexinServers,
} from '../src/animexin-feed.js';
import { publicRelease } from '../src/releases.js';

const config = {
  animexinEnabled: true,
  animexinBaseUrl: 'https://animexin.dev',
  animexinImageHosts: [],
};

function html(body) {
  return new Response(body, { headers: { 'content-type': 'text/html; charset=utf-8' } });
}

const serverButtons = `
<div class="player-options">
  <button class="player-option" data-src="https://www.dailymotion.com/video/x8english" data-name="Hardsub English Dailymotion AX">Hardsub English Dailymotion AX</button>
  <button class="player-option" data-src="https://www.dailymotion.com/video/x8indo" data-name="Hardsub Indonesia Dailymotion AX">Hardsub Indonesia Dailymotion AX</button>
  <button class="player-option" data-src="https://rumble.com/venglish-rumble.html" data-name="Hardsub English Rumble AX">Hardsub English Rumble AX</button>
  <button class="player-option" data-src="https://rumble.com/vindo-rumble.html" data-name="Hardsub Indonesia Rumble AX">Hardsub Indonesia Rumble AX</button>
  <button class="player-option" data-src="https://odysee.com/@animexin:1/english" data-name="Hardsub English Odysee AX">Hardsub English Odysee AX</button>
  <button class="player-option" data-src="https://ok.ru/video/123" data-name="Hardsub English Ok.ru AX">Hardsub English Ok.ru AX</button>
</div>`;

const releasePage = `<!doctype html><html><head>
<meta property="og:title" content="Shrouding the Heavens Episode 191 English Sub">
<meta property="og:image" content="https://cdn.animexin.dev/shrouding-191.jpg">
</head><body>
<h1>Shrouding the Heavens Episode 191 English Sub</h1>
${serverButtons}
<a href="https://www.mediafire.com/file/abc123/shrouding-191.mp4/file">MediaFire 1080p</a>
<a href="https://mega.nz/file/xyz">Mega mirror</a>
</body></html>`;

test('the Animexin RSS feed yields newest-first release candidates', () => {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item><title>Shrouding the Heavens Episode 191 English Sub</title><link>https://animexin.dev/shrouding-the-heavens-episode-191/</link><guid>post-191</guid><pubDate>Tue, 24 Nov 2026 12:00:00 +0000</pubDate></item>
<item><title>Perfect World Episode 208 English Sub</title><link>https://animexin.dev/perfect-world-episode-208/</link><pubDate>Mon, 23 Nov 2026 12:00:00 +0000</pubDate></item>
<item><title>Off-site</title><link>https://evil.example/perfect-world/</link></item>
</channel></rss>`;
  const entries = parseAnimexinFeed(xml, 'https://animexin.dev');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].pageUrl, 'https://animexin.dev/shrouding-the-heavens-episode-191/');
  assert.equal(entries[0].publishedAt, '2026-11-24T12:00:00.000Z');
  assert.equal(entries[1].title, 'Perfect World Episode 208 English Sub');
});

test('only English Dailymotion and Rumble servers become playable entries', () => {
  const release = parseAnimexinRelease(releasePage, 'https://animexin.dev/shrouding-the-heavens-episode-191/');
  assert.equal(release.series, 'Shrouding the Heavens');
  assert.equal(release.episode, 191);
  assert.equal(release.title, 'Shrouding the Heavens Episode 191 English Sub');
  assert.equal(release.thumbnailUrl, 'https://cdn.animexin.dev/shrouding-191.jpg');
  assert.deepEqual(release.players.map((player) => player.provider), ['Dailymotion', 'Rumble']);
  assert.deepEqual(release.players.map((player) => player.label), [
    'Hardsub English Dailymotion AX',
    'Hardsub English Rumble AX',
  ]);
  assert.ok(release.players.every((player) => player.embedUrl.startsWith('https://')));
  // Indonesian, Odysee, and Ok.ru servers are all dropped.
  assert.equal(release.serverCount, 6);
  assert.deepEqual(release.downloads.map((entry) => entry.url), [
    'https://www.mediafire.com/file/abc123/shrouding-191.mp4/file',
  ]);
});

test('unlabelled pages keep only raw approved provider embeds', () => {
  const page = '<h1>Perfect World Episode 208 English Sub</h1>'
    + '<iframe src="https://www.dailymotion.com/video/x8perfect"></iframe>'
    + '<iframe src="https://ok.ru/video/999"></iframe>';
  const release = parseAnimexinRelease(page, 'https://animexin.dev/perfect-world-episode-208/');
  assert.equal(release.players.length, 1);
  assert.equal(release.players[0].provider, 'Dailymotion');
  assert.equal(release.episode, 208);
});

test('labelled server parsing keeps the display name with its embed URL', () => {
  const servers = parseAnimexinServers(releasePage, 'https://animexin.dev');
  assert.ok(servers.length >= 6);
  assert.equal(servers[0].name, 'Hardsub English Dailymotion AX');
  assert.equal(servers[1].url, 'https://www.dailymotion.com/video/x8indo');
});

test('the release feed caches one upstream pass and never leaks scrape URLs', async () => {
  clearAnimexinReleaseCache();
  const calls = [];
  const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<item><title>Shrouding the Heavens Episode 191 English Sub</title><link>https://animexin.dev/shrouding-the-heavens-episode-191/</link><pubDate>Tue, 24 Nov 2026 12:00:00 +0000</pubDate></item>
</channel></rss>`;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    calls.push(url.href);
    assert.equal(options.redirect, 'error');
    if (url.pathname === '/feed/') {
      return new Response(feedXml, { headers: { 'content-type': 'application/rss+xml' } });
    }
    if (url.pathname === '/shrouding-the-heavens-episode-191/') return html(releasePage);
    throw new Error(`Unexpected Animexin request: ${url.href}`);
  };
  const feed = createAnimexinReleaseFeed({ config, fetchImpl });
  const [first, second] = await Promise.all([feed.getLatest({ limit: 3 }), feed.getLatest({ limit: 3 })]);
  assert.equal(first.items.length, 1);
  assert.equal(second.items.length, 1);
  // One feed read and one release read, shared by both concurrent callers.
  assert.deepEqual(calls, [
    'https://animexin.dev/feed/',
    'https://animexin.dev/shrouding-the-heavens-episode-191/',
  ]);

  const item = first.items[0];
  assert.equal(item.id, 'shrouding-the-heavens-episode-191');
  assert.equal(item.playerCount, 2);

  const published = publicRelease({ ...item, scrapedDownloads: item.downloads, addedDownloads: [] }, config);
  assert.equal(published.players.length, 2);
  assert.equal(published.downloads.length, 1);
  assert.equal('scrapedDownloads' in published, false);
  assert.equal('pageUrl' in published, false);
});

test('the feed reports disabled Animexin without any network call', async () => {
  clearAnimexinReleaseCache();
  let calls = 0;
  const feed = createAnimexinReleaseFeed({
    config: { ...config, animexinEnabled: false },
    fetchImpl: async () => { calls += 1; return html(''); },
  });
  const result = await feed.getLatest();
  assert.equal(result.enabled, false);
  assert.deepEqual(result.items, []);
  assert.equal(calls, 0);
});

test('public release serialization refuses non-approved embeds and downloads', () => {
  const published = publicRelease({
    id: 'release-1',
    title: 'Shrouding the Heavens Episode 191 English Sub',
    series: 'Shrouding the Heavens',
    episode: 191,
    publishedAt: '2026-11-24T12:00:00.000Z',
    thumbnailUrl: 'https://evil.example/thumb.jpg',
    players: [
      { provider: 'Dailymotion', label: 'Hardsub English Dailymotion AX', embedUrl: 'https://www.dailymotion.com/embed/video/x8english', watchUrl: 'https://www.dailymotion.com/video/x8english' },
      { provider: 'Odysee', label: 'Hardsub English Odysee AX', embedUrl: 'https://odysee.com/embed/x', watchUrl: 'https://odysee.com/x' },
      { provider: 'Rumble', label: 'Hardsub English Rumble AX', embedUrl: 'http://rumble.com/embed/v1/', watchUrl: 'https://rumble.com/v1.html' },
    ],
    scrapedDownloads: [{ provider: 'MediaFire', label: 'MediaFire', url: 'https://www.mediafire.com/file/abc/file.mp4' }],
    addedDownloads: [
      { provider: 'MediaFire', label: 'Owner file', url: 'https://www.mediafire.com/file/def/owner.mp4' },
      { provider: 'Mega', label: 'Mega', url: 'https://mega.nz/file/xyz' },
    ],
  }, config);
  assert.equal(published.players.length, 1);
  assert.equal(published.players[0].provider, 'Dailymotion');
  assert.equal(published.downloads.length, 2);
  assert.equal('thumbnailUrl' in published, false);
  assert.equal(published.playerCount, 1);
});
