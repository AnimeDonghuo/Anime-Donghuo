import { createAnimexinReleaseFeed } from './animexin-feed.js';
import { publishNewReleases } from './release-publisher.js';
import { canonicalContentUrl } from './server/services/telegram-bot.js';
import { mergeStreamingEntries } from './server/services/streaming-service.js';

const SCAN_LIMIT = 12;

/**
 * Force a full Animexin pass and reconcile every episode with the website.
 *
 * Manual posts often already exist for an episode (a publisher uploaded it by
 * hand), so a scan must attach the approved English players to that card rather
 * than publishing a second copy. Only an episode with no card anywhere becomes a
 * new post.
 */
export async function checkAnimexin({ config, store, repository, bot = null, fetchImpl = fetch, limit = SCAN_LIMIT } = {}) {
  if (!config?.animexinEnabled) {
    return { enabled: false, scanned: 0, published: [], updated: [], unmatched: [], playable: 0 };
  }
  const feed = createAnimexinReleaseFeed({ config, fetchImpl });
  const latest = await feed.getLatest({ limit });
  const saved = await store.saveAnimexinReleases(latest.items);
  const releases = await store.listAnimexinReleases(limit);

  const published = [];
  const updated = [];
  const unmatched = [];
  let playable = 0;

  for (const release of releases) {
    const players = (Array.isArray(release.players) ? release.players : [])
      .filter((player) => player?.embedUrl && ['Dailymotion', 'Rumble'].includes(player.provider));
    if (!players.length) {
      unmatched.push({ release, reason: 'no English Dailymotion or Rumble server on the Animexin page' });
      continue;
    }
    playable += 1;

    // 1. Already mirrored by a previous automated pass.
    let content = release.publishedAdminId && typeof repository.findContentByAdminId === 'function'
      ? await repository.findContentByAdminId(release.publishedAdminId).catch(() => null)
      : null;

    // 2. A manually published card for the same episode. Titles differ in the
    //    "English Sub" suffix and dashes, so compare normalized keys instead of
    //    exact strings; a series-level card is deliberately not reused.
    if (!content) {
      content = await findEpisodeCard(repository, release);
    }

    if (!content) {
      unmatched.push({ release, reason: 'needs a catalog card' });
      continue;
    }

    // Attach/refresh only the approved players on the existing card.
    const entries = players.map((player) => ({
      provider: player.provider,
      label: player.label || player.provider,
      server: `${player.provider} English`,
      embedUrl: player.embedUrl,
      watchUrl: player.watchUrl || player.embedUrl,
    }));
    try {
      const stream = mergeStreamingEntries(content.stream, entries, {
        allowedHosts: ['dailymotion.com', 'dai.ly', 'rumble.com'],
        granularity: 'exact',
      });
      const savedContent = typeof repository.updateContentStreamByAdminId === 'function'
        ? await repository.updateContentStreamByAdminId(content.adminId, stream)
        : null;
      if (savedContent && typeof store.markAnimexinReleasePublished === 'function') {
        await store.markAnimexinReleasePublished(release.id, {
          adminId: content.adminId,
          slug: content.slug,
        });
      }
      updated.push({
        releaseId: release.id,
        adminId: content.adminId,
        slug: savedContent?.slug || content.slug,
        players: entries.length,
        url: canonicalContentUrl(config, savedContent || content),
      });
    } catch (error) {
      unmatched.push({ release, reason: `could not attach players: ${error?.message || 'unknown error'}` });
    }
  }

  // 3. Anything with approved players and no card at all is published once.
  const publishable = unmatched.filter((entry) => entry.reason === 'needs a catalog card');
  let created = [];
  if (publishable.length) {
    const result = await publishNewReleases({ store, repository, bot, config, limit: publishable.length });
    created = result.published || [];
    const createdIds = new Set(created.map((entry) => entry.releaseId));
    for (let index = unmatched.length - 1; index >= 0; index -= 1) {
      if (createdIds.has(unmatched[index].release.id)) unmatched.splice(index, 1);
    }
  }

  return {
    enabled: true,
    scanned: releases.length,
    saved,
    playable,
    published: created,
    updated,
    unmatched: unmatched.map((entry) => ({
      id: entry.release.id,
      title: entry.release.title,
      episode: entry.release.episode,
      reason: entry.reason,
    })),
  };
}

/** Normalized title key: "Series Episode 12" with suffixes and punctuation removed. */
function titleKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\b(?:english|indonesia|indo|sub(?:title)?s?|hardsub|softsub)\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Alternative titles the same episode could already be stored under. */
export function releaseTitleCandidates(release) {
  const series = String(release?.series || '').trim();
  const episode = Number.isInteger(release?.episode) ? release.episode : null;
  const keys = new Set([titleKey(release?.title)]);
  if (series && episode !== null) {
    keys.add(titleKey(`${series} Episode ${episode}`));
    keys.add(titleKey(`${series} ${episode}`));
    keys.add(titleKey(`${series} Ep ${episode}`));
  }
  if (series) keys.add(titleKey(series));
  return [...keys].filter(Boolean);
}

async function findEpisodeCard(repository, release) {
  if (typeof repository.listContent !== 'function') return null;
  const keys = releaseTitleCandidates(release);
  if (!keys.length) return null;
  const search = String(release.series || release.title || '').trim();
  const matches = await repository
    .listContent({ query: search || undefined, limit: 50 })
    .catch(() => null);
  const rows = Array.isArray(matches) ? matches : matches?.items || [];
  const episode = Number.isInteger(release.episode) ? release.episode : null;
  for (const row of rows) {
    if (!row?.adminId) continue;
    const key = titleKey(row.title);
    if (!keys.includes(key)) continue;
    // Never attach an episode player to a different episode's card.
    if (episode !== null && row.title && /\bepisode\s*\d+/i.test(row.title) && !key.includes(`episode ${episode}`) && !key.endsWith(` ${episode}`)) {
      continue;
    }
    return row;
  }
  return null;
}

/** A Telegram-sized report of one /checkanimexin pass. */
export function checkAnimexinReport(result) {
  if (!result?.enabled) {
    return 'Animexin is disabled by ANIMEXIN_ENABLED=false. Nothing was checked.';
  }
  const lines = [
    `Animexin check finished: ${result.scanned} release${result.scanned === 1 ? '' : 's'} read, ${result.playable} with English players.`,
  ];
  if (result.published?.length) {
    lines.push('', `Published ${result.published.length} new post${result.published.length === 1 ? '' : 's'}:`);
    for (const entry of result.published) {
      lines.push(`• ${entry.adminId} — /donghua/${entry.slug}${entry.announced ? ` · ${entry.announced} announcement${entry.announced === 1 ? '' : 's'}` : ''}`);
    }
  }
  if (result.updated?.length) {
    lines.push('', `Updated ${result.updated.length} existing post${result.updated.length === 1 ? '' : 's'}:`);
    for (const entry of result.updated.slice(0, 8)) {
      lines.push(`• ${entry.adminId} — ${entry.players} English player${entry.players === 1 ? '' : 's'}${entry.url ? ` · ${entry.url}` : ''}`);
    }
  }
  if (result.unmatched?.length) {
    lines.push('', `Left alone (${result.unmatched.length}):`);
    for (const entry of result.unmatched.slice(0, 6)) {
      lines.push(`• ${entry.title || entry.id} — ${entry.reason}`);
    }
  }
  if (!result.published?.length && !result.updated?.length && !result.unmatched?.length) {
    lines.push('', 'Every cached release already matches the website.');
  }
  return lines.join('\n');
}
