import { catalogById, safeMediaFireUrl } from './catalog.js';
import { uploadImageToImgBB } from './image-hosting.js';
import { constantTimeStringEqual } from './security.js';

const maxImageBytes = 10 * 1024 * 1024;

function parseCommand(message) {
  const text = typeof message.caption === 'string' ? message.caption : message.text;
  const commandText = typeof text === 'string'
    ? text
    : (message.reply_to_message?.caption || message.reply_to_message?.text);
  if (typeof commandText !== 'string') return null;
  const firstLine = commandText.split(/\r?\n/, 1)[0].trim();
  const match = firstLine.match(/^\/(poster|download|help)(?:@[A-Za-z0-9_]+)?(?:\s+([\s\S]*))?$/i);
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
  const fileId = telegramImageFileId(message);
  const privateChat = message.chat.type === 'private';

  if (!Number.isSafeInteger(message.from.id) || !config.telegramAdminIds.includes(String(message.from.id))) return;
  if (!privateChat) {
    await telegramReply(chatId, 'Use the bot in a private chat to manage catalogue artwork.', config, fetchImpl);
    return;
  }

  if (command?.command === 'help') {
    await telegramReply(chatId,
      'Poster: send a photo with caption /poster <existing-title-id>.\n'
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

  if (command?.command !== 'poster' && fileId) {
    await telegramReply(chatId, 'Send a photo with caption /poster <existing-title-id>.', config, fetchImpl);
    return;
  }
  if (command?.command !== 'poster') return;

  const titleId = command.args.split(/\s+/, 1)[0]?.toLowerCase();
  const title = catalogById.get(titleId || '');
  if (!title) {
    await telegramReply(chatId, 'Unknown title. Use an existing catalogue ID, for example /poster perfect-world.', config, fetchImpl);
    return;
  }
  if (!fileId) {
    await telegramReply(chatId, `Reply to this command with a photo, or caption a photo with /poster ${title.id}.`, config, fetchImpl);
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

export function createTelegramWebhookHandler({ config, store, fetchImpl = fetch }) {
  return async (request, response) => {
    const suppliedSecret = request.get('x-telegram-bot-api-secret-token') || '';
    if (!config.telegramBotToken || !constantTimeStringEqual(suppliedSecret, config.telegramWebhookSecret || '')) {
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
