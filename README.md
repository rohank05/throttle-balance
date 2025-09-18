# Flow-Control

A high-performance, TypeScript-based API gateway package for Node.js that provides intelligent rate limiting and load balancing with proxy capabilities.

[![npm version](https://badge.fury.io/js/flow-control.svg)](https://badge.fury.io/js/flow-control)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![TypeScript](https://img.shields.io/badge/%3C%2F%3E-TypeScript-%230074c1.svg)](http://www.typescriptlang.org/)

## Features

- 🚀 **High Performance**: Sub-millisecond overhead for rate limiting operations
- 🔒 **Type Safe**: Full TypeScript support with comprehensive type definitions
- 🔧 **Modular Design**: Use rate limiting, load balancing, or both independently
- 💾 **Flexible Storage**: In-memory and Redis storage options
- 📈 **Production Ready**: Redis integration with cluster and sentinel support
- 🛡️ **Enterprise Security**: IP filtering, request validation, security headers
- 🏥 **Health Monitoring**: HTTP, HTTPS, and TCP health checks
- ⚡ **Circuit Breaker**: Resilience patterns for failing services
- 📊 **Structured Logging**: Configurable logging with multiple transports
- ✅ **Robust Validation**: Comprehensive configuration validation with Joi

## Installation

```bash
npm install flow-control
# or
yarn add flow-control
```

## Quick Start

### Rate Limiting Only

```typescript
import express from 'express';
import { FlowControl } from 'flow-control';

const app = express();

const flowControl = await FlowControl.create({
  rateLimiter: {
    windowMs: 60000,     // 1 minute window
    maxRequests: 100,    // Maximum 100 requests per window
    message: 'Too many requests, please try again later.',
  },
});

app.use(flowControl.getMiddleware());

app.get('/', (req, res) => {
  res.json({ message: 'Hello World!' });
});

app.listen(3000, () => {
  console.log('Server running on port 3000 with rate limiting');
});
```

### Load Balancing Only

```typescript
import express from 'express';
import { FlowControl } from 'flow-control';

const app = express();

const flowControl = await FlowControl.create({
  loadBalancer: {
    servers: [
      { host: 'backend1.example.com', port: 8080 },
      { host: 'backend2.example.com', port: 8080 },
      { host: 'backend3.example.com', port: 8080 },
    ],
    healthCheck: {
      enabled: true,
      endpoint: '/health',
      interval: 30000,
    },
  },
});

app.use(flowControl.getMiddleware());

app.listen(3000, () => {
  console.log('Load balancer running on port 3000');
});
```

### Production-Ready API Gateway

```typescript
import express from 'express';
import { FlowControl } from 'flow-control';

const app = express();

const flowControl = await FlowControl.create({
  rateLimiter: {
    windowMs: 60000,
    maxRequests: 1000,
    store: {
      type: 'redis',
      redis: {
        host: 'localhost',
        port: 6379,
        db: 0,
      },
    },
  },
  loadBalancer: {
    servers: [
      { host: 'backend1.example.com', port: 8080, protocol: 'https' },
      { host: 'backend2.example.com', port: 8080, protocol: 'https' },
    ],
    healthCheck: {
      enabled: true,
      interval: 15000,
      timeout: 3000,
      endpoint: '/health',
      protocol: 'https',
    },
  },
  security: {
    ipFilter: {
      whitelist: ['10.0.0.0/8', '192.168.0.0/16'],
      blacklist: ['192.168.1.100'],
    },
    requestValidation: {
      enabled: true,
      maxBodySize: '1mb',
      sanitizeHeaders: true,
    },
    headers: {
      contentSecurityPolicy: true,
      hsts: true,
      noSniff: true,
    },
  },
  logging: {
    level: 'info',
    transports: [
      { type: 'console', colorize: true },
      { type: 'file', filename: 'flow-control.log' },
    ],
  },
});

app.use(flowControl.getMiddleware());

// Health check endpoint for the gateway
app.get('/gateway/health', (req, res) => {
  const stats = flowControl.getStats();
  res.json({
    status: 'healthy',
    rateLimiter: stats.rateLimiter,
    loadBalancer: stats.loadBalancer,
  });
});

app.listen(3000, () => {
  console.log('Production API Gateway running on port 3000');
});
```

## Configuration

### Rate Limiter Configuration

```typescript
interface RateLimiterConfig {
  windowMs: number;                    // Time window in milliseconds
  maxRequests: number;                 // Maximum requests per window
  keyGenerator?: (req: Request) => string;  // Custom key generation
  skip?: (req: Request) => boolean;    // Skip rate limiting for specific requests
  message?: string;                    // Custom error message
  statusCode?: number;                 // HTTP status code (default: 429)
  headers?: boolean;                   // Include rate limit headers (default: true)
  store?: StoreConfig;                 // Storage configuration
}
```

### Load Balancer Configuration

```typescript
interface LoadBalancerConfig {
  servers: ServerConfig[];             // Array of backend servers
  algorithm?: 'round-robin' | 'resilient-round-robin';  // Load balancing algorithm
  healthCheck?: HealthCheckConfig;     // Health check configuration
  proxyTimeout?: number;               // Proxy timeout in milliseconds
  retryAttempts?: number;              // Number of retry attempts
}

interface ServerConfig {
  host: string;                        // Server hostname
  port: number;                        // Server port
  protocol?: 'http' | 'https';        // Protocol (default: 'http')
  weight?: number;                     // Server weight (future use)
  metadata?: Record<string, any>;      // Custom metadata
}

interface HealthCheckConfig {
  enabled: boolean;                    // Enable health checks
  endpoint?: string;                   // Health check endpoint (default: '/health')
  interval?: number;                   // Check interval in ms (default: 30000)
  timeout?: number;                    // Request timeout in ms (default: 5000)
  protocol?: 'http' | 'https' | 'tcp'; // Health check protocol
  healthyThreshold?: number;           // Consecutive successes to mark healthy
  unhealthyThreshold?: number;         // Consecutive failures to mark unhealthy
}
```

### Security Configuration

```typescript
interface SecurityConfig {
  ipFilter?: IPFilterConfig;           // IP filtering configuration
  requestValidation?: RequestValidationConfig; // Request validation
  headers?: SecurityHeadersConfig;     // Security headers
}

interface IPFilterConfig {
  whitelist?: string[];                // Allowed IP addresses/CIDR ranges
  blacklist?: string[];                // Blocked IP addresses/CIDR ranges
  trustProxy?: boolean;                // Trust X-Forwarded-For headers
}

interface RequestValidationConfig {
  enabled: boolean;                    // Enable request validation
  maxBodySize?: string;                // Maximum body size (e.g., '1mb')
  sanitizeHeaders?: boolean;           // Sanitize headers for XSS
  allowedMethods?: string[];           // Allowed HTTP methods
}

interface SecurityHeadersConfig {
  contentSecurityPolicy?: boolean | string; // CSP header
  hsts?: boolean | HSTSConfig;         // HSTS configuration
  noSniff?: boolean;                   // X-Content-Type-Options: nosniff
  frameOptions?: boolean | string;     // X-Frame-Options
  xssFilter?: boolean;                 // X-XSS-Protection
}
```

### Storage Configuration

```typescript
interface StoreConfig {
  type: 'memory' | 'redis';            // Storage type
  redis?: RedisStoreConfig;            // Redis configuration
}

interface RedisStoreConfig {
  host?: string;                       // Redis host (default: 'localhost')
  port?: number;                       // Redis port (default: 6379)
  password?: string;                   // Redis password
  db?: number;                         // Database number (default: 0)
  keyPrefix?: string;                  // Key prefix for rate limiting
  cluster?: ClusterConfig;             // Redis cluster configuration
  sentinel?: SentinelConfig;           // Redis sentinel configuration
}
```

### Logging Configuration

```typescript
interface LoggingConfig {
  level?: 'error' | 'warn' | 'info' | 'debug'; // Log level
  transports?: LogTransportConfig[];   // Log transports
}

interface LogTransportConfig {
  type: 'console' | 'file';            // Transport type
  level?: string;                      // Transport-specific log level
  colorize?: boolean;                  // Colorize console output
  filename?: string;                   // File path for file transport
  maxFiles?: number;                   // Maximum log files to keep
  maxSize?: string;                    // Maximum file size
}
```

## Advanced Usage

### Redis Cluster Configuration

```typescript
const flowControl = await FlowControl.create({
  rateLimiter: {
    windowMs: 60000,
    maxRequests: 1000,
    store: {
      type: 'redis',
      redis: {
        cluster: {
          nodes: [
            { host: 'redis-1.example.com', port: 6379 },
            { host: 'redis-2.example.com', port: 6379 },
            { host: 'redis-3.example.com', port: 6379 },
          ],
        },
        keyPrefix: 'flow-control:',
      },
    },
  },
});
```

### Security with IP Filtering

```typescript
const flowControl = await FlowControl.create({
  security: {
    ipFilter: {
      whitelist: [
        '10.0.0.0/8',           // Private network
        '192.168.0.0/16',       // Local network
        '203.0.113.0/24',       // Office network
      ],
      blacklist: [
        '192.168.1.100',        // Blocked specific IP
        '10.0.0.50/32',         // Blocked single IP
      ],
      trustProxy: true,         // Trust X-Forwarded-For headers
    },
    requestValidation: {
      enabled: true,
      maxBodySize: '10mb',
      sanitizeHeaders: true,
      allowedMethods: ['GET', 'POST', 'PUT', 'DELETE'],
    },
    headers: {
      contentSecurityPolicy: "default-src 'self'; script-src 'self' 'unsafe-inline'",
      hsts: { maxAge: 31536000, includeSubDomains: true },
      noSniff: true,
      frameOptions: 'DENY',
      xssFilter: true,
    },
  },
});
```

### Advanced Health Checks

```typescript
const flowControl = await FlowControl.create({
  loadBalancer: {
    servers: [
      { host: 'api1.example.com', port: 443, protocol: 'https' },
      { host: 'api2.example.com', port: 443, protocol: 'https' },
    ],
    healthCheck: {
      enabled: true,
      endpoint: '/api/health',
      interval: 15000,          // Check every 15 seconds
      timeout: 3000,            // 3 second timeout
      protocol: 'https',        // Use HTTPS for health checks
      healthyThreshold: 2,      // 2 consecutive successes = healthy
      unhealthyThreshold: 3,    // 3 consecutive failures = unhealthy
    },
  },
});
```

### Circuit Breaker Pattern

```typescript
const flowControl = await FlowControl.create({
  loadBalancer: {
    servers: [
      { host: 'backend1.example.com', port: 8080 },
      { host: 'backend2.example.com', port: 8080 },
    ],
    algorithm: 'resilient-round-robin', // Uses circuit breakers
    healthCheck: {
      enabled: true,
      interval: 10000,
    },
  },
});

// Monitor circuit breaker status
app.get('/circuit-status', (req, res) => {
  const loadBalancer = flowControl.getLoadBalancer();
  const servers = loadBalancer?.getAllServers() || [];

  const circuitStatus = servers.map(server => ({
    server: `${server.host}:${server.port}`,
    healthy: server.isHealthy,
    circuitBreaker: server.circuitBreaker?.getStats(),
  }));

  res.json({ circuits: circuitStatus });
});
```

### Custom Key Generation

```typescript
const flowControl = await FlowControl.create({
  rateLimiter: {
    windowMs: 60000,
    maxRequests: 100,
    keyGenerator: (req) => {
      // Rate limit by API key instead of IP
      const apiKey = req.headers['x-api-key'];
      const userTier = req.headers['x-user-tier'];

      // Different limits for different user tiers
      if (userTier === 'premium') {
        return `premium:${apiKey}`;
      }
      return `standard:${apiKey || req.ip}`;
    },
  },
});
```

### Structured Logging Configuration

```typescript
const flowControl = await FlowControl.create({
  logging: {
    level: 'info',
    transports: [
      {
        type: 'console',
        level: 'debug',
        colorize: true,
      },
      {
        type: 'file',
        level: 'error',
        filename: 'logs/errors.log',
        maxFiles: 5,
        maxSize: '10mb',
      },
      {
        type: 'file',
        level: 'info',
        filename: 'logs/access.log',
        maxFiles: 10,
        maxSize: '50mb',
      },
    ],
  },
  // ... other configuration
});
```

### Health Monitoring Dashboard

```typescript
app.get('/health', (req, res) => {
  const stats = flowControl.getStats();
  const loadBalancer = flowControl.getLoadBalancer();
  const rateLimiter = flowControl.getRateLimiter();

  const healthyServers = loadBalancer?.getHealthyServers() || [];
  const allServers = loadBalancer?.getAllServers() || [];

  res.json({
    status: healthyServers.length > 0 ? 'healthy' : 'degraded',
    timestamp: new Date().toISOString(),
    servers: {
      healthy: healthyServers.length,
      total: allServers.length,
      details: allServers.map(server => ({
        host: server.host,
        port: server.port,
        healthy: server.isHealthy,
        lastCheck: server.lastHealthCheck,
      })),
    },
    rateLimiter: {
      activeKeys: stats.rateLimiter?.activeKeys || 0,
      totalRequests: stats.rateLimiter?.totalRequests || 0,
      blockedRequests: stats.rateLimiter?.blockedRequests || 0,
    },
    uptime: process.uptime(),
    memory: process.memoryUsage(),
  });
});
```

## API Reference

### FlowControl Class

#### Static Methods
```typescript
FlowControl.create(config: FlowControlConfig): Promise<FlowControl>
```
Creates a new FlowControl instance with validation and async initialization.

#### Instance Methods
- `getMiddleware(): FlowControlMiddleware` - Returns Express middleware
- `getRateLimiter(): FixedWindowRateLimiter | undefined` - Returns rate limiter instance
- `getLoadBalancer(): RoundRobinLoadBalancer | ResilientRoundRobinLoadBalancer | undefined` - Returns load balancer instance
- `getStats(): FlowControlStats` - Returns comprehensive statistics
- `getLogger(): Logger | undefined` - Returns configured logger instance
- `destroy(): Promise<void>` - Cleanup resources and close connections

#### Statistics Object
```typescript
interface FlowControlStats {
  rateLimiter?: {
    activeKeys: number;
    totalRequests: number;
    blockedRequests: number;
    hitRate: number;
  };
  loadBalancer?: {
    totalRequests: number;
    healthyServers: number;
    totalServers: number;
    serverStats: Map<string, ServerStats>;
  };
  security?: {
    blockedIPs: number;
    validationFailures: number;
    sanitizedRequests: number;
  };
}
```

## Performance

Flow-Control is designed for high performance:

- **Rate Limiting**: < 1ms overhead per request
- **Load Balancing**: < 0.5ms server selection time
- **Memory Usage**: Linear with active rate limit keys
- **Throughput**: Supports 10,000+ requests/second

## Testing

```bash
# Run all tests
yarn test

# Run tests with coverage
yarn test:coverage

# Run tests in watch mode
yarn test:watch
```

## Examples

See the [examples](./examples/) directory for complete working examples:

- [Rate Limiter Only](./examples/rate-limiter-only.ts)
- [Load Balancer Only](./examples/load-balancer-only.ts)
- [Combined Gateway](./examples/combined-gateway.ts)
- [Backend Server](./examples/backend-server.ts)

## Roadmap

### ✅ Phase 2 (Production Features) - COMPLETED
- ✅ Redis storage integration with cluster and sentinel support
- ✅ Advanced health checks (HTTP, HTTPS, TCP)
- ✅ Security enhancements (IP filtering, request validation, security headers)
- ✅ Circuit breaker patterns for resilience
- ✅ Structured logging with multiple transports
- ✅ Comprehensive configuration validation

### Phase 3 (Monitoring & Operations)
- Prometheus metrics export
- OpenTelemetry integration
- Performance optimizations
- Graceful shutdown handling
- Health check aggregation
- Custom middleware plugins

### Phase 4 (Advanced Features)
- Additional rate limiting algorithms (Sliding Window, Token Bucket)
- Additional load balancing algorithms (Weighted Round Robin, Least Connections)
- WebSocket proxy support
- API rate limiting with quotas
- Geographic load balancing
- Plugin ecosystem framework

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- 📚 [Documentation](./docs/)
- 🐛 [Issue Tracker](https://github.com/rohank05/throttle-balance/issues)
- 💬 [Discussions](https://github.com/rohank05/throttle-balance/discussions)

---

Built with ❤️ and TypeScript