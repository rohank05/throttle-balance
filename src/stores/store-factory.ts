import type { Store, RateLimiterConfig, Logger } from '../types/index.js';
import { MemoryStore } from '../rate-limiter/memory-store.js';
import { RedisStore } from './redis-store.js';

export class StoreFactory {
  static async createStore(config: RateLimiterConfig, logger?: Logger): Promise<Store> {
    const storeType = config.store || 'memory';

    switch (storeType) {
      case 'memory':
        return new MemoryStore();

      case 'redis':
        if (!config.redis) {
          throw new Error('Redis configuration is required when using Redis store');
        }
        const redisStore = new RedisStore(config.redis, logger);

        // Test connection during creation
        try {
          const isHealthy = await redisStore.isHealthy();
          if (!isHealthy) {
            logger?.warn('Redis store is not healthy, falling back to memory store');
            return new MemoryStore();
          }
          return redisStore;
        } catch (error) {
          logger?.error('Failed to connect to Redis, falling back to memory store', error);
          await redisStore.destroy().catch(() => {});
          return new MemoryStore();
        }

      default:
        throw new Error(`Unsupported store type: ${storeType}`);
    }
  }

  static async createStoreWithFallback(
    config: RateLimiterConfig,
    logger?: Logger
  ): Promise<{ store: Store; usingFallback: boolean }> {
    try {
      const store = await StoreFactory.createStore(config, logger);

      // Check if we ended up with a fallback
      const usingFallback = config.store === 'redis' && store instanceof MemoryStore;

      return { store, usingFallback };
    } catch (error) {
      logger?.error('Store creation failed, using memory store as fallback', error);
      return { store: new MemoryStore(), usingFallback: true };
    }
  }
}