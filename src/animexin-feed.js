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
// "ID" is the two-letter Indonesian code Animexin uses in server names, and a
// bare "Rumble"/"Dailymotion" label names no language at all — both are handled
// around this pattern rather than by it.
const NON_ENGLISH_LABEL = /\b(?:indonesia|indonesian|indo|id|malay|melayu|hindi|tagalog|thai|vietnam|vietnamese|spanish|latino|portuguese|arabic|japanese|korean|chinese|mandarin)\b/i;
const ENGLISH_LABEL = /\benglish\b/i;

// An episode page title always carries an episode number; a nav link never does.
const EPISODE_TITLE = /\b(?:episode|ep\.?|episode-)\s*0*\d{1,4}\b|\bepisode\s*\d+\b/i;
// Wording that belongs to a theme menu, not a release.
const MENU_LABEL = /^(?:home|genres?|release date|release-date|schedule|anime list|anime-list|series list|ongoing|completed|movies?|dub|sub|search|about|contact|privacy|disclaimer|dmca|request|report|login|register|animexin list)\b/i;

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
  // i0.wp.com and the other Jetpack/WordPress CDNs are where Animexin's own
  // featured images actually live; excluding them is why posts arrived with no
  // poster at all.
  const allowedHosts = ['animexin.dev', 'animexin.vip', 'animexin.xyz', 'animexin.top', 'animexinax.com', 'i.ibb.co',
    'i0.wp.com', 'i1.wp.com', 'i2.wp.com', 'i3.wp.com', 'wp.com', 'gravatar.com', configuredHost];
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
    if (!pageUrl || pageUrl.pathname === '/' || /^\/(?:category|tag|page|feed|wp-|author|genre|release|schedule|list|movie|dub|type|year|status|search|login|register|dmca|about|contact|privacy|disclaimer|request|report|donate|bookmark|anime-list|series-list|ongoing|completed)/i.test(pageUrl.pathname)) continue;
    const title = cleanText(anchor, 200);
    if (!title || title.length < 3 || seen.has(pageUrl.href)) continue;
    // A menu link ("Genres", "Release Date") is not an episode. The first pass
    // used to publish those as posts with an empty genre list and no artwork.
    if (!EPISODE_TITLE.test(title) || MENU_LABEL.test(title)) continue;
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

  // Servers are not always buttons with a data-src: many themes render them as a
  // plain <a href> (sometimes with the provider name only, sometimes with the
  // label in the text). Those were invisible to this parser, which is why a page
  // could show Dailymotion only while Rumble sat right there in an anchor.
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((match = anchorPattern.exec(markup))) {
    const openingTag = `<a${match[1]}>`;
    const href = attribute(openingTag, 'href');
    if (!/^https?:\/\//i.test(href) && !href.startsWith('//')) continue;
    // Only provider links count; a nav anchor is not a server.
    if (!/(?:^|\/\/)(?:[a-z0-9-]+\.)?(?:dailymotion\.com|dai\.ly|rumble\.com)\//i.test(href)
      && !/(?:^|\/\/)(?:[a-z0-9-]+\.)?(?:dailymotion\.com|dai\.ly|rumble\.com)$/i.test(href)) continue;
    const name = attribute(openingTag, 'data-name')
      || attribute(openingTag, 'data-server')
      || attribute(openingTag, 'title')
      || cleanText(match[2], 80);
    if (!name) continue;
    servers.push({ name: cleanText(name, 80), url: href });
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
  // Language is decided per server, and a server that names no language inherits
  // the page's: Animexin labels its English releases "… English Sub", so a
  // Dailymotion/Rumble server listed there is English. Requiring the word
  // "English" in every label silently dropped the Rumble players that Animexin
  // names just "Rumble", which is why only Dailymotion ever appeared.
  const pageIsEnglish = !NON_ENGLISH_LABEL.test(rawTitle) && !NON_ENGLISH_LABEL.test(seriesFromTitle(rawTitle));
  for (const server of servers) {
    if (NON_ENGLISH_LABEL.test(server.name)) continue;
    if (!ENGLISH_LABEL.test(server.name) && !pageIsEnglish) continue;
    push(playerEntry(server.url, server.name, baseUrl));
  }
  {
    // Always look at the raw provider embeds too. A page can label one server in a
    // button and carry the other as a bare iframe; only fetching raw URLs when the
    // whole page had no labels is why Rumble went missing on mixed pages.
    //
    // The catch: a raw URL carries no label, so it carries no language. An
    // unlabelled Dailymotion URL on a page whose Dailymotion buttons include an
    // "Indonesia" one could be exactly that mirror, and it cannot be told apart.
    // So a raw URL is accepted only for a provider the theme never labelled: that
    // is the provider whose real servers were invisible to the button scan (the
    // Rumble link this was meant to recover). Providers that do have labelled
    // servers are already represented by those servers alone.
    const labelledProviders = new Set(
      servers.map((server) => playerEntry(server.url, '', baseUrl)?.provider).filter(Boolean)
    );
    for (const url of rawEmbedUrls(html)) {
      const entry = playerEntry(url, '', baseUrl);
      if (!entry) continue;
      if (labelledProviders.has(entry.provider)) continue;
      push(entry);
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
      if (!html) return { ...entry, players: [], downloads: [], serverCount: 0, thumbnailUrl: null, episode: episodeFromTitle(entry.title), series: seriesFromTitle(entry.title) };
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
        serverCount: 0,
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
      // How many server buttons the page advertised, so a later report can say
      // whether the page had no players or only non-English ones.
      serverCount: entry.serverCount || entry.players.length,
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
    const cappedLimit = Math.max(1, Math.min(Number.isInteger(limit) ? limit : 6, 24));
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
