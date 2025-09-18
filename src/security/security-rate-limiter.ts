import type { Request, Response, NextFunction } from 'express';
import type { Logger, Store } from '../types/index.js';
import { MemoryStore } from '../rate-limiter/memory-store.js';
import { createDefaultLogger } from '../utils/index.js';

export interface SecurityRateLimitConfig {
  windowMs?: number;
  maxAttempts?: number;
  blockDuration?: number;
  skipSuccessfulRequests?: boolean;
  skipFailedRequests?: boolean;
  keyGenerator?: (req: Request) => string;
  store?: Store;
  onLimitReached?: (req: Request, key: string) => void;
  onBlocked?: (req: Request, key: string, resetTime: number) => void;
}

export interface SecurityRateLimitInfo {
  totalHits: number;
  resetTime: number;
  remaining: number;
  blocked: boolean;
  blockUntil?: number;
}

export interface SecurityRateLimitResult {
  allowed: boolean;
  info: SecurityRateLimitInfo;
}

export class SecurityRateLimiter {
  private readonly config: {
    windowMs: number;
    maxAttempts: number;
    blockDuration: number;
    skipSuccessfulRequests: boolean;
    skipFailedRequests: boolean;
    keyGenerator: (req: Request) => string;
    store: Store;
    onLimitReached?: (req: Request, key: string) => void;
    onBlocked?: (req: Request, key: string, resetTime: number) => void;
  };
  private readonly logger: Logger;

  constructor(config: SecurityRateLimitConfig = {}, logger?: Logger) {
    this.config = {
      windowMs: config.windowMs || 15 * 60 * 1000, // 15 minutes
      maxAttempts: config.maxAttempts || 5,
      blockDuration: config.blockDuration || 60 * 60 * 1000, // 1 hour
      skipSuccessfulRequests: config.skipSuccessfulRequests ?? false,
      skipFailedRequests: config.skipFailedRequests ?? false,
      keyGenerator: config.keyGenerator || this.defaultKeyGenerator,
      store: config.store || new MemoryStore(),
    };

    if (config.onLimitReached) {
      this.config.onLimitReached = config.onLimitReached;
    }
    if (config.onBlocked) {
      this.config.onBlocked = config.onBlocked;
    }

    this.logger = logger || createDefaultLogger();
  }

  private defaultKeyGenerator(req: Request): string {
    return req.ip || req.socket.remoteAddress || 'unknown';
  }

  async checkLimit(req: Request): Promise<SecurityRateLimitResult> {
    const key = this.config.keyGenerator(req);
    const now = Date.now();

    // Check if IP is currently blocked
    const blockKey = `block:${key}`;
    const blockUntil = await this.config.store.get(blockKey);

    if (blockUntil && now < blockUntil) {
      this.logger.warn(`Request blocked for security rate limit: ${key}`, {
        key,
        blockUntil: new Date(blockUntil).toISOString(),
        remaining: Math.ceil((blockUntil - now) / 1000),
      });

      if (this.config.onBlocked) {
        this.config.onBlocked(req, key, blockUntil);
      }

      return {
        allowed: false,
        info: {
          totalHits: this.config.maxAttempts,
          resetTime: now + this.config.windowMs,
          remaining: 0,
          blocked: true,
          blockUntil,
        },
      };
    }

    // Get current attempt count
    const attemptKey = `attempts:${key}`;
    const currentAttempts = await this.config.store.get(attemptKey) || 0;
    const resetTime = now + this.config.windowMs;

    if (currentAttempts >= this.config.maxAttempts) {
      // Rate limit exceeded, block the IP
      const blockUntil = now + this.config.blockDuration;
      await this.config.store.set(blockKey, blockUntil, this.config.blockDuration);

      // Clear attempt counter
      await this.config.store.set(attemptKey, 0, this.config.windowMs);

      this.logger.warn(`Security rate limit exceeded, blocking IP: ${key}`, {
        key,
        attempts: currentAttempts,
        maxAttempts: this.config.maxAttempts,
        blockDuration: this.config.blockDuration,
        blockUntil: new Date(blockUntil).toISOString(),
      });

      if (this.config.onLimitReached) {
        this.config.onLimitReached(req, key);
      }

      return {
        allowed: false,
        info: {
          totalHits: currentAttempts,
          resetTime,
          remaining: 0,
          blocked: true,
          blockUntil,
        },
      };
    }

    // Increment attempt counter
    const newAttempts = await this.config.store.increment(attemptKey, this.config.windowMs);

    this.logger.debug(`Security rate limit check: ${key}`, {
      key,
      attempts: newAttempts,
      maxAttempts: this.config.maxAttempts,
      remaining: Math.max(0, this.config.maxAttempts - newAttempts),
    });

    return {
      allowed: true,
      info: {
        totalHits: newAttempts,
        resetTime,
        remaining: Math.max(0, this.config.maxAttempts - newAttempts),
        blocked: false,
      },
    };
  }

  async recordFailedAttempt(req: Request): Promise<void> {
    if (this.config.skipFailedRequests) return;

    const key = this.config.keyGenerator(req);
    const attemptKey = `attempts:${key}`;
    await this.config.store.increment(attemptKey, this.config.windowMs);

    this.logger.debug(`Recorded failed attempt for: ${key}`);
  }

  async recordSuccessfulAttempt(req: Request): Promise<void> {
    if (this.config.skipSuccessfulRequests) return;

    const key = this.config.keyGenerator(req);

    // Reset attempt counter on successful request
    const attemptKey = `attempts:${key}`;
    await this.config.store.set(attemptKey, 0, this.config.windowMs);

    this.logger.debug(`Reset attempt counter for successful request: ${key}`);
  }

  async unblockIP(key: string): Promise<boolean> {
    const blockKey = `block:${key}`;
    const attemptKey = `attempts:${key}`;

    try {
      // Remove block
      await this.config.store.set(blockKey, 0, 1);
      // Reset attempts
      await this.config.store.set(attemptKey, 0, 1);

      this.logger.info(`Manually unblocked IP: ${key}`);
      return true;
    } catch (error) {
      this.logger.error(`Failed to unblock IP: ${key}`, error);
      return false;
    }
  }

  async getIPStatus(key: string): Promise<{
    blocked: boolean;
    attempts: number;
    blockUntil?: number;
    resetTime: number;
  }> {
    const now = Date.now();
    const blockKey = `block:${key}`;
    const attemptKey = `attempts:${key}`;

    const [blockUntil, attempts] = await Promise.all([
      this.config.store.get(blockKey),
      this.config.store.get(attemptKey),
    ]);

    const blocked = blockUntil ? now < blockUntil : false;

    const result: {
      blocked: boolean;
      attempts: number;
      resetTime: number;
      blockUntil?: number;
    } = {
      blocked,
      attempts: attempts || 0,
      resetTime: now + this.config.windowMs,
    };

    if (blocked && blockUntil) {
      result.blockUntil = blockUntil;
    }

    return result;
  }

  getMiddleware() {
    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
      try {
        const result = await this.checkLimit(req);

        // Set rate limit headers
        res.set({
          'X-Security-RateLimit-Limit': this.config.maxAttempts.toString(),
          'X-Security-RateLimit-Remaining': result.info.remaining.toString(),
          'X-Security-RateLimit-Reset': result.info.resetTime.toString(),
        });

        if (result.info.blocked && result.info.blockUntil) {
          res.set({
            'X-Security-RateLimit-Blocked': 'true',
            'X-Security-RateLimit-Block-Until': result.info.blockUntil.toString(),
            'Retry-After': Math.ceil((result.info.blockUntil - Date.now()) / 1000).toString(),
          });
        }

        if (!result.allowed) {
          res.status(429).json({
            error: 'Too Many Requests',
            message: result.info.blocked
              ? 'Your IP has been temporarily blocked due to suspicious activity'
              : 'Rate limit exceeded',
            code: result.info.blocked ? 'IP_BLOCKED' : 'RATE_LIMIT_EXCEEDED',
            retryAfter: result.info.blockUntil
              ? Math.ceil((result.info.blockUntil - Date.now()) / 1000)
              : Math.ceil((result.info.resetTime - Date.now()) / 1000),
            timestamp: new Date().toISOString(),
          });
          return;
        }

        next();
      } catch (error) {
        this.logger.error('Security rate limiter middleware error', error);
        next(error);
      }
    };
  }

  async getStats(): Promise<{
    config: {
      windowMs: number;
      maxAttempts: number;
      blockDuration: number;
    };
    store: {
      healthy: boolean;
    };
  }> {
    const storeHealthy = await this.config.store.isHealthy();

    return {
      config: {
        windowMs: this.config.windowMs,
        maxAttempts: this.config.maxAttempts,
        blockDuration: this.config.blockDuration,
      },
      store: {
        healthy: storeHealthy,
      },
    };
  }

  async destroy(): Promise<void> {
    try {
      await this.config.store.destroy();
      this.logger.info('Security rate limiter destroyed');
    } catch (error) {
      this.logger.error('Error destroying security rate limiter', error);
    }
  }
}