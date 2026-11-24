import compression from 'compression';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { catalogById, catalogItems, publicTitle } from './catalog.js';
import { createAnimexinReleaseFeed } from './animexin-feed.js';
import { publicRelease, refreshAnimexinReleases } from './releases.js';
import { toPublicContent } from './server/index.js';
import { createTelegramWebhookHandler } from './telegram-bot.js';
import { SCHEDULE_DAYS } from './schedule.js';
import {
  constantTimeStringEqual,
  createSessionToken,
  decryptPrivateField,
  encryptPrivateField,
  hashPassword,
  isValidEmail,
  lookupEmail,
  normalizeEmail,
  verifyPassword,
  verifySessionToken,
} from './security.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const validSections = new Set(['featured', 'trending', 'donghua', 'anime', 'movies', 'updates', 'continue']);
const validGenres = new Set(catalogItems.flatMap((item) => item.genres.map((genre) => genre.toLowerCase())));
const maxPasswordBytes = 512;
const sessionMaxAgeSeconds = 7 * 24 * 60 * 60;

function noStore(response) {
  response.set('Cache-Control', 'no-store');
}

function readCookie(request, name) {
  const cookieHeader = request.get('cookie');
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return null;
}

function appendCookie(response, name, value, { httpOnly, secure, maxAge } = {}) {
  const fields = [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'SameSite=Lax',
  ];
  if (Number.isInteger(maxAge)) fields.push(`Max-Age=${maxAge}`);
  if (httpOnly) fields.push('HttpOnly');
  if (secure) fields.push('Secure');
  response.append('Set-Cookie', fields.join('; '));
}

function clearCookie(response, name, { httpOnly, secure } = {}) {
  const fields = [
    `${name}=`,
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];
  if (httpOnly) fields.push('HttpOnly');
  if (secure) fields.push('Secure');
  response.append('Set-Cookie', fields.join('; '));
}

function expectedOrigin(request) {
  const host = request.get('host');
  if (!host) return null;
  try {
    return new URL(`${request.protocol}://${host}`).origin;
  } catch {
    return null;
  }
}

function shouldUseSecureCookie(request, config) {
  if (config.production || request.secure) return true;
  const pageOrigin = request.get('origin') || request.get('referer');
  if (!pageOrigin) return false;
  try {
    return new URL(pageOrigin).protocol === 'https:';
  } catch {
    return false;
  }
}

function csrfAndOriginGuard(config) {
  return (request, response, next) => {
    if (!writeMethods.has(request.method)) return next();

    const originHeader = request.get('origin');
    if (originHeader) {
      let origin;
      let originHost;
      try {
        const parsedOrigin = new URL(originHeader);
        origin = parsedOrigin.origin;
        originHost = parsedOrigin.host.toLowerCase();
      } catch {
        return response.status(403).json({ error: 'Request origin could not be verified.' });
      }
      const sameOrigin = origin === expectedOrigin(request);
      const sameDevelopmentHost = !config.production && originHost === request.get('host')?.toLowerCase();
      if (!sameOrigin && !sameDevelopmentHost && origin !== config.publicOrigin) {
        return response.status(403).json({ error: 'Request origin could not be verified.' });
      }
    }

    const cookieToken = readCookie(request, config.csrfCookieName);
    const headerToken = request.get('x-csrf-token');
    if (!cookieToken || !headerToken || !constantTimeStringEqual(cookieToken, headerToken)) {
      return response.status(403).json({ error: 'Your security token expired. Refresh the page and try again.' });
    }
    return next();
  };
}

function publicUser(user, config) {
  return {
    id: user.id,
    email: decryptPrivateField(user.emailCiphertext, config.dataEncryptionKey, 'email'),
    displayName: decryptPrivateField(user.displayNameCiphertext, config.dataEncryptionKey, 'display-name'),
  };
}

function authFailure(response) {
  noStore(response);
  return response.status(401).json({ error: 'Email or password is incorrect.' });
}

function bodyIsObject(body) {
  return body !== null && typeof body === 'object' && !Array.isArray(body);
}

function sendValidationError(response, message) {
  noStore(response);
  return response.status(400).json({ error: message });
}

function parsePositiveInteger(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) return null;
  return parsed;
}

/** Map a publisher catalog record onto the public title shape this site renders. */
function publishedTitleContent(content, config) {
  const category = String(content?.category || '').toLowerCase();
  if (!content?.slug || !content?.title) return null;
  // A draft is not public anywhere: not in a shelf, not by slug, not by Post ID.
  if (content.published === false) return null;
  // Only the shelves this site publishes are exposed publicly.
  const type = category === 'donghua' ? 'donghua' : ['anime', 'cartoon', 'movie'].includes(category) ? 'anime' : null;
  if (!type) return null;
  const publicConfig = {
    ...(config || {}),
    // The publisher config keeps its Telegram settings under `telegram`; the public
    // serializer reads `botUsername` from there. Without this bridge a card with
    // delivery files threw and every published post looked "not available".
    telegram: {
      ...(config?.telegram || {}),
      botUsername: config?.telegram?.botUsername || config?.telegramBotUsername || null,
    },
    streaming: config?.streaming || {},
    playback: config?.playback || {},
  };
  // includeFileChoices: the detail page needs the stream entries (players) and the
  // delivery file list, both of which the list serializer intentionally drops.
  return { ...toPublicContent(content, publicConfig, { includeFileChoices: true }), type };
}

/**
 * Public serialization of one publisher catalog record, or null when it is not public.
 *
 * `detailed` adds the delivery list the post page renders (the bot-uploaded files
 * and the MediaFire links the publisher registered). Listings stay lean so a
 * 48-card page never ships other people's file lists.
 */
function publicPublishedItem(content, config, { detailed = false } = {}) {
  const item = publishedTitleContent(content, config);
  if (!item) return null;
  const players = Array.isArray(item.stream?.entries)
    ? item.stream.entries
      .filter((entry) => entry?.embedUrl && ['Dailymotion', 'Rumble'].includes(entry.provider))
      .slice(0, 8)
      .map((entry) => ({
        provider: entry.provider,
        label: entry.label || entry.provider,
        embedUrl: entry.embedUrl,
        watchUrl: entry.watchUrl || entry.embedUrl,
      }))
    : [];
  return {
    id: item.slug,
    title: item.title,
    type: item.type,
    // The publisher shelf decides the format: a movie card stays a movie even
    // when it carries one episode record.
    format: item.category === 'movie' || item.episodeCount <= 1 ? 'movie' : 'series',
    status: 'ongoing',
    genres: Array.isArray(item.genres) ? item.genres : [],
    sections: [],
    description: item.description,
    ...(item.posterUrl ? { imageUrl: item.posterUrl } : {}),
    ...(players.length ? { players } : {}),
    ...(item.languages?.length ? { languages: item.languages } : {}),
    ...(item.subtitleLanguages?.length ? { subtitles: item.subtitleLanguages } : {}),
    ...(item.year ? { year: item.year } : {}),
    ...(item.episodeCount > 0 ? { episodeCount: item.episodeCount } : {}),
    ...(item.publishedAt ? { addedAt: item.publishedAt } : {}),
    ...(item.telegramUrl ? { telegramUrl: item.telegramUrl } : {}),
    ...(Array.isArray(content.downloads) && content.downloads.length ? { hasDownloads: true } : {}),
    ...(detailed && Number(item.filesCount) > 0 ? { filesCount: Number(item.filesCount) } : {}),
    ...(detailed && Array.isArray(item.fileChoices) && item.fileChoices.length
      ? {
        fileChoices: item.fileChoices.map((choice) => ({
          id: choice.id,
          position: choice.position,
          label: choice.label,
          fileName: choice.fileName,
          quality: choice.quality,
          size: choice.size,
          kind: choice.kind,
          episode: choice.episode,
          season: choice.season,
          telegramUrl: choice.telegramUrl || null,
          deliveryUrl: choice.deliveryUrl || null,
        })),
      }
      : {}),
    ...(detailed && item.deliveryUrl ? { deliveryUrl: item.deliveryUrl, deliveryReady: Boolean(item.deliveryReady) } : {}),
    // MediaFire is the only external download host this site exposes, plus the
    // Telegram deep links the publisher registers themselves.
    ...(detailed && content.downloadUrl ? { downloadUrl: content.downloadUrl } : {}),
    ...(detailed && Array.isArray(content.downloads) && content.downloads.length
      ? {
        downloads: content.downloads
          .filter((entry) => entry?.url && /^https:\/\/(?:(?:www\.)?mediafire\.com|t\.me|telegram\.me)\//i.test(entry.url))
          .slice(0, 10)
          .map((entry) => ({
            provider: entry.provider === 'Telegram' ? 'Telegram' : 'MediaFire',
            label: entry.label || (entry.provider === 'Telegram' ? 'Telegram delivery' : 'MediaFire download'),
            url: entry.url,
          })),
      }
      : {}),
    publisherAdminId: content.adminId || null,
    source: 'publisher',
  };
}

/**
 * Merge the static catalogue with the published posts, newest first.
 *
 * The site used to append published posts after every static title, so a brand
 * new episode never reached the featured hero even with `sort=newest`.
 */
function interleaveNewest(staticItems, publishedItems) {
  const timeOf = (item) => {
    const value = item?.addedAt || item?.publishedAt || null;
    const parsed = value ? Date.parse(value) : Number.NaN;
    return Number.isFinite(parsed) ? parsed : null;
  };
  const merged = [...staticItems, ...publishedItems].map((item, index) => ({ item, index, time: timeOf(item) }));
  merged.sort((left, right) => {
    if (left.time !== null && right.time !== null) return right.time - left.time || left.index - right.index;
    if (left.time !== null) return -1;
    if (right.time !== null) return 1;
    return left.index - right.index;
  });
  return merged.map(({ item }) => item);
}

/**
 * Published Telegram posts are the newest thing on the site, so they lead the hero
 * rotation and always appear once the whole catalogue is loaded.
 */
export function createApp({ store, config, fetchImpl = fetch, releaseFeed = null, catalogRepository = null }) {
  if (!store || !config) throw new Error('createApp requires a store and configuration.');

  const animexinHost = new URL(config.animexinBaseUrl).hostname;
  const feed = releaseFeed || createAnimexinReleaseFeed({ config, fetchImpl });
  const publisher = catalogRepository;

  /**
   * Published posts created through the Telegram publisher live in the publisher
   * catalog, not in src/catalog.js. They are read here so /donghua/<slug> and the
   * public API resolve the same card the bot linked to instead of returning 404.
   */
  async function publisherContentBySlug(slug) {
    if (!publisher || typeof publisher.findContentBySlug !== 'function') return null;
    try {
      return await publisher.findContentBySlug(String(slug || '').trim());
    } catch {
      return null;
    }
  }

  /** A link the bot printed may carry either the slug or the SB-… Post ID. */
  async function publisherContentByReference(reference) {
    const value = String(reference || '').trim();
    if (!value) return null;
    if (/^SB-[A-Z0-9]{6,}$/i.test(value) && typeof publisher?.findContentByAdminId === 'function') {
      try {
        return await publisher.findContentByAdminId(value.toUpperCase());
      } catch {
        return null;
      }
    }
    return publisherContentBySlug(value);
  }

  async function publisherContentList({ type, format } = {}) {
    if (!publisher || typeof publisher.listContent !== 'function') return [];
    try {
      const rows = await publisher.listContent({ limit: 100, hideAdult: true });
      return rows
        .map((row) => publicPublishedItem(row, config))
        .filter(Boolean)
        .filter((item) => (!type || item.type === type) && (!format || item.format === format));
    } catch {
      return [];
    }
  }
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        baseUri: ["'self'"],
        connectSrc: ["'self'"],
        fontSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        frameAncestors: config.production ? ["'none'"] : ["'self'", 'https:'],
        frameSrc: [
          "'self'",
          'https://dailymotion.com', 'https://*.dailymotion.com', 'https://dai.ly',
          'https://rumble.com', 'https://*.rumble.com',
        ],
        imgSrc: [
          "'self'", 'data:',
          'https://i.ibb.co',
          // WordPress/Jetpack image CDNs, where Animexin's own featured images live.
          'https://i0.wp.com', 'https://i1.wp.com', 'https://i2.wp.com', 'https://i3.wp.com',
          'https://cdn.myanimelist.net',
          'https://image.tmdb.org',
          'https://s1.anilist.co', 'https://s2.anilist.co', 'https://s3.anilist.co', 'https://s4.anilist.co',
          'https://animexin.dev', 'https://*.animexin.dev',
          'https://animexin.vip', 'https://*.animexin.vip',
          'https://animexin.xyz', 'https://*.animexin.xyz',
          'https://animexin.top', 'https://*.animexin.top',
          'https://animexinax.com', 'https://*.animexinax.com',
          `https://${animexinHost}`, `https://*.${animexinHost}`,
          ...(config.animexinImageHosts || []).flatMap((host) => [`https://${host}`, `https://*.${host}`]),
        ],
        mediaSrc: ["'self'"],
        objectSrc: ["'none'"],
        scriptSrc: ["'self'"],
        scriptSrcAttr: ["'none'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        styleSrcAttr: ["'unsafe-inline'"],
        ...(config.production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginResourcePolicy: { policy: 'same-origin' },
    frameguard: false,
    hsts: config.production ? { maxAge: 31_536_000, includeSubDomains: true } : false,
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  app.use(compression({ threshold: 1024 }));

  const apiLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many requests. Please slow down and try again shortly.' },
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: { error: 'Too many sign-in attempts. Please wait a little before trying again.' },
  });

  if (config.telegramBotToken) {
    const telegramLimiter = rateLimit({
      windowMs: 60_000,
      limit: 30,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
      message: 'Too many Telegram webhook updates.',
    });
    app.post(
      '/api/telegram/webhook',
      telegramLimiter,
      express.json({ limit: '24kb', strict: true }),
      createTelegramWebhookHandler({ config, store, fetchImpl }),
    );
  }

  app.use('/api', apiLimiter, csrfAndOriginGuard(config));
  app.use(express.json({ limit: '24kb', strict: true }));

  app.get('/healthz', (_request, response) => {
    response.set('Cache-Control', 'no-store').status(200).json({ status: 'ok' });
  });

  app.get('/readyz', (_request, response) => {
    const healthy = store.isHealthy();
    response.set('Cache-Control', 'no-store').status(healthy ? 200 : 503).json({
      status: healthy ? 'ready' : 'not-ready',
    });
  });

  app.get('/api/csrf', (request, response) => {
    noStore(response);
    let token = readCookie(request, config.csrfCookieName);
    if (!token || !/^[\w-]{40,60}$/.test(token)) {
      token = cryptoRandomToken();
      appendCookie(response, config.csrfCookieName, token, {
        httpOnly: false,
        secure: shouldUseSecureCookie(request, config),
        maxAge: sessionMaxAgeSeconds,
      });
    }
    response.json({ csrfToken: token });
  });

  app.get('/api/catalog', async (request, response) => {
    const query = typeof request.query.q === 'string' ? request.query.q.trim().toLowerCase() : '';
    const type = request.query.type;
    const format = request.query.format;
    const status = request.query.status;
    const section = request.query.section;
    const genre = typeof request.query.genre === 'string' ? request.query.genre.trim().toLowerCase() : '';
    const yearValue = request.query.year;
    const year = yearValue === undefined
      ? undefined
      : (typeof yearValue === 'string' && /^\d{4}$/.test(yearValue) && Number(yearValue) >= 1900 && Number(yearValue) <= 2100 ? Number(yearValue) : null);
    const sort = request.query.sort;
    const limit = parsePositiveInteger(request.query.limit, 24, 48);
    const offset = parsePositiveInteger(request.query.offset, 0, 1000);

    if (query.length > 100 || limit === null || offset === null
      || (yearValue !== undefined && year === null)
      || (sort !== undefined && sort !== 'newest')) {
      return sendValidationError(response, 'Invalid catalogue filters.');
    }
    if (type !== undefined && !['anime', 'donghua'].includes(type)) {
      return sendValidationError(response, 'Type must be anime or donghua.');
    }
    if (format !== undefined && !['series', 'movie'].includes(format)) {
      return sendValidationError(response, 'Format must be series or movie.');
    }
    if (status !== undefined && !['ongoing', 'completed'].includes(status)) {
      return sendValidationError(response, 'Status must be ongoing or completed.');
    }
    if (section !== undefined && !validSections.has(section)) {
      return sendValidationError(response, 'Unknown catalogue section.');
    }
    if (genre && !validGenres.has(genre)) {
      return sendValidationError(response, 'Unknown genre.');
    }

    let filtered = catalogItems.filter((item) => {
      // Only anime and donghua exist on this site, as series or movies.
      if (!['anime', 'donghua'].includes(item.type)) return false;
      const searchable = `${item.title} ${(item.alternativeTitles || []).join(' ')} ${item.description} ${item.genres.join(' ')}`.toLowerCase();
      return (!query || searchable.includes(query))
        && (!type || item.type === type)
        && (!format || item.format === format)
        && (!status || item.status === status)
        && (!year || item.year === year)
        && (!section || item.sections.includes(section))
        && (!genre || item.genres.some((itemGenre) => itemGenre.toLowerCase() === genre));
    });
    if (sort === 'newest') {
      filtered = filtered
        .map((item, index) => {
          const value = item.addedAt || item.createdAt;
          const date = typeof value === 'string' || value instanceof Date ? new Date(value) : null;
          return { item, index, time: date && Number.isFinite(date.getTime()) ? date.getTime() : null };
        })
        .sort((left, right) => {
          if (left.time !== null && right.time !== null) return right.time - left.time || left.index - right.index;
          if (left.time !== null) return -1;
          if (right.time !== null) return 1;
          return left.index - right.index;
        })
        .map(({ item }) => item);
    }
    // The page is cut *after* both catalogues are merged. Slicing the static list
    // first meant a static page could fill every slot, which is why a newly
    // published post never appeared in a short page or in the featured hero.
    const mediaFor = async (rows) => store.getTitleMedia(rows.map((item) => item.id));
    const staticPage = offset === 0 ? filtered : [];
    const mediaById = await mediaFor(filtered);
    const staticItems = staticPage.map((item) => publicTitle(item, mediaById.get(item.id)));
    // Published Telegram posts share the same catalogue. They always belong to
    // trending/updates/donghua/anime discovery, so a section filter other than
    // featured still includes them.
    const published = offset === 0 && (!section || section !== 'featured')
      ? (await publisherContentList({ type, format }))
        .filter((entry) => !status || entry.status === status)
        .filter((entry) => !query || `${entry.title} ${entry.description}`.toLowerCase().includes(query))
        .filter((entry) => !genre || entry.genres.some((value) => value.toLowerCase() === genre))
        .filter((entry) => !year || entry.year === year)
      : [];
    // Newest first across both catalogues, then cut to one page.
    const merged = sort === 'newest'
      ? interleaveNewest(staticItems, published)
      : [...staticItems, ...published];
    const items = merged.slice(0, limit);
    response.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    return response.json({
      items,
      total: filtered.length + published.length,
      offset,
      limit,
    });
  });

  /**
   * The weekly schedule the publisher writes with /schedule in Telegram.
   *
   * It is served on its own endpoint because it is editorial data, not a title:
   * a donghua can be scheduled before it has a post, and removing it must not
   * touch the catalogue.
   */
  app.get('/api/schedule', async (_request, response) => {
    noStore(response);
    if (!publisher || typeof publisher.listScheduleEntries !== 'function') {
      return response.json({ days: [], entries: [], updatedAt: null });
    }
    try {
      const entries = await publisher.listScheduleEntries();
      const days = SCHEDULE_DAYS.map((day) => ({
        day,
        entries: entries
          .filter((entry) => entry.day === day)
          .map((entry) => ({
            id: entry.key,
            title: entry.title,
            time: entry.time,
            ...(entry.timezone ? { timezone: entry.timezone } : {}),
            ...(entry.postId ? { postId: entry.postId } : {}),
            ...(entry.slug ? { slug: entry.slug } : {}),
          })),
      })).filter((group) => group.entries.length);
      return response.json({
        days,
        entries: entries.length,
        updatedAt: entries.reduce((latest, entry) => {
          const value = Date.parse(entry.updatedAt || '');
          const best = Date.parse(latest || '');
          return Number.isFinite(value) && (!Number.isFinite(best) || value > best) ? entry.updatedAt : latest;
        }, null),
      });
    } catch {
      return response.json({ days: [], entries: 0, updatedAt: null });
    }
  });

  app.get('/api/catalog/:id', async (request, response) => {
    const item = catalogById.get(request.params.id);
    if (item) {
      const mediaById = await store.getTitleMedia([item.id]);
      response.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      return response.json({ item: publicTitle(item, mediaById.get(item.id)) });
    }
    // A published Telegram post is addressable by its slug or its SB-… Post ID.
    const published = await publisherContentByReference(request.params.id);
    const publishedItem = published && published.published !== false ? publicPublishedItem(published, config, { detailed: true }) : null;
    if (publishedItem) {
      response.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
      return response.json({ item: publishedItem });
    }
    return response.status(404).json({ error: 'Title not found.' });
  });

  app.post('/api/auth/register', authLimiter, requireJsonBody, async (request, response) => {
    noStore(response);
    if (!bodyIsObject(request.body)) return sendValidationError(response, 'Enter your account details.');

    const email = normalizeEmail(request.body.email);
    const password = request.body.password;
    const requestedName = typeof request.body.displayName === 'string' ? request.body.displayName.trim() : '';
    const displayName = requestedName || 'Anime Donghua fan';

    if (!isValidEmail(email)) return sendValidationError(response, 'Enter a valid email address.');
    if (typeof password !== 'string'
      || password.length < 12
      || password.length > 256
      || Buffer.byteLength(password, 'utf8') > maxPasswordBytes) {
      return sendValidationError(response, 'Use a password between 12 and 256 characters.');
    }
    if (displayName.length > 50 || /[\u0000-\u001f\u007f]/.test(displayName)) {
      return sendValidationError(response, 'Your display name must be 50 characters or fewer.');
    }

    const userFields = {
      emailLookup: lookupEmail(email, config.emailLookupSecret),
      emailCiphertext: encryptPrivateField(email, config.dataEncryptionKey, 'email'),
      displayNameCiphertext: encryptPrivateField(displayName, config.dataEncryptionKey, 'display-name'),
      passwordHash: await hashPassword(password),
    };

    try {
      const user = await store.createUser(userFields);
      const token = createSessionToken(user, config.sessionSecret);
      appendCookie(response, config.sessionCookieName, token, {
        httpOnly: true,
        secure: shouldUseSecureCookie(request, config),
        maxAge: sessionMaxAgeSeconds,
      });
      return response.status(201).json({ user: publicUser(user, config) });
    } catch (error) {
      if (error?.code === 11000) {
        return response.status(409).json({
          error: 'Unable to create an account with these details. If you already have an account, sign in instead.',
        });
      }
      throw error;
    }
  });

  app.post('/api/auth/login', authLimiter, requireJsonBody, async (request, response) => {
    noStore(response);
    if (!bodyIsObject(request.body)) return sendValidationError(response, 'Enter your email and password.');

    const email = normalizeEmail(request.body.email);
    const password = request.body.password;
    if (!isValidEmail(email) || typeof password !== 'string' || password.length > 256
      || Buffer.byteLength(password, 'utf8') > maxPasswordBytes) {
      return authFailure(response);
    }

    const user = await store.findUserByEmailLookup(lookupEmail(email, config.emailLookupSecret));
    const passwordMatches = await verifyPassword(password, user?.passwordHash);
    if (!user || !passwordMatches) return authFailure(response);

    const token = createSessionToken(user, config.sessionSecret);
    appendCookie(response, config.sessionCookieName, token, {
      httpOnly: true,
      secure: shouldUseSecureCookie(request, config),
      maxAge: sessionMaxAgeSeconds,
    });
    return response.json({ user: publicUser(user, config) });
  });

  app.get('/api/auth/me', requireUser(store, config), (request, response) => {
    noStore(response);
    return response.json({ user: publicUser(request.user, config) });
  });

  app.post('/api/auth/logout', async (request, response) => {
    noStore(response);
    const payload = verifySessionToken(readCookie(request, config.sessionCookieName), config.sessionSecret);
    if (payload) await store.invalidateSessions(payload.sub, payload.ver);
    clearCookie(response, config.sessionCookieName, {
      httpOnly: true,
      secure: shouldUseSecureCookie(request, config),
    });
    return response.json({ ok: true });
  });

  app.get('/api/releases', async (request, response) => {
    const limit = parsePositiveInteger(request.query.limit, 6, 12);
    if (limit === null) return sendValidationError(response, 'Invalid release limit.');
    if (!config.animexinEnabled) {
      return response.json({ enabled: false, items: [], total: 0 });
    }
    let items = [];
    try {
      items = await store.listAnimexinReleases(limit);
    } catch {
      items = [];
    }
    if (items.length === 0 && feed) {
      try {
        await refreshAnimexinReleases({ store, feed, limit });
        items = await store.listAnimexinReleases(limit);
      } catch {
        items = [];
      }
    }
    const releases = items.map((release) => publicRelease(release, config)).filter(Boolean);
    response.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    return response.json({
      enabled: true,
      source: 'animexin',
      items: releases,
      total: releases.length,
      playable: releases.filter((release) => release.playerCount > 0).length,
    });
  });

  app.get('/api/releases/:id', async (request, response) => {
    const id = String(request.params.id || '');
    if (!/^[\w%.-]{1,140}$/.test(id)) return sendValidationError(response, 'Invalid release id.');
    if (!config.animexinEnabled) return response.status(404).json({ error: 'Release not found.' });
    let release = null;
    try {
      release = await store.getAnimexinRelease(decodeURIComponent(id));
    } catch {
      release = null;
    }
    if (!release) return response.status(404).json({ error: 'Release not found.' });
    const item = publicRelease(release, config);
    if (!item) return response.status(404).json({ error: 'Release not found.' });
    response.set('Cache-Control', 'public, max-age=60, stale-while-revalidate=120');
    return response.json({ item });
  });

  app.get('/api/me/favorites', requireUser(store, config), async (request, response) => {
    noStore(response);
    const favorites = await store.getFavorites(request.user.id);
    if (!favorites) return response.status(401).json({ error: 'Please sign in again.' });
    return response.json({ favorites });
  });

  app.post('/api/me/favorites', requireJsonBody, requireUser(store, config), async (request, response) => {
    noStore(response);
    if (!bodyIsObject(request.body) || typeof request.body.titleId !== 'string') {
      return sendValidationError(response, 'Choose a title to add to your list.');
    }
    if (!catalogById.has(request.body.titleId)) return response.status(404).json({ error: 'Title not found.' });
    const favorites = await store.addFavorite(request.user.id, request.body.titleId);
    if (!favorites) return response.status(401).json({ error: 'Please sign in again.' });
    return response.json({ favorites });
  });

  app.delete('/api/me/favorites/:titleId', requireUser(store, config), async (request, response) => {
    noStore(response);
    if (!catalogById.has(request.params.titleId)) return response.status(404).json({ error: 'Title not found.' });
    const favorites = await store.removeFavorite(request.user.id, request.params.titleId);
    if (!favorites) return response.status(401).json({ error: 'Please sign in again.' });
    return response.json({ favorites });
  });

  app.use(express.static(publicDirectory, {
    etag: true,
    fallthrough: true,
    maxAge: config.production ? '1h' : 0,
    setHeaders(response, filePath) {
      if (filePath.endsWith('/index.html')) response.setHeader('Cache-Control', 'no-cache, must-revalidate');
      if (filePath.endsWith('/app.js') || filePath.endsWith('/app.css')) {
        response.setHeader('Cache-Control', 'no-cache, must-revalidate');
      }
    },
  }));

  app.get(['/trending', '/updates', '/releases', '/donghua', '/anime', '/ongoing', '/movies', '/categories', '/continue-watching', '/my-list', '/profile', '/discover', '/schedule'], (_request, response) => {
    response.set('Cache-Control', 'no-cache').sendFile(`${publicDirectory}/index.html`);
  });
  app.get('/releases/:id', (_request, response) => {
    response.set('Cache-Control', 'no-cache').sendFile(`${publicDirectory}/index.html`);
  });
  app.get(['/release/:id'], (_request, response) => {
    response.set('Cache-Control', 'no-cache').sendFile(`${publicDirectory}/index.html`);
  });
  app.get(['/title/:id', '/watch/:id'], async (request, response, next) => {
    if (catalogById.has(request.params.id)) {
      return response.set('Cache-Control', 'no-cache').sendFile(`${publicDirectory}/index.html`);
    }
    const published = await publisherContentByReference(request.params.id);
    if (!published || published.published === false) return next();
    return response.set('Cache-Control', 'no-cache').sendFile(`${publicDirectory}/index.html`);
  });
  // The publisher bot links to /<category>/<slug> (e.g. /donghua/swallowed-star-season-4).
  // Those cards live in the publisher catalog, so the route must serve the app shell
  // and let the client resolve the slug instead of 404ing on a live post.
  // The bot also prints the Post ID itself, so /post/<SB-…> (and a bare /<SB-…>)
  // opens the same card. A printed ID must never dead-end.
  app.get(['/post/:id', '/p/:id'], async (request, response, next) => {
    const published = await publisherContentByReference(request.params.id);
    if (!published || published.published === false) return next();
    return response.set('Cache-Control', 'no-cache').sendFile(`${publicDirectory}/index.html`);
  });
  app.get('/:category/:slug', async (request, response, next) => {
    const category = String(request.params.category || '').toLowerCase();
    if (!['anime', 'donghua', 'movie', 'cartoon'].includes(category)) return next();
    if (!/^[a-z0-9][a-z0-9-]{0,119}$/i.test(request.params.slug || '')) return next();
    const published = await publisherContentByReference(request.params.slug);
    if (!published || published.published === false) {
      // Give a clear answer instead of a bare 404 when the post simply is not
      // published yet (or was deleted after the bot shared the link).
      return response.status(404).set('Cache-Control', 'no-store').type('html').send(
        '<!doctype html><meta charset="utf-8"><title>Post not available | Anime Donghua</title>'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<body style="font-family:system-ui;background:#0d1020;color:#eee8ff;padding:32px">'
        + '<h1 style="font-size:22px">That post is not available</h1>'
        + `<p style="color:#a7a8c2">No published catalog post matches <code>${request.params.slug.replace(/[<>&"]/g, '')}</code>.</p>`
        + '<p><a style="color:#cdb5ff" href="/">Browse the catalogue</a> · '
        + '<a style="color:#cdb5ff" href="/releases">Latest releases</a></p></body>',
      );
    }
    return response.set('Cache-Control', 'no-cache').sendFile(`${publicDirectory}/index.html`);
  });
  app.get('/genre/:slug', (request, response, next) => {
    if (!/^[a-z0-9-]{1,40}$/i.test(request.params.slug)) return next();
    return response.set('Cache-Control', 'no-cache').sendFile(`${publicDirectory}/index.html`);
  });

  app.use((request, response) => {
    if (request.path.startsWith('/api/')) return response.status(404).json({ error: 'Endpoint not found.' });
    return response.status(404).type('text/plain').send('Not found');
  });

  app.use((error, request, response, _next) => {
    if (response.headersSent) return;
    const isApiRequest = request.path.startsWith('/api/');
    const duplicate = error?.code === 11000;
    const tooLarge = error?.type === 'entity.too.large';
    const malformedJson = error instanceof SyntaxError && Object.hasOwn(error, 'body');
    const passwordBusy = error?.code === 'PASSWORD_SERVICE_BUSY';
    const databaseError = error?.name?.startsWith('Mongo') || error?.name === 'MongooseError';

    if (error && !tooLarge && !malformedJson && !duplicate && !passwordBusy) {
      console.error('Request failed:', error?.name || 'Error');
    }

    if (duplicate) return response.status(409).json({ error: 'Unable to complete this request.' });
    if (tooLarge) return response.status(413).json({ error: 'Request is too large.' });
    if (malformedJson) return response.status(400).json({ error: 'Request body must be valid JSON.' });
    if (passwordBusy) return response.status(503).json({ error: 'The sign-in service is busy. Please try again shortly.' });
    if (databaseError) return response.status(503).json({ error: 'Account storage is temporarily unavailable.' });
    if (isApiRequest) return response.status(500).json({ error: 'Something went wrong. Please try again.' });
    return response.status(500).type('text/plain').send('Something went wrong');
  });

  return app;
}

function cryptoRandomToken() {
  return randomBytes(32).toString('base64url');
}

function requireJsonBody(request, response, next) {
  if (!request.is('application/json')) {
    return response.status(415).json({ error: 'Send this request as JSON.' });
  }
  return next();
}

function requireUser(store, config) {
  return async (request, response, next) => {
    noStore(response);
    const token = readCookie(request, config.sessionCookieName);
    const payload = verifySessionToken(token, config.sessionSecret);
    if (!payload) return response.status(401).json({ error: 'Please sign in to continue.' });

    const user = await store.findUserById(payload.sub);
    if (!user || user.tokenVersion !== payload.ver) {
      return response.status(401).json({ error: 'Please sign in to continue.' });
    }
    request.user = user;
    return next();
  };
}
