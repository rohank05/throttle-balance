import express from 'express';
import { FlowControl } from '../src/index.js';

const app = express();

// Combined rate limiter + load balancer configuration
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60000, // 1 minute window
    maxRequests: 1000, // 1000 requests per minute per IP
    message: 'Rate limit exceeded. Please try again later.',
    headers: true, // Include rate limit headers in responses
  },
  loadBalancer: {
    servers: [
      { host: 'backend1.example.com', port: 8080, protocol: 'http' },
      { host: 'backend2.example.com', port: 8080, protocol: 'http' },
      { host: 'backend3.example.com', port: 8080, protocol: 'https' },
    ],
    algorithm: 'round-robin',
    healthCheck: {
      enabled: true,
      endpoint: '/health',
      interval: 15000, // Check every 15 seconds
      timeout: 3000, // 3 second timeout
      failureThreshold: 3, // Mark unhealthy after 3 failures
      successThreshold: 2, // Mark healthy after 2 successes
    },
    proxyTimeout: 25000,
    retryAttempts: 2,
  },
});

// Apply the combined middleware
app.use(flowControl.getMiddleware());

// Health check endpoint for the gateway itself
app.get('/gateway/health', (req, res) => {
  const stats = flowControl.getStats();
  const healthyServers = flowControl.getLoadBalancer()?.getHealthyServers() || [];

  res.json({
    status: healthyServers.length > 0 ? 'healthy' : 'degraded',
    rateLimiter: stats.rateLimiter,
    loadBalancer: {
      enabled: stats.loadBalancer.enabled,
      healthyServers: healthyServers.length,
      totalServers: flowControl.getLoadBalancer()?.getStats().serverStats.size || 0,
    },
    timestamp: new Date().toISOString(),
  });
});

// Statistics endpoint
app.get('/gateway/stats', (req, res) => {
  const stats = flowControl.getStats();
  res.json(stats);
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`API Gateway running on port ${port}`);
  console.log('Features enabled:');
  console.log('- Rate limiting: 1000 requests/minute per IP');
  console.log('- Load balancing: Round robin across backend servers');
  console.log('- Health checks: Every 15 seconds');
  console.log('');
  console.log('Gateway endpoints:');
  console.log(`- Health: http://localhost:${port}/gateway/health`);
  console.log(`- Stats: http://localhost:${port}/gateway/stats`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down API gateway gracefully...');
  flowControl.destroy();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Received SIGINT, shutting down API gateway gracefully...');
  flowControl.destroy();
  process.exit(0);
});