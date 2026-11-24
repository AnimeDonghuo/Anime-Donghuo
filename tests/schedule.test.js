import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createConfig } from '../src/config.js';
import { MemoryStore } from '../src/stores/memory-store.js';
import { MemoryCatalogRepository } from '../src/server/catalog.repository.js';
import { formatScheduleReport, parseScheduleMessage, parseScheduleLine, resolveScheduleDay } from '../src/schedule.js';

const config = createConfig({
  NODE_ENV: 'test',
  PUBLIC_SITE_URL: 'https://app.animedonghua.nx.kg',
  TELEGRAM_BOT_USERNAME: 'demo_bot',
  TELEGRAM_ADMIN_IDS: '123456789',
  SESSION_SECRET: 'schedule-session-secret-long-enough-to-be-safe-505',
  EMAIL_LOOKUP_SECRET: 'schedule-email-secret-long-enough-to-be-safe-606',
});
const store = new MemoryStore();
const repository = new MemoryCatalogRepository([]);
let server;
let baseUrl;

before(async () => {
  await repository.init();
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

/** Every reply the bot handler produced for one message. */
function makeSender() {
  const replies = [];
  return {
    replies,
    async send(handler, text) {
      const ctx = {
        from: { id: 123456789 },
        chat: { type: 'private' },
        message: { text, entities: [{ type: 'bot_command', offset: 0, length: text.split(/\s+/)[0].length }] },
        reply: async (reply) => { replies.push(String(reply?.text ?? reply)); },
      };
      await handler(ctx, async () => { replies.push('NEXT'); });
    },
  };
}

test('the day-first format the publisher types is parsed into one entry per line', () => {
  const parsed = parseScheduleMessage('Monday\nBattle Through The Heavens 19:00\nSwallowed Star 20:30\nPerfect World 21:00');
  assert.deepEqual(parsed.errors, []);
  assert.deepEqual(parsed.entries.map((entry) => [entry.day, entry.title, entry.time]), [
    ['Monday', 'Battle Through The Heavens', '19:00'],
    ['Monday', 'Swallowed Star', '20:30'],
    ['Monday', 'Perfect World', '21:00'],
  ]);
  // A day on the same line, commas as separators, 12-hour times, and a zone all work.
  const inline = parseScheduleMessage('Tue Renegade Immortal - 7:30 PM BST, Soul Land 2 10 pm');
  assert.deepEqual(inline.entries.map((entry) => [entry.day, entry.title, entry.time, entry.timezone]), [
    ['Tuesday', 'Renegade Immortal', '19:30', 'BST'],
    ['Tuesday', 'Soul Land 2', '22:00', null],
  ]);
  assert.equal(resolveScheduleDay('WEDS'), 'Wednesday');
});

test('a line without a time is reported instead of being saved wrongly', () => {
  const parsed = parseScheduleMessage('Monday\nNoTimeHere\nSoul Land 25:00\nSwallowed Star 20:30');
  assert.deepEqual(parsed.entries.map((entry) => entry.title), ['Swallowed Star']);
  assert.equal(parsed.errors.length, 2);
  assert.match(parsed.errors[0], /has no time/);
  assert.match(parsed.errors[1], /not a clock time/);
  assert.match(parseScheduleLine('A 10:00').time, /^10:00$/);
});

test('/schedule saves each day permanently and /api/schedule serves it', async () => {
  const { registerAppTelegramCommands } = await import('../src/telegram-bot.js');
  let handler = null;
  const bot = { use(fn) { handler = fn; } };
  registerAppTelegramCommands(bot, { config, store, repository });
  const sender = makeSender();

  await sender.send(handler, '/schedule Monday\nBattle Through The Heavens 19:00\nSwallowed Star 20:30');
  await sender.send(handler, '/schedule Wednesday\nPerfect World 21:00');
  assert.match(sender.replies.join('\n'), /Saved 2 Monday entries/);
  assert.match(sender.replies.join('\n'), /Saved 1 Wednesday entry/);

  // A second deployment reads the same rows back.
  const saved = await repository.listScheduleEntries();
  assert.deepEqual(saved.map((entry) => [entry.day, entry.title, entry.time]), [
    ['Monday', 'Battle Through The Heavens', '19:00'],
    ['Monday', 'Swallowed Star', '20:30'],
    ['Wednesday', 'Perfect World', '21:00'],
  ]);

  const body = await (await fetch(`${baseUrl}/api/schedule`)).json();
  assert.equal(body.entries, 3);
  assert.deepEqual(body.days.map((group) => group.day), ['Monday', 'Wednesday']);
  assert.deepEqual(body.days[0].entries.map((entry) => entry.title), ['Battle Through The Heavens', 'Swallowed Star']);
  assert.equal(body.days[0].entries[0].time, '19:00');

  // Re-sending the same donghua on the same day updates its time instead of duplicating it.
  await sender.send(handler, '/schedule Monday\nSwallowed Star 21:15');
  const updated = await repository.listScheduleEntries();
  assert.equal(updated.filter((entry) => entry.title === 'Swallowed Star').length, 1);
  assert.equal(updated.find((entry) => entry.title === 'Swallowed Star').time, '21:15');

  const schedulePage = await fetch(`${baseUrl}/schedule`);
  assert.equal(schedulePage.status, 200);
});

test('/removeschedule clears one donghua, one day, or the whole week', async () => {
  const { registerAppTelegramCommands } = await import('../src/telegram-bot.js');
  let handler = null;
  const bot = { use(fn) { handler = fn; } };
  registerAppTelegramCommands(bot, { config, store, repository });
  const sender = makeSender();

  await sender.send(handler, '/removeschedule Monday Swallowed Star');
  assert.deepEqual((await repository.listScheduleEntries()).map((entry) => entry.title), ['Battle Through The Heavens', 'Perfect World']);

  await sender.send(handler, '/removeschedule Wednesday');
  assert.deepEqual((await repository.listScheduleEntries()).map((entry) => entry.day), ['Monday']);

  await sender.send(handler, '/schedule list');
  assert.match(sender.replies.join('\n'), /Battle Through The Heavens/);
  assert.match(sender.replies.join('\n'), /7:00 PM/);

  await sender.send(handler, '/removeschedule all');
  assert.deepEqual(await repository.listScheduleEntries(), []);
  const body = await (await fetch(`${baseUrl}/api/schedule`)).json();
  assert.deepEqual(body.days, []);
  assert.equal(body.entries, 0);
});

test('the schedule report groups by day and formats the time for readers', () => {
  const report = formatScheduleReport([
    { day: 'Friday', title: 'Soul Land 2', time: '22:00', timezone: 'BST' },
    { day: 'Monday', title: 'A Title', time: '09:05' },
  ], { siteUrl: 'https://app.animedonghua.nx.kg' });
  assert.ok(report.indexOf('Monday') < report.indexOf('Friday'));
  assert.match(report, /A Title — 9:05 AM/);
  assert.match(report, /Soul Land 2 — 10:00 PM BST/);
  assert.match(report, /https:\/\/app\.animedonghua\.nx\.kg\/schedule/);
});
