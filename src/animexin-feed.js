import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { safeMediaFireUrl } from './catalog.js';
import { safeStreamingLink } from './server/services/streaming-service.js';

const requestTimeoutMs = 7_000;
const maxHtmlBytes = 2_000_000;
const maxPlayersPerRelease = 8;
const releaseCacheTtlMs = 10 * 60 * 1000;
const releaseFailureTtlMs = 60 * 1000;
const maxReleaseCacheEntries = 12;

const ALLOWED_PLAYER_HOSTS = ['dailymotion.com', 'dai.ly', 'rumble.com'];
const NON_ENGLISH_LABEL = /\b(?:indonesia|indonesian|indo|malay|melayu|hindi|tagalog|thai|vietnam|vietnamese|spanish|latino|portuguese|arabic|japanese|korean|chinese|mandarin)\b/i;
const ENGLISH_LABEL = /\benglish\b/i;

const cache = new Map();

function decodeHtml(value) {
  return String(value || '')
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
  return decodeHtml(String(value || '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function cleanText(value, maxLength = 160) {
  return stripHtml(value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function attribute(tag, name) {
  const escapedName = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(tag).match(new RegExp(`\\b${escapedName}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? decodeHtml(match[1] ?? match[2] ?? match[3] ?? '').trim() : '';
}

function safeAnimexinUrl(value, baseUrl) {
  let url;
  try {
    url = new URL(decodeHtml(value), baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const configuredHost = new URL(baseUrl).hostname.toLowerCase();
  const allowedHosts = ['animexin.dev', 'animexin.vip', 'animexin.xyz', 'animexin.top', 'animexinax.com', configuredHost];
  if (!allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
  url.hash = '';
  return url;
}

function safeImageUrl(value, baseUrl) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  let url;
  try {
    url = new URL(decodeHtml(value), baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const configuredHost = new URL(baseUrl).hostname.toLowerCase();
  const allowedHosts = ['animexin.dev', 'animexin.vip', 'animexin.xyz', 'animexin.top', 'animexinax.com', 'i.ibb.co', configuredHost];
  if (!allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
  return url.href;
}

async function readLimitedText(response, maxBytes) {
  const advertisedLength = Number(response.headers?.get('content-length') || 0);
  if (advertisedLength > maxBytes) return null;
  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.length <= maxBytes ? new TextDecoder().decode(buffer) : null;
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
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder().decode(merged);
}

async function fetchAnimexinText(url, fetchImpl, accept) {
  const response = await fetchImpl(url, {
    headers: {
      Accept: accept,
      'User-Agent': 'AnimeDonghuaReleaseBot/1.0 (+latest release metadata and approved embeds)',
    },
    redirect: 'error',
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!response?.ok) return null;
  return readLimitedText(response, maxHtmlBytes);
}

function feedEntryDate(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

/**
 * Read the Animexin WordPress feed. Returns [] when the feed is unavailable or
 * malformed so the caller can fall back to the homepage listing.
 */
export function parseAnimexinFeed(xml, baseUrl) {
  if (typeof xml !== 'string' || !xml.trim()) return [];
  if (XMLValidator.validate(xml) !== true) return [];
  let document;
  try {
    document = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true }).parse(xml);
  } catch {
    return [];
  }
  const rawItems = document?.rss?.channel?.item ?? document?.feed?.entry;
  const entries = Array.isArray(rawItems) ? rawItems : (rawItems ? [rawItems] : []);
  const releases = [];
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue;
    const linkValue = typeof entry.link === 'string' ? entry.link : entry.link?.['@_href'];
    const title = cleanText(entry.title, 200);
    const pageUrl = safeAnimexinUrl(linkValue, baseUrl);
    if (!title || !pageUrl) continue;
    const identifier = typeof entry.guid === 'string' ? entry.guid : (typeof entry.id === 'string' ? entry.id : pageUrl.href);
    releases.push({
      title,
      pageUrl: pageUrl.href,
      guid: identifier,
      publishedAt: feedEntryDate(entry.pubDate || entry.published || entry.updated),
    });
  }
  return releases;
}

/** Fallback listing read from the homepage when the RSS feed is empty. */
export function parseAnimexinHomepage(html, baseUrl) {
  if (typeof html !== 'string' || !html) return [];
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?\1>/gi, ' ');
  const anchors = markup.match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  const releases = [];
  const seen = new Set();
  for (const anchor of anchors) {
    const href = attribute(anchor, 'href');
    const pageUrl = href ? safeAnimexinUrl(href, baseUrl) : null;
    if (!pageUrl || pageUrl.pathname === '/' || /^\/(?:category|tag|page|feed|wp-|author)/i.test(pageUrl.pathname)) continue;
    const title = cleanText(anchor, 200);
    if (!title || title.length < 3 || seen.has(pageUrl.href)) continue;
    seen.add(pageUrl.href);
    releases.push({ title, pageUrl: pageUrl.href, guid: pageUrl.href, publishedAt: null });
  }
  return releases.slice(0, 40);
}

function episodeFromTitle(title) {
  const explicit = String(title || '').match(/\b(?:episode|ep\.?|e)\s*0*(\d{1,4})\b/i);
  if (explicit) return Number(explicit[1]);
  return null;
}

function seriesFromTitle(title) {
  const withoutEpisode = String(title || '')
    .replace(/\s*[|\-–—]\s*(?:animexin|anime xin)\b.*$/i, '')
    .replace(/\s*\b(?:episode|ep\.?)\s*0*\d{1,4}\b.*$/i, '')
    .replace(/\s*\b(?:english|indonesia|indo|sub(?:title)?s?|hardsub|softsub)\b.*$/i, '')
    .replace(/[\s,·|\-–—]+$/g, ' ')
    .trim();
  return cleanText(withoutEpisode || title, 160);
}

function englishLabelAllowed(label) {
  if (!label) return false;
  if (NON_ENGLISH_LABEL.test(label)) return false;
  return ENGLISH_LABEL.test(label);
}

function playerEntry(rawUrl, label, baseUrl) {
  const candidate = rawUrl.startsWith('//') ? `https:${rawUrl}` : decodeHtml(rawUrl);
  const link = safeStreamingLink(candidate, { allowedHosts: ALLOWED_PLAYER_HOSTS });
  if (!link?.embedUrl || !link.watchUrl) return null;
  let host;
  try {
    host = new URL(link.embedUrl).hostname.toLowerCase();
  } catch {
    return null;
  }
  const provider = host === 'rumble.com' || host.endsWith('.rumble.com') ? 'Rumble' : 'Dailymotion';
  if (!ALLOWED_PLAYER_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return null;
  if (provider === 'Dailymotion' && !(host === 'dailymotion.com' || host.endsWith('.dailymotion.com') || host === 'dai.ly')) return null;
  const cleanLabel = cleanText(label || '', 80) || provider;
  return {
    provider,
    label: cleanLabel,
    episode: null,
    embedUrl: link.embedUrl,
    watchUrl: link.watchUrl,
  };
}

/**
 * Read the labelled server buttons the Animexin theme renders (`.player-option`,
 * `.server-option`, or `<option>` entries). Each entry pairs a display name with
 * its embed URL so non-English servers can be dropped by name.
 */
export function parseAnimexinServers(html, baseUrl) {
  if (typeof html !== 'string' || !html) return [];
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?\1>/gi, ' ');
  const servers = [];
  const containerPattern = /<([a-z][a-z0-9]*)\b([^>]*(?:class\s*=\s*["'][^"']*\b(?:player-option|server-option|server-item|player-item|mirror-option)\b[^"']*["']|data-(?:src|video|embed)\s*=)[^>]*)>([\s\S]*?)<\/\1>/gi;
  let match;
  while ((match = containerPattern.exec(markup))) {
    const openingTag = `<${match[1]}${match[2]}>`;
    const url = attribute(openingTag, 'data-src')
      || attribute(openingTag, 'data-video')
      || attribute(openingTag, 'data-embed')
      || attribute(openingTag, 'data-url')
      || attribute(openingTag, 'value');
    if (!/^https?:\/\//i.test(url) && !url.startsWith('//')) continue;
    const name = attribute(openingTag, 'data-name')
      || attribute(openingTag, 'data-server')
      || attribute(openingTag, 'title')
      || cleanText(match[3], 80);
    if (!name) continue;
    servers.push({ name: cleanText(name, 80), url });
  }

  const optionPattern = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  while ((match = optionPattern.exec(markup))) {
    const openingTag = `<option${match[1]}>`;
    const url = attribute(openingTag, 'data-src')
      || attribute(openingTag, 'data-video')
      || attribute(openingTag, 'data-embed')
      || attribute(openingTag, 'value');
    if (!/^https?:\/\//i.test(url) && !url.startsWith('//')) continue;
    const name = attribute(openingTag, 'data-name') || cleanText(match[2], 80);
    if (!name) continue;
    servers.push({ name: cleanText(name, 80), url });
  }
  return servers;
}

function rawEmbedUrls(html) {
  if (typeof html !== 'string' || !html) return [];
  const normalized = decodeHtml(html)
    .replace(/\\u003a/gi, ':')
    .replace(/\\u002f/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/%3a/gi, ':')
    .replace(/%2f/gi, '/')
    .replace(/%3f/gi, '?')
    .replace(/%26/gi, '&')
    .replace(/%3d/gi, '=');
  const matches = normalized.match(/(?:https?:)?\/\/(?:[a-z0-9-]+\.)?(?:dailymotion\.com|dai\.ly|rumble\.com)(?::\d+)?\/[^\s"'<>]+/gi) || [];
  return [...new Set(matches.map((value) => value.replace(/[),.;\]}]+$/g, '')).filter(Boolean))];
}

function releaseThumbnail(html, baseUrl) {
  for (const tag of String(html || '').match(/<meta\b[^>]*>/gi) || []) {
    const key = (attribute(tag, 'property') || attribute(tag, 'name')).toLowerCase();
    if (['og:image', 'twitter:image'].includes(key)) {
      const image = safeImageUrl(attribute(tag, 'content'), baseUrl);
      if (image) return image;
    }
  }
  const images = String(html || '').match(/<img\b[^>]*>/gi) || [];
  for (const image of images) {
    const candidate = attribute(image, 'data-src') || attribute(image, 'data-lazy-src') || attribute(image, 'src');
    const safe = safeImageUrl(candidate, baseUrl);
    if (safe) return safe;
  }
  return null;
}

function releaseDownloadLinks(html) {
  const links = [];
  const seen = new Set();
  const anchors = String(html || '').match(/<a\b[^>]*>[\s\S]*?<\/a>/gi) || [];
  for (const anchor of anchors) {
    const href = attribute(anchor, 'href');
    const safe = safeMediaFireUrl(href);
    if (!safe || seen.has(safe)) continue;
    seen.add(safe);
    links.push({ provider: 'MediaFire', label: cleanText(anchor, 80) || 'MediaFire download', url: safe });
    if (links.length >= 3) break;
  }
  return links;
}

/**
 * Parse one Animexin release page. Only English-labelled Dailymotion and Rumble
 * servers become playable entries; every other provider (Odysee, Ok.ru, Dtube,
 * Mega, Dood, …) is dropped, as are Indonesian and other non-English variants.
 */
export function parseAnimexinRelease(html, pageUrl) {
  const baseUrl = new URL(pageUrl).origin;
  const titleTag = String(html || '').match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  const metaTitle = (String(html || '').match(/<meta\b[^>]*>/gi) || [])
    .map((tag) => tag)
    .find((tag) => ['og:title', 'twitter:title'].includes((attribute(tag, 'property') || attribute(tag, 'name')).toLowerCase()));
  const rawTitle = cleanText(titleTag?.[1], 200) || cleanText(metaTitle ? attribute(metaTitle, 'content') : '', 200);
  const episode = episodeFromTitle(rawTitle);

  const players = [];
  const seen = new Set();
  const push = (entry) => {
    if (!entry || seen.has(entry.embedUrl) || players.length >= maxPlayersPerRelease) return;
    seen.add(entry.embedUrl);
    players.push({ ...entry, episode });
  };

  const servers = parseAnimexinServers(html, baseUrl);
  for (const server of servers) {
    if (!englishLabelAllowed(server.name)) continue;
    push(playerEntry(server.url, server.name, baseUrl));
  }
  if (!servers.length) {
    // A page without labelled servers cannot prove a language, so only the raw
    // approved provider embeds are used and labelled by provider.
    for (const url of rawEmbedUrls(html)) {
      push(playerEntry(url, '', baseUrl));
    }
  }

  return {
    title: rawTitle || seriesFromTitle(pageUrl),
    series: seriesFromTitle(rawTitle) || seriesFromTitle(pageUrl),
    episode,
    thumbnailUrl: releaseThumbnail(html, baseUrl),
    players,
    downloads: releaseDownloadLinks(html),
    serverCount: servers.length || rawEmbedUrls(html).length,
  };
}

function releaseId(pageUrl) {
  try {
    const path = new URL(pageUrl).pathname.replace(/^\/+|\/+$/g, '');
    return path ? path.slice(0, 120) : 'release';
  } catch {
    return 'release';
  }
}

async function loadLatestReleases({ config, fetchImpl, limit }) {
  const baseUrl = config.animexinBaseUrl;
  const feedUrl = new URL('/feed/', baseUrl).href;

  let listed = [];
  let source = 'feed';
  try {
    const feedXml = await fetchAnimexinText(feedUrl, fetchImpl, 'application/rss+xml, application/xml, text/xml');
    if (feedXml) listed = parseAnimexinFeed(feedXml, baseUrl);
  } catch {
    listed = [];
  }
  if (!listed.length) {
    source = 'homepage';
    try {
      const homeHtml = await fetchAnimexinText(new URL('/', baseUrl).href, fetchImpl, 'text/html');
      if (homeHtml) listed = parseAnimexinHomepage(homeHtml, baseUrl);
    } catch {
      listed = [];
    }
  }

  const selected = listed.slice(0, limit);
  const pages = await Promise.all(selected.map(async (entry) => {
    try {
      const html = await fetchAnimexinText(entry.pageUrl, fetchImpl, 'text/html');
      if (!html) return { ...entry, players: [], downloads: [], thumbnailUrl: null, episode: episodeFromTitle(entry.title), series: seriesFromTitle(entry.title) };
      const parsed = parseAnimexinRelease(html, entry.pageUrl);
      return {
        ...entry,
        title: parsed.title || entry.title,
        series: parsed.series || seriesFromTitle(entry.title),
        episode: parsed.episode ?? episodeFromTitle(entry.title),
        thumbnailUrl: parsed.thumbnailUrl,
        players: parsed.players,
        downloads: parsed.downloads,
      };
    } catch {
      return {
        ...entry,
        series: seriesFromTitle(entry.title),
        episode: episodeFromTitle(entry.title),
        thumbnailUrl: null,
        players: [],
        downloads: [],
      };
    }
  }));

  const items = pages
    .filter((entry) => entry.players !== null)
    .map((entry) => ({
      id: releaseId(entry.pageUrl),
      title: entry.title,
      series: entry.series,
      episode: entry.episode,
      pageUrl: entry.pageUrl,
      thumbnailUrl: entry.thumbnailUrl,
      publishedAt: entry.publishedAt,
      players: entry.players,
      playerCount: entry.players.length,
      downloads: entry.downloads,
    }));

  return {
    enabled: true,
    source,
    fetchedAt: new Date().toISOString(),
    items,
    total: items.length,
    playable: items.filter((item) => item.playerCount > 0).length,
  };
}

/**
 * Cached latest Animexin release list for the public site. Concurrent callers
 * share one upstream pass, and a failed pass is cached briefly so a slow or
 * unreachable Animexin cannot stall every visitor request.
 */
export function createAnimexinReleaseFeed({ config, fetchImpl = fetch } = {}) {
  if (!config) throw new Error('The Animexin release feed requires configuration.');

  async function getLatest({ limit = 6 } = {}) {
    if (!config.animexinEnabled) {
      return { enabled: false, source: null, fetchedAt: new Date().toISOString(), items: [], total: 0, playable: 0 };
    }
    const cappedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 6, 12));
    const key = `${config.animexinBaseUrl}|${cappedLimit}`;
    const cached = cache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.promise ? cached.promise : cached.value;
    }
    const promise = loadLatestReleases({ config, fetchImpl, limit: cappedLimit })
      .catch(() => ({
        enabled: true,
        source: null,
        fetchedAt: new Date().toISOString(),
        items: [],
        total: 0,
        playable: 0,
      }))
      .then((value) => {
        cache.set(key, { value, expiresAt: Date.now() + (value.items.length ? releaseCacheTtlMs : releaseFailureTtlMs) });
        return value;
      });
    cache.set(key, { promise, expiresAt: now + requestTimeoutMs * 3 });
    if (cache.size > maxReleaseCacheEntries) {
      cache.delete(cache.keys().next().value);
    }
    return promise;
  }

  return { getLatest };
}

export function clearAnimexinReleaseCache() {
  cache.clear();
}
