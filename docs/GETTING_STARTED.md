# Getting Started with Flow-Control

This guide will help you get up and running with Flow-Control quickly.

## Installation

First, install Flow-Control in your Node.js project:

```bash
npm install flow-control
# or
yarn add flow-control
```

## Prerequisites

- Node.js 16+ (LTS recommended)
- Express.js 4+ (for middleware integration)
- TypeScript 5.0+ (optional but recommended)

## Your First Rate Limiter

Let's start with a simple rate limiter that allows 10 requests per minute:

```typescript
import express from 'express';
import { FlowControl } from 'flow-control';

const app = express();

// Create a rate limiter
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60 * 1000,  // 1 minute
    maxRequests: 10,      // 10 requests per minute
  },
});

// Apply rate limiting to all routes
app.use(flowControl.getMiddleware());

// Your API routes
app.get('/api/data', (req, res) => {
  res.json({ message: 'This endpoint is rate limited!' });
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

Test it by making multiple requests to `http://localhost:3000/api/data`. After 10 requests within a minute, you'll receive a 429 status code.

## Your First Load Balancer

Now let's create a simple load balancer:

```typescript
import express from 'express';
import { FlowControl } from 'flow-control';

const app = express();

// Create a load balancer
const flowControl = new FlowControl({
  loadBalancer: {
    servers: [
      { host: 'localhost', port: 3001 },
      { host: 'localhost', port: 3002 },
      { host: 'localhost', port: 3003 },
    ],
  },
});

// Apply load balancing to all routes
app.use(flowControl.getMiddleware());

app.listen(3000, () => {
  console.log('Load balancer running on http://localhost:3000');
});
```

You'll need to run backend servers on ports 3001, 3002, and 3003 for this to work. You can use the example backend server provided in the `examples/` folder.

## Running Backend Servers

To test the load balancer, start multiple backend servers:

```bash
# Terminal 1
PORT=3001 SERVER_NAME="Backend-1" node examples/backend-server.js

# Terminal 2
PORT=3002 SERVER_NAME="Backend-2" node examples/backend-server.js

# Terminal 3
PORT=3003 SERVER_NAME="Backend-3" node examples/backend-server.js
```

## Combining Rate Limiting and Load Balancing

For a complete API gateway, combine both features:

```typescript
import express from 'express';
import { FlowControl } from 'flow-control';

const app = express();

const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60 * 1000,
    maxRequests: 100,
  },
  loadBalancer: {
    servers: [
      { host: 'localhost', port: 3001 },
      { host: 'localhost', port: 3002 },
    ],
    healthCheck: {
      enabled: true,
      interval: 30000,  // Check every 30 seconds
    },
  },
});

app.use(flowControl.getMiddleware());

// Gateway status endpoint
app.get('/gateway/status', (req, res) => {
  const stats = flowControl.getStats();
  res.json({
    status: 'healthy',
    rateLimiter: stats.rateLimiter,
    loadBalancer: stats.loadBalancer,
  });
});

app.listen(3000, () => {
  console.log('API Gateway running on http://localhost:3000');
});
```

## Understanding Rate Limit Headers

Flow-Control automatically adds rate limit headers to responses:

```
X-RateLimit-Limit: 100
X-RateLimit-Remaining: 85
X-RateLimit-Reset: 1640995200000
X-RateLimit-Window: 60000
```

- `X-RateLimit-Limit`: Maximum requests allowed in the window
- `X-RateLimit-Remaining`: Remaining requests in current window
- `X-RateLimit-Reset`: Timestamp when the window resets
- `X-RateLimit-Window`: Window duration in milliseconds

## Customizing Rate Limiting

### Custom Key Generation

Rate limit by API key instead of IP address:

```typescript
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60 * 1000,
    maxRequests: 100,
    keyGenerator: (req) => {
      // Use API key from header, fallback to IP
      return req.headers['x-api-key'] || req.ip;
    },
  },
});
```

### Skipping Requests

Skip rate limiting for specific requests:

```typescript
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60 * 1000,
    maxRequests: 100,
    skip: (req) => {
      // Skip rate limiting for health checks
      return req.path === '/health';
    },
  },
});
```

### Custom Error Messages

Customize the rate limit exceeded message:

```typescript
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60 * 1000,
    maxRequests: 100,
    message: 'Whoa there! You\'re going too fast. Please slow down.',
    statusCode: 429,
  },
});
```

## Health Checks

Enable health monitoring for your backend servers:

```typescript
const flowControl = new FlowControl({
  loadBalancer: {
    servers: [
      { host: 'api1.example.com', port: 80 },
      { host: 'api2.example.com', port: 80 },
    ],
    healthCheck: {
      enabled: true,
      endpoint: '/health',     // Health check endpoint
      interval: 15000,         // Check every 15 seconds
      timeout: 5000,           // 5 second timeout
      failureThreshold: 3,     // Mark unhealthy after 3 failures
      successThreshold: 2,     // Mark healthy after 2 successes
    },
  },
});
```

## Monitoring Your Gateway

Get real-time statistics:

```typescript
app.get('/stats', (req, res) => {
  const stats = flowControl.getStats();
  const loadBalancer = flowControl.getLoadBalancer();
  const healthyServers = loadBalancer?.getHealthyServers() || [];

  res.json({
    timestamp: new Date().toISOString(),
    rateLimiter: {
      enabled: stats.rateLimiter.enabled,
    },
    loadBalancer: {
      enabled: stats.loadBalancer.enabled,
      totalRequests: stats.loadBalancer.totalRequests || 0,
      totalErrors: stats.loadBalancer.totalErrors || 0,
      healthyServers: healthyServers.length,
      totalServers: stats.loadBalancer.serverStats?.size || 0,
    },
  });
});
```

## Error Handling

Flow-Control provides graceful error handling:

```typescript
import { FlowControlError, RateLimitError, LoadBalancerError } from 'flow-control';

app.use((err, req, res, next) => {
  if (err instanceof RateLimitError) {
    res.status(429).json({
      error: 'Rate limit exceeded',
      retryAfter: Math.ceil((err.rateLimitInfo.resetTime - Date.now()) / 1000),
    });
  } else if (err instanceof LoadBalancerError) {
    res.status(503).json({
      error: 'Service unavailable',
      message: 'Backend servers are temporarily unavailable',
    });
  } else if (err instanceof FlowControlError) {
    res.status(err.statusCode).json({
      error: err.message,
      code: err.code,
    });
  } else {
    next(err);
  }
});
```

## Graceful Shutdown

Properly cleanup resources on shutdown:

```typescript
const flowControl = new FlowControl({
  rateLimiter: { windowMs: 60000, maxRequests: 100 },
  loadBalancer: { servers: [{ host: 'backend.com', port: 80 }] },
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  flowControl.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down gracefully...');
  flowControl.destroy();
  process.exit(0);
});
```

## Environment Configuration

Use environment variables for configuration:

```typescript
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: parseInt(process.env.RATE_LIMIT_WINDOW || '60000'),
    maxRequests: parseInt(process.env.RATE_LIMIT_MAX || '100'),
  },
  loadBalancer: {
    servers: JSON.parse(process.env.BACKEND_SERVERS || '[{"host":"localhost","port":3001}]'),
    healthCheck: {
      enabled: process.env.HEALTH_CHECK_ENABLED === 'true',
      interval: parseInt(process.env.HEALTH_CHECK_INTERVAL || '30000'),
    },
  },
});
```

Example `.env` file:

```env
RATE_LIMIT_WINDOW=60000
RATE_LIMIT_MAX=1000
BACKEND_SERVERS=[{"host":"api1.example.com","port":80},{"host":"api2.example.com","port":80}]
HEALTH_CHECK_ENABLED=true
HEALTH_CHECK_INTERVAL=15000
```

## Development vs Production

### Development Setup

For development, use simple in-memory storage:

```typescript
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60 * 1000,
    maxRequests: 1000,  // Higher limits for development
  },
  loadBalancer: {
    servers: [
      { host: 'localhost', port: 3001 },
    ],
    healthCheck: { enabled: false },  // Disable for development
  },
});
```

### Production Setup

For production, you'll want more robust configuration:

```typescript
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60 * 1000,
    maxRequests: 100,
    keyGenerator: (req) => req.headers['x-forwarded-for'] || req.ip,
  },
  loadBalancer: {
    servers: [
      { host: 'api1.internal', port: 8080, protocol: 'https' },
      { host: 'api2.internal', port: 8080, protocol: 'https' },
      { host: 'api3.internal', port: 8080, protocol: 'https' },
    ],
    healthCheck: {
      enabled: true,
      interval: 10000,
      timeout: 3000,
      failureThreshold: 2,
    },
    proxyTimeout: 30000,
  },
});
```

## Next Steps

- Explore the [API Reference](./API.md) for detailed documentation
- Check out the [examples](../examples/) directory for complete working examples
- Learn about [Performance Tuning](./PERFORMANCE.md) for production deployments
- Read about [Security Best Practices](./SECURITY.md)

## Getting Help

- 📚 [Documentation](../docs/)
- 🐛 [Report Issues](https://github.com/rohank05/throttle-balance/issues)
- 💬 [Ask Questions](https://github.com/rohank05/throttle-balance/discussions)

Happy building! 🚀