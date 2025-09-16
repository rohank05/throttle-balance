# API Reference

## FlowControl

The main class that orchestrates rate limiting and load balancing functionality.

### Constructor

```typescript
new FlowControl(config: FlowControlConfig, logger?: Logger)
```

**Parameters:**
- `config`: Configuration object for rate limiter and/or load balancer
- `logger`: Optional custom logger (defaults to console-based logger)

**Example:**
```typescript
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60000,
    maxRequests: 100,
  },
  loadBalancer: {
    servers: [
      { host: 'backend.example.com', port: 8080 },
    ],
  },
});
```

### Methods

#### getMiddleware()

Returns an Express middleware function that applies rate limiting and/or load balancing.

```typescript
getMiddleware(): FlowControlMiddleware
```

**Returns:** Express middleware function

**Example:**
```typescript
const middleware = flowControl.getMiddleware();
app.use(middleware);
```

#### getRateLimiter()

Returns the rate limiter instance if configured.

```typescript
getRateLimiter(): FixedWindowRateLimiter | undefined
```

**Returns:** Rate limiter instance or undefined

#### getLoadBalancer()

Returns the load balancer instance if configured.

```typescript
getLoadBalancer(): RoundRobinLoadBalancer | undefined
```

**Returns:** Load balancer instance or undefined

#### getStats()

Returns current statistics for all enabled components.

```typescript
getStats(): object
```

**Returns:** Statistics object with rate limiter and load balancer stats

**Example:**
```typescript
const stats = flowControl.getStats();
console.log(stats);
// {
//   rateLimiter: { enabled: true },
//   loadBalancer: {
//     enabled: true,
//     totalRequests: 150,
//     totalErrors: 2,
//     serverStats: Map { ... }
//   }
// }
```

#### destroy()

Cleans up resources including timers and connections.

```typescript
destroy(): void
```

**Example:**
```typescript
process.on('SIGTERM', () => {
  flowControl.destroy();
  process.exit(0);
});
```

## FixedWindowRateLimiter

Rate limiter implementation using the Fixed Window Counter algorithm.

### Constructor

```typescript
new FixedWindowRateLimiter(config: RateLimiterConfig, store?: Store, logger?: Logger)
```

### Methods

#### checkLimit()

Checks if a request should be rate limited.

```typescript
checkLimit(req: Request): Promise<RateLimitResult>
```

**Parameters:**
- `req`: Express request object

**Returns:** Promise resolving to rate limit result

#### setHeaders()

Sets rate limit headers on the response.

```typescript
setHeaders(res: Response, rateLimitInfo: RateLimitInfo): void
```

#### sendRateLimitResponse()

Sends a rate limit exceeded response.

```typescript
sendRateLimitResponse(res: Response, rateLimitInfo: RateLimitInfo): void
```

## RoundRobinLoadBalancer

Load balancer implementation using Round Robin algorithm.

### Constructor

```typescript
new RoundRobinLoadBalancer(servers: ServerConfig[], healthCheckConfig?: HealthCheckConfig, logger?: Logger)
```

### Methods

#### getNextServer()

Returns the next server in the rotation.

```typescript
getNextServer(): ServerConfig | null
```

**Returns:** Next server configuration or null if no healthy servers

#### getHealthyServers()

Returns list of currently healthy servers.

```typescript
getHealthyServers(): ServerConfig[]
```

**Returns:** Array of healthy server configurations

#### getServerHealth()

Returns health information for a specific server.

```typescript
getServerHealth(server: ServerConfig): ServerHealth | undefined
```

#### checkServerHealth()

Performs a health check on a specific server.

```typescript
checkServerHealth(server: ServerConfig): Promise<boolean>
```

#### recordRequest()

Records request statistics for a server.

```typescript
recordRequest(server: ServerConfig, success: boolean, responseTime?: number): void
```

#### getStats()

Returns load balancer statistics.

```typescript
getStats(): LoadBalancerStats
```

## MemoryStore

In-memory storage implementation for rate limiting.

### Constructor

```typescript
new MemoryStore(cleanupIntervalMs?: number)
```

### Methods

#### get()

Retrieves a value by key.

```typescript
get(key: string): Promise<number | undefined>
```

#### set()

Sets a value with TTL.

```typescript
set(key: string, value: number, ttl: number): Promise<void>
```

#### increment()

Increments a value by 1.

```typescript
increment(key: string, ttl: number): Promise<number>
```

#### clear()

Clears all stored values.

```typescript
clear(): Promise<void>
```

## Type Definitions

### FlowControlConfig

```typescript
interface FlowControlConfig {
  rateLimiter?: RateLimiterConfig;
  loadBalancer?: LoadBalancerConfig;
}
```

### RateLimiterConfig

```typescript
interface RateLimiterConfig {
  windowMs: number;                    // Time window in milliseconds
  maxRequests: number;                 // Maximum requests per window
  keyGenerator?: KeyGenerator;         // Custom key generation function
  skip?: SkipFunction;                 // Skip rate limiting function
  message?: string;                    // Custom error message
  statusCode?: number;                 // HTTP status code (default: 429)
  headers?: boolean;                   // Include rate limit headers
  skipSuccessfulRequests?: boolean;    // Skip successful requests
  skipFailedRequests?: boolean;        // Skip failed requests
}
```

### LoadBalancerConfig

```typescript
interface LoadBalancerConfig {
  servers: ServerConfig[];             // Array of backend servers
  algorithm?: 'round-robin';           // Load balancing algorithm
  healthCheck?: HealthCheckConfig;     // Health check configuration
  proxyTimeout?: number;               // Proxy timeout in milliseconds
  retryAttempts?: number;              // Number of retry attempts
}
```

### ServerConfig

```typescript
interface ServerConfig {
  host: string;                        // Server hostname
  port: number;                        // Server port
  protocol?: 'http' | 'https';        // Protocol (default: 'http')
  weight?: number;                     // Server weight (future use)
  metadata?: Record<string, any>;      // Custom metadata
}
```

### HealthCheckConfig

```typescript
interface HealthCheckConfig {
  enabled?: boolean;                   // Enable health checks (default: true)
  endpoint?: string;                   // Health check endpoint (default: '/health')
  interval?: number;                   // Check interval in ms (default: 30000)
  timeout?: number;                    // Request timeout in ms (default: 5000)
  retries?: number;                    // Number of retries (default: 3)
  successThreshold?: number;           // Successes to mark healthy (default: 2)
  failureThreshold?: number;           // Failures to mark unhealthy (default: 3)
}
```

### RateLimitInfo

```typescript
interface RateLimitInfo {
  limit: number;                       // Request limit
  remaining: number;                   // Remaining requests
  resetTime: number;                   // When the window resets (timestamp)
  windowMs: number;                    // Window duration in ms
}
```

### ServerHealth

```typescript
interface ServerHealth {
  server: ServerConfig;                // Server configuration
  healthy: boolean;                    // Health status
  lastCheck: Date;                     // Last health check time
  consecutiveFailures: number;         // Consecutive failure count
  consecutiveSuccesses: number;        // Consecutive success count
  responseTime?: number;               // Last response time
  error?: string;                      // Last error message
}
```

### LoadBalancerStats

```typescript
interface LoadBalancerStats {
  totalRequests: number;               // Total requests processed
  totalErrors: number;                 // Total errors encountered
  serverStats: Map<string, ServerStats>; // Per-server statistics
}
```

### ServerStats

```typescript
interface ServerStats {
  requests: number;                    // Total requests to this server
  errors: number;                      // Total errors from this server
  totalResponseTime: number;           // Cumulative response time
  averageResponseTime: number;         // Average response time
  lastUsed: Date;                      // Last time server was used
}
```

## Function Types

### KeyGenerator

```typescript
type KeyGenerator = (req: Request) => string;
```

Function that generates a unique key for rate limiting based on the request.

### SkipFunction

```typescript
type SkipFunction = (req: Request) => boolean;
```

Function that determines whether to skip rate limiting for a request.

### FlowControlMiddleware

```typescript
type FlowControlMiddleware = (req: Request, res: Response, next: NextFunction) => void | Promise<void>;
```

Express middleware function type.

## Error Classes

### FlowControlError

Base error class for Flow-Control errors.

```typescript
class FlowControlError extends Error {
  public readonly code: string;
  public readonly statusCode: number;
}
```

### RateLimitError

Error thrown when rate limits are exceeded.

```typescript
class RateLimitError extends FlowControlError {
  public readonly rateLimitInfo: RateLimitInfo;
}
```

### LoadBalancerError

Error thrown by the load balancer.

```typescript
class LoadBalancerError extends FlowControlError {
  // Inherits from FlowControlError
}
```

## Usage Examples

### Custom Key Generator

```typescript
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60000,
    maxRequests: 100,
    keyGenerator: (req) => {
      // Rate limit by user ID from JWT token
      const token = req.headers.authorization?.split(' ')[1];
      const decoded = jwt.decode(token);
      return decoded?.sub || req.ip;
    },
  },
});
```

### Advanced Health Checks

```typescript
const flowControl = new FlowControl({
  loadBalancer: {
    servers: [
      { host: 'api1.example.com', port: 443, protocol: 'https' },
      { host: 'api2.example.com', port: 443, protocol: 'https' },
    ],
    healthCheck: {
      enabled: true,
      endpoint: '/api/health',
      interval: 10000,      // Check every 10 seconds
      timeout: 2000,        // 2 second timeout
      successThreshold: 3,  // Need 3 successes to mark healthy
      failureThreshold: 2,  // 2 failures to mark unhealthy
    },
  },
});
```

### Monitoring Integration

```typescript
// Prometheus metrics example
app.get('/metrics', (req, res) => {
  const stats = flowControl.getStats();
  const loadBalancer = flowControl.getLoadBalancer();

  let metrics = '';

  // Rate limiter metrics
  if (stats.rateLimiter.enabled) {
    metrics += '# HELP flow_control_rate_limit_enabled Rate limiter status\n';
    metrics += '# TYPE flow_control_rate_limit_enabled gauge\n';
    metrics += 'flow_control_rate_limit_enabled 1\n';
  }

  // Load balancer metrics
  if (stats.loadBalancer.enabled) {
    metrics += '# HELP flow_control_requests_total Total requests processed\n';
    metrics += '# TYPE flow_control_requests_total counter\n';
    metrics += `flow_control_requests_total ${stats.loadBalancer.totalRequests}\n`;

    metrics += '# HELP flow_control_errors_total Total errors encountered\n';
    metrics += '# TYPE flow_control_errors_total counter\n';
    metrics += `flow_control_errors_total ${stats.loadBalancer.totalErrors}\n`;

    const healthyServers = loadBalancer?.getHealthyServers() || [];
    metrics += '# HELP flow_control_healthy_servers Number of healthy servers\n';
    metrics += '# TYPE flow_control_healthy_servers gauge\n';
    metrics += `flow_control_healthy_servers ${healthyServers.length}\n`;
  }

  res.set('Content-Type', 'text/plain');
  res.send(metrics);
});
```