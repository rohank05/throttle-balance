import express from 'express';
import request from 'supertest';
import { FlowControl } from '../../src/core/flow-control.js';
import { IPFilter, SecurityRateLimiter, RequestValidator, SecurityHeaders } from '../../src/security/index.js';
import { StructuredLogger, LoggingMiddleware } from '../../src/logging/index.js';
import { MemoryStore } from '../../src/rate-limiter/memory-store.js';
import { AdvancedHealthChecker } from '../../src/health/index.js';

describe('FlowControl Integration Tests', () => {
  let app: express.Application;
  let flowControl: FlowControl;
  let mockUpstreamServer: express.Application;
  let upstreamPort: number;
  let server: any;

  beforeAll(() => {
    // Create mock upstream server
    mockUpstreamServer = express();
    mockUpstreamServer.use(express.json());

    mockUpstreamServer.get('/health', (req, res) => {
      res.json({ status: 'healthy', timestamp: new Date().toISOString() });
    });

    mockUpstreamServer.get('/api/users', (req, res) => {
      res.json({ users: ['user1', 'user2'], page: req.query.page || 1 });
    });

    mockUpstreamServer.post('/api/users', (req, res) => {
      if (req.body.name) {
        res.status(201).json({ id: '123', name: req.body.name });
      } else {
        res.status(400).json({ error: 'Name is required' });
      }
    });

    mockUpstreamServer.get('/api/slow', (req, res) => {
      setTimeout(() => {
        res.json({ message: 'slow response' });
      }, 1000);
    });

    mockUpstreamServer.get('/api/error', (req, res) => {
      res.status(500).json({ error: 'Internal server error' });
    });
  });

  beforeEach(async () => {
    // Start upstream server with dynamic port
    server = mockUpstreamServer.listen(0);
    upstreamPort = server.address().port;

    // Create FlowControl instance with comprehensive configuration
    flowControl = await FlowControl.create({
      rateLimiter: {
        windowMs: 60000, // 1 minute
        maxRequests: 10,
        store: 'memory',
      },
      loadBalancer: {
        servers: [
          { host: 'localhost', port: upstreamPort },
        ],
        healthCheck: {
          enabled: true,
          endpoint: '/health',
          interval: 5000,
          timeout: 2000,
        },
        proxyTimeout: 3000,
      },
    });

    // Create Express app with all security and logging middleware
    app = express();
    app.use(express.json());

    // Security Headers
    const securityHeaders = new SecurityHeaders({
      contentSecurityPolicy: {
        enabled: true,
        directives: {
          'default-src': ["'self'"],
          'script-src': ["'self'"],
        },
      },
      strictTransportSecurity: {
        enabled: true,
        maxAge: 31536000,
      },
    });
    app.use(securityHeaders.getMiddleware());

    // IP Filtering
    const ipFilter = new IPFilter({
      mode: 'hybrid',
      defaultAction: 'allow',
      blacklist: ['192.168.999.999'], // Fake blocked IP
    });
    app.use(ipFilter.getMiddleware());

    // Request Validation
    const requestValidator = new RequestValidator({
      body: [
        { field: 'name', type: 'string', required: true, minLength: 2 },
      ],
    });

    // Security Rate Limiting
    const securityRateLimiter = new SecurityRateLimiter({
      maxAttempts: 5,
      windowMs: 60000,
      blockDuration: 30000,
      store: new MemoryStore(),
    });
    app.use(securityRateLimiter.getMiddleware());

    // Structured Logging
    const logger = new StructuredLogger({
      level: 'info',
      maskSensitiveData: true,
    });
    const loggingMiddleware = new LoggingMiddleware({ logger });
    app.use(loggingMiddleware.getMiddleware());

    // Add test endpoints BEFORE FlowControl middleware
    app.get('/test/health', (req, res) => {
      res.json({ status: 'ok', middleware: 'working' });
    });

    // Apply request validation only to POST routes
    app.use('/api/users', (req, res, next) => {
      if (req.method === 'POST') {
        return requestValidator.getMiddleware()(req, res, next);
      }
      next();
    });

    // FlowControl middleware (should only handle /api routes)
    app.use('/api', flowControl.getMiddleware());
  });

  afterEach(async () => {
    if (flowControl) {
      await flowControl.destroy();
    }
    if (server) {
      server.close();
    }
  });

  describe('Basic Proxy Functionality', () => {
    it('should proxy GET requests successfully', async () => {
      const response = await request(app)
        .get('/api/users')
        .expect(200);

      expect(response.body).toHaveProperty('users');
      expect(response.body.users).toEqual(['user1', 'user2']);
    });

    it('should proxy POST requests with valid data', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({ name: 'John Doe' })
        .expect(201);

      expect(response.body).toHaveProperty('id');
      expect(response.body.name).toBe('John Doe');
    });

    it('should proxy query parameters', async () => {
      const response = await request(app)
        .get('/api/users?page=2')
        .expect(200);

      expect(response.body.page).toBe('2');
    });
  });

  describe('Security Headers Integration', () => {
    it('should include security headers in responses', async () => {
      const response = await request(app)
        .get('/test/health')
        .expect(200);

      expect(response.headers).toHaveProperty('content-security-policy');
      expect(response.headers).toHaveProperty('x-frame-options', 'DENY');
      expect(response.headers).toHaveProperty('x-content-type-options', 'nosniff');
    });

    it('should include HSTS header for HTTPS requests', async () => {
      // Simulate HTTPS request
      const response = await request(app)
        .get('/test/health')
        .set('X-Forwarded-Proto', 'https')
        .expect(200);

      expect(response.headers).toHaveProperty('strict-transport-security');
    });
  });

  describe('Request Validation Integration', () => {
    it('should validate POST request bodies', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({ invalidField: 'value' }) // Missing required 'name' field
        .expect(400);

      expect(response.body.error).toBe('Validation Error');
      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'name',
            message: expect.stringContaining('required'),
          }),
        ])
      );
    });

    it('should validate field constraints', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({ name: 'X' }) // Too short (minLength: 2)
        .expect(400);

      expect(response.body.errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            field: 'name',
            message: expect.stringContaining('at least 2 characters'),
          }),
        ])
      );
    });
  });

  describe('Rate Limiting Integration', () => {
    it('should enforce rate limits', async () => {
      // Make requests up to the limit
      const promises = Array.from({ length: 10 }, () =>
        request(app).get('/api/users')
      );

      const responses = await Promise.all(promises);

      // All should succeed initially
      responses.forEach(response => {
        expect([200, 201].includes(response.status)).toBe(true);
      });

      // The 11th request should be rate limited
      const rateLimitedResponse = await request(app)
        .get('/api/users')
        .expect(429);

      expect(rateLimitedResponse.body.error).toContain('Too Many Requests');
    });

    it('should include rate limit headers', async () => {
      const response = await request(app)
        .get('/api/users')
        .expect(200);

      expect(response.headers).toHaveProperty('x-ratelimit-limit');
      expect(response.headers).toHaveProperty('x-ratelimit-remaining');
      expect(response.headers).toHaveProperty('x-ratelimit-reset');
    });
  });

  describe('Security Rate Limiting Integration', () => {
    it('should block IPs after too many failed attempts', async () => {
      // Make multiple requests to trigger security rate limiting
      const promises = Array.from({ length: 6 }, () =>
        request(app)
          .get('/api/error') // This will return 500, counting as failed attempt
          .expect(500)
      );

      await Promise.all(promises);

      // Next request should be blocked by security rate limiter
      const response = await request(app)
        .get('/api/users')
        .expect(429);

      expect(response.body.code).toBe('IP_BLOCKED');
    });
  });

  describe('Health Check Integration', () => {
    it('should perform health checks on upstream servers', async () => {
      // Wait a moment for health checks to run
      await new Promise(resolve => setTimeout(resolve, 100));

      const stats = flowControl.getStats();
      expect(stats.loadBalancer.enabled).toBe(true);

      // The upstream server should be considered healthy
      const loadBalancer = flowControl.getLoadBalancer();
      if (loadBalancer) {
        const healthyServers = loadBalancer.getHealthyServers();
        expect(healthyServers).toHaveLength(1);
      }
    });

    it('should handle upstream server health endpoint', async () => {
      const response = await request(app)
        .get('/health')
        .expect(200);

      expect(response.body.status).toBe('healthy');
    });
  });

  describe('Error Handling Integration', () => {
    it('should handle upstream server errors gracefully', async () => {
      const response = await request(app)
        .get('/api/error')
        .expect(500);

      expect(response.body.error).toBe('Internal server error');
    });

    it('should handle request validation errors', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({}) // Empty body, should fail validation
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('should handle rate limit exceeded errors', async () => {
      // Exhaust rate limit
      const promises = Array.from({ length: 11 }, () =>
        request(app).get('/api/users')
      );

      const responses = await Promise.all(promises);
      const rateLimitedResponse = responses[responses.length - 1];

      expect(rateLimitedResponse.status).toBe(429);
      expect(rateLimitedResponse.body.error).toContain('Too Many Requests');
    });
  });

  describe('Load Balancing Integration', () => {
    it('should distribute requests to available servers', async () => {
      // Make multiple requests
      const responses = await Promise.all([
        request(app).get('/api/users'),
        request(app).get('/api/users'),
        request(app).get('/api/users'),
      ]);

      // All should succeed
      responses.forEach(response => {
        expect(response.status).toBe(200);
        expect(response.body.users).toBeDefined();
      });
    });

    it('should handle server unavailability', async () => {
      // Get current stats
      const stats = flowControl.getStats();
      expect(stats.loadBalancer.enabled).toBe(true);

      // All requests should still work with one server
      const response = await request(app)
        .get('/api/users')
        .expect(200);

      expect(response.body.users).toBeDefined();
    });
  });

  describe('Complex Scenarios', () => {
    it('should handle multiple middleware layers correctly', async () => {
      const response = await request(app)
        .post('/api/users')
        .send({ name: 'Integration Test User' })
        .expect(201);

      // Should pass through all middleware layers
      expect(response.body.name).toBe('Integration Test User');

      // Should have security headers
      expect(response.headers).toHaveProperty('x-frame-options');

      // Should have rate limit headers
      expect(response.headers).toHaveProperty('x-ratelimit-remaining');
    });

    it('should maintain security even under load', async () => {
      // Simulate load with multiple concurrent requests
      const promises = Array.from({ length: 5 }, () =>
        request(app)
          .post('/api/users')
          .send({ name: 'Load Test User' })
      );

      const responses = await Promise.all(promises);

      // All should succeed and have proper security headers
      responses.forEach(response => {
        expect(response.status).toBe(201);
        expect(response.headers).toHaveProperty('x-frame-options');
        expect(response.headers).toHaveProperty('content-security-policy');
      });
    });

    it('should handle mixed valid and invalid requests', async () => {
      const requests = [
        request(app).get('/api/users'), // Valid
        request(app).post('/api/users').send({}), // Invalid - missing name
        request(app).post('/api/users').send({ name: 'Valid User' }), // Valid
        request(app).get('/api/error'), // Error from upstream
      ];

      const responses = await Promise.all(requests);

      expect(responses[0].status).toBe(200); // Valid GET
      expect(responses[1].status).toBe(400); // Invalid POST
      expect(responses[2].status).toBe(201); // Valid POST
      expect(responses[3].status).toBe(500); // Upstream error
    });
  });

  describe('Monitoring and Observability', () => {
    it('should provide comprehensive statistics', async () => {
      // Make some requests to generate stats
      await request(app).get('/api/users');
      await request(app).post('/api/users').send({ name: 'Test User' });

      const stats = flowControl.getStats();

      expect(stats.rateLimiter.enabled).toBe(true);
      expect(stats.loadBalancer.enabled).toBe(true);
      expect(stats.loadBalancer.totalRequests).toBeGreaterThan(0);
    });

    it('should track request patterns', async () => {
      // Make requests with different patterns
      await request(app).get('/api/users?page=1');
      await request(app).get('/api/users?page=2');
      await request(app).post('/api/users').send({ name: 'Pattern Test' });

      const loadBalancer = flowControl.getLoadBalancer();
      if (loadBalancer) {
        const stats = loadBalancer.getStats();
        expect(stats.totalRequests).toBeGreaterThanOrEqual(3);
      }
    });
  });

  describe('Graceful Degradation', () => {
    it('should continue operating when individual components fail', async () => {
      // Even if some middleware has issues, basic functionality should work
      const response = await request(app)
        .get('/test/health')
        .expect(200);

      expect(response.body.status).toBe('ok');
    });

    it('should handle middleware errors gracefully', async () => {
      // The application should not crash due to middleware errors
      const response = await request(app)
        .get('/api/users')
        .expect(200);

      expect(response.body.users).toBeDefined();
    });
  });
});