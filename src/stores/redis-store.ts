const IORedis = require('ioredis');
import type { Store, RedisConfig, Logger } from '../types/index.js';
import { createDefaultLogger } from '../utils/index.js';

export class RedisStore implements Store {
  private redis: any;
  private logger: Logger;
  private keyPrefix: string;
  private isConnected: boolean = false;
  private reconnectAttempts: number = 0;
  private maxReconnectAttempts: number = 10;

  constructor(config: RedisConfig, logger?: Logger) {
    this.logger = logger || createDefaultLogger();
    this.keyPrefix = config.keyPrefix || 'flow-control:';

    if (config.cluster) {
      this.redis = this.createClusterConnection(config);
    } else if (config.sentinel) {
      this.redis = this.createSentinelConnection(config);
    } else {
      this.redis = this.createStandaloneConnection(config);
    }

    this.setupEventHandlers();
  }

  private createStandaloneConnection(config: RedisConfig): any {
    return new IORedis({
      host: config.host || 'localhost',
      port: config.port || 6379,
      ...(config.password && { password: config.password }),
      db: config.db || 0,
      maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
      enableOfflineQueue: config.enableOfflineQueue !== false,
      lazyConnect: true,
    });
  }

  private createClusterConnection(config: RedisConfig): any {
    if (!config.cluster?.enabledNodes || config.cluster.enabledNodes.length === 0) {
      throw new Error('Redis cluster configuration requires enabledNodes');
    }

    return new IORedis.Cluster(config.cluster.enabledNodes, {
      enableReadyCheck: config.cluster.enableReadyCheck !== false,
      maxRedirections: config.cluster.maxRedirections || 16,
      redisOptions: {
        ...(config.password && { password: config.password }),
        maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
        lazyConnect: true,
      },
    });
  }

  private createSentinelConnection(config: RedisConfig): any {
    if (!config.sentinel?.sentinels || config.sentinel.sentinels.length === 0) {
      throw new Error('Redis sentinel configuration requires sentinels array');
    }

    return new IORedis({
      sentinels: config.sentinel.sentinels,
      name: config.sentinel.name,
      ...(config.password && { password: config.password }),
      ...(config.sentinel.password && { sentinelPassword: config.sentinel.password }),
      db: config.db || 0,
      maxRetriesPerRequest: config.maxRetriesPerRequest || 3,
      enableOfflineQueue: config.enableOfflineQueue !== false,
      lazyConnect: true,
    });
  }

  private setupEventHandlers(): void {
    this.redis.on('connect', () => {
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.logger.info('Redis store connected');
    });

    this.redis.on('ready', () => {
      this.logger.info('Redis store ready');
    });

    this.redis.on('error', (error: Error) => {
      this.isConnected = false;
      this.logger.error('Redis store error', error);
    });

    this.redis.on('close', () => {
      this.isConnected = false;
      this.logger.warn('Redis store connection closed');
    });

    this.redis.on('reconnecting', () => {
      this.reconnectAttempts++;
      this.logger.info(`Redis store reconnecting (attempt ${this.reconnectAttempts})`);

      if (this.reconnectAttempts >= this.maxReconnectAttempts) {
        this.logger.error('Redis store max reconnection attempts exceeded');
        this.redis.disconnect();
      }
    });
  }

  private getKey(key: string): string {
    return `${this.keyPrefix}${key}`;
  }

  async get(key: string): Promise<number | undefined> {
    try {
      if (!this.isConnected) {
        await this.redis.connect();
      }

      const value = await this.redis.get(this.getKey(key));
      return value ? parseInt(value, 10) : undefined;
    } catch (error) {
      this.logger.error('Redis get operation failed', { key, error });
      throw error;
    }
  }

  async set(key: string, value: number, ttl: number): Promise<void> {
    try {
      if (!this.isConnected) {
        await this.redis.connect();
      }

      const redisKey = this.getKey(key);
      if (ttl > 0) {
        await this.redis.setex(redisKey, Math.ceil(ttl / 1000), value.toString());
      } else {
        await this.redis.set(redisKey, value.toString());
      }
    } catch (error) {
      this.logger.error('Redis set operation failed', { key, value, ttl, error });
      throw error;
    }
  }

  async increment(key: string, ttl: number): Promise<number> {
    try {
      if (!this.isConnected) {
        await this.redis.connect();
      }

      const redisKey = this.getKey(key);

      // Use Lua script for atomic increment with TTL
      const luaScript = `
        local key = KEYS[1]
        local ttl = tonumber(ARGV[1])
        local current = redis.call('INCR', key)
        if current == 1 and ttl > 0 then
          redis.call('EXPIRE', key, ttl)
        end
        return current
      `;

      const result = await this.redis.eval(
        luaScript,
        1,
        redisKey,
        Math.ceil(ttl / 1000).toString()
      ) as number;

      return result;
    } catch (error) {
      this.logger.error('Redis increment operation failed', { key, ttl, error });
      throw error;
    }
  }

  async clear(): Promise<void> {
    try {
      if (!this.isConnected) {
        await this.redis.connect();
      }

      const pattern = `${this.keyPrefix}*`;

      if (this.redis.nodes) {
        // For cluster, we need to scan each master node
        const nodes = this.redis.nodes('master');
        await Promise.all(
          nodes.map(async (node: any) => {
            const keys = await node.keys(pattern);
            if (keys.length > 0) {
              await node.del(...keys);
            }
          })
        );
      } else {
        // For standalone and sentinel
        const keys = await this.redis.keys(pattern);
        if (keys.length > 0) {
          await this.redis.del(...keys);
        }
      }

      this.logger.info('Redis store cleared');
    } catch (error) {
      this.logger.error('Redis clear operation failed', { error });
      throw error;
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      if (!this.isConnected) {
        await this.redis.connect();
      }

      await this.redis.ping();
      return true;
    } catch (error) {
      this.logger.error('Redis health check failed', error);
      return false;
    }
  }

  async destroy(): Promise<void> {
    try {
      this.logger.info('Destroying Redis store');

      if (this.redis) {
        await this.redis.disconnect();
      }

      this.isConnected = false;
    } catch (error) {
      this.logger.error('Error destroying Redis store', error);
      throw error;
    }
  }

  getConnectionStatus(): { connected: boolean; attempts: number } {
    return {
      connected: this.isConnected,
      attempts: this.reconnectAttempts,
    };
  }

  async getStats(): Promise<{
    connected: boolean;
    reconnectAttempts: number;
    keyCount: number;
    memoryUsage: string | undefined;
  }> {
    try {
      const stats = {
        connected: this.isConnected,
        reconnectAttempts: this.reconnectAttempts,
        keyCount: 0,
        memoryUsage: undefined as string | undefined,
      };

      if (this.isConnected) {
        const pattern = `${this.keyPrefix}*`;

        if (this.redis.nodes) {
          // For cluster, count keys across all master nodes
          const nodes = this.redis.nodes('master');
          const keyCounts = await Promise.all(
            nodes.map(async (node: any) => {
              const keys = await node.keys(pattern);
              return keys.length;
            })
          );
          stats.keyCount = keyCounts.reduce((sum: number, count: number) => sum + count, 0);
        } else {
          const keys = await this.redis.keys(pattern);
          stats.keyCount = keys.length;

          // Get memory usage for standalone/sentinel
          const info = await this.redis.info('memory');
          const memoryMatch = info.match(/used_memory_human:(.+)/);
          if (memoryMatch && memoryMatch[1]) {
            stats.memoryUsage = memoryMatch[1].trim();
          }
        }
      }

      return stats;
    } catch (error) {
      this.logger.error('Failed to get Redis stats', error);
      throw error;
    }
  }
}