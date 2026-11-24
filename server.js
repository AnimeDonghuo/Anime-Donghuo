import 'dotenv/config';
import { createApp } from './src/app.js';
import { createConfig } from './src/config.js';
import { createStore } from './src/database.js';
import { syncCatalogPosters } from './src/posters.js';
import { registerTelegramWebhook } from './src/telegram-bot.js';

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
  if (config.telegramBotToken && config.publicOrigin) {
    void registerTelegramWebhook(config)
      .then((registered) => console.log(registered ? 'Telegram webhook configured.' : 'Telegram webhook configuration failed.'));
  }

  server.requestTimeout = 20_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  let stopping = false;
  const shutdown = (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`Received ${signal}; shutting down.`);
    const forceExit = setTimeout(() => {
      console.error('Graceful shutdown timed out.');
      process.exit(1);
    }, 10_000);
    forceExit.unref();

    server.close(async () => {
      try {
        await store.close();
        clearTimeout(forceExit);
        process.exit(0);
      } catch {
        process.exit(1);
      }
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
});
