import { catalogById, catalogItems, safeMediaFireUrl } from './catalog.js';
import { uploadImageToImgBB } from './image-hosting.js';
import { constantTimeStringEqual } from './security.js';
import { createAnimexinReleaseFeed } from './animexin-feed.js';
import { checkAnimexin, checkAnimexinReport } from './animexin-check.js';
import { extractAnimexinPlayers, normalizeTitle } from './posters.js';
import { publicRelease } from './releases.js';
import { mergeStreamingEntries, safeStreamingLink } from './server/services/streaming-service.js';

const maxImageBytes = 10 * 1024 * 1024;

function parseCommand(message) {
  const text = typeof message.caption === 'string' ? message.caption : message.text;
  const commandText = typeof text === 'string'
    ? text
    : (message.reply_to_message?.caption || message.reply_to_message?.text);
  if (typeof commandText !== 'string') return null;
  const firstLine = commandText.split(/\r?\n/, 1)[0].trim();
  const match = firstLine.match(/^\/(poster|catalogposter|download|help|animexinplayers|releases|releasedownload|checkanimexin)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
  return match ? { command: match[1].toLowerCase(), args: (match[2] || '').trim() } : null;
}

function telegramImageFileId(message) {
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return typeof largest?.file_id === 'string' ? largest.file_id : null;
  }
  if (message.document?.mime_type?.toLowerCase().startsWith('image/')) {
    return typeof message.document.file_id === 'string' ? message.document.file_id : null;
  }
  return null;
}

function imageMimeType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && Buffer.from(bytes).toString('ascii', 0, 4) === 'RIFF'
    && Buffer.from(bytes).toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function readLimitedBytes(response, maxBytes) {
  const reader = response.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    return bytes.length <= maxBytes ? bytes : null;
  }
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

function validTelegramFilePath(value) {
  return typeof value === 'string'
    && value.length <= 256
    && /^[A-Za-z0-9_./-]+$/.test(value)
    && !value.split('/').includes('..')
    && !value.startsWith('/');
}

async function getTelegramImage(fileId, config, fetchImpl) {
  const apiUrl = new URL(`https://api.telegram.org/bot${config.telegramBotToken}/getFile`);
  apiUrl.searchParams.set('file_id', fileId);
  let metadataResponse;
  try {
    metadataResponse = await fetchImpl(apiUrl, {
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error('Telegram could not provide that image.');
  }
  if (!metadataResponse.ok) throw new Error('Telegram could not provide that image.');

  let metadata;
  try {
    metadata = await metadataResponse.json();
  } catch {
    throw new Error('Telegram returned invalid file information.');
  }
  const filePath = metadata?.result?.file_path;
  if (metadata?.ok !== true || !validTelegramFilePath(filePath)) {
    throw new Error('Telegram returned invalid file information.');
  }

  const fileUrl = `https://api.telegram.org/file/bot${config.telegramBotToken}/${filePath}`;
  let imageResponse;
  try {
    imageResponse = await fetchImpl(fileUrl, {
      headers: { Accept: 'image/jpeg,image/png,image/webp' },
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error('The Telegram image download failed.');
  }
  if (!imageResponse.ok) throw new Error('The Telegram image download failed.');
  const contentLength = Number(imageResponse.headers?.get('content-length') || 0);
  if (contentLength > maxImageBytes) throw new Error('Images must be 10 MB or smaller.');
  const bytes = await readLimitedBytes(imageResponse, maxImageBytes);
  if (!bytes || bytes.length === 0) throw new Error('Images must be 10 MB or smaller.');
  const contentType = imageMimeType(bytes);
  if (!contentType) throw new Error('Send a valid JPEG, PNG, or WebP image.');
  return { bytes, contentType };
}

async function telegramReply(chatId, text, config, fetchImpl) {
  const url = `https://api.telegram.org/bot${config.telegramBotToken}/sendMessage`;
  try {
    await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // The webhook still returns successfully so Telegram doesn't retry a completed update.
  }
}

async function processUpdate(update, { config, store, fetchImpl }) {
  const message = update?.message;
  if (!message || !message.chat || !message.from) return;
  const chatId = message.chat.id;
  const command = parseCommand(message);
  const fileId = telegramImageFileId(message) || telegramImageFileId(message.reply_to_message || {});
  const privateChat = message.chat.type === 'private';

  if (!Number.isSafeInteger(message.from.id) || !config.telegramAdminIds.includes(String(message.from.id))) return;
  if (!privateChat) {
    await telegramReply(chatId, 'Use the bot in a private chat to manage catalogue artwork.', config, fetchImpl);
    return;
  }

  if (command?.command === 'help') {
    await telegramReply(chatId,
      'Static catalog poster: /catalogposter <existing-title-id> and reply with a photo, or caption a photo with that command.\n'
      + 'Download: /download <existing-title-id> <authorized MediaFire URL>.',
      config,
      fetchImpl,
    );
    return;
  }

  if (command?.command === 'download') {
    const [titleId, ...urlParts] = command.args.split(/\s+/);
    const title = catalogById.get(titleId || '');
    const downloadUrl = safeMediaFireUrl(urlParts.join(' '));
    if (!title || !downloadUrl) {
      await telegramReply(chatId,
        'Use /download <existing-title-id> <https://www.mediafire.com/file/...> for a file you own or may distribute.',
        config,
        fetchImpl,
      );
      return;
    }
    await store.setTitleMedia(title.id, { downloadUrl, downloadUpdatedAt: new Date() });
    await telegramReply(chatId, `Authorized download link saved for ${title.title}.`, config, fetchImpl);
    return;
  }

  if (!['poster', 'catalogposter'].includes(command?.command) && fileId) {
    await telegramReply(chatId, 'Send a photo with caption /catalogposter <existing-title-id>.', config, fetchImpl);
    return;
  }
  if (!['poster', 'catalogposter'].includes(command?.command)) return;

  const titleId = command.args.split(/\s+/, 1)[0]?.toLowerCase();
  const title = catalogById.get(titleId || '');
  if (!title) {
    await telegramReply(chatId, 'Unknown title. Use an existing catalogue ID, for example /catalogposter perfect-world.', config, fetchImpl);
    return;
  }
  if (!fileId) {
    await telegramReply(chatId, `Reply to this command with a photo, or caption a photo with /catalogposter ${title.id}.`, config, fetchImpl);
    return;
  }
  if (!config.imgbbApiKey) {
    await telegramReply(chatId, 'Poster hosting is not configured yet. Set IMGBB_API_KEY in deployment secrets.', config, fetchImpl);
    return;
  }

  const { bytes, contentType } = await getTelegramImage(fileId, config, fetchImpl);
  const imageUrl = await uploadImageToImgBB(bytes, contentType, config.imgbbApiKey, fetchImpl);
  const now = new Date();
  await store.setTitleMedia(title.id, {
    imageUrl,
    artworkSource: 'telegram',
    artworkUpdatedAt: now,
    artworkCheckedAt: now,
  });
  await telegramReply(chatId, `Poster saved for ${title.title}.`, config, fetchImpl);
}

function normalizedCatalogPlayers(existing, incoming) {
  const players = new Map();
  for (const entry of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(incoming) ? incoming : [])]) {
    const safe = safeStreamingLink(entry?.embedUrl || entry?.watchUrl);
    if (!safe?.embedUrl || !safe.watchUrl) continue;
    let embed;
    let watch;
    try {
      embed = new URL(safe.embedUrl);
      watch = new URL(safe.watchUrl);
    } catch {
      continue;
    }
    const providerFor = (host) => {
      if (host === 'dailymotion.com' || host.endsWith('.dailymotion.com') || host === 'dai.ly') return 'Dailymotion';
      if (host === 'rumble.com' || host.endsWith('.rumble.com')) return 'Rumble';
      return null;
    };
    const provider = providerFor(watch.hostname.toLowerCase());
    if (!provider || providerFor(embed.hostname.toLowerCase()) !== provider
      || embed.protocol !== 'https:' || watch.protocol !== 'https:'
      || embed.username || embed.password || embed.port || watch.username || watch.password || watch.port) continue;
    const embedUrl = safe.embedUrl;
    players.set(embedUrl, { provider, label: provider, embedUrl, watchUrl: safe.watchUrl });
  }
  return [...players.values()].slice(-8);
}

function splitAnimexinPlayerTarget(argument) {
  const value = String(argument || '').trim();
  const sourceMatch = value.match(/\s+(https?:\/\/\S+)\s*$/i);
  const sourceUrl = sourceMatch?.[1]?.replace(/[),.;]+$/g, '') || null;
  const target = sourceMatch ? value.slice(0, sourceMatch.index).trim() : value;
  return { target, sourceUrl };
}

async function findAnimexinTarget(target, repository) {
  const value = String(target || '').trim();
  if (!value) return null;
  const staticTitle = catalogById.get(value.toLowerCase())
    || catalogItems.find((item) => normalizeTitle(item.title) === normalizeTitle(value));
  if (staticTitle) return { kind: 'static', content: staticTitle };

  if (/^SB-[A-F0-9]{10}$/i.test(value)) {
    const content = await repository?.findContentByAdminId?.(value.toUpperCase());
    return content ? { kind: 'published', content } : null;
  }
  if (typeof repository?.findContentByTitle === 'function') {
    const matches = await repository.findContentByTitle(value, { category: 'donghua', limit: 1 });
    if (matches?.[0]) return { kind: 'published', content: matches[0] };
  }
  return null;
}

async function handleAnimexinPlayers(ctx, { config, store, repository, publisherConfig, fetchImpl }) {
  const command = parseCommand(ctx.message || {});
  if (command?.command !== 'animexinplayers') return false;
  const argument = command.args;
  if (!argument) {
    await ctx.reply('Usage: /animexinplayers <catalog ID, title, or SB-Post-ID> [Animexin page URL]. Example: /animexinplayers perfect-world');
    return true;
  }
  const { target: targetName, sourceUrl } = splitAnimexinPlayerTarget(argument);
  const target = await findAnimexinTarget(targetName, repository);
  if (!target) {
    await ctx.reply(`No Anime Donghua catalog title or published donghua post matched “${targetName}”. Add the title first, or use its SB-Post-ID.`);
    return true;
  }
  const item = target.kind === 'static'
    ? target.content
    : {
      id: target.content.adminId,
      title: target.content.title,
      type: target.content.category,
      format: target.content.format || 'series',
      alternativeTitles: target.content.alternativeTitles || [],
    };
  if (item.type !== 'donghua') {
    await ctx.reply('Animexin player import is limited to donghua titles. No player data was changed.');
    return true;
  }
  if (!config.animexinEnabled) {
    await ctx.reply('Animexin scraping is disabled by ANIMEXIN_ENABLED=false. No player data was changed.');
    return true;
  }
  if (sourceUrl && !/^https:\/\//i.test(sourceUrl)) {
    await ctx.reply('Use an HTTPS Animexin title page URL. Only Dailymotion and Rumble player URLs from that page are accepted.');
    return true;
  }

  let extracted;
  try {
    extracted = await extractAnimexinPlayers(item, config, fetchImpl, { pageUrl: sourceUrl });
  } catch (error) {
    console.warn('[telegram] Animexin player extraction failed:', error?.message || 'Unknown error');
    await ctx.reply('Animexin could not be read right now. The existing players were left unchanged. Try again later.');
    return true;
  }
  if (!extracted?.players?.length) {
    const note = extracted?.sourceUrl
      ? `I checked ${extracted.sourceUrl}, but found no supported Dailymotion or Rumble player.`
      : 'I could not find an exact Animexin title page for that donghua.';
    await ctx.reply(`${note} Existing players were left unchanged.`);
    return true;
  }

  const now = new Date();
  if (target.kind === 'static') {
    const current = (await store.getTitleMedia([target.content.id])).get(target.content.id);
    const players = normalizedCatalogPlayers(current?.players, extracted.players);
    await store.setTitleMedia(target.content.id, { players, playerSource: 'animexin', playerUpdatedAt: now });
  } else {
    if (typeof repository.updateContentStreamByAdminId !== 'function') {
      await ctx.reply('The publisher catalog cannot store player links in this environment. No data was changed.');
      return true;
    }
    const entries = extracted.players.map((player) => ({
      ...player,
      server: `${player.provider} server`,
    }));
    const stream = mergeStreamingEntries(target.content.stream, entries, {
      allowedHosts: publisherConfig?.streaming?.allowedHosts,
      granularity: 'exact',
      updatedAt: now.toISOString(),
    });
    const saved = await repository.updateContentStreamByAdminId(target.content.adminId, stream);
    if (!saved) {
      await ctx.reply('The catalog post is no longer available. Its player data was not changed.');
      return true;
    }
  }

  const names = extracted.players.map((player) => player.provider).join(' and ');
  await ctx.reply(`Saved ${extracted.players.length} authorized Animexin player${extracted.players.length === 1 ? '' : 's'} for ${item.title}: ${names}. Only Dailymotion and Rumble links were accepted.`);
  return true;
}

function releaseCommandSummary(release) {
  const episode = Number.isInteger(release.episode) ? ` · Episode ${release.episode}` : '';
  return `${release.title}${episode} — ${release.playerCount} English player${release.playerCount === 1 ? '' : 's'}`;
}

async function handleAnimexinReleases(ctx, { config, store, fetchImpl }) {
  const command = parseCommand(ctx.message || {});
  if (!['releases', 'releasedownload'].includes(command?.command)) return false;
  if (!config.animexinEnabled) {
    await ctx.reply('Animexin is disabled by ANIMEXIN_ENABLED=false. No release data was read.');
    return true;
  }

  if (command.command === 'releasedownload') {
    const [releaseId, ...urlParts] = command.args.split(/\s+/);
    const url = safeMediaFireUrl(urlParts.join(' ').trim());
    if (!releaseId || !url) {
      await ctx.reply('Use /releasedownload <release-id> <https://www.mediafire.com/file/...> for a file you own or may distribute.');
      return true;
    }
    const release = await store.getAnimexinRelease(releaseId);
    if (!release) {
      await ctx.reply(`No stored Animexin release matched “${releaseId}”. Run /releases to see the current IDs.`);
      return true;
    }
    const result = await store.addAnimexinReleaseDownload(releaseId, {
      provider: 'MediaFire',
      label: `${release.series || release.title} MediaFire`,
      url,
    });
    await ctx.reply(result?.added
      ? `MediaFire download saved for ${release.title}. Visitors now see it beside the English Dailymotion/Rumble players.`
      : `That MediaFire link is already saved for ${release.title}.`);
    return true;
  }

  let refreshed = 0;
  if (typeof store.saveAnimexinReleases === 'function') {
    try {
      const feed = createAnimexinReleaseFeed({ config, fetchImpl });
      const latest = await feed.getLatest({ limit: 6 });
      refreshed = await store.saveAnimexinReleases(latest.items);
    } catch {
      refreshed = 0;
    }
  }
  const releases = await store.listAnimexinReleases(6);
  if (!releases.length) {
    await ctx.reply('No Animexin releases could be read right now. The site keeps the last stored list until the next successful refresh.');
    return true;
  }
  const lines = releases.map((release, index) => {
    const item = publicRelease(release, config);
    const downloads = item?.downloads?.length || 0;
    return `${index + 1}. ${releaseCommandSummary({ ...release, playerCount: item?.playerCount || 0 })}${downloads ? ` · ${downloads} download${downloads === 1 ? '' : 's'}` : ''}\n   ID: ${release.id}`;
  });
  await ctx.reply([
    `Latest Animexin releases (${refreshed ? `${refreshed} refreshed` : 'stored list'}):`,
    ...lines,
    'Only English-labelled Dailymotion and Rumble servers are playable on the site.',
    'Add an authorized file with /releasedownload <release-id> <MediaFire URL>.',
  ].join('\n'));
  return true;
}

/** Register the existing static-catalog admin tools and the Animexin player importer on Telegraf. */
export function registerAppTelegramCommands(bot, { config, store, repository = null, publisherConfig = null, fetchImpl = fetch } = {}) {
  if (!bot || !config || !store) throw new Error('Telegram command registration requires a bot, app config, and store.');
  bot.use(async (ctx, next) => {
    const message = ctx.message;
    if (!message) return next();
    const command = parseCommand(message);
    if (!command || !['poster', 'catalogposter', 'download', 'animexinplayers', 'releases', 'releasedownload', 'checkanimexin'].includes(command.command)) return next();
    const userId = String(ctx.from?.id || '');
    if (!config.telegramAdminIds.includes(userId)) return next();
    if (ctx.chat?.type !== 'private') {
      await ctx.reply('Use the bot in a private chat to manage the catalog.');
      return;
    }
    if (command.command === 'animexinplayers') {
      await handleAnimexinPlayers(ctx, { config, store, repository, publisherConfig, fetchImpl });
      return;
    }
    if (command.command === 'releases' || command.command === 'releasedownload') {
      await handleAnimexinReleases(ctx, { config, store, fetchImpl });
      return;
    }
    if (command.command === 'checkanimexin') {
      if (!config.animexinEnabled) {
        await ctx.reply('Animexin is disabled by ANIMEXIN_ENABLED=false. Nothing was checked.');
        return;
      }
      if (!repository) {
        await ctx.reply('The publisher catalog is not available, so there is nowhere to publish Animexin posts. Check the MongoDB settings and try again.');
        return;
      }
      await ctx.reply('Checking Animexin now. This reads the feed, every release page, and updates the website…');
      try {
        const result = await checkAnimexin({ config, store, repository, bot, publisherConfig, fetchImpl });
        await ctx.reply(checkAnimexinReport(result));
      } catch (error) {
        console.error('[telegram] /checkanimexin failed:', error?.message || 'Unknown error');
        await ctx.reply('The Animexin check could not finish. The website keeps the last stored posts; try again shortly.');
      }
      return;
    }
    if (command.command === 'download') {
      const [titleId, ...urlParts] = command.args.split(/\s+/);
      const title = catalogById.get((titleId || '').toLowerCase());
      if (!title) {
        await ctx.reply('Unknown static catalog title. Use an existing ID from src/catalog.js, for example /download big-fish-and-begonia https://www.mediafire.com/file/...');
        return;
      }
      const downloadUrl = safeMediaFireUrl(urlParts.join(' '));
      if (!downloadUrl) {
        await ctx.reply('Use /download <existing-title-id> <https://www.mediafire.com/file/...> for a file you own or may distribute.');
        return;
      }
      await store.setTitleMedia(title.id, { downloadUrl, downloadUpdatedAt: new Date() });
      await ctx.reply(`Authorized download link saved for ${title.title}.`);
      return;
    }

    const [titleId] = command.args.split(/\s+/, 1);
    const title = catalogById.get((titleId || '').toLowerCase());
    const fileId = telegramImageFileId(message) || telegramImageFileId(message.reply_to_message || {});
    // /poster belongs to the full publisher workflow. Preserve the older static
    // catalogue shortcut only when a photo is attached; /catalogposter is the
    // explicit command for the reply-to-photo workflow.
    if (command.command === 'poster' && !fileId) return next();
    if (!title) {
      if (command.command === 'catalogposter') {
        await ctx.reply('Use /catalogposter <existing-title-id> and attach a photo, or reply to that command with the photo.');
        return;
      }
      return next();
    }
    if (!fileId) {
      await ctx.reply(`Send a photo with caption /catalogposter ${title.id}, or reply to a /catalogposter ${title.id} command with the photo.`);
      return;
    }
    if (!config.imgbbApiKey) {
      await ctx.reply('Poster hosting is not configured yet. Set IMGBB_API_KEY in deployment secrets.');
      return;
    }
    try {
      const { bytes, contentType } = await getTelegramImage(fileId, config, fetchImpl);
      const imageUrl = await uploadImageToImgBB(bytes, contentType, config.imgbbApiKey, fetchImpl);
      const now = new Date();
      await store.setTitleMedia(title.id, {
        imageUrl,
        artworkSource: 'telegram',
        artworkUpdatedAt: now,
        artworkCheckedAt: now,
      });
      await ctx.reply(`Poster saved for ${title.title}.`);
    } catch (error) {
      console.warn('[telegram] poster update failed:', error?.message || 'Unknown error');
      await ctx.reply('The poster could not be saved. Check the image, ImgBB key, and try again.');
    }
  });
}

export function createTelegramWebhookHandler({ config, store, fetchImpl = fetch }) {
  return async (request, response) => {
    const suppliedSecret = request.get('x-telegram-bot-api-secret-token') || '';
    if (!config.telegramBotToken || !config.telegramWebhookSecret || !constantTimeStringEqual(suppliedSecret, config.telegramWebhookSecret)) {
      return response.sendStatus(403);
    }
    if (!request.body || typeof request.body !== 'object' || Array.isArray(request.body)) {
      return response.sendStatus(400);
    }

    response.sendStatus(200);
    try {
      await processUpdate(request.body, { config, store, fetchImpl });
    } catch {
      const chatId = request.body?.message?.chat?.id;
      if (Number.isSafeInteger(chatId)) {
        await telegramReply(chatId, 'The request could not be completed. Check the bot configuration and try again.', config, fetchImpl);
      }
    }
  };
}

export async function registerTelegramWebhook(config, fetchImpl = fetch) {
  if (!config.telegramBotToken || !config.telegramWebhookSecret || !config.publicOrigin) return false;
  const apiBase = `https://api.telegram.org/bot${config.telegramBotToken}`;
  const payloads = [
    ['setWebhook', {
      url: `${config.publicOrigin}/api/telegram/webhook`,
      secret_token: config.telegramWebhookSecret,
      allowed_updates: ['message'],
    }],
    ['setMyCommands', {
      commands: [
        { command: 'poster', description: 'Set an existing title poster' },
        { command: 'download', description: 'Set an authorized MediaFire link' },
        { command: 'help', description: 'Show admin bot commands' },
      ],
    }],
  ];

  try {
    for (const [method, body] of payloads) {
      const response = await fetchImpl(`${apiBase}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) return false;
      const result = await response.json();
      if (result?.ok !== true) return false;
    }
    return true;
  } catch {
    return false;
  }
}
