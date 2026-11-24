import 'dotenv/config';
import { createApp } from './src/app.js';
import { createConfig } from './src/config.js';
import { createStore } from './src/database.js';
import { syncCatalogPosters } from './src/posters.js';
import { createAnimexinReleaseFeed } from './src/animexin-feed.js';
import { refreshAnimexinReleases } from './src/releases.js';
import { publishNewReleases, releasePublishReport } from './src/release-publisher.js';
import { registerAppTelegramCommands } from './src/telegram-bot.js';
import { launchTelegramBot } from './src/server/services/telegram-bot.js';
import { createPublisherConfig, createPublisherRepository } from './src/server/telegram-integration.js';

async function start() {
  const config = createConfig();
  const store = await createStore(config);

  // The publisher catalog holds every post created through the Telegram bot. It is
  // opened once and shared by the public site and the bot so a link the bot prints
  // resolves on the same host the visitor is already on.
  const publisherConfig = config.telegramBotToken ? createPublisherConfig(config) : null;
  let publisherRepository = null;
  if (publisherConfig) {
    try {
      publisherRepository = await createPublisherRepository(publisherConfig);
    } catch (error) {
      console.error('[catalog] Publisher catalog did not open:', error?.message || 'Unknown error');
      publisherRepository = null;
    }
  }

  const releaseFeed = createAnimexinReleaseFeed({ config });
  const app = createApp({ store, config, releaseFeed, catalogRepository: publisherRepository });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Anime Donghua listening on 0.0.0.0:${config.port} (${config.nodeEnv})`);
  });

  let bot = null;
  let releaseTimer = null;
  let initialReleaseRefresh = null;
  if (config.animexinEnabled) {
    // Keep the latest Animexin releases warm so a visitor request never waits on
    // an upstream scrape, and so a scheduled episode appears without a deploy.
    const refreshReleases = () => {
      void refreshAnimexinReleases({ store, feed: releaseFeed, limit: 6 })
        .then(async ({ refreshed }) => {
          if (refreshed) console.log(`Animexin releases refreshed (${refreshed}).`);
          // Mirror new episodes into the catalog so each one gets a Post ID, a
          // website page, and an announcement — no manual /donghua draft needed.
          if (!publisherRepository) return;
          const result = await publishNewReleases({
            store,
            repository: publisherRepository,
            bot,
            config: publisherConfig,
            limit: 6,
          });
          if (result.published.length) console.log(`Animexin episodes mirrored: ${result.published.length}.`);
        })
        .catch(() => console.error('Animexin release refresh did not complete.'));
    };
    // The first pass runs after the bot is up, so a brand-new episode can be
    // announced in the same run that mirrors it into the catalog.
    releaseTimer = setInterval(refreshReleases, config.animexinRefreshMinutes * 60 * 1000);
    releaseTimer.unref?.();
    initialReleaseRefresh = refreshReleases;
  }

  if (config.posterSyncEnabled) {
    void syncCatalogPosters({ store, config })
      .then((updated) => console.log(`Poster sync finished (${updated} artwork records updated).`))
      .catch(() => console.error('Poster sync did not complete.'));
  }

  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; shutting down.`);
    const forceExit = setTimeout(() => {
      console.error('Graceful shutdown timed out.');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    if (releaseTimer) clearInterval(releaseTimer);
    try { bot?.stop?.(signal); } catch {}
    try { await new Promise((resolve) => server.close(resolve)); } catch {}
    try { await publisherRepository?.close?.(); } catch {}
    try { await store.close(); } catch {}
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (config.telegramBotToken && publisherConfig) {
    if (!publisherRepository) publisherRepository = await createPublisherRepository(publisherConfig).catch(() => null);
    try {
      bot = await launchTelegramBot({
        config: publisherConfig,
        repository: publisherRepository,
        setupBot: (botInstance) => registerAppTelegramCommands(botInstance, {
          config,
          store,
          repository: publisherRepository,
          publisherConfig,
        }),
        onRestart: () => shutdown('TELEGRAM_RESTART'),
      });
    } catch (error) {
      // A bot that cannot start must not close the catalog the website is reading.
      console.error('[telegram] Publisher bot did not start:', error?.message || 'Unknown error');
    }
  }

  // First Animexin pass, now that the bot (and its announcement ability) exists.
  try {
    await initialReleaseRefresh?.();
  } catch {
    // The site still serves the stored release list if this pass fails.
  }
}

start().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
});
