import { safeMediaFireUrl } from './catalog.js';
import { safeStreamingLink } from './server/services/streaming-service.js';

const publicPlayerLimit = 6;

function safePlayer(entry) {
  const supplied = typeof entry?.embedUrl === 'string' ? entry.embedUrl : entry?.watchUrl;
  const safe = safeStreamingLink(supplied, { allowedHosts: ['dailymotion.com', 'dai.ly', 'rumble.com'] });
  if (!safe?.embedUrl || !safe.watchUrl) return null;
  let embed;
  let watch;
  try {
    embed = new URL(safe.embedUrl);
    watch = new URL(safe.watchUrl);
  } catch {
    return null;
  }
  const providerFor = (host) => {
    if (host === 'dailymotion.com' || host.endsWith('.dailymotion.com') || host === 'dai.ly') return 'Dailymotion';
    if (host === 'rumble.com' || host.endsWith('.rumble.com')) return 'Rumble';
    return null;
  };
  const provider = providerFor(watch.hostname.toLowerCase());
  if (!provider || providerFor(embed.hostname.toLowerCase()) !== provider) return null;
  if (embed.protocol !== 'https:' || watch.protocol !== 'https:') return null;
  if (embed.username || embed.password || embed.port || watch.username || watch.password || watch.port) return null;
  return {
    provider,
    label: typeof entry?.label === 'string' && entry.label.trim()
      ? entry.label.trim().slice(0, 120)
      : provider,
    ...(Number.isInteger(entry?.episode) && entry.episode > 0 ? { episode: entry.episode } : {}),
    embedUrl: embed.href,
    watchUrl: watch.href,
  };
}

function publicDownloads(release) {
  const candidates = [
    ...(Array.isArray(release?.scrapedDownloads) ? release.scrapedDownloads : []),
    ...(Array.isArray(release?.addedDownloads) ? release.addedDownloads : []),
  ];
  const seen = new Set();
  const downloads = [];
  for (const entry of candidates) {
    const url = safeMediaFireUrl(entry?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    downloads.push({
      provider: 'MediaFire',
      label: typeof entry?.label === 'string' && entry.label.trim() ? entry.label.trim().slice(0, 120) : 'MediaFire download',
      url,
    });
    if (downloads.length >= 6) break;
  }
  return downloads;
}

function publicImage(value, config) {
  if (typeof value !== 'string' || value.length > 2048) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return undefined;
    const host = url.hostname.toLowerCase();
    const configured = new URL(config.animexinBaseUrl).hostname.toLowerCase();
    const allowed = ['animexin.dev', 'animexin.vip', 'animexin.xyz', 'animexin.top', 'animexinax.com', 'i.ibb.co',
      'i0.wp.com', 'i1.wp.com', 'i2.wp.com', 'i3.wp.com', 'wp.com', configured];
    return allowed.some((entry) => host === entry || host.endsWith(`.${entry}`)) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/** Public shape of a stored Animexin release: no scrape URLs, only approved embeds. */
export function publicRelease(release, config) {
  if (!release?.id) return null;
  const players = (Array.isArray(release.players) ? release.players : [])
    .map(safePlayer)
    .filter(Boolean)
    .slice(0, publicPlayerLimit);
  const thumbnailUrl = publicImage(release.thumbnailUrl, config);
  return {
    id: String(release.id),
    title: String(release.title || '').slice(0, 220),
    series: typeof release.series === 'string' ? release.series.slice(0, 200) : '',
    ...(Number.isInteger(release.episode) && release.episode > 0 ? { episode: release.episode } : {}),
    ...(typeof release.publishedAt === 'string' && Number.isFinite(Date.parse(release.publishedAt))
      ? { publishedAt: new Date(release.publishedAt).toISOString() }
      : {}),
    ...(thumbnailUrl ? { thumbnailUrl } : {}),
    players,
    playerCount: players.length,
    downloads: publicDownloads(release),
  };
}

/**
 * Refresh the Animexin release cache: keep everything scrapeable now, then read
 * the stored rows back so admin-added downloads are never dropped.
 */
export async function refreshAnimexinReleases({ store, feed, limit = 6 } = {}) {
  if (!store || !feed) return { refreshed: 0, stored: 0 };
  const latest = await feed.getLatest({ limit });
  if (!latest?.items?.length) return { refreshed: 0, stored: 0 };
  const saved = await store.saveAnimexinReleases(latest.items.map((item) => ({
    ...item,
    downloads: item.downloads,
  })));
  return { refreshed: saved, stored: latest.items.length };
}
