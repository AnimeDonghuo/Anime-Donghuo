import { createCatalogRepository, MemoryCatalogRepository } from './catalog.repository.js';
import { isKoyebAssignedHost, loadConfig as loadPublisherConfig } from './config.js';

function databaseNameFromUri(uri) {
  if (!uri) return null;
  try {
    const parsed = new URL(uri);
    const path = decodeURIComponent(parsed.pathname.replace(/^\/+/, '')).split('/')[0];
    return path || null;
  } catch {
    return null;
  }
}

/**
 * Translate this app's existing env/config contract to the publisher service's
 * config without changing the website's current storage or auth settings.
 */
export function createPublisherConfig(appConfig, env = process.env) {
  if (!appConfig) throw new Error('Publisher config requires the Anime Donghua app config.');
  const database = env.TELEGRAM_CATALOG_DB?.trim()
    || databaseNameFromUri(appConfig.mongodbUri)
    // Mongoose uses the MongoDB driver's `test` database when the URI has no path.
    || 'test';
  const config = loadPublisherConfig({ ...env, MONGODB_DB: database });

  // The site's own public origin wins over an auto-assigned platform host, so a
  // link the bot prints points at the domain the visitor actually uses.
  if (appConfig.publicOrigin && !isKoyebAssignedHost(appConfig.publicOrigin)) {
    config.siteUrl = appConfig.publicOrigin;
  } else if (appConfig.siteUrl && !isKoyebAssignedHost(appConfig.siteUrl)) {
    config.siteUrl = appConfig.siteUrl;
  }

  config.environment = appConfig.nodeEnv;
  config.port = appConfig.port;
  config.mongodbUri = appConfig.mongodbUri || '';
  config.mongodbDb = database;
  config.adminLoginCode = appConfig.telegramPublisherLoginCode || '';
  config.telegram.botToken = appConfig.telegramBotToken || '';
  config.telegram.adminIds = new Set(appConfig.telegramAdminIds || []);
  config.telegram.mode = 'polling';
  if (env.TELEGRAM_BOT_USERNAME?.trim()) {
    config.telegram.botUsername = env.TELEGRAM_BOT_USERNAME.trim().replace(/^@/, '');
  }
  return config;
}

export async function createPublisherRepository(config) {
  if (!config?.mongodbUri) {
    const repository = new MemoryCatalogRepository([]);
    await repository.init();
    return repository;
  }
  return createCatalogRepository(config);
}
