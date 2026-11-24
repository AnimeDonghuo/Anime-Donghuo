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

const titleMediaSchema = new mongoose.Schema({
  titleId: { type: String, required: true, unique: true, immutable: true, maxlength: 100 },
  imageUrl: { type: String, maxlength: 2048 },
  artworkSource: { type: String, maxlength: 40 },
  artworkUpdatedAt: { type: Date },
  artworkCheckedAt: { type: Date },
  downloadUrl: { type: String, maxlength: 2048 },
  downloadUpdatedAt: { type: Date },
}, {
  timestamps: true,
  versionKey: false,
  strict: 'throw',
  minimize: true,
});

const TitleMedia = mongoose.models.AnimeDonghuaTitleMedia || mongoose.model('AnimeDonghuaTitleMedia', titleMediaSchema);

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
      updatedAt: document.updatedAt,
    }]));
  }

  async setTitleMedia(titleId, fields) {
    const allowed = ['imageUrl', 'artworkSource', 'artworkUpdatedAt', 'artworkCheckedAt', 'downloadUrl', 'downloadUpdatedAt'];
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
      updatedAt: document.updatedAt,
    };
  }

  isHealthy() {
    return mongoose.connection.readyState === 1;
  }

  async close() {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
  }
}
