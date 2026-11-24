import { createAnimexinReleaseFeed } from './animexin-feed.js';
import { publishNewReleases } from './release-publisher.js';
import { canonicalContentUrl } from './server/services/telegram-bot.js';
import { mergeStreamingEntries } from './server/services/streaming-service.js';
import { resolveReleasePoster } from './animexin-posters.js';

// "Check all releases" has to mean the whole cached window, not just a page of it.
const SCAN_LIMIT = 24;

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
  const removed = [];
  let playable = 0;

  // A theme-menu card ("Genres", "Release Date") is not attached to any release, so
  // it can only be found by sweeping the catalogue. This is what clears the empty
  // cards an earlier homepage scan published.
  if (typeof repository.listContent === 'function' && typeof repository.deleteContentByAdminId === 'function') {
    let sweep = [];
    try {
      const rows = await repository.listContent({ limit: 100 });
      sweep = Array.isArray(rows) ? rows : (rows?.items || []);
    } catch {
      sweep = [];
    }
    for (const row of sweep) {
      if (!isJunkCard(row)) continue;
      const deleted = await repository.deleteContentByAdminId(row.adminId).catch(() => null);
      if (deleted) removed.push({ adminId: row.adminId, title: row.title });
    }
  }

  for (const release of releases) {
    const players = (Array.isArray(release.players) ? release.players : [])
      .filter((player) => player?.embedUrl && ['Dailymotion', 'Rumble'].includes(player.provider));
    if (!players.length) {
      // Say what was actually on the page, so the reason is actionable instead of
      // a guess: no servers found at all is a different problem from servers found
      // but all of them non-English.
      const serverCount = Number(release.serverCount) || 0;
      const reason = serverCount > 0
        ? `the page lists ${serverCount} server${serverCount === 1 ? '' : 's'} but none is an English Dailymotion or Rumble player`
        : 'no Dailymotion or Rumble player was found on the Animexin page';
      unmatched.push({ release, reason });
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

    // A card that is a theme menu ("Genres", "Release Date") — which an early
    // homepage scan could publish — is not an episode. Remove it instead of
    // attaching a player to it, so the shelves stop filling with empty cards.
    if (isJunkCard(content)) {
      if (typeof repository.deleteContentByAdminId === 'function') {
        const deleted = await repository.deleteContentByAdminId(content.adminId).catch(() => null);
        if (deleted) {
          removed.push({ adminId: content.adminId, title: content.title });
          if (typeof store.forgetAnimexinReleasePublication === 'function') {
            await store.forgetAnimexinReleasePublication(release.id).catch(() => {});
          }
          unmatched.push({ release, reason: 'removed a non-episode card; republishing it properly' });
          continue;
        }
      }
    }

    // A card with no artwork (or one still pointing at the scraped URL) gets the
    // mirrored ImgBB copy so the post page and the home shelves render an image.
    const needsArtwork = !content.posterUrl || !/^https:\/\/i\.ibb\.co\//.test(String(content.posterUrl));
    if (needsArtwork) {
      const poster = await resolveReleasePoster({ release, config, fetchImpl }).catch(() => null);
      if (poster?.posterUrl && typeof repository.updateContentByAdminId === 'function') {
        const patched = await repository.updateContentByAdminId(content.adminId, {
          posterUrl: poster.posterUrl,
          backdropUrl: poster.posterUrl,
        }).catch(() => null);
        if (patched) content = { ...content, posterUrl: poster.posterUrl, backdropUrl: poster.posterUrl };
      }
    }

    // Attach/refresh only the approved players on the existing card.
    const entries = players.map((player) => ({
      provider: player.provider,
      label: player.label || player.provider,
      server: `${player.provider} English`,
      embedUrl: player.embedUrl,
      watchUrl: player.watchUrl || player.embedUrl,
    }));
    // Only the episode this card is for. Sources attached for other episodes are
    // kept; a stale player for the same episode (an old Dailymotion upload) is
    // replaced instead of accumulating beside the new one.
    const sameEpisode = (entry) => !Number.isInteger(release.episode)
      || !entry?.episode?.start
      || Number(entry.episode.start) === release.episode;
    const keptEntries = (Array.isArray(content.stream?.entries) ? content.stream.entries : []).filter((entry) => {
      if (!sameEpisode(entry)) return true;
      if (!['Dailymotion', 'Rumble'].includes(entry?.provider)) return true;
      // A same-episode approved player is superseded by this fresh scrape.
      return false;
    });
    try {
      const stream = mergeStreamingEntries({ ...(content.stream || {}), entries: keptEntries }, entries, {
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
    const result = await publishNewReleases({ store, repository, bot, config, fetchImpl, limit: publishable.length });
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
    removed,
    unmatched: unmatched.map((entry) => ({
      id: entry.release.id,
      title: entry.release.title,
      episode: entry.release.episode,
      reason: entry.reason,
    })),
  };
}

/**
 * True for a card that is really a theme menu entry ("Genres", "Release Date")
 * rather than a release: no episode number anywhere and no files attached.
 */
export function isJunkCard(content) {
  const title = String(content?.title || '').trim();
  if (!title) return true;
  const hasEpisode = /\b(?:episode|ep\b|ep\.)\s*0*\d{1,4}/i.test(title) || Number.isInteger(content?.episodeCount) && content.episodeCount > 0;
  const hasFiles = Number(content?.filesCount) > 0 || (Array.isArray(content?.files) && content.files.length > 0);
  const hasPlayers = Array.isArray(content?.stream?.entries) && content.stream.entries.length > 0;
  if (hasEpisode || hasFiles || hasPlayers) return false;
  return /^(?:home|genres?|release date|release-date|schedule|anime list|anime-list|series list|ongoing|completed|movies?|dub|sub|search|about|contact|privacy|disclaimer|dmca|request|report|login|register|animexin list)\b/i.test(title);
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

function rowEpisode(row) {
  const title = String(row?.title || '');
  const explicit = title.match(/\b(?:episode|ep\.?|ep)\s*0*(\d{1,4})\b/i);
  if (explicit) return Number(explicit[1]);
  const groups = Array.isArray(row?.episodeGroups) ? row.episodeGroups : [];
  if (groups.length === 1 && Number.isInteger(Number(groups[0]?.start)) && Number(groups[0]?.start) === Number(groups[0]?.end)) {
    return Number(groups[0].start);
  }
  return null;
}

/** The series name with its season marker removed: "Swallowed Star Season 5" → "swallowed star". */
function seriesStem(value) {
  const stripped = String(value || '')
    .toLowerCase()
    .replace(/\bseason\s*\d+\b/g, ' ')
    .replace(/\bs\d+\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return stripped.split(' ').slice(0, 4).join(' ');
}

/**
 * Find the card that is this episode, if it already exists.
 *
 * Stores name the same episode differently — "Swallowed Star Season 5 Episode
 * 191", "Swallowed Star Episode 191 English Sub", "Swallowed Star 191" — so the
 * match is on series stem plus episode number rather than on an exact title.
 * A card for a different episode of the same series is never reused.
 */
async function findEpisodeCard(repository, release) {
  if (typeof repository.listContent !== 'function') return null;
  const episode = Number.isInteger(release?.episode) ? release.episode : null;
  const stem = seriesStem(release?.series || release?.title);
  const keys = new Set(releaseTitleCandidates(release));
  const search = String(release.series || release.title || '').trim();
  const matches = await repository
    .listContent({ query: search || undefined, limit: 50 })
    .catch(() => null);
  const rows = Array.isArray(matches) ? matches : matches?.items || [];

  for (const row of rows) {
    if (!row?.adminId) continue;
    const key = titleKey(row.title);
    // An exact title match is the strongest signal, then series+episode.
    if (keys.has(key)) return row;
    if (episode === null || !stem) continue;
    const rowLength = seriesStem(row.title);
    if (!rowLength || !(rowLength.startsWith(stem) || stem.startsWith(rowLength))) continue;
    if (rowEpisode(row) === episode) return row;
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
  if (result.removed?.length) {
    lines.push('', `Removed ${result.removed.length} non-episode card${result.removed.length === 1 ? '' : 's'}:`);
    for (const entry of result.removed.slice(0, 8)) lines.push(`• ${entry.adminId} — ${entry.title}`);
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
