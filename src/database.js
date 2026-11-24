import { MemoryStore } from './stores/memory-store.js';
import { MongoStore } from './stores/mongo-store.js';

export async function createStore(config) {
  if (!config.mongodbUri) {
    if (config.production) throw new Error('MongoDB is required when NODE_ENV=production.');
    return new MemoryStore();
  }
  return MongoStore.connect(config.mongodbUri);
}
