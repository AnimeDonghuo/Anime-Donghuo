import 'dotenv/config';
import { createApp } from './src/app.js';
import { createConfig } from './src/config.js';
import { createStore } from './src/database.js';
import { syncCatalogPosters } from './src/posters.js';
import { registerAppTelegramCommands } from './src/telegram-bot.js';
import { launchTelegramBot } from './src/server/services/telegram-bot.js';
import { createPublisherConfig, createPublisherRepository } from './src/server/telegram-integration.js';

async function start() {
  const config = createConfig();
  const store = await createStore(config);
  const app = createApp({ store, config });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`Anime Donghua listening on 0.0.0.0:${config.port} (${config.nodeEnv})`);
  });

  if (config.posterSyncEnabled) {
    void syncCatalogPosters({ store, config })
      .then((updated) => console.log(`Poster sync finished (${updated} artwork records updated).`))
      .catch(() => console.error('Poster sync did not complete.'));
  }

  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  let bot = null;
  let publisherRepository = null;
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

    try { bot?.stop?.(signal); } catch {}
    try { await new Promise((resolve) => server.close(resolve)); } catch {}
    try { await publisherRepository?.close?.(); } catch {}
    try { await store.close(); } catch {}
    clearTimeout(forceExit);
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  if (config.telegramBotToken) {
    const publisherConfig = createPublisherConfig(config);
    try {
      publisherRepository = await createPublisherRepository(publisherConfig);
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
      console.error('[telegram] Publisher bot did not start:', error?.message || 'Unknown error');
      try { await publisherRepository?.close?.(); } catch {}
      publisherRepository = null;
    }
  }
}

start().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
});
