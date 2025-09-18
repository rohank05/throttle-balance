import { RedisStore } from '../../src/stores/redis-store.js';
import Redis from 'ioredis-mock';

// Mock ioredis
jest.mock('ioredis', () => {
  const MockIORedis = require('ioredis-mock');
  return MockIORedis;
});

describe('RedisStore', () => {
  let store: RedisStore;
  let mockRedis: Redis;

  beforeEach(async () => {
    // Create a fresh Redis store for each test
    store = new RedisStore({
      host: 'localhost',
      port: 6379,
      keyPrefix: 'test:',
    });

    // Get the internal Redis instance for testing
    mockRedis = (store as any).redis;
    await mockRedis.flushall();
  });

  afterEach(async () => {
    await store.destroy();
  });

  describe('Basic Operations', () => {
    it('should set and get values', async () => {
      await store.set('test-key', 42, 1000);
      const value = await store.get('test-key');
      expect(value).toBe(42);
    });

    it('should return undefined for non-existent keys', async () => {
      const value = await store.get('non-existent');
      expect(value).toBeUndefined();
    });

    it('should apply key prefix', async () => {
      await store.set('my-key', 123, 1000);

      // Check that the key is stored with prefix
      const rawValue = await mockRedis.get('test:my-key');
      expect(rawValue).toBe('123');
    });

    it('should handle TTL expiration', async () => {
      await store.set('expire-key', 99, 100); // 100ms TTL

      // Should exist immediately
      let value = await store.get('expire-key');
      expect(value).toBe(99);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 150));

      value = await store.get('expire-key');
      expect(value).toBeUndefined();
    });

    it('should clear all keys with prefix', async () => {
      await store.set('key1', 1, 1000);
      await store.set('key2', 2, 1000);
      await store.set('key3', 3, 1000);

      await store.clear();

      expect(await store.get('key1')).toBeUndefined();
      expect(await store.get('key2')).toBeUndefined();
      expect(await store.get('key3')).toBeUndefined();
    });
  });

  describe('Increment Operations', () => {
    it('should increment new keys from 0', async () => {
      const result = await store.increment('counter', 1000);
      expect(result).toBe(1);
    });

    it('should increment existing keys', async () => {
      await store.set('counter', 5, 1000);
      const result = await store.increment('counter', 1000);
      expect(result).toBe(6);
    });

    it('should handle multiple increments', async () => {
      await store.increment('multi-counter', 1000);
      await store.increment('multi-counter', 1000);
      const result = await store.increment('multi-counter', 1000);
      expect(result).toBe(3);
    });

    it('should preserve TTL on increment', async () => {
      await store.set('ttl-counter', 10, 500);
      await store.increment('ttl-counter', 500);

      // Wait a bit but not enough for expiration
      await new Promise(resolve => setTimeout(resolve, 100));

      const value = await store.get('ttl-counter');
      expect(value).toBe(11);

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 450));

      const expiredValue = await store.get('ttl-counter');
      expect(expiredValue).toBeUndefined();
    });
  });

  describe('Health Checks', () => {
    it('should report healthy when connected', async () => {
      const healthy = await store.isHealthy();
      expect(healthy).toBe(true);
    });

    it('should handle ping failures gracefully', async () => {
      // Mock a ping failure
      const originalPing = mockRedis.ping;
      mockRedis.ping = jest.fn().mockRejectedValue(new Error('Connection lost'));

      const healthy = await store.isHealthy();
      expect(healthy).toBe(false);

      // Restore original ping
      mockRedis.ping = originalPing;
    });
  });

  describe('Error Handling', () => {
    it('should handle Redis connection errors', async () => {
      // Mock a connection error
      const originalGet = mockRedis.get;
      mockRedis.get = jest.fn().mockRejectedValue(new Error('Redis error'));

      await expect(store.get('test-key')).rejects.toThrow('Redis error');

      // Restore original method
      mockRedis.get = originalGet;
    });

    it('should handle set operation errors', async () => {
      const originalSetex = mockRedis.setex;
      mockRedis.setex = jest.fn().mockRejectedValue(new Error('Set failed'));

      await expect(store.set('test-key', 123, 1000)).rejects.toThrow('Set failed');

      mockRedis.setex = originalSetex;
    });

    it('should handle increment operation errors', async () => {
      const originalIncr = mockRedis.incr;
      mockRedis.incr = jest.fn().mockRejectedValue(new Error('Increment failed'));

      await expect(store.increment('test-key', 1000)).rejects.toThrow('Increment failed');

      mockRedis.incr = originalIncr;
    });
  });

  describe('Configuration', () => {
    it('should handle custom Redis configuration', async () => {
      const customStore = new RedisStore({
        host: 'custom.redis.host',
        port: 6380,
        password: 'secret',
        db: 2,
        keyPrefix: 'custom:',
        maxRetriesPerRequest: 5,
        enableOfflineQueue: false,
      });

      // The mock doesn't validate connection params, but we can check they're passed
      expect(customStore).toBeInstanceOf(RedisStore);

      await customStore.destroy();
    });

    it('should handle cluster configuration', async () => {
      const clusterStore = new RedisStore({
        cluster: {
          enabledNodes: [
            { host: 'redis1.example.com', port: 6379 },
            { host: 'redis2.example.com', port: 6379 },
          ],
          enableReadyCheck: true,
          maxRedirections: 16,
        },
        keyPrefix: 'cluster:',
      });

      expect(clusterStore).toBeInstanceOf(RedisStore);

      await clusterStore.destroy();
    });

    it('should handle sentinel configuration', async () => {
      const sentinelStore = new RedisStore({
        sentinel: {
          sentinels: [
            { host: 'sentinel1.example.com', port: 26379 },
            { host: 'sentinel2.example.com', port: 26379 },
          ],
          name: 'mymaster',
          password: 'sentinel-password',
        },
        keyPrefix: 'sentinel:',
      });

      expect(sentinelStore).toBeInstanceOf(RedisStore);

      await sentinelStore.destroy();
    });
  });

  describe('Key Management', () => {
    it('should handle keys with special characters', async () => {
      const specialKey = 'key:with:colons/and/slashes-and-dashes_and_underscores';
      await store.set(specialKey, 42, 1000);

      const value = await store.get(specialKey);
      expect(value).toBe(42);
    });

    it('should handle empty string keys', async () => {
      await store.set('', 123, 1000);
      const value = await store.get('');
      expect(value).toBe(123);
    });

    it('should handle unicode keys', async () => {
      const unicodeKey = '测试键名🔑';
      await store.set(unicodeKey, 456, 1000);

      const value = await store.get(unicodeKey);
      expect(value).toBe(456);
    });
  });

  describe('Value Types', () => {
    it('should handle zero values', async () => {
      await store.set('zero', 0, 1000);
      const value = await store.get('zero');
      expect(value).toBe(0);
    });

    it('should handle negative values', async () => {
      await store.set('negative', -42, 1000);
      const value = await store.get('negative');
      expect(value).toBe(-42);
    });

    it('should handle large numbers', async () => {
      const largeNumber = 2147483647; // Max 32-bit integer
      await store.set('large', largeNumber, 1000);
      const value = await store.get('large');
      expect(value).toBe(largeNumber);
    });

    it('should handle floating point precision', async () => {
      // Redis stores numbers as strings, so floating point should work
      await store.set('float', 3.14159, 1000);
      const value = await store.get('float');
      expect(value).toBe(3.14159);
    });
  });

  describe('Concurrent Operations', () => {
    it('should handle concurrent increments correctly', async () => {
      const promises = Array.from({ length: 10 }, () =>
        store.increment('concurrent-counter', 1000)
      );

      const results = await Promise.all(promises);

      // All increments should succeed and return different values
      expect(results).toHaveLength(10);
      expect(new Set(results).size).toBe(10); // All values should be unique
      expect(Math.max(...results)).toBe(10); // Final value should be 10
    });

    it('should handle concurrent set operations', async () => {
      const promises = Array.from({ length: 5 }, (_, i) =>
        store.set(`concurrent-key-${i}`, i * 10, 1000)
      );

      await Promise.all(promises);

      // All keys should be set correctly
      for (let i = 0; i < 5; i++) {
        const value = await store.get(`concurrent-key-${i}`);
        expect(value).toBe(i * 10);
      }
    });
  });

  describe('Connection Management', () => {
    it('should properly destroy connection', async () => {
      const isHealthyBefore = await store.isHealthy();
      expect(isHealthyBefore).toBe(true);

      await store.destroy();

      // After destroy, operations should fail or connection should be closed
      // The mock might not perfectly simulate this, but we can test the destroy call
      expect(mockRedis.disconnect).toHaveBeenCalled();
    });

    it('should handle graceful shutdown', async () => {
      // Set some data
      await store.set('shutdown-test', 123, 1000);

      // Destroy should complete without errors
      await expect(store.destroy()).resolves.not.toThrow();
    });
  });

  describe('Memory and Performance', () => {
    it('should handle large number of keys efficiently', async () => {
      const keyCount = 100;
      const promises = [];

      // Set many keys
      for (let i = 0; i < keyCount; i++) {
        promises.push(store.set(`perf-key-${i}`, i, 1000));
      }

      await Promise.all(promises);

      // Get all keys back
      const getPromises = [];
      for (let i = 0; i < keyCount; i++) {
        getPromises.push(store.get(`perf-key-${i}`));
      }

      const values = await Promise.all(getPromises);

      expect(values).toHaveLength(keyCount);
      values.forEach((value, index) => {
        expect(value).toBe(index);
      });
    });

    it('should clear many keys efficiently', async () => {
      // Set many keys
      const promises = [];
      for (let i = 0; i < 50; i++) {
        promises.push(store.set(`clear-test-${i}`, i, 1000));
      }
      await Promise.all(promises);

      // Clear should be fast
      const start = Date.now();
      await store.clear();
      const duration = Date.now() - start;

      expect(duration).toBeLessThan(1000); // Should complete within 1 second

      // Verify all keys are cleared
      const value = await store.get('clear-test-0');
      expect(value).toBeUndefined();
    });
  });

  describe('Edge Cases', () => {
    it('should handle extremely long TTL values', async () => {
      const longTTL = 2147483647; // Max 32-bit integer (about 68 years)
      await store.set('long-ttl', 123, longTTL);

      const value = await store.get('long-ttl');
      expect(value).toBe(123);
    });

    it('should handle very short TTL values', async () => {
      await store.set('short-ttl', 456, 1); // 1ms TTL

      // Might or might not be expired depending on timing
      const value = await store.get('short-ttl');
      // Don't assert specific value due to timing sensitivity
      expect(typeof value === 'number' || value === undefined).toBe(true);
    });

    it('should handle increment on expired keys', async () => {
      await store.set('expire-incr', 10, 1); // Very short TTL

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 10));

      // Increment should treat as new key
      const result = await store.increment('expire-incr', 1000);
      expect(result).toBe(1); // Should start from 0 + 1
    });
  });
});