import { catalogItems } from './catalog.js';
import { uploadImageToImgBB } from './image-hosting.js';

const requestTimeoutMs = 7_000;
const maxPosterBytes = 8 * 1024 * 1024;
const artworkRefreshMs = 30 * 24 * 60 * 60 * 1000;
const artworkRetryMs = 7 * 24 * 60 * 60 * 1000;

export function normalizeTitle(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function matchesTitle(item, values) {
  const alternatives = Array.isArray(item.alternativeTitles) ? item.alternativeTitles : [];
  const expected = new Set([item.title, ...alternatives].map(normalizeTitle).filter(Boolean));
  return values.some((value) => typeof value === 'string' && expected.has(normalizeTitle(value)));
}

function matchesFormat(item, value) {
  if (!value) return true;
  const isMovie = String(value).toLowerCase() === 'movie';
  return item.format === 'movie' ? isMovie : !isMovie;
}

function safeImageUrl(value, source, config) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(value, source === 'animexin' ? config.animexinBaseUrl : undefined);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;

  const host = url.hostname.toLowerCase();
  let allowed = false;
  if (source === 'mal') allowed = host === 'cdn.myanimelist.net';
  if (source === 'anilist') allowed = /^s[1-4]\.anilist\.co$/.test(host);
  if (source === 'tmdb') allowed = host === 'image.tmdb.org';
  if (source === 'animexin') {
    const configuredHost = new URL(config.animexinBaseUrl).hostname.toLowerCase();
    const knownHosts = [configuredHost, 'animexin.dev', 'animexin.vip', 'animexin.xyz', 'animexin.top', 'animexinax.com', ...(config.animexinImageHosts || [])];
    allowed = knownHosts.some((knownHost) => host === knownHost || host.endsWith(`.${knownHost}`));
  }
  return allowed ? url.href : null;
}

async function fetchJson(fetchImpl, url, options = {}) {
  const response = await fetchImpl(url, {
    ...options,
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) return null;
  try {
    return await response.json();
  } catch {
    return null;
  }
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
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

async function searchMyAnimeList(item, config, fetchImpl) {
  if (!config.malClientId) return null;
  const url = new URL('https://api.myanimelist.net/v2/anime');
  url.searchParams.set('q', item.title);
  url.searchParams.set('limit', '10');
  url.searchParams.set('fields', 'alternative_titles,main_picture,media_type');
  const data = await fetchJson(fetchImpl, url, {
    headers: { 'X-MAL-CLIENT-ID': config.malClientId, Accept: 'application/json' },
  });
  const entries = Array.isArray(data?.data) ? data.data : [];
  for (const entry of entries) {
    const node = entry?.node;
    if (!node || !matchesFormat(item, node.media_type)) continue;
    const alternatives = node.alternative_titles || {};
    const synonyms = Array.isArray(alternatives.synonyms) ? alternatives.synonyms : [];
    if (!matchesTitle(item, [node.title, alternatives.en, alternatives.ja, ...synonyms])) continue;
    const imageUrl = safeImageUrl(node.main_picture?.large || node.main_picture?.medium, 'mal', config);
    if (imageUrl) return { imageUrl, source: 'mal' };
  }
  return null;
}

async function searchAniList(item, config, fetchImpl) {
  const query = `query ($search: String) {
    Page(page: 1, perPage: 10) {
      media(search: $search, type: ANIME) {
        title { romaji english native }
        format
        countryOfOrigin
        coverImage { extraLarge large }
      }
    }
  }`;
  const data = await fetchJson(fetchImpl, 'https://graphql.anilist.co', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ query, variables: { search: item.title } }),
  });
  const mediaEntries = Array.isArray(data?.data?.Page?.media) ? data.data.Page.media : [];
  for (const media of mediaEntries) {
    if (!matchesFormat(item, media.format)) continue;
    if (item.type === 'donghua' && media.countryOfOrigin !== 'CN') continue;
    const title = media.title || {};
    if (!matchesTitle(item, [title.romaji, title.english, title.native])) continue;
    const imageUrl = safeImageUrl(media.coverImage?.extraLarge || media.coverImage?.large, 'anilist', config);
    if (imageUrl) return { imageUrl, source: 'anilist' };
  }
  return null;
}

async function searchTmdb(item, config, fetchImpl) {
  if (!config.tmdbApiKey && !config.tmdbReadAccessToken) return null;
  if (item.type === 'donghua' && item.format !== 'movie') return null;

  const collection = item.format === 'movie' ? 'movie' : 'tv';
  const url = new URL(`https://api.themoviedb.org/3/search/${collection}`);
  url.searchParams.set('query', item.title);
  url.searchParams.set('include_adult', 'false');
  url.searchParams.set('language', 'en-US');
  const headers = { Accept: 'application/json' };
  if (config.tmdbReadAccessToken) headers.Authorization = `Bearer ${config.tmdbReadAccessToken}`;
  else if (config.tmdbApiKey) url.searchParams.set('api_key', config.tmdbApiKey);
  const data = await fetchJson(fetchImpl, url, { headers });
  const results = Array.isArray(data?.results) ? data.results : [];
  for (const result of results) {
    if (!matchesTitle(item, [result.title, result.name, result.original_title, result.original_name])) continue;
    const imageUrl = safeImageUrl(result.poster_path ? `https://image.tmdb.org/t/p/w500${result.poster_path}` : '', 'tmdb', config);
    if (imageUrl) return { imageUrl, source: 'tmdb' };
  }
  return null;
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#x([\da-f]{1,6});/gi, (entity, hex) => {
      const codePoint = Number.parseInt(hex, 16);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    })
    .replace(/&#(\d{1,7});/g, (entity, number) => {
      const codePoint = Number.parseInt(number, 10);
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : entity;
    });
}

function stripHtml(value) {
  return decodeHtml(value.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function attribute(tag, name) {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = tag.match(new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '') : '';
}

function animexinCards(html) {
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  const articles = markup.match(/<article\b[\s\S]*?<\/article>/gi) || [];
  if (articles.length) return articles;

  const openingCards = /<div\b[^>]*class=["'][^"']*\b(?:bsx|bs)\b[^"']*["'][^>]*>/gi;
  const divTags = /<\/?div\b[^>]*>/gi;
  const cards = [];
  let opening;
  while ((opening = openingCards.exec(markup))) {
    divTags.lastIndex = opening.index;
    let depth = 0;
    let end = -1;
    let tag;
    while ((tag = divTags.exec(markup))) {
      if (/^<\s*\//.test(tag[0])) depth -= 1;
      else if (!/\/\s*>$/.test(tag[0])) depth += 1;
      if (depth === 0) {
        end = divTags.lastIndex;
        break;
      }
    }
    if (end < 0) break;
    cards.push(markup.slice(opening.index, end));
    openingCards.lastIndex = end;
  }
  return cards;
}

function parseAnimexinPoster(html, item, config) {
  for (const card of animexinCards(html)) {
    const headings = card.match(/<h[1-6]\b[^>]*>[\s\S]*?<\/h[1-6]>/gi) || [];
    const headline = headings.find((heading) => /\bitemprop\s*=\s*(?:["']headline["']|headline(?=\s|>))/i.test(heading));
    if (!headline || !matchesTitle(item, [stripHtml(headline)])) continue;
    const typeMatch = card.match(/<([a-z][a-z0-9]*)\b[^>]*class=["'][^"']*\b(?:typez|eggtype)\b[^"']*["'][^>]*>([\s\S]*?)<\/\1>/i);
    const listingType = typeMatch ? stripHtml(typeMatch[2]) : '';
    if (!/\b(?:movies?|films?)\b/i.test(listingType)) continue;
    const images = card.match(/<img\b[^>]*>/gi) || [];
    const posterTag = images.find((image) => /\bitemprop\s*=\s*["']image["']/i.test(image)) || images[0];
    if (!posterTag) continue;
    const rawUrl = attribute(posterTag, 'data-src')
      || attribute(posterTag, 'data-lazy-src')
      || attribute(posterTag, 'data-original')
      || attribute(posterTag, 'src');
    const imageUrl = safeImageUrl(rawUrl, 'animexin', config);
    if (imageUrl) return imageUrl;
  }
  return null;
}

async function searchAnimexin(item, config, fetchImpl) {
  if (!config.animexinEnabled || item.type !== 'donghua' || item.format !== 'movie') return null;
  const url = new URL('/', config.animexinBaseUrl);
  url.searchParams.set('s', item.title);
  const response = await fetchImpl(url, {
    headers: {
      Accept: 'text/html',
      'User-Agent': 'AnimeDonghuaPosterBot/1.0 (+poster metadata only)',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response.ok) return null;
  const contentType = response.headers?.get('content-type') || '';
  if (contentType && !contentType.toLowerCase().includes('text/html')) return null;
  const advertisedLength = Number(response.headers?.get('content-length') || 0);
  if (advertisedLength > 2_000_000) return null;
  const htmlBytes = await readLimitedBytes(response, 2_000_000);
  if (!htmlBytes) return null;
  const html = new TextDecoder().decode(htmlBytes);
  const imageUrl = parseAnimexinPoster(html, item, config);
  return imageUrl ? { imageUrl, source: 'animexin' } : null;
}

export async function findPosterSource(item, config, fetchImpl = fetch) {
  const providers = [];
  if (item.type === 'donghua' && item.format === 'movie') providers.push(searchAnimexin);
  providers.push(searchMyAnimeList, searchAniList);
  if (item.type === 'anime' || item.format === 'movie') providers.push(searchTmdb);

  for (const provider of providers) {
    try {
      const result = await provider(item, config, fetchImpl);
      if (result?.imageUrl) return result;
    } catch {
      // A missing or unavailable provider is a normal fallback condition.
    }
  }
  return null;
}

function sniffImageType(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47
    && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) return 'image/png';
  if (bytes.length >= 12 && Buffer.from(bytes).toString('ascii', 0, 4) === 'RIFF' && Buffer.from(bytes).toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function cachePosterImage(poster, config, fetchImpl) {
  if (!config.imgbbApiKey) return poster.imageUrl;
  const safeUrl = safeImageUrl(poster.imageUrl, poster.source, config);
  if (!safeUrl) return null;

  try {
    const response = await fetchImpl(safeUrl, {
      headers: { Accept: 'image/jpeg,image/png,image/webp' },
      redirect: 'error',
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    if (!response.ok) return safeUrl;
    const advertisedLength = Number(response.headers?.get('content-length') || 0);
    if (advertisedLength > maxPosterBytes) return safeUrl;
    const bytes = await readLimitedBytes(response, maxPosterBytes);
    if (!bytes || bytes.length === 0) return safeUrl;
    const contentType = sniffImageType(bytes);
    if (!contentType) return safeUrl;
    return await uploadImageToImgBB(bytes, contentType, config.imgbbApiKey, fetchImpl);
  } catch {
    return safeUrl;
  }
}

export async function resolveAndCachePoster(item, config, fetchImpl = fetch) {
  const poster = await findPosterSource(item, config, fetchImpl);
  if (!poster) return null;
  const imageUrl = await cachePosterImage(poster, config, fetchImpl);
  return imageUrl ? { imageUrl, artworkSource: poster.source } : null;
}

function isImgBBUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === 'i.ibb.co';
  } catch {
    return false;
  }
}

export async function syncCatalogPosters({ store, config, fetchImpl = fetch, items = catalogItems }) {
  if (!store || !config?.posterSyncEnabled) return 0;
  const mediaById = await store.getTitleMedia(items.map((item) => item.id));
  const now = Date.now();
  let updated = 0;

  for (const item of items) {
    const current = mediaById.get(item.id);
    if (current?.artworkSource === 'telegram') continue;
    const checkedAt = new Date(current?.artworkCheckedAt || current?.artworkUpdatedAt || 0).getTime();
    const refreshAfter = current?.imageUrl ? artworkRefreshMs : artworkRetryMs;
    const needsImgBBRehost = Boolean(config.imgbbApiKey && current?.imageUrl && !isImgBBUrl(current.imageUrl));
    if (!needsImgBBRehost && Number.isFinite(checkedAt) && checkedAt > 0 && now - checkedAt < refreshAfter) continue;

    let resolved = null;
    try {
      resolved = await resolveAndCachePoster(item, config, fetchImpl);
    } catch {
      // Continue with the remaining catalogue titles if one provider fails.
    }

    const checked = new Date();
    const latest = (await store.getTitleMedia([item.id])).get(item.id);
    if (latest?.artworkSource === 'telegram') continue;
    if (resolved) {
      await store.setTitleMedia(item.id, {
        imageUrl: resolved.imageUrl,
        artworkSource: resolved.artworkSource,
        artworkUpdatedAt: checked,
        artworkCheckedAt: checked,
      });
      updated += 1;
    } else {
      await store.setTitleMedia(item.id, { artworkCheckedAt: checked });
    }
    await new Promise((resolve) => setTimeout(resolve, 1_050));
  }
  return updated;
}
