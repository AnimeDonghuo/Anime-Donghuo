import mongoose from 'mongoose';

const userSchema = new mongoose.Schema({
  emailLookup: { type: String, required: true, unique: true, select: false, immutable: true },
  emailCiphertext: { type: String, required: true, select: false },
  displayNameCiphertext: { type: String, required: true, select: false },
  passwordHash: { type: String, required: true, select: false },
  tokenVersion: { type: Number, default: 0, min: 0 },
  favorites: { type: [String], default: [] },
}, {
  timestamps: true,
  versionKey: false,
  strict: 'throw',
  minimize: true,
});

const User = mongoose.models.AnimeDonghuaUser || mongoose.model('AnimeDonghuaUser', userSchema);

const playerSchema = new mongoose.Schema({
  provider: { type: String, enum: ['Dailymotion', 'Rumble'], required: true, maxlength: 24 },
  label: { type: String, maxlength: 80 },
  embedUrl: { type: String, required: true, maxlength: 2048 },
  watchUrl: { type: String, required: true, maxlength: 2048 },
}, { _id: false, strict: 'throw' });

const titleMediaSchema = new mongoose.Schema({
  titleId: { type: String, required: true, unique: true, immutable: true, maxlength: 100 },
  imageUrl: { type: String, maxlength: 2048 },
  artworkSource: { type: String, maxlength: 40 },
  artworkUpdatedAt: { type: Date },
  artworkCheckedAt: { type: Date },
  downloadUrl: { type: String, maxlength: 2048 },
  downloadUpdatedAt: { type: Date },
  players: { type: [playerSchema], default: undefined },
  playerSource: { type: String, maxlength: 40 },
  playerUpdatedAt: { type: Date },
}, {
  timestamps: true,
  versionKey: false,
  strict: 'throw',
  minimize: true,
});

const TitleMedia = mongoose.models.AnimeDonghuaTitleMedia || mongoose.model('AnimeDonghuaTitleMedia', titleMediaSchema);

const releaseDownloadSchema = new mongoose.Schema({
  provider: { type: String, maxlength: 40, required: true },
  label: { type: String, maxlength: 120 },
  url: { type: String, maxlength: 2048, required: true },
}, { _id: false, strict: 'throw' });

const releasePlayerSchema = new mongoose.Schema({
  provider: { type: String, enum: ['Dailymotion', 'Rumble'], required: true },
  label: { type: String, maxlength: 120 },
  episode: { type: Number, min: 1, max: 99999 },
  embedUrl: { type: String, maxlength: 2048, required: true },
  watchUrl: { type: String, maxlength: 2048, required: true },
}, { _id: false, strict: 'throw' });

const animexinReleaseSchema = new mongoose.Schema({
  releaseId: { type: String, required: true, unique: true, immutable: true, maxlength: 140 },
  title: { type: String, maxlength: 220, required: true },
  series: { type: String, maxlength: 200 },
  episode: { type: Number, min: 1, max: 99999 },
  pageUrl: { type: String, maxlength: 2048, required: true },
  thumbnailUrl: { type: String, maxlength: 2048 },
  publishedAt: { type: String, maxlength: 40 },
  players: { type: [releasePlayerSchema], default: [] },
  scrapedDownloads: { type: [releaseDownloadSchema], default: [] },
  addedDownloads: { type: [releaseDownloadSchema], default: [] },
  // The Post ID of the catalog card this episode was mirrored into, so a later
  // refresh updates that card instead of publishing a second copy.
  publishedAdminId: { type: String, maxlength: 40 },
  publishedSlug: { type: String, maxlength: 140 },
}, {
  timestamps: true,
  versionKey: false,
  strict: 'throw',
  minimize: true,
});

const AnimexinRelease = mongoose.models.AnimeDonghuaAnimexinRelease
  || mongoose.model('AnimeDonghuaAnimexinRelease', animexinReleaseSchema);

function asRelease(document) {
  if (!document) return null;
  return {
    id: document.releaseId,
    title: document.title,
    series: document.series,
    episode: document.episode,
    pageUrl: document.pageUrl,
    thumbnailUrl: document.thumbnailUrl,
    publishedAt: document.publishedAt,
    players: document.players || [],
    scrapedDownloads: document.scrapedDownloads || [],
    addedDownloads: document.addedDownloads || [],
    publishedAdminId: document.publishedAdminId || null,
    publishedSlug: document.publishedSlug || null,
    updatedAt: document.updatedAt,
  };
}

function asUser(document) {
  if (!document) return null;
  return {
    id: document._id.toString(),
    emailLookup: document.emailLookup,
    emailCiphertext: document.emailCiphertext,
    displayNameCiphertext: document.displayNameCiphertext,
    passwordHash: document.passwordHash,
    tokenVersion: document.tokenVersion,
    favorites: [...(document.favorites || [])],
    createdAt: document.createdAt,
  };
}

export class MongoStore {
  static async connect(uri) {
    await mongoose.connect(uri, {
      maxPoolSize: 5,
      minPoolSize: 0,
      serverSelectionTimeoutMS: 10_000,
      socketTimeoutMS: 45_000,
      autoIndex: true,
      bufferCommands: false,
    });
    return new MongoStore();
  }

  async findUserByEmailLookup(emailLookup) {
    const user = await User.findOne({ emailLookup })
      .select('+emailLookup +emailCiphertext +displayNameCiphertext +passwordHash')
      .lean();
    return asUser(user);
  }

  async createUser(fields) {
    const user = await User.create(fields);
    return asUser(user);
  }

  async findUserById(id) {
    if (!mongoose.isValidObjectId(id)) return null;
    const user = await User.findById(id)
      .select('+emailLookup +emailCiphertext +displayNameCiphertext')
      .lean();
    return asUser(user);
  }

  async getFavorites(userId) {
    if (!mongoose.isValidObjectId(userId)) return null;
    const user = await User.findById(userId).select('favorites').lean();
    return user ? [...(user.favorites || [])] : null;
  }

  async addFavorite(userId, titleId) {
    if (!mongoose.isValidObjectId(userId)) return null;
    const current = await User.findById(userId).select('favorites').lean();
    if (!current) return null;
    const favorites = current.favorites || [];
    if (favorites.includes(titleId)) return [...favorites];
    if (favorites.length >= 100) {
      const error = new Error('Favorite limit reached.');
      error.code = 'FAVORITE_LIMIT';
      throw error;
    }

    await User.updateOne(
      {
        _id: userId,
        $expr: { $lt: [{ $size: { $ifNull: ['$favorites', []] } }, 100] },
      },
      { $addToSet: { favorites: titleId } },
    );
    return this.getFavorites(userId);
  }

  async removeFavorite(userId, titleId) {
    if (!mongoose.isValidObjectId(userId)) return null;
    const user = await User.findByIdAndUpdate(
      userId,
      { $pull: { favorites: titleId } },
      { new: true, projection: { favorites: 1 } },
    ).lean();
    return user ? [...(user.favorites || [])] : null;
  }

  async invalidateSessions(userId, currentVersion) {
    if (!mongoose.isValidObjectId(userId)) return false;
    const result = await User.updateOne(
      { _id: userId, tokenVersion: currentVersion },
      { $inc: { tokenVersion: 1 } },
    );
    return result.modifiedCount === 1;
  }

  async getTitleMedia(titleIds) {
    if (!Array.isArray(titleIds) || titleIds.length === 0) return new Map();
    const documents = await TitleMedia.find({ titleId: { $in: titleIds } }).lean();
    return new Map(documents.map((document) => [document.titleId, {
      titleId: document.titleId,
      imageUrl: document.imageUrl,
      artworkSource: document.artworkSource,
      artworkUpdatedAt: document.artworkUpdatedAt,
      artworkCheckedAt: document.artworkCheckedAt,
      downloadUrl: document.downloadUrl,
      downloadUpdatedAt: document.downloadUpdatedAt,
      players: document.players,
      playerSource: document.playerSource,
      playerUpdatedAt: document.playerUpdatedAt,
      updatedAt: document.updatedAt,
    }]));
  }

  async setTitleMedia(titleId, fields) {
    const allowed = ['imageUrl', 'artworkSource', 'artworkUpdatedAt', 'artworkCheckedAt', 'downloadUrl', 'downloadUpdatedAt', 'players', 'playerSource', 'playerUpdatedAt'];
    const set = Object.fromEntries(allowed
      .filter((key) => Object.hasOwn(fields, key) && fields[key] !== undefined)
      .map((key) => [key, fields[key]]));
    if (Object.keys(set).length === 0) return null;
    const document = await TitleMedia.findOneAndUpdate(
      { titleId: String(titleId) },
      { $set: set },
      { upsert: true, new: true, runValidators: true, setDefaultsOnInsert: true },
    ).lean();
    return {
      titleId: document.titleId,
      imageUrl: document.imageUrl,
      artworkSource: document.artworkSource,
      artworkUpdatedAt: document.artworkUpdatedAt,
      artworkCheckedAt: document.artworkCheckedAt,
      downloadUrl: document.downloadUrl,
      downloadUpdatedAt: document.downloadUpdatedAt,
      players: document.players,
      playerSource: document.playerSource,
      playerUpdatedAt: document.playerUpdatedAt,
      updatedAt: document.updatedAt,
    };
  }

  async listAnimexinReleases(limit = 12) {
    const documents = await AnimexinRelease.find({})
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(Math.max(1, Math.min(Number(limit) || 12, 40)))
      .lean();
    return documents.map(asRelease);
  }

  async getAnimexinRelease(id) {
    return asRelease(await AnimexinRelease.findOne({ releaseId: String(id) }).lean());
  }

  async saveAnimexinReleases(releases) {
    let saved = 0;
    for (const release of Array.isArray(releases) ? releases : []) {
      const releaseId = String(release?.id || '').trim();
      if (!releaseId) continue;
      await AnimexinRelease.updateOne(
        { releaseId },
        {
          $set: {
            title: release.title,
            series: release.series || null,
            episode: Number.isInteger(release.episode) ? release.episode : null,
            pageUrl: release.pageUrl,
            thumbnailUrl: release.thumbnailUrl || null,
            publishedAt: release.publishedAt || null,
            players: Array.isArray(release.players) ? release.players : [],
            scrapedDownloads: Array.isArray(release.downloads) ? release.downloads : [],
          },
          $setOnInsert: { addedDownloads: [] },
        },
        { upsert: true, runValidators: true },
      );
      saved += 1;
    }
    return saved;
  }

  async markAnimexinReleasePublished(id, { adminId, slug } = {}) {
    const document = await AnimexinRelease.findOneAndUpdate(
      { releaseId: String(id) },
      { $set: { publishedAdminId: adminId || null, publishedSlug: slug || null } },
      { new: true, runValidators: true },
    ).lean();
    return asRelease(document);
  }

  /** Forget a mirror that no longer exists on the site (a removed non-episode card). */
  async forgetAnimexinReleasePublication(id) {
    const document = await AnimexinRelease.findOneAndUpdate(
      { releaseId: String(id) },
      { $set: { publishedAdminId: null, publishedSlug: null } },
      { new: true, runValidators: true },
    ).lean();
    return asRelease(document);
  }

  async addAnimexinReleaseDownload(id, download) {
    const releaseId = String(id);
    const existing = await AnimexinRelease.findOne({ releaseId, 'addedDownloads.url': download.url }).lean();
    if (existing) return { release: asRelease(existing), added: false };
    const document = await AnimexinRelease.findOneAndUpdate(
      { releaseId },
      { $push: { addedDownloads: { $each: [download], $slice: -10 } } },
      { new: true, runValidators: true },
    ).lean();
    if (!document) return null;
    return { release: asRelease(document), added: true };
  }

  isHealthy() {
    return mongoose.connection.readyState === 1;
  }

  async close() {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
}
