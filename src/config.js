import { randomBytes } from 'node:crypto';
import { isIP } from 'node:net';

function requiredSecret(env, name, fallback, minimumBytes = 32) {
  const value = env[name] || fallback;
  if (!value) throw new Error(`${name} must be set in production.`);
  if (Buffer.byteLength(value, 'utf8') < minimumBytes) {
    throw new Error(`${name} must contain at least ${minimumBytes} bytes.`);
  }
  return Buffer.from(value, 'utf8');
}

function encryptionKey(env, fallback) {
  const value = env.DATA_ENCRYPTION_KEY;
  if (!value) {
    if (!fallback) throw new Error('DATA_ENCRYPTION_KEY must be set in production.');
    return fallback;
  }

  let key;
  if (/^[\da-f]{64}$/i.test(value)) {
    key = Buffer.from(value, 'hex');
  } else {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      throw new Error('DATA_ENCRYPTION_KEY must be valid base64 or 64 hex characters.');
    }
    key = Buffer.from(value, 'base64');
  }
  if (key.length !== 32) {
    throw new Error('DATA_ENCRYPTION_KEY must be 32 bytes encoded as base64 or 64 hex characters.');
  }
  return key;
}

export function createConfig(env = process.env) {
  const nodeEnv = env.NODE_ENV || 'development';
  const production = nodeEnv === 'production';
  const hasMongo = Boolean(env.MONGODB_URI);
  const telegramBotToken = env.TELEGRAM_BOT_TOKEN?.trim() || null;
  const telegramWebhookSecret = env.TELEGRAM_WEBHOOK_SECRET?.trim() || null;
  const telegramAdminIds = [...new Set((env.TELEGRAM_ADMIN_IDS || '').split(',').map((value) => value.trim()).filter(Boolean))];
  if (telegramAdminIds.length > 50 || telegramAdminIds.some((id) => !/^\d{1,20}$/.test(id))) {
    throw new Error('TELEGRAM_ADMIN_IDS must be a comma-separated list of up to 50 numeric Telegram user IDs.');
  }
  if (telegramWebhookSecret && !/^[A-Za-z0-9_-]{32,256}$/.test(telegramWebhookSecret)) {
    throw new Error('TELEGRAM_WEBHOOK_SECRET must contain 32–256 URL-safe characters.');
  }
  if (telegramBotToken && telegramAdminIds.length === 0) {
    throw new Error('TELEGRAM_BOT_TOKEN requires at least one TELEGRAM_ADMIN_IDS value.');
  }
  const telegramPublisherLoginCode = env.ADMIN_LOGIN_CODE?.trim() || null;
  if (telegramPublisherLoginCode && (Buffer.byteLength(telegramPublisherLoginCode, 'utf8') < 8 || Buffer.byteLength(telegramPublisherLoginCode, 'utf8') > 128)) {
    throw new Error('ADMIN_LOGIN_CODE must contain between 8 and 128 bytes.');
  }

  const malClientId = env.MAL_CLIENT_ID?.trim() || null;
  const tmdbApiKey = env.TMDB_API_KEY?.trim() || null;
  const tmdbReadAccessToken = env.TMDB_READ_ACCESS_TOKEN?.trim() || null;
  const imgbbApiKey = env.IMGBB_API_KEY?.trim() || null;
  const animexinEnabled = env.ANIMEXIN_ENABLED !== 'false';
  const animexinBaseUrlValue = env.ANIMEXIN_BASE_URL?.trim() || 'https://animexin.dev';
  let animexinBaseUrl;
  try {
    const parsed = new URL(animexinBaseUrlValue);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error();
    animexinBaseUrl = parsed.origin;
  } catch {
    throw new Error('ANIMEXIN_BASE_URL must be an HTTPS origin, for example https://animexin.dev.');
  }
  const animexinRefreshMinutes = Number.parseInt(env.ANIMEXIN_REFRESH_MINUTES || '30', 10);
  if (!Number.isInteger(animexinRefreshMinutes) || animexinRefreshMinutes < 5 || animexinRefreshMinutes > 1_440) {
    throw new Error('ANIMEXIN_REFRESH_MINUTES must be an integer between 5 and 1440.');
  }
  const animexinImageHosts = [...new Set((env.ANIMEXIN_IMAGE_HOSTS || '')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean))];
  const validImageHost = (host) => host.length <= 253
    && host.includes('.')
    && !isIP(host)
    && !host.endsWith('.local')
    && host !== 'localhost'
    && /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/.test(host);
  if (animexinImageHosts.length > 20 || animexinImageHosts.some((host) => !validImageHost(host))) {
    throw new Error('ANIMEXIN_IMAGE_HOSTS must contain up to 20 public DNS hostnames, separated by commas.');
  }

  if (production && !hasMongo) {
    throw new Error('MONGODB_URI is required in production; in-memory storage is development-only.');
  }
  if (production && /(?:[?&])tls=false(?:&|$)/i.test(env.MONGODB_URI)) {
    throw new Error('MongoDB TLS must remain enabled in production.');
  }
  if (production && !env.MONGODB_URI.startsWith('mongodb+srv://') && !/(?:[?&])tls=true(?:&|$)/i.test(env.MONGODB_URI)) {
    throw new Error('Use a mongodb+srv:// URI or explicitly enable tls=true in production.');
  }

  const ephemeral = production ? null : randomBytes(32);
  const sessionSecret = requiredSecret(
    env,
    'SESSION_SECRET',
    ephemeral?.toString('hex'),
  );
  const emailLookupSecret = requiredSecret(
    env,
    'EMAIL_LOOKUP_SECRET',
    ephemeral?.toString('hex'),
  );
  const dataEncryptionKey = encryptionKey(env, ephemeral);

  if (hasMongo && (!env.SESSION_SECRET || !env.EMAIL_LOOKUP_SECRET || !env.DATA_ENCRYPTION_KEY)) {
    throw new Error('When MongoDB is enabled, set persistent SESSION_SECRET, EMAIL_LOOKUP_SECRET, and DATA_ENCRYPTION_KEY values.');
  }

  const port = Number.parseInt(env.PORT || '8000', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('PORT must be an integer between 1 and 65535.');
  }

  let publicOrigin = null;
  if (env.PUBLIC_ORIGIN) {
    try {
      const parsed = new URL(env.PUBLIC_ORIGIN);
      if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== env.PUBLIC_ORIGIN.replace(/\/$/, '')) {
        throw new Error();
      }
      publicOrigin = parsed.origin;
    } catch {
      throw new Error('PUBLIC_ORIGIN must be a valid origin, for example https://anime-donghua.example.com.');
    }
  }

  // The public site origin used for links the bot prints. A custom domain must
  // beat Koyeb's auto-assigned *.koyeb.app host that stays in the environment
  // after a domain is attached.
  const siteUrlCandidates = [
    env.PUBLIC_SITE_URL, env.WEBSITE_URL, env.SITE_URL, env.APP_URL,
    env.PUBLIC_URL, env.PUBLIC_ORIGIN, env.CUSTOM_DOMAIN, env.PUBLIC_DOMAIN,
    env.KOYEB_PUBLIC_DOMAIN,
  ].map((value) => {
    const candidate = String(value || '').trim().replace(/\/+$/, '');
    if (!candidate) return '';
    return /^https?:\/\//i.test(candidate) ? candidate : `https://${candidate}`;
  }).filter(Boolean);
  const isKoyebHost = (value) => {
    try {
      const host = new URL(value).hostname.toLowerCase();
      return host === 'koyeb.app' || host.endsWith('.koyeb.app');
    } catch {
      return false;
    }
  };
  const siteUrl = siteUrlCandidates.find((value) => !isKoyebHost(value)) || siteUrlCandidates[0] || null;

  return Object.freeze({
    nodeEnv,
    production,
    port,
    siteUrl,
    mongodbUri: env.MONGODB_URI || null,
    sessionSecret,
    emailLookupSecret,
    dataEncryptionKey,
    publicOrigin,
    telegramBotToken,
    telegramWebhookSecret,
    telegramAdminIds: Object.freeze(telegramAdminIds),
    telegramPublisherLoginCode,
    imgbbApiKey,
    malClientId,
    tmdbApiKey,
    tmdbReadAccessToken,
    animexinEnabled,
    animexinBaseUrl,
    animexinImageHosts: Object.freeze(animexinImageHosts),
    animexinRefreshMinutes,
    posterSyncEnabled: env.POSTER_SYNC_ENABLED === 'true' || (production && env.POSTER_SYNC_ENABLED !== 'false'),
    sessionCookieName: production ? '__Host-anime-donghua_session' : 'anime_donghua_session',
    csrfCookieName: production ? '__Host-anime-donghua_csrf' : 'anime_donghua_csrf',
    trustProxy: production || env.TRUST_PROXY === '1' ? 1 : false,
  });
}
