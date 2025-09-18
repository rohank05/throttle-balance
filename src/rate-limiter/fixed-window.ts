import type { Request, Response } from 'express';
import type {
  RateLimiterConfig,
  RequiredRateLimiterConfig,
  RateLimitResult,
  RateLimitInfo,
  Store,
  KeyGenerator,
  Logger,
} from '../types/index.js';
import { MemoryStore } from './memory-store.js';
import { StoreFactory } from '../stores/index.js';
import { createDefaultKeyGenerator, createDefaultLogger, getResetTime } from '../utils/index.js';

export class FixedWindowRateLimiter {
  private readonly config: RequiredRateLimiterConfig;
  private readonly store: Store;
  private readonly keyGenerator: KeyGenerator;
  private readonly logger: Logger;

  constructor(config: RateLimiterConfig, store?: Store, logger?: Logger) {
    this.config = this.createDefaultConfig(config);
    this.store = store || new MemoryStore();
    this.keyGenerator = config.keyGenerator || createDefaultKeyGenerator();
    this.logger = logger || createDefaultLogger();
  }

  static async create(config: RateLimiterConfig, logger?: Logger): Promise<FixedWindowRateLimiter> {
    const { store, usingFallback } = await StoreFactory.createStoreWithFallback(config, logger);

    if (usingFallback && config.store === 'redis') {
      logger?.warn('Using memory store fallback instead of Redis for rate limiting');
    }

    return new FixedWindowRateLimiter(config, store, logger);
  }

  async checkLimit(req: Request): Promise<RateLimitResult> {
    if (this.config.skip && this.config.skip(req)) {
      return this.createAllowedResult();
    }

    const key = this.generateKey(req);
    const windowStart = this.getWindowStart();
    const windowKey = `${key}:${windowStart}`;

    try {
      const currentCount = await this.store.increment(windowKey, this.config.windowMs);
      const resetTime = getResetTime(this.config.windowMs);

      const rateLimitInfo: RateLimitInfo = {
        limit: this.config.maxRequests,
        remaining: Math.max(0, this.config.maxRequests - currentCount),
        resetTime,
        windowMs: this.config.windowMs,
      };

      const allowed = currentCount <= this.config.maxRequests;

      this.logger.debug('Rate limit check', {
        key: windowKey,
        currentCount,
        limit: this.config.maxRequests,
        allowed,
      });

      return {
        allowed,
        info: rateLimitInfo,
      };
    } catch (error) {
      this.logger.error('Rate limiter error', error);
      return this.createAllowedResult();
    }
  }

  setHeaders(res: Response, rateLimitInfo: RateLimitInfo): void {
    if (!this.config.headers) {
      return;
    }

    res.set({
      'X-RateLimit-Limit': rateLimitInfo.limit.toString(),
      'X-RateLimit-Remaining': rateLimitInfo.remaining.toString(),
      'X-RateLimit-Reset': rateLimitInfo.resetTime.toString(),
      'X-RateLimit-Window': rateLimitInfo.windowMs.toString(),
    });
  }

  sendRateLimitResponse(res: Response, rateLimitInfo: RateLimitInfo): void {
    this.setHeaders(res, rateLimitInfo);
    res.status(this.config.statusCode).json({
      error: 'Rate limit exceeded',
      message: this.config.message,
      retryAfter: Math.ceil((rateLimitInfo.resetTime - Date.now()) / 1000),
    });
  }

  private generateKey(req: Request): string {
    return this.keyGenerator(req);
  }

  private getWindowStart(): number {
    return Math.floor(Date.now() / this.config.windowMs);
  }

  private createAllowedResult(): RateLimitResult {
    return {
      allowed: true,
      info: {
        limit: this.config.maxRequests,
        remaining: this.config.maxRequests,
        resetTime: getResetTime(this.config.windowMs),
        windowMs: this.config.windowMs,
      },
    };
  }

  private createDefaultConfig(config: RateLimiterConfig): RequiredRateLimiterConfig {
    const result: RequiredRateLimiterConfig = {
      windowMs: config.windowMs,
      maxRequests: config.maxRequests,
      keyGenerator: config.keyGenerator || createDefaultKeyGenerator(),
      skip: config.skip || (() => false),
      message: config.message || 'Too many requests, please try again later.',
      statusCode: config.statusCode || 429,
      headers: config.headers !== false,
      skipSuccessfulRequests: config.skipSuccessfulRequests || false,
      skipFailedRequests: config.skipFailedRequests || false,
      store: config.store || 'memory',
    };

    if (config.redis) {
      result.redis = config.redis;
    }

    return result;
  }

  async destroy(): Promise<void> {
    try {
      await this.store.destroy();
    } catch (error) {
      this.logger.error('Error destroying rate limiter store', error);
    }
  }
}