import assert from 'node:assert/strict';
import test from 'node:test';
import { PUBLISHER_COMMANDS, postIdAnswerText } from '../src/server/services/telegram-bot.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { createPublisherConfig, createPublisherRepository } from '../src/server/telegram-integration.js';
import { createConfig } from '../src/config.js';
import { registerAppTelegramCommands } from '../src/telegram-bot.js';
import { MemoryStore } from '../src/stores/memory-store.js';

// This site publishes anime and donghua only, so its command scope lists two
// draft shelves plus the anime-movie shelf. The extra upstream shelves are still
// answered (with guidance) but are deliberately kept out of the menu.
const requiredPublisherCommands = [
  'request', 'login', 'help', 'panel', 'movie', 'anime', 'donghua',
  'batch', 'batch1', 'cateloguefix', 'repair', 'sync', 'auto', 'title', 'titlebatch', 'lang', 'lan', 'lam',
  'subtitles', 'subs', 'year', 'genres', 'description', 'poster', 'p', 'imgdd', 'scrape', 'category', 'release',
  'done', 'status', 'teststorage', 'cancel', 'delete', 'removefile', 'merge', 'posts', 'postid', 'searchm', 'search',
  'stats', 'cmd', 'players', 'playerapi', 'backup', 'recover', 'addchannel', 'channels', 'removechannel', 'requests', 'catalogposter',
  'imgapis', 'addimgapi', 'removeimgapi', 'maintanence', 'restart', 'logout', 'download', 'animexinplayers',
  'releases', 'releasedownload',
];

function makeConfig(extra = {}) {
  return createConfig({
    NODE_ENV: 'test',
    PORT: '8000',
    SESSION_SECRET: 'publisher-test-session-secret-long-enough-to-be-safe-001',
    EMAIL_LOOKUP_SECRET: 'publisher-test-email-secret-long-enough-to-be-safe-002',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 91).toString('base64'),
    TELEGRAM_BOT_TOKEN: '123456:fake-telegram-token-for-tests',
    TELEGRAM_ADMIN_IDS: '123456789',
    ...extra,
  });
}

function fakeBot() {
  return {
    middleware: null,
    use(handler) { this.middleware = handler; },
  };
}

async function dispatch(bot, ctx) {
  let passedThrough = false;
  await bot.middleware(ctx, async () => { passedThrough = true; });
  return passedThrough;
}

test('publisher command menu contains every upstream visitor and publisher command once', () => {
  const commands = PUBLISHER_COMMANDS.map(({ command }) => command);
  const unique = new Set(commands);
  assert.equal(unique.size, commands.length, 'Telegram command scopes must not contain duplicate commands');
  for (const name of requiredPublisherCommands) assert.ok(unique.has(name), `missing /${name}`);
  assert.ok(commands.length >= requiredPublisherCommands.length);
});

test('publisher config reuses the app database and locks publisher access to the existing admin allowlist', async () => {
  const uri = 'mongodb+srv://user:pass@cluster.example/anime_donghua?retryWrites=true';
  const appConfig = makeConfig({ MONGODB_URI: uri, ADMIN_LOGIN_CODE: 'publisher-code-123' });
  const publisherConfig = createPublisherConfig(appConfig, {
    NODE_ENV: 'test',
    MONGODB_URI: uri,
    TELEGRAM_BOT_TOKEN: '123456:fake-telegram-token-for-tests',
    TELEGRAM_ADMIN_IDS: '123456789',
    ADMIN_LOGIN_CODE: 'publisher-code-123',
  });
  assert.equal(publisherConfig.mongodbUri, uri);
  assert.equal(publisherConfig.mongodbDb, 'anime_donghua');
  assert.equal(publisherConfig.telegram.mode, 'polling');
  assert.equal(publisherConfig.telegram.botToken, appConfig.telegramBotToken);
  assert.deepEqual([...publisherConfig.telegram.adminIds], ['123456789']);
  assert.equal(publisherConfig.adminLoginCode, 'publisher-code-123');

  const memoryConfig = createPublisherConfig(makeConfig(), { NODE_ENV: 'test' });
  const repository = await createPublisherRepository(memoryConfig);
  assert.equal(repository.kind, 'memory');
  assert.equal(repository.persistent, false);
  await repository.close();
});

test('app middleware leaves upstream /help and publisher /poster workflows untouched', async () => {
  const config = makeConfig();
  const store = new MemoryStore();
  const bot = fakeBot();
  registerAppTelegramCommands(bot, { config, store });
  const replies = [];
  for (const text of ['/help', '/poster perfect-world']) {
    const passedThrough = await dispatch(bot, {
      message: { text },
      from: { id: 123456789 },
      chat: { id: 123456789, type: 'private' },
      reply: async (reply) => replies.push(reply),
    });
    assert.equal(passedThrough, true, `${text} should reach the upstream publisher command`);
  }
  assert.deepEqual(replies, []);
  await store.close();
});

test('static title posters use the separate /catalogposter shortcut', async () => {
  const config = makeConfig();
  const store = new MemoryStore();
  const bot = fakeBot();
  registerAppTelegramCommands(bot, { config, store });
  const replies = [];
  const passedThrough = await dispatch(bot, {
    message: { text: '/catalogposter perfect-world' },
    from: { id: 123456789 },
    chat: { id: 123456789, type: 'private' },
    reply: async (text) => replies.push(text),
  });
  assert.equal(passedThrough, false);
  assert.match(replies[0], /reply to a \/catalogposter perfect-world command/);

  const captionReplies = [];
  const captionPassedThrough = await dispatch(bot, {
    message: { caption: '/poster perfect-world', photo: [{ file_id: 'poster-photo-file' }] },
    from: { id: 123456789 },
    chat: { id: 123456789, type: 'private' },
    reply: async (text) => captionReplies.push(text),
  });
  assert.equal(captionPassedThrough, false);
  assert.match(captionReplies[0], /Poster hosting is not configured/);
  await store.close();
});

test('Telegraf keeps the legacy authorized MediaFire command for this app', async () => {
  const config = makeConfig();
  const store = new MemoryStore();
  const bot = fakeBot();
  registerAppTelegramCommands(bot, { config, store });
  const replies = [];
  const passedThrough = await dispatch(bot, {
    message: { text: '/download big-fish-and-begonia https://www.mediafire.com/file/abc/movie.zip' },
    from: { id: 123456789 },
    chat: { id: 123456789, type: 'private' },
    reply: async (text) => replies.push(text),
  });
  const media = (await store.getTitleMedia(['big-fish-and-begonia'])).get('big-fish-and-begonia');
  assert.equal(passedThrough, false);
  assert.equal(media.downloadUrl, 'https://www.mediafire.com/file/abc/movie.zip');
  assert.match(replies[0], /saved for Big Fish & Begonia/);

  const unauthorizedPassedThrough = await dispatch(bot, {
    message: { text: '/download big-fish-and-begonia https://www.mediafire.com/file/abc/other.zip' },
    from: { id: 999 },
    chat: { id: 999, type: 'private' },
    reply: async () => assert.fail('unauthorized user should not receive a write confirmation'),
  });
  assert.equal(unauthorizedPassedThrough, true);
  await store.close();
});

test('Animexin player command stores only approved Dailymotion and Rumble embeds', async () => {
  const config = makeConfig();
  const store = new MemoryStore();
  const bot = fakeBot();
  const replies = [];
  const searchHtml = '<article><a href="/donghua-bolay">'
    + '<h2 itemprop="headline">Perfect World</h2><div class="typez">TV Series</div></a></article>';
  const detailHtml = '<iframe src="https://www.dailymotion.com/video/x123456"></iframe>'
    + '<iframe src="https://rumble.com/vabcde-bolay.html"></iframe>'
    + '<iframe src="https://evil.example/embed/not-authorized"></iframe>';
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.searchParams.has('s')) return new Response(searchHtml, { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/donghua-bolay') return new Response(detailHtml, { headers: { 'content-type': 'text/html' } });
    throw new Error(`Unexpected provider request: ${url.href}`);
  };
  registerAppTelegramCommands(bot, { config, store, fetchImpl });
  const passedThrough = await dispatch(bot, {
    message: { text: '/animexinplayers perfect-world' },
    from: { id: 123456789 },
    chat: { id: 123456789, type: 'private' },
    reply: async (text) => replies.push(text),
  });
  const media = (await store.getTitleMedia(['perfect-world'])).get('perfect-world');
  assert.equal(passedThrough, false);
  assert.equal(media.playerSource, 'animexin');
  assert.equal(media.players.length, 2);
  assert.deepEqual(media.players.map((player) => player.provider), ['Dailymotion', 'Rumble']);
  assert.deepEqual(media.players.map((player) => player.embedUrl), [
    'https://www.dailymotion.com/embed/video/x123456',
    'https://rumble.com/embed/vabcde/',
  ]);
  assert.match(replies[0], /2 authorized Animexin players/);
  await store.close();
});

test('Animexin player imports into published donghua posts while preserving existing sources', async () => {
  const config = makeConfig();
  const store = new MemoryStore();
  const repository = new MemoryCatalogRepository([{
    adminId: 'SB-0123ABCDEF',
    slug: 'perfect-world',
    title: 'Perfect World',
    category: 'donghua',
    stream: {
      provider: 'Dailymotion',
      entries: [{
        provider: 'Dailymotion',
        label: 'Existing Dailymotion mirror',
        embedUrl: 'https://www.dailymotion.com/embed/video/x999999',
        watchUrl: 'https://www.dailymotion.com/video/x999999',
      }],
    },
  }]);
  await repository.init();
  const bot = fakeBot();
  const searchHtml = '<article><a href="/perfect-world-season-1">'
    + '<h2 itemprop="headline">Perfect World</h2><div class="typez">TV Series</div></a></article>';
  const detailHtml = '<iframe src="https://www.dailymotion.com/video/x123456"></iframe>'
    + '<iframe src="https://rumble.com/vabcde-bolay.html"></iframe>';
  const fetchImpl = async (input) => {
    const url = new URL(input);
    if (url.searchParams.has('s')) return new Response(searchHtml, { headers: { 'content-type': 'text/html' } });
    if (url.pathname === '/perfect-world-season-1') return new Response(detailHtml, { headers: { 'content-type': 'text/html' } });
    throw new Error(`Unexpected provider request: ${url.href}`);
  };
  registerAppTelegramCommands(bot, { config, store, repository, fetchImpl });
  const replies = [];
  const passedThrough = await dispatch(bot, {
    message: { text: '/animexinplayers SB-0123ABCDEF' },
    from: { id: 123456789 },
    chat: { id: 123456789, type: 'private' },
    reply: async (text) => replies.push(text),
  });
  const updated = await repository.findContentByAdminId('SB-0123ABCDEF');
  assert.equal(passedThrough, false);
  assert.equal(updated.stream.entries.length, 3);
  assert.deepEqual(updated.stream.entries.map((entry) => entry.provider).sort(), ['Dailymotion', 'Dailymotion', 'Rumble']);
  assert.ok(updated.stream.entries.some((entry) => entry.embedUrl === 'https://www.dailymotion.com/embed/video/x999999'));
  assert.match(replies[0], /2 authorized Animexin players/);
  await repository.close();
  await store.close();
});

test('the site origin prefers a custom domain over the platform host', () => {
  const koyebOnly = makeConfig({ KOYEB_PUBLIC_DOMAIN: 'previous-alleen-hshdhhdh-95ed6732.koyeb.app' });
  assert.equal(koyebOnly.siteUrl, 'https://previous-alleen-hshdhhdh-95ed6732.koyeb.app');

  const withDomain = makeConfig({
    KOYEB_PUBLIC_DOMAIN: 'previous-alleen-hshdhhdh-95ed6732.koyeb.app',
    PUBLIC_SITE_URL: 'https://app.animedonghua.nx.kg/',
  });
  assert.equal(withDomain.siteUrl, 'https://app.animedonghua.nx.kg');

  const viaOrigin = makeConfig({
    KOYEB_PUBLIC_DOMAIN: 'placeholder-abc.koyeb.app',
    PUBLIC_ORIGIN: 'https://app.animedonghua.nx.kg',
  });
  assert.equal(viaOrigin.siteUrl, 'https://app.animedonghua.nx.kg');

  // The publisher config the bot reads must print the same domain.
  const publisherConfig = createPublisherConfig(withDomain, {
    NODE_ENV: 'test',
    MONGODB_URI: 'mongodb+srv://user:pass@cluster.example/anime_donghua?retryWrites=true',
    PUBLIC_SITE_URL: 'https://app.animedonghua.nx.kg/',
    KOYEB_PUBLIC_DOMAIN: 'previous-alleen-hshdhhdh-95ed6732.koyeb.app',
  });
  assert.equal(publisherConfig.siteUrl, 'https://app.animedonghua.nx.kg');
});

test('a card link on the site domain resolves to its post id', () => {
  const card = {
    adminId: 'SB-3B00158B29',
    slug: 'swallowed-star-season-4',
    title: 'Swallowed Star Season 4',
    category: 'donghua',
    filesCount: 5,
  };
  const config = makeConfig({ PUBLIC_SITE_URL: 'https://app.animedonghua.nx.kg' });
  const text = postIdAnswerText(card, config);
  assert.match(text, /Catalog page: https:\/\/app\.animedonghua\.nx\.kg\/donghua\/swallowed-star-season-4/);
});

test('the announcement caption keeps the whole page link at the end', async () => {
  const { announcementCaption } = await import('../src/server/services/telegram-bot.js');
  const content = {
    title: 'Battle Through The Heavens Episode 92',
    category: 'donghua',
    year: 2026,
    languages: ['Chinese'],
    subtitleLanguages: ['English'],
    genres: ['Action', 'Fantasy'],
    description: 'x'.repeat(800),
    filesCount: 4,
  };
  const pageUrl = 'https://app.animedonghua.nx.kg/donghua/battle-through-the-heavens-the-battle-of-two-emperors';
  const caption = announcementCaption(content, { pageUrl });
  assert.ok(caption.length <= 1024, 'caption stays inside Telegram limits');
  assert.ok(caption.endsWith(`Watch here:</b> ${pageUrl}`), 'the link is whole and last');
  assert.ok(caption.includes(pageUrl), 'the full page path survives, not a truncated slug');
});
