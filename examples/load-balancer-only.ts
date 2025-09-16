import express from 'express';
import { FlowControl } from '../src/index.js';

const app = express();

// Load balancer only configuration
const flowControl = new FlowControl({
  loadBalancer: {
    servers: [
      { host: 'localhost', port: 3001, protocol: 'http' },
      { host: 'localhost', port: 3002, protocol: 'http' },
      { host: 'localhost', port: 3003, protocol: 'http' },
    ],
    algorithm: 'round-robin',
    healthCheck: {
      enabled: true,
      endpoint: '/health',
      interval: 30000, // Check every 30 seconds
      timeout: 5000, // 5 second timeout
    },
    proxyTimeout: 30000, // 30 second proxy timeout
  },
});

// Apply load balancing middleware to all routes
app.use(flowControl.getMiddleware());

// Health endpoint for the load balancer itself
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// Stats endpoint to see load balancer statistics
app.get('/stats', (req, res) => {
  const stats = flowControl.getStats();
  res.json(stats);
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Load balancer running on port ${port}`);
  console.log('Backend servers:');
  console.log('- http://localhost:3001');
  console.log('- http://localhost:3002');
  console.log('- http://localhost:3003');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  flowControl.destroy();
  process.exit(0);
});