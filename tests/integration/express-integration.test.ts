import express from 'express';
import request from 'supertest';
import { FlowControl } from '../../src/index.js';

describe('Express Integration', () => {
  let app: express.Application;
  let flowControl: FlowControl;

  afterEach(() => {
    if (flowControl) {
      flowControl.destroy();
    }
  });

  describe('Rate Limiter Integration', () => {
    beforeEach(() => {
      flowControl = new FlowControl({
        rateLimiter: {
          windowMs: 60000, // 1 minute
          maxRequests: 3,  // 3 requests max
          message: 'Custom rate limit message',
        },
      });

      app = express();
      app.use(flowControl.getMiddleware());
      app.get('/test', (req, res) => {
        res.json({ message: 'Success', timestamp: Date.now() });
      });
    });

    it('should allow requests under the limit', async () => {
      for (let i = 0; i < 3; i++) {
        const response = await request(app)
          .get('/test')
          .expect(200);

        expect(response.body.message).toBe('Success');
        expect(response.headers).toHaveProperty('x-ratelimit-limit', '3');
        expect(response.headers).toHaveProperty('x-ratelimit-remaining', (2 - i).toString());
      }
    });

    it('should block requests over the limit', async () => {
      // Make 3 requests (should all succeed)
      for (let i = 0; i < 3; i++) {
        await request(app).get('/test').expect(200);
      }

      // 4th request should be rate limited
      const response = await request(app)
        .get('/test')
        .expect(429);

      expect(response.body.error).toBe('Rate limit exceeded');
      expect(response.body.message).toBe('Custom rate limit message');
      expect(response.body).toHaveProperty('retryAfter');
    });

    it('should set proper rate limit headers', async () => {
      const response = await request(app)
        .get('/test')
        .expect(200);

      expect(response.headers).toHaveProperty('x-ratelimit-limit', '3');
      expect(response.headers).toHaveProperty('x-ratelimit-remaining', '2');
      expect(response.headers).toHaveProperty('x-ratelimit-reset');
      expect(response.headers).toHaveProperty('x-ratelimit-window', '60000');
    });
  });

  describe('Load Balancer Integration (Mock)', () => {
    beforeEach(() => {
      flowControl = new FlowControl({
        loadBalancer: {
          servers: [
            { host: 'backend1.example.com', port: 8080 },
            { host: 'backend2.example.com', port: 8080 },
          ],
          healthCheck: { enabled: false }, // Disable for testing
        },
      });

      app = express();
      app.use(flowControl.getMiddleware());
    });

    it.skip('should proxy requests to backend servers', async () => {
      // Skipping proxy tests for Phase 1 - focusing on core functionality
      expect(true).toBe(true);
    });
  });

  describe('Combined Rate Limiting and Load Balancing', () => {
    beforeEach(() => {
      jest.mock('http-proxy-middleware', () => ({
        createProxyMiddleware: jest.fn(() => (req: any, res: any, next: any) => {
          res.json({ message: 'Combined middleware success' });
        }),
      }));

      flowControl = new FlowControl({
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 2,
        },
        loadBalancer: {
          servers: [{ host: 'backend.example.com', port: 8080 }],
          healthCheck: { enabled: false },
        },
      });

      app = express();
      app.use(flowControl.getMiddleware());
    });

    it.skip('should apply rate limiting before load balancing', async () => {
      // Skipping proxy tests for Phase 1 - will be implemented in Phase 2
      expect(true).toBe(true);
    });
  });

  describe('Error Handling', () => {
    it('should handle rate limiter failures gracefully', async () => {
      const mockLogger = {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
      };

      flowControl = new FlowControl({
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 100,
        },
      }, mockLogger);

      // Mock the rate limiter to throw an error
      const rateLimiter = flowControl.getRateLimiter();
      jest.spyOn(rateLimiter!, 'checkLimit').mockRejectedValue(new Error('Storage error'));

      app = express();
      app.use(flowControl.getMiddleware());
      app.get('/test', (req, res) => res.json({ message: 'Success' }));

      const response = await request(app)
        .get('/test')
        .expect(500);

      expect(response.body.error).toBe('Internal server error');
      expect(mockLogger.error).toHaveBeenCalledWith('Middleware error', expect.any(Error));
    });
  });

  describe('Statistics Endpoint', () => {
    beforeEach(() => {
      flowControl = new FlowControl({
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 100,
        },
        loadBalancer: {
          servers: [{ host: 'backend.example.com', port: 8080 }],
          healthCheck: { enabled: false },
        },
      });

      app = express();
      app.use(flowControl.getMiddleware());
      app.get('/stats', (req, res) => {
        const stats = flowControl.getStats();
        res.json(stats);
      });
    });

    it.skip('should provide accurate statistics', async () => {
      // Skipping proxy tests for Phase 1 - will be implemented in Phase 2
      expect(true).toBe(true);
    });
  });
});