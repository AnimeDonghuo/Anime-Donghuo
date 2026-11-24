import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

const SCRYPT_N = 32_768;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEY_BYTES = 64;
const SCRYPT_MAX_MEMORY = 64 * 1024 * 1024;
const SESSION_SECONDS = 7 * 24 * 60 * 60;
const DUMMY_SALT = Buffer.alloc(16, 0x61);
let activePasswordHashes = 0;
const MAX_ACTIVE_PASSWORD_HASHES = 2;

function deriveScrypt(password, salt) {
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      SCRYPT_KEY_BYTES,
      { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAX_MEMORY },
      (error, derivedKey) => (error ? reject(error) : resolve(derivedKey)),
    );
  });
}

function acquirePasswordHashSlot() {
  if (activePasswordHashes >= MAX_ACTIVE_PASSWORD_HASHES) {
    const error = new Error('Password service is busy.');
    error.code = 'PASSWORD_SERVICE_BUSY';
    throw error;
  }
  activePasswordHashes += 1;
}

export async function hashPassword(password) {
  acquirePasswordHashSlot();
  try {
    const salt = randomBytes(16);
    const derivedKey = await deriveScrypt(password, salt);
    return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('base64url')}$${derivedKey.toString('base64url')}`;
  } finally {
    activePasswordHashes -= 1;
  }
}

export async function verifyPassword(password, encodedHash) {
  acquirePasswordHashSlot();
  try {
    const parts = typeof encodedHash === 'string' ? encodedHash.split('$') : [];
    const validFormat = parts.length === 6
      && parts[0] === 'scrypt'
      && parts[1] === String(SCRYPT_N)
      && parts[2] === String(SCRYPT_R)
      && parts[3] === String(SCRYPT_P);

    let salt = DUMMY_SALT;
    let expected = Buffer.alloc(SCRYPT_KEY_BYTES);
    if (validFormat) {
      const candidateSalt = Buffer.from(parts[4], 'base64url');
      const candidateHash = Buffer.from(parts[5], 'base64url');
      if (candidateSalt.length === 16 && candidateHash.length === SCRYPT_KEY_BYTES) {
        salt = candidateSalt;
        expected = candidateHash;
      }
    }

    const actual = await deriveScrypt(password, salt);
    return validFormat
      && timingSafeEqual(actual, expected);
  } finally {
    activePasswordHashes -= 1;
  }
}

export function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

export function isValidEmail(value) {
  return typeof value === 'string'
    && Buffer.byteLength(value, 'utf8') <= 254
    && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function lookupEmail(email, secret) {
  return createHmac('sha256', secret).update(email, 'utf8').digest('hex');
}

export function encryptPrivateField(value, key, context) {
  const version = `v1.${context}`;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(version, 'utf8'));
  const ciphertext = Buffer.concat([
    cipher.update(value, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return `${version}.${iv.toString('base64url')}.${tag.toString('base64url')}.${ciphertext.toString('base64url')}`;
}

export function decryptPrivateField(encrypted, key, context) {
  const parts = typeof encrypted === 'string' ? encrypted.split('.') : [];
  const version = `v1.${context}`;
  if (parts.length !== 5 || `${parts[0]}.${parts[1]}` !== version) {
    throw new Error('Unsupported encrypted field format.');
  }

  const iv = Buffer.from(parts[2], 'base64url');
  const tag = Buffer.from(parts[3], 'base64url');
  const ciphertext = Buffer.from(parts[4], 'base64url');
  if (iv.length !== 12 || tag.length !== 16) {
    throw new Error('Invalid encrypted field.');
  }

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(Buffer.from(version, 'utf8'));
  decipher.setAuthTag(tag);
  return Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]).toString('utf8');
}

export function createSessionToken(user, secret, now = Date.now()) {
  const issuedAt = Math.floor(now / 1000);
  const payload = {
    sub: String(user.id),
    ver: Number.isInteger(user.tokenVersion) ? user.tokenVersion : 0,
    iat: issuedAt,
    exp: issuedAt + SESSION_SECONDS,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret).update(encodedPayload).digest('base64url');
  return `${encodedPayload}.${signature}`;
}

export function verifySessionToken(token, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

  const expected = createHmac('sha256', secret).update(parts[0]).digest();
  const supplied = Buffer.from(parts[1], 'base64url');
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return null;

  try {
    const payload = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
    const nowSeconds = Math.floor(now / 1000);
    if (typeof payload.sub !== 'string' || payload.sub.length < 16 || payload.sub.length > 64) return null;
    if (!Number.isInteger(payload.ver) || payload.ver < 0) return null;
    if (!Number.isInteger(payload.iat) || !Number.isInteger(payload.exp)) return null;
    if (payload.iat > nowSeconds + 60 || payload.exp <= nowSeconds) return null;
    if (payload.exp - payload.iat > SESSION_SECONDS) return null;
    return payload;
  } catch {
    return null;
  }
}

export function constantTimeStringEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string') return false;
  if (left.length > 512 || right.length > 512) return false;
  const leftBytes = Buffer.from(left, 'utf8');
  const rightBytes = Buffer.from(right, 'utf8');
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}
