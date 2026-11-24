import 'dotenv/config';
import { createApp } from './src/app.js';
import { createConfig } from './src/config.js';
import { createStore } from './src/database.js';

async function start() {
  const config = createConfig();
  const store = await createStore(config);
  const app = createApp({ store, config });
  const server = app.listen(config.port, '0.0.0.0', () => {
    console.log(`AniVerse listening on 0.0.0.0:${config.port} (${config.nodeEnv})`);
  });

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
