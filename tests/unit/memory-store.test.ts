import { MemoryStore } from '../../src/rate-limiter/memory-store.js';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore(100); // 100ms cleanup interval for faster tests
  });

  afterEach(() => {
    store.destroy();
  });

  describe('get and set operations', () => {
    it('should store and retrieve values', async () => {
      await store.set('test-key', 42, 1000);
      const value = await store.get('test-key');
      expect(value).toBe(42);
    });

    it('should return undefined for non-existent keys', async () => {
      const value = await store.get('non-existent');
      expect(value).toBeUndefined();
    });

    it('should return undefined for expired keys', async () => {
      await store.set('test-key', 42, 50); // 50ms TTL

      // Wait for expiration
      await new Promise(resolve => setTimeout(resolve, 100));

      const value = await store.get('test-key');
      expect(value).toBeUndefined();
    });
  });

  describe('increment operation', () => {
    it('should increment non-existent keys starting from 1', async () => {
      const value = await store.increment('counter', 1000);
      expect(value).toBe(1);
    });

    it('should increment existing keys', async () => {
      await store.set('counter', 5, 1000);
      const value = await store.increment('counter', 1000);
      expect(value).toBe(6);
    });

    it('should handle multiple increments', async () => {
      let value = await store.increment('counter', 1000);
      expect(value).toBe(1);

      value = await store.increment('counter', 1000);
      expect(value).toBe(2);

      value = await store.increment('counter', 1000);
      expect(value).toBe(3);
    });
  });

  describe('clear operation', () => {
    it('should clear all stored values', async () => {
      await store.set('key1', 1, 1000);
      await store.set('key2', 2, 1000);

      expect(store.getSize()).toBe(2);

      await store.clear();

      expect(store.getSize()).toBe(0);
      expect(await store.get('key1')).toBeUndefined();
      expect(await store.get('key2')).toBeUndefined();
    });
  });

  describe('automatic cleanup', () => {
    it('should automatically clean up expired entries', async () => {
      await store.set('short-lived', 1, 50); // 50ms TTL
      await store.set('long-lived', 2, 5000); // 5s TTL

      expect(store.getSize()).toBe(2);

      // Wait for cleanup to run
      await new Promise(resolve => setTimeout(resolve, 200));

      expect(store.getSize()).toBe(1);
      expect(await store.get('short-lived')).toBeUndefined();
      expect(await store.get('long-lived')).toBe(2);
    });
  });

  describe('destroy', () => {
    it('should clean up resources', () => {
      const sizeBefore = store.getSize();
      store.destroy();
      expect(store.getSize()).toBe(0);
    });
  });
});