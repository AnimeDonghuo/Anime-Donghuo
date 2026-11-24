import assert from 'node:assert/strict';
import test from 'node:test';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { MemoryStore } from '../src/stores/memory-store.js';

const secret = 'test-telegram-webhook-secret-1234567890';
const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);

function jsonResponse(value) {
  return new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
}

async function waitForTitleMedia(store, titleId, predicate = () => true) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const media = (await store.getTitleMedia([titleId])).get(titleId);
    if (media && predicate(media)) return media;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for media update: ${titleId}`);
}

test('Telegram admins can upload existing-title posters and save owner-provided MediaFire links', async () => {
  const config = createConfig({
    NODE_ENV: 'test',
    PORT: '8000',
    SESSION_SECRET: 'telegram-test-session-secret-long-enough-to-be-safe-001',
    EMAIL_LOOKUP_SECRET: 'telegram-test-email-secret-long-enough-to-be-safe-002',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 83).toString('base64'),
    TELEGRAM_BOT_TOKEN: '123456:fake-telegram-token-for-tests',
    TELEGRAM_WEBHOOK_SECRET: secret,
    TELEGRAM_ADMIN_IDS: '123456789',
    IMGBB_API_KEY: 'test-imgbb-key',
  });
  const store = new MemoryStore();
  const calls = [];
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    calls.push({ url, options });
    if (url.hostname === 'api.telegram.org' && url.pathname.endsWith('/getFile')) {
      return jsonResponse({ ok: true, result: { file_path: 'photos/poster.png' } });
    }
    if (url.hostname === 'api.telegram.org' && url.pathname.includes('/file/bot')) {
      return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
    }
    if (url.hostname === 'api.telegram.org' && url.pathname.endsWith('/sendMessage')) {
      return jsonResponse({ ok: true, result: {} });
    }
    if (url.hostname === 'api.imgbb.com') {
      assert.equal(url.searchParams.get('key'), 'test-imgbb-key');
      assert.ok(options.body instanceof FormData);
      return jsonResponse({ success: true, data: { url: 'https://i.ibb.co/testid/perfect-world.png' } });
    }
    throw new Error(`Unexpected request to ${url.hostname}${url.pathname}`);
  };
  const server = createApp({ store, config, fetchImpl }).listen(0, '127.0.0.1');
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  try {
    const badSecret = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': 'wrong-secret' },
      body: JSON.stringify({ update_id: 1 }),
    });
    assert.equal(badSecret.status, 403);
    assert.equal(calls.length, 0);

    const posterResponse = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({
        update_id: 2,
        message: {
          message_id: 4,
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789 },
          caption: '/poster perfect-world',
          photo: [{ file_id: 'small-id' }, { file_id: 'large-id' }],
        },
      }),
    });
    assert.equal(posterResponse.status, 200);
    const posterMedia = await waitForTitleMedia(store, 'perfect-world', (media) => Boolean(media.imageUrl));
    assert.equal(posterMedia.imageUrl, 'https://i.ibb.co/testid/perfect-world.png');
    assert.equal(posterMedia.artworkSource, 'telegram');
    assert.ok(calls.some(({ url }) => url.hostname === 'api.imgbb.com'));
    assert.ok(calls.some(({ url }) => url.pathname.includes('/file/bot')));

    const linkResponse = await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({
        update_id: 3,
        message: {
          message_id: 5,
          chat: { id: 123456789, type: 'private' },
          from: { id: 123456789 },
          text: '/download big-fish-and-begonia https://www.mediafire.com/file/abc/movie.zip',
        },
      }),
    });
    assert.equal(linkResponse.status, 200);
    const linkMedia = await waitForTitleMedia(store, 'big-fish-and-begonia', (media) => Boolean(media.downloadUrl));
    assert.equal(linkMedia.downloadUrl, 'https://www.mediafire.com/file/abc/movie.zip');

    const catalogResponse = await fetch(`${baseUrl}/api/catalog/perfect-world`);
    const catalogPayload = await catalogResponse.json();
    assert.equal(catalogPayload.item.imageUrl, 'https://i.ibb.co/testid/perfect-world.png');
    assert.equal(catalogPayload.item.artworkSource, 'telegram');

    const unauthorizedCount = calls.length;
    await fetch(`${baseUrl}/api/telegram/webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Bot-Api-Secret-Token': secret },
      body: JSON.stringify({
        update_id: 4,
        message: {
          message_id: 6,
          chat: { id: 999, type: 'private' },
          from: { id: 999 },
          text: '/poster perfect-world',
          photo: [{ file_id: 'not-admin-file' }],
        },
      }),
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(calls.length, unauthorizedCount);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await store.close();
  }
});
