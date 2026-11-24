import { randomBytes } from 'node:crypto';

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

  return Object.freeze({
    nodeEnv,
    production,
    port,
    mongodbUri: env.MONGODB_URI || null,
    sessionSecret,
    emailLookupSecret,
    dataEncryptionKey,
    publicOrigin,
    sessionCookieName: production ? '__Host-anime-donghua_session' : 'anime_donghua_session',
    csrfCookieName: production ? '__Host-anime-donghua_csrf' : 'anime_donghua_csrf',
    trustProxy: production || env.TRUST_PROXY === '1' ? 1 : false,
  });
}
