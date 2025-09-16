import type { Store } from '../types/index.js';

interface MemoryRecord {
  value: number;
  expireAt: number;
}

export class MemoryStore implements Store {
  private store: Map<string, MemoryRecord> = new Map();
  private cleanupInterval: NodeJS.Timeout;
  private readonly cleanupIntervalMs: number;

  constructor(cleanupIntervalMs: number = 60000) {
    this.cleanupIntervalMs = cleanupIntervalMs;
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, this.cleanupIntervalMs);
  }

  async get(key: string): Promise<number | undefined> {
    const record = this.store.get(key);

    if (!record) {
      return undefined;
    }

    if (Date.now() > record.expireAt) {
      this.store.delete(key);
      return undefined;
    }

    return record.value;
  }

  async set(key: string, value: number, ttl: number): Promise<void> {
    const expireAt = Date.now() + ttl;
    this.store.set(key, { value, expireAt });
  }

  async increment(key: string, ttl: number): Promise<number> {
    const current = await this.get(key);
    const newValue = (current || 0) + 1;
    await this.set(key, newValue, ttl);
    return newValue;
  }

  async clear(): Promise<void> {
    this.store.clear();
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, record] of this.store.entries()) {
      if (now > record.expireAt) {
        this.store.delete(key);
      }
    }
  }

  getSize(): number {
    return this.store.size;
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.clear();
  }
}