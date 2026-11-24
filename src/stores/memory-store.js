import { randomUUID } from 'node:crypto';

function duplicateEmailError() {
  const error = new Error('Duplicate email lookup key.');
  error.code = 11000;
  return error;
}

export class MemoryStore {
  #users = new Map();
  #emailIndex = new Map();
  #titleMedia = new Map();
  #releases = new Map();

  async findUserByEmailLookup(emailLookup) {
    const id = this.#emailIndex.get(emailLookup);
    return id ? this.findUserById(id) : null;
  }

  async createUser(fields) {
    if (this.#emailIndex.has(fields.emailLookup)) throw duplicateEmailError();
    const user = {
      id: randomUUID(),
      emailLookup: fields.emailLookup,
      emailCiphertext: fields.emailCiphertext,
      displayNameCiphertext: fields.displayNameCiphertext,
      passwordHash: fields.passwordHash,
      tokenVersion: 0,
      favorites: [],
      createdAt: new Date(),
    };
    this.#users.set(user.id, user);
    this.#emailIndex.set(user.emailLookup, user.id);
    return { ...user, favorites: [...user.favorites] };
  }

  async findUserById(id) {
    const user = this.#users.get(String(id));
    return user ? { ...user, favorites: [...user.favorites] } : null;
  }

  async getFavorites(userId) {
    const user = this.#users.get(String(userId));
    return user ? [...user.favorites] : null;
  }

  async addFavorite(userId, titleId) {
    const user = this.#users.get(String(userId));
    if (!user) return null;
    if (!user.favorites.includes(titleId)) {
      user.favorites = [...user.favorites, titleId].slice(-100);
    }
    return [...user.favorites];
  }

  async removeFavorite(userId, titleId) {
    const user = this.#users.get(String(userId));
    if (!user) return null;
    user.favorites = user.favorites.filter((favoriteId) => favoriteId !== titleId);
    return [...user.favorites];
  }

  async invalidateSessions(userId, currentVersion) {
    const user = this.#users.get(String(userId));
    if (!user || user.tokenVersion !== currentVersion) return false;
    user.tokenVersion += 1;
    return true;
  }

  async getTitleMedia(titleIds) {
    const result = new Map();
    for (const titleId of titleIds) {
      const media = this.#titleMedia.get(String(titleId));
      if (media) result.set(String(titleId), { ...media });
    }
    return result;
  }

  async setTitleMedia(titleId, fields) {
    const key = String(titleId);
    const media = {
      ...(this.#titleMedia.get(key) || {}),
      ...fields,
      titleId: key,
      updatedAt: new Date(),
    };
    this.#titleMedia.set(key, media);
    return { ...media };
  }

  async listAnimexinReleases(limit = 12) {
    return [...this.#releases.values()]
      .sort((left, right) => String(right.publishedAt || '').localeCompare(String(left.publishedAt || '')))
      .slice(0, Math.max(1, Math.min(Number(limit) || 12, 40)))
      .map((release) => structuredClone(release));
  }

  async getAnimexinRelease(id) {
    const release = this.#releases.get(String(id));
    return release ? structuredClone(release) : null;
  }

  async saveAnimexinReleases(releases) {
    let saved = 0;
    for (const release of Array.isArray(releases) ? releases : []) {
      const id = String(release?.id || '').trim();
      if (!id) continue;
      const existing = this.#releases.get(id);
      // Admin-added downloads survive a refresh of the scraped release.
      this.#releases.set(id, {
        ...release,
        id,
        // Publication state belongs to the release row and must survive a refresh.
        publishedAdminId: existing?.publishedAdminId || release.publishedAdminId || null,
        publishedSlug: existing?.publishedSlug || release.publishedSlug || null,
        players: Array.isArray(release.players) ? release.players : [],
        scrapedDownloads: Array.isArray(release.downloads)
          ? release.downloads
          : (Array.isArray(release.scrapedDownloads) ? release.scrapedDownloads : []),
        addedDownloads: existing?.addedDownloads || [],
        updatedAt: new Date(),
      });
      saved += 1;
    }
    if (this.#releases.size > 120) {
      const keep = [...this.#releases.values()]
        .sort((left, right) => String(right.publishedAt || '').localeCompare(String(left.publishedAt || '')))
        .slice(0, 120);
      this.#releases = new Map(keep.map((release) => [release.id, release]));
    }
    return saved;
  }

  async markAnimexinReleasePublished(id, { adminId, slug } = {}) {
    const release = this.#releases.get(String(id));
    if (!release) return null;
    release.publishedAdminId = adminId || release.publishedAdminId || null;
    release.publishedSlug = slug || release.publishedSlug || null;
    release.publishedAt = release.publishedAt || null;
    release.updatedAt = new Date();
    return structuredClone(release);
  }

  async addAnimexinReleaseDownload(id, download) {
    const release = this.#releases.get(String(id));
    if (!release) return null;
    const addedDownloads = Array.isArray(release.addedDownloads) ? release.addedDownloads : [];
    if (addedDownloads.some((entry) => entry.url === download.url)) {
      return { release: structuredClone(release), added: false };
    }
    release.addedDownloads = [...addedDownloads, download].slice(-10);
    release.updatedAt = new Date();
    return { release: structuredClone(release), added: true };
  }

  isHealthy() {
    return true;
  }

  async close() {}
}
