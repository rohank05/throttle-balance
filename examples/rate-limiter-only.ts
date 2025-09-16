import express from 'express';
import { FlowControl } from '../src/index.js';

const app = express();

// Rate limiter only configuration
const flowControl = new FlowControl({
  rateLimiter: {
    windowMs: 60000, // 1 minute window
    maxRequests: 100, // Maximum 100 requests per window
    message: 'Too many requests from this IP, please try again later.',
  },
});

// Apply rate limiting middleware
app.use(flowControl.getMiddleware());

// Your regular routes
app.get('/', (req, res) => {
  res.json({ message: 'Hello World!' });
});

app.get('/api/data', (req, res) => {
  res.json({
    data: 'This endpoint is rate limited',
    timestamp: new Date().toISOString(),
  });
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Rate-limited server running on port ${port}`);
  console.log('Rate limit: 100 requests per minute');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  flowControl.destroy();
  process.exit(0);
});