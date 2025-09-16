import { FlowControl } from '../../src/core/flow-control.js';
import { FlowControlConfig } from '../../src/types/index.js';
import { Request, Response, NextFunction } from 'express';

// Mock the http-proxy-middleware
jest.mock('http-proxy-middleware', () => ({
  createProxyMiddleware: jest.fn(() => jest.fn()),
}));

const createMockRequest = (ip: string = '127.0.0.1'): Partial<Request> => ({
  ip,
  socket: { remoteAddress: ip },
  url: '/test',
  method: 'GET',
});

const createMockResponse = (): Partial<Response> => {
  const headers: Record<string, string> = {};
  const res = {
    set: jest.fn((headerObj: Record<string, string>) => {
      Object.assign(headers, headerObj);
    }),
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    headersSent: false,
    getHeaders: () => headers,
  };
  return res;
};

const createMockNext = (): NextFunction => jest.fn();

describe('FlowControl', () => {
  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('constructor validation', () => {
    it('should throw error when no configuration provided', () => {
      expect(() => {
        new FlowControl(null as any);
      }).toThrow('Configuration is required');
    });

    it('should throw error when neither rate limiter nor load balancer configured', () => {
      expect(() => {
        new FlowControl({});
      }).toThrow('At least one of rateLimiter or loadBalancer must be configured');
    });

    it('should validate rate limiter configuration', () => {
      expect(() => {
        new FlowControl({
          rateLimiter: {
            windowMs: -1000,
            maxRequests: 100,
          },
        });
      }).toThrow('windowMs must be positive');

      expect(() => {
        new FlowControl({
          rateLimiter: {
            windowMs: 60000,
            maxRequests: 0,
          },
        });
      }).toThrow('maxRequests must be positive');
    });

    it('should validate load balancer configuration', () => {
      expect(() => {
        new FlowControl({
          loadBalancer: {
            servers: [],
          },
        });
      }).toThrow('servers array cannot be empty');

      expect(() => {
        new FlowControl({
          loadBalancer: {
            servers: [
              { host: 'example.com', port: -1 },
            ],
          },
        });
      }).toThrow('Invalid server port');
    });
  });

  describe('conditional component loading', () => {
    it('should only initialize rate limiter when configured', () => {
      const config: FlowControlConfig = {
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 100,
        },
      };

      const flowControl = new FlowControl(config);

      expect(flowControl.getRateLimiter()).toBeDefined();
      expect(flowControl.getLoadBalancer()).toBeUndefined();

      flowControl.destroy();
    });

    it('should only initialize load balancer when configured', () => {
      const config: FlowControlConfig = {
        loadBalancer: {
          servers: [
            { host: 'example.com', port: 8080 },
          ],
        },
      };

      const flowControl = new FlowControl(config);

      expect(flowControl.getRateLimiter()).toBeUndefined();
      expect(flowControl.getLoadBalancer()).toBeDefined();

      flowControl.destroy();
    });

    it('should initialize both components when configured', () => {
      const config: FlowControlConfig = {
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 100,
        },
        loadBalancer: {
          servers: [
            { host: 'example.com', port: 8080 },
          ],
        },
      };

      const flowControl = new FlowControl(config);

      expect(flowControl.getRateLimiter()).toBeDefined();
      expect(flowControl.getLoadBalancer()).toBeDefined();

      flowControl.destroy();
    });
  });

  describe('middleware functionality', () => {
    it('should provide middleware function', () => {
      const config: FlowControlConfig = {
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 100,
        },
      };

      const flowControl = new FlowControl(config);
      const middleware = flowControl.getMiddleware();

      expect(typeof middleware).toBe('function');

      flowControl.destroy();
    });

    it('should handle rate limiting in middleware', async () => {
      const config: FlowControlConfig = {
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 1, // Very low limit for testing
        },
      };

      const flowControl = new FlowControl(config);
      const middleware = flowControl.getMiddleware();

      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      // First request should pass
      await middleware(req, res, next);
      expect(next).toHaveBeenCalled();

      // Reset mocks
      jest.clearAllMocks();

      // Second request should be rate limited
      await middleware(req, res, next);
      expect(res.status).toHaveBeenCalledWith(429);
      expect(next).not.toHaveBeenCalled();

      flowControl.destroy();
    });

    it('should pass through when only load balancer configured', async () => {
      const config: FlowControlConfig = {
        loadBalancer: {
          servers: [
            { host: 'example.com', port: 8080 },
          ],
        },
      };

      const flowControl = new FlowControl(config);
      const middleware = flowControl.getMiddleware();

      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await middleware(req, res, next);

      // Should use proxy middleware (mocked)
      expect(require('http-proxy-middleware').createProxyMiddleware).toHaveBeenCalled();

      flowControl.destroy();
    });
  });

  describe('statistics', () => {
    it('should provide statistics for enabled components', () => {
      const config: FlowControlConfig = {
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 100,
        },
        loadBalancer: {
          servers: [
            { host: 'example.com', port: 8080 },
          ],
        },
      };

      const flowControl = new FlowControl(config);
      const stats = flowControl.getStats();

      expect(stats.rateLimiter.enabled).toBe(true);
      expect(stats.loadBalancer.enabled).toBe(true);

      flowControl.destroy();
    });

    it('should show disabled components in statistics', () => {
      const config: FlowControlConfig = {
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 100,
        },
      };

      const flowControl = new FlowControl(config);
      const stats = flowControl.getStats();

      expect(stats.rateLimiter.enabled).toBe(true);
      expect(stats.loadBalancer.enabled).toBe(false);

      flowControl.destroy();
    });
  });

  describe('error handling', () => {
    it('should handle middleware errors gracefully', async () => {
      // Mock rate limiter to throw error
      const config: FlowControlConfig = {
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 100,
        },
      };

      const flowControl = new FlowControl(config);
      const rateLimiter = flowControl.getRateLimiter();

      // Mock checkLimit to throw error
      jest.spyOn(rateLimiter!, 'checkLimit').mockRejectedValue(new Error('Store error'));

      const middleware = flowControl.getMiddleware();
      const req = createMockRequest() as Request;
      const res = createMockResponse() as Response;
      const next = createMockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(500);
      expect(res.json).toHaveBeenCalledWith({
        error: 'Internal server error',
        message: 'An unexpected error occurred',
      });

      flowControl.destroy();
    });
  });

  describe('destroy', () => {
    it('should clean up all components', () => {
      const config: FlowControlConfig = {
        rateLimiter: {
          windowMs: 60000,
          maxRequests: 100,
        },
        loadBalancer: {
          servers: [
            { host: 'example.com', port: 8080 },
          ],
        },
      };

      const flowControl = new FlowControl(config);
      const rateLimiter = flowControl.getRateLimiter();
      const loadBalancer = flowControl.getLoadBalancer();

      const rateLimiterDestroySpy = jest.spyOn(rateLimiter!, 'destroy');
      const loadBalancerDestroySpy = jest.spyOn(loadBalancer!, 'destroy');

      flowControl.destroy();

      expect(rateLimiterDestroySpy).toHaveBeenCalled();
      expect(loadBalancerDestroySpy).toHaveBeenCalled();
    });
  });
});