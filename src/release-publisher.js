import { announcePublishedContent } from './server/services/telegram-bot.js';
import { getContentPageUrl } from './server/config.js';

const MAX_PER_RUN = 6;

function releaseSeries(release) {
  return String(release?.series || release?.title || '').trim().slice(0, 150);
}

function releaseTitle(release) {
  const series = releaseSeries(release) || 'Animexin release';
  if (Number.isInteger(release?.episode)) return `${series} Episode ${release.episode}`.slice(0, 180);
  return series.slice(0, 180);
}

/** Approved players only: English Dailymotion/Rumble, already validated upstream. */
function releaseStream(release) {
  const entries = (Array.isArray(release?.players) ? release.players : [])
    .filter((player) => player?.embedUrl && ['Dailymotion', 'Rumble'].includes(player.provider))
    .slice(0, 6)
    .map((player) => ({
      provider: player.provider,
      label: player.label || player.provider,
      server: `${player.provider} English`,
      ...(Number.isInteger(player.episode) ? { episode: { start: player.episode, end: player.episode } } : {}),
      embedUrl: player.embedUrl,
      watchUrl: player.watchUrl || player.embedUrl,
    }));
  if (!entries.length) return null;
  return { provider: entries[0].provider, entries, updatedAt: new Date().toISOString() };
}

/**
 * Mirror new Animexin episodes into the publisher catalog so each one has a real
 * Post ID, a website page, and (when announcement channels are configured) a
 * channel post. A release is published once: its Post ID is stored on the release
 * row, so a later refresh updates the same card instead of creating a duplicate.
 */
export async function publishNewReleases({ store, repository, bot = null, config, limit = MAX_PER_RUN } = {}) {
  if (!store || !repository || !config?.animexinEnabled) return { published: [], skipped: 0 };
  if (typeof repository.createContent !== 'function') return { published: [], skipped: 0 };

  const releases = await store.listAnimexinReleases(limit);
  const published = [];
  let skipped = 0;

  for (const release of releases) {
    const stream = releaseStream(release);
    if (!stream) {
      skipped += 1;
      continue;
    }
    const existingAdminId = release.publishedAdminId || null;
    let content = existingAdminId && typeof repository.findContentByAdminId === 'function'
      ? await repository.findContentByAdminId(existingAdminId).catch(() => null)
      : null;
    let created = false;

    if (!content) {
      const input = {
        title: releaseTitle(release),
        category: 'donghua',
        description: `${releaseSeries(release)} episode ${release.episode ?? ''}`.trim(),
        year: null,
        languages: ['Chinese'],
        subtitleLanguages: ['English'],
        genres: [],
        status: 'Ongoing',
        releaseLabel: Number.isInteger(release.episode) ? `Episode ${release.episode}` : 'Latest episode',
        posterUrl: release.thumbnailUrl || null,
        backdropUrl: release.thumbnailUrl || null,
        metadataProvider: 'animexin',
        stream,
        files: [],
        published: true,
      };
      try {
        content = await repository.createContent(input);
        created = true;
      } catch (error) {
        console.warn('[releases] could not publish', release.id, error?.message || error);
        skipped += 1;
        continue;
      }
      if (typeof store.markAnimexinReleasePublished === 'function') {
        await store.markAnimexinReleasePublished(release.id, {
          adminId: content.adminId,
          slug: content.slug,
        }).catch(() => {});
      }
    } else {
      // Keep the player list current on an already-published episode.
      if (typeof repository.updateContentStreamByAdminId === 'function') {
        await repository.updateContentStreamByAdminId(content.adminId, stream).catch(() => {});
      }
      if (Number.isInteger(release.episode) && typeof repository.updateContentByAdminId === 'function') {
        await repository.updateContentByAdminId(content.adminId, {
          releaseLabel: `Episode ${release.episode}`,
        }).catch(() => {});
      }
    }

    const websiteUrl = getContentPageUrl(config, content);
    let announcements = null;
    if (created && bot?.telegram) {
      try {
        const channels = typeof repository.listAnnouncementChannels === 'function'
          ? await repository.listAnnouncementChannels()
          : [];
        if (channels.length) {
          announcements = await announcePublishedContent({ bot, repository, content, websiteUrl });
          if (announcements.posts?.length && typeof repository.updateContentByAdminId === 'function') {
            await repository.updateContentByAdminId(content.adminId, { announcementRefs: announcements.posts }).catch(() => {});
          }
        }
      } catch (error) {
        console.warn('[releases] announcement failed:', error?.message || error);
      }
    }

    published.push({
      releaseId: release.id,
      created,
      adminId: content.adminId,
      slug: content.slug,
      websiteUrl,
      announced: announcements?.sent || 0,
    });
  }

  return { published, skipped };
}

/** Report new posts to the publisher, including the Post ID they can reuse. */
export function releasePublishReport(result) {
  if (!result?.published?.length) return null;
  const lines = result.published.map((entry) => {
    const parts = [`${entry.created ? 'Published' : 'Updated'} ${entry.adminId}`];
    if (entry.slug) parts.push(`/${entry.slug}`);
    if (entry.announced) parts.push(`${entry.announced} announcement${entry.announced === 1 ? '' : 's'}`);
    return `• ${parts.join(' · ')}`;
  });
  return ['New Animexin episodes added to the site:', ...lines].join('\n');
}
