import { SecurityRateLimiter } from '../../src/security/security-rate-limiter.js';
import { MemoryStore } from '../../src/rate-limiter/memory-store.js';
import type { Request, Response } from 'express';

// Mock request and response objects
const mockRequest = (ip: string = '192.168.1.1'): Partial<Request> => ({
  ip,
  socket: { remoteAddress: ip } as any,
  headers: { 'user-agent': 'test-client' },
  method: 'POST',
  path: '/login',
});

const mockResponse = (): Partial<Response> => {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
  };
  return res;
};

describe('SecurityRateLimiter', () => {
  let store: MemoryStore;

  beforeEach(async () => {
    store = new MemoryStore();
  });

  afterEach(async () => {
    await store.clear();
  });

  describe('Basic Rate Limiting', () => {
    it('should allow requests within limit', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 3,
        windowMs: 60000,
        store,
      });

      const req = mockRequest() as Request;

      // First attempt should be allowed
      const result1 = await limiter.checkLimit(req);
      expect(result1.allowed).toBe(true);
      expect(result1.info.remaining).toBe(2);

      // Second attempt should be allowed
      const result2 = await limiter.checkLimit(req);
      expect(result2.allowed).toBe(true);
      expect(result2.info.remaining).toBe(1);

      // Third attempt should be allowed
      const result3 = await limiter.checkLimit(req);
      expect(result3.allowed).toBe(true);
      expect(result3.info.remaining).toBe(0);
    });

    it('should block requests when limit exceeded', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 2,
        windowMs: 60000,
        blockDuration: 30000,
        store,
      });

      const req = mockRequest() as Request;

      // Use up the allowed attempts
      await limiter.checkLimit(req);
      await limiter.checkLimit(req);

      // Next attempt should trigger blocking
      const result = await limiter.checkLimit(req);
      expect(result.allowed).toBe(false);
      expect(result.info.blocked).toBe(true);
      expect(result.info.blockUntil).toBeDefined();
      expect(result.info.blockUntil! > Date.now()).toBe(true);
    });

    it('should maintain separate counters for different IPs', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 2,
        windowMs: 60000,
        store,
      });

      const req1 = mockRequest('192.168.1.1') as Request;
      const req2 = mockRequest('192.168.1.2') as Request;

      // Use up attempts for first IP
      await limiter.checkLimit(req1);
      await limiter.checkLimit(req1);

      // Block first IP
      const blocked = await limiter.checkLimit(req1);
      expect(blocked.allowed).toBe(false);

      // Second IP should still be allowed
      const allowed = await limiter.checkLimit(req2);
      expect(allowed.allowed).toBe(true);
    });
  });

  describe('Blocking Behavior', () => {
    it('should enforce block duration', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 1,
        windowMs: 60000,
        blockDuration: 100, // 100ms for quick test
        store,
      });

      const req = mockRequest() as Request;

      // Trigger block
      await limiter.checkLimit(req);
      const blocked = await limiter.checkLimit(req);
      expect(blocked.allowed).toBe(false);

      // Should still be blocked immediately
      const stillBlocked = await limiter.checkLimit(req);
      expect(stillBlocked.allowed).toBe(false);

      // Wait for block to expire
      await new Promise(resolve => setTimeout(resolve, 150));

      // Should be allowed again after block expires
      const afterBlock = await limiter.checkLimit(req);
      expect(afterBlock.allowed).toBe(true);
    });

    it('should handle custom key generator', async () => {
      const customKeyGen = jest.fn((req: Request) => `user-${req.headers['user-id']}`);

      const limiter = new SecurityRateLimiter({
        maxAttempts: 1,
        keyGenerator: customKeyGen,
        store,
      });

      const req = mockRequest() as Request;
      req.headers = { 'user-id': 'user123' };

      await limiter.checkLimit(req);
      expect(customKeyGen).toHaveBeenCalledWith(req);
    });
  });

  describe('Failed and Successful Attempts', () => {
    it('should record failed attempts', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 3,
        windowMs: 60000,
        store,
      });

      const req = mockRequest() as Request;

      await limiter.recordFailedAttempt(req);

      const result = await limiter.checkLimit(req);
      expect(result.info.totalHits).toBe(2); // 1 from recordFailedAttempt + 1 from checkLimit
    });

    it('should reset attempts on successful request', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 3,
        windowMs: 60000,
        store,
      });

      const req = mockRequest() as Request;

      // Build up attempts
      await limiter.checkLimit(req);
      await limiter.checkLimit(req);

      // Record successful attempt
      await limiter.recordSuccessfulAttempt(req);

      // Next check should show reset counter
      const result = await limiter.checkLimit(req);
      expect(result.info.totalHits).toBe(1); // Counter was reset
    });

    it('should skip failed requests when configured', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 3,
        skipFailedRequests: true,
        store,
      });

      const req = mockRequest() as Request;

      await limiter.recordFailedAttempt(req);

      const result = await limiter.checkLimit(req);
      expect(result.info.totalHits).toBe(1); // Only checkLimit counted
    });

    it('should skip successful requests when configured', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 3,
        skipSuccessfulRequests: true,
        store,
      });

      const req = mockRequest() as Request;

      await limiter.recordSuccessfulAttempt(req);

      const result = await limiter.checkLimit(req);
      expect(result.info.totalHits).toBe(1); // recordSuccessfulAttempt was skipped
    });
  });

  describe('IP Management', () => {
    it('should manually unblock IP', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 1,
        blockDuration: 60000,
        store,
      });

      const req = mockRequest() as Request;
      const ip = '192.168.1.1';

      // Block the IP
      await limiter.checkLimit(req);
      const blocked = await limiter.checkLimit(req);
      expect(blocked.allowed).toBe(false);

      // Manually unblock
      const unblocked = await limiter.unblockIP(ip);
      expect(unblocked).toBe(true);

      // Should be allowed again
      const result = await limiter.checkLimit(req);
      expect(result.allowed).toBe(true);
    });

    it('should get IP status', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 2,
        blockDuration: 60000,
        store,
      });

      const req = mockRequest() as Request;
      const ip = '192.168.1.1';

      // Make some attempts
      await limiter.checkLimit(req);
      await limiter.checkLimit(req);

      const status = await limiter.getIPStatus(ip);
      expect(status.attempts).toBe(2);
      expect(status.blocked).toBe(false);

      // Block the IP
      await limiter.checkLimit(req);
      const blockedStatus = await limiter.getIPStatus(ip);
      expect(blockedStatus.blocked).toBe(true);
      expect(blockedStatus.blockUntil).toBeDefined();
    });
  });

  describe('Express Middleware', () => {
    it('should allow request within limits', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 3,
        store,
      });

      const middleware = limiter.getMiddleware();
      const req = mockRequest() as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      await new Promise<void>((resolve) => {
        res.locals = {};
        next.mockImplementation(() => resolve());
        middleware(req, res, next);
      });

      expect(next).toHaveBeenCalled();
      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'X-Security-RateLimit-Limit': '5', // default maxAttempts
        })
      );
    });

    it('should block request when limit exceeded', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 1,
        blockDuration: 60000,
        store,
      });

      const middleware = limiter.getMiddleware();
      const req = mockRequest() as Request;

      // First request - should work
      const res1 = mockResponse() as Response;
      const next1 = jest.fn();

      await new Promise<void>((resolve) => {
        res1.locals = {};
        next1.mockImplementation(() => resolve());
        middleware(req, res1, next1);
      });

      expect(next1).toHaveBeenCalled();

      // Second request - should be blocked
      const res2 = mockResponse() as Response;
      const next2 = jest.fn();

      await new Promise<void>((resolve) => {
        res2.locals = {};
        res2.status = jest.fn().mockImplementation(() => {
          resolve();
          return res2;
        });
        middleware(req, res2, next2);
      });

      expect(next2).not.toHaveBeenCalled();
      expect(res2.status).toHaveBeenCalledWith(429);
      expect(res2.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: 'Too Many Requests',
          code: 'IP_BLOCKED',
        })
      );
    });

    it('should set appropriate headers for blocked requests', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 1,
        blockDuration: 30000,
        store,
      });

      const req = mockRequest() as Request;

      // Trigger block
      await limiter.checkLimit(req);

      const middleware = limiter.getMiddleware();
      const res = mockResponse() as Response;
      const next = jest.fn();

      await new Promise<void>((resolve) => {
        res.locals = {};
        res.status = jest.fn().mockImplementation(() => {
          resolve();
          return res;
        });
        middleware(req, res, next);
      });

      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'X-Security-RateLimit-Blocked': 'true',
          'Retry-After': expect.any(String),
        })
      );
    });
  });

  describe('Statistics and Monitoring', () => {
    it('should provide configuration stats', async () => {
      const limiter = new SecurityRateLimiter({
        maxAttempts: 5,
        windowMs: 30000,
        blockDuration: 120000,
        store,
      });

      const stats = await limiter.getStats();
      expect(stats.config.maxAttempts).toBe(5);
      expect(stats.config.windowMs).toBe(30000);
      expect(stats.config.blockDuration).toBe(120000);
      expect(stats.store.healthy).toBe(true);
    });
  });

  describe('Callbacks', () => {
    it('should call onLimitReached when limit is exceeded', async () => {
      const onLimitReached = jest.fn();
      const limiter = new SecurityRateLimiter({
        maxAttempts: 1,
        onLimitReached,
        store,
      });

      const req = mockRequest() as Request;

      // Use up attempts
      await limiter.checkLimit(req);
      await limiter.checkLimit(req); // This should trigger callback

      expect(onLimitReached).toHaveBeenCalledWith(req, '192.168.1.1');
    });

    it('should call onBlocked when IP is blocked', async () => {
      const onBlocked = jest.fn();
      const limiter = new SecurityRateLimiter({
        maxAttempts: 1,
        blockDuration: 60000,
        onBlocked,
        store,
      });

      const req = mockRequest() as Request;

      // Trigger block
      await limiter.checkLimit(req);
      await limiter.checkLimit(req);

      // Try again while blocked
      await limiter.checkLimit(req);

      expect(onBlocked).toHaveBeenCalledWith(
        req,
        '192.168.1.1',
        expect.any(Number)
      );
    });
  });

  describe('Error Handling', () => {
    it('should handle store errors gracefully', async () => {
      const faultyStore = {
        ...store,
        get: jest.fn().mockRejectedValue(new Error('Store error')),
      };

      const limiter = new SecurityRateLimiter({
        store: faultyStore as any,
      });

      const req = mockRequest() as Request;

      // Should not throw, but handle error gracefully
      await expect(limiter.checkLimit(req)).rejects.toThrow('Store error');
    });

    it('should handle middleware errors', async () => {
      const faultyStore = {
        ...store,
        get: jest.fn().mockRejectedValue(new Error('Store error')),
      };

      const mockLogger = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      };

      const limiter = new SecurityRateLimiter({
        store: faultyStore as any,
      }, mockLogger);

      const middleware = limiter.getMiddleware();
      const req = mockRequest() as Request;
      const res = mockResponse() as Response;
      const next = jest.fn();

      await new Promise<void>((resolve) => {
        res.locals = {};
        next.mockImplementation((error?: any) => {
          expect(error).toBeInstanceOf(Error);
          resolve();
        });
        middleware(req, res, next);
      });

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Security rate limiter middleware error',
        expect.any(Error)
      );
    });
  });

  describe('Cleanup', () => {
    it('should destroy properly', async () => {
      const mockStore = {
        ...store,
        destroy: jest.fn().mockResolvedValue(undefined),
      };

      const limiter = new SecurityRateLimiter({
        store: mockStore as any,
      });

      await limiter.destroy();
      expect(mockStore.destroy).toHaveBeenCalled();
    });
  });
});