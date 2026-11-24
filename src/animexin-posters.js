import { hostPosterImage, preparePosterImage, posterHostingConfigured } from './server/services/poster-service.js';

/**
 * Artwork for one Animexin episode.
 *
 * The scraped page points at an Animexin/Jetpack CDN image, which changes per
 * episode and can be hotlink-blocked. Every post therefore gets its own copy on
 * ImgBB (the same host the publisher's own posters use), and the original URL is
 * only kept as the fallback when ImgBB is not configured or refuses the upload —
 * so a card never renders with a broken image.
 */
export async function resolveReleasePoster({ release, config, fetchImpl = fetch } = {}) {
  const sourceUrl = typeof release?.thumbnailUrl === 'string' ? release.thumbnailUrl : null;
  if (!sourceUrl && !posterHostingConfigured(config)) return { posterUrl: null, hosted: false, sourceUrl: null };

  if (!posterHostingConfigured(config)) {
    return { posterUrl: sourceUrl, hosted: false, sourceUrl };
  }

  const title = release?.series || release?.title || 'Animexin release';
  try {
    const image = await preparePosterImage({ sourceUrl, title, category: 'donghua', fetchImpl });
    const hosted = await hostPosterImage({ image, title, config, fetchImpl });
    if (hosted?.url) {
      return { posterUrl: hosted.url, hosted: true, sourceUrl: image?.sourceUrl || sourceUrl };
    }
  } catch (error) {
    // A full ImgBB quota must not stop an episode from publishing; the scraped
    // URL still renders, and the next /checkanimexin pass re-hosts it.
    if (sourceUrl) return { posterUrl: sourceUrl, hosted: false, sourceUrl, error: error?.message || 'poster upload failed' };
    return { posterUrl: null, hosted: false, sourceUrl: null, error: error?.message || 'poster upload failed' };
  }
  return { posterUrl: sourceUrl, hosted: false, sourceUrl };
}
