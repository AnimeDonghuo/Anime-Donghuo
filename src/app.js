import compression from 'compression';
import express from 'express';
import { rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { catalogById, catalogItems, publicTitle } from './catalog.js';
import { createTelegramWebhookHandler } from './telegram-bot.js';
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

export function createApp({ store, config, fetchImpl = fetch }) {
  if (!store || !config) throw new Error('createApp requires a store and configuration.');

  const animexinHost = new URL(config.animexinBaseUrl).hostname;
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
        frameSrc: ["'none'"],
        imgSrc: [
          "'self'", 'data:',
          'https://i.ibb.co',
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
    const pageItems = filtered.slice(offset, offset + limit);
    const mediaById = await store.getTitleMedia(pageItems.map((item) => item.id));
    response.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    return response.json({
      items: pageItems.map((item) => publicTitle(item, mediaById.get(item.id))),
      total: filtered.length,
      offset,
      limit,
    });
  });

  app.get('/api/catalog/:id', async (request, response) => {
    const item = catalogById.get(request.params.id);
    if (!item) return response.status(404).json({ error: 'Title not found.' });
    const mediaById = await store.getTitleMedia([item.id]);
    response.set('Cache-Control', 'public, max-age=30, stale-while-revalidate=60');
    return response.json({ item: publicTitle(item, mediaById.get(item.id)) });
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

  app.get(['/trending', '/updates', '/donghua', '/anime', '/ongoing', '/movies', '/categories', '/continue-watching', '/my-list', '/profile', '/discover', '/schedule'], (_request, response) => {
    response.set('Cache-Control', 'no-cache').sendFile(`${publicDirectory}/index.html`);
  });
  app.get(['/title/:id', '/watch/:id'], (request, response, next) => {
    if (!catalogById.has(request.params.id)) return next();
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
      console.error('Request failed:', error.name || 'Error');
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
