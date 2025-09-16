import { FixedWindowRateLimiter } from '../../src/rate-limiter/fixed-window.js';
import { MemoryStore } from '../../src/rate-limiter/memory-store.js';
import { Request, Response } from 'express';

// Mock Express request/response objects
const createMockRequest = (ip: string = '127.0.0.1'): Partial<Request> => ({
  ip,
  socket: { remoteAddress: ip },
});

const createMockResponse = (): Partial<Response> => {
  const headers: Record<string, string> = {};
  const res = {
    set: jest.fn((headerObj: Record<string, string>) => {
      Object.assign(headers, headerObj);
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    getHeaders: () => headers,
  };
  return res;
};

describe('FixedWindowRateLimiter', () => {
  let rateLimiter: FixedWindowRateLimiter;
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
    rateLimiter = new FixedWindowRateLimiter(
      {
        windowMs: 60000, // 1 minute
        maxRequests: 5,   // 5 requests max
      },
      store
    );
  });

  afterEach(() => {
    rateLimiter.destroy();
  });

  describe('rate limiting logic', () => {
    it('should allow requests under the limit', async () => {
      const req = createMockRequest('192.168.1.1') as Request;

      for (let i = 0; i < 5; i++) {
        const result = await rateLimiter.checkLimit(req);
        expect(result.allowed).toBe(true);
        expect(result.info.remaining).toBe(5 - (i + 1));
      }
    });

    it('should deny requests over the limit', async () => {
      const req = createMockRequest('192.168.1.2') as Request;

      // Make 5 requests (should all be allowed)
      for (let i = 0; i < 5; i++) {
        const result = await rateLimiter.checkLimit(req);
        expect(result.allowed).toBe(true);
      }

      // 6th request should be denied
      const result = await rateLimiter.checkLimit(req);
      expect(result.allowed).toBe(false);
      expect(result.info.remaining).toBe(0);
    });

    it('should track requests per IP separately', async () => {
      const req1 = createMockRequest('192.168.1.1') as Request;
      const req2 = createMockRequest('192.168.1.2') as Request;

      // Make 5 requests from first IP
      for (let i = 0; i < 5; i++) {
        const result = await rateLimiter.checkLimit(req1);
        expect(result.allowed).toBe(true);
      }

      // First IP should be rate limited
      const result1 = await rateLimiter.checkLimit(req1);
      expect(result1.allowed).toBe(false);

      // Second IP should still be allowed
      const result2 = await rateLimiter.checkLimit(req2);
      expect(result2.allowed).toBe(true);
    });
  });

  describe('custom key generator', () => {
    it('should use custom key generator when provided', async () => {
      const customRateLimiter = new FixedWindowRateLimiter(
        {
          windowMs: 60000,
          maxRequests: 2,
          keyGenerator: (req) => req.headers?.['x-api-key'] as string || 'anonymous',
        },
        store
      );

      const req1 = { headers: { 'x-api-key': 'user1' } } as Request;
      const req2 = { headers: { 'x-api-key': 'user2' } } as Request;
      const req3 = { headers: {} } as Request;

      // User1 makes 2 requests
      await customRateLimiter.checkLimit(req1);
      const result1 = await customRateLimiter.checkLimit(req1);
      expect(result1.allowed).toBe(true);

      // User1's 3rd request should be denied
      const result2 = await customRateLimiter.checkLimit(req1);
      expect(result2.allowed).toBe(false);

      // User2 should still be allowed
      const result3 = await customRateLimiter.checkLimit(req2);
      expect(result3.allowed).toBe(true);

      // Anonymous user should be allowed
      const result4 = await customRateLimiter.checkLimit(req3);
      expect(result4.allowed).toBe(true);

      customRateLimiter.destroy();
    });
  });

  describe('skip function', () => {
    it('should skip rate limiting when skip function returns true', async () => {
      const skipRateLimiter = new FixedWindowRateLimiter(
        {
          windowMs: 60000,
          maxRequests: 1,
          skip: (req) => req.headers?.['x-skip'] === 'true',
        },
        store
      );

      const normalReq = createMockRequest('192.168.1.3') as Request;
      normalReq.headers = {};
      const skipReq = createMockRequest('192.168.1.4') as Request;
      skipReq.headers = { 'x-skip': 'true' };

      // Normal request should count
      const result1 = await skipRateLimiter.checkLimit(normalReq);
      expect(result1.allowed).toBe(true);

      // Second normal request should be denied
      const result2 = await skipRateLimiter.checkLimit(normalReq);
      expect(result2.allowed).toBe(false);

      // Skipped request should always be allowed
      const result3 = await skipRateLimiter.checkLimit(skipReq);
      expect(result3.allowed).toBe(true);

      skipRateLimiter.destroy();
    });
  });

  describe('response headers', () => {
    it('should set rate limit headers when enabled', () => {
      const res = createMockResponse() as Response;
      const rateLimitInfo = {
        limit: 100,
        remaining: 75,
        resetTime: Date.now() + 60000,
        windowMs: 60000,
      };

      rateLimiter.setHeaders(res, rateLimitInfo);

      expect(res.set).toHaveBeenCalledWith({
        'X-RateLimit-Limit': '100',
        'X-RateLimit-Remaining': '75',
        'X-RateLimit-Reset': rateLimitInfo.resetTime.toString(),
        'X-RateLimit-Window': '60000',
      });
    });

    it('should not set headers when disabled', () => {
      const noHeadersRateLimiter = new FixedWindowRateLimiter(
        {
          windowMs: 60000,
          maxRequests: 5,
          headers: false,
        },
        store
      );

      const res = createMockResponse() as Response;
      const rateLimitInfo = {
        limit: 100,
        remaining: 75,
        resetTime: Date.now() + 60000,
        windowMs: 60000,
      };

      noHeadersRateLimiter.setHeaders(res, rateLimitInfo);

      expect(res.set).not.toHaveBeenCalled();

      noHeadersRateLimiter.destroy();
    });
  });

  describe('rate limit exceeded response', () => {
    it('should send proper rate limit exceeded response', () => {
      const res = createMockResponse() as Response;
      const rateLimitInfo = {
        limit: 100,
        remaining: 0,
        resetTime: Date.now() + 30000, // 30 seconds from now
        windowMs: 60000,
      };

      rateLimiter.sendRateLimitResponse(res, rateLimitInfo);

      expect(res.status).toHaveBeenCalledWith(429);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Rate limit exceeded',
        message: 'Too many requests, please try again later.',
        retryAfter: 30,
      });
    });
  });
});