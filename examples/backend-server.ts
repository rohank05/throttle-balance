import express from 'express';

const app = express();
const port = process.env.PORT || 3001;
const serverName = process.env.SERVER_NAME || `Backend-${port}`;

app.use(express.json());

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    server: serverName,
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
  });
});

// Sample API endpoints
app.get('/api/users', (req, res) => {
  res.json({
    users: [
      { id: 1, name: 'John Doe', email: 'john@example.com' },
      { id: 2, name: 'Jane Smith', email: 'jane@example.com' },
    ],
    server: serverName,
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/users/:id', (req, res) => {
  const userId = parseInt(req.params.id);
  const user = { id: userId, name: `User ${userId}`, email: `user${userId}@example.com` };

  res.json({
    user,
    server: serverName,
    timestamp: new Date().toISOString(),
  });
});

app.post('/api/users', (req, res) => {
  const newUser = {
    id: Math.floor(Math.random() * 1000),
    ...req.body,
    createdAt: new Date().toISOString(),
  };

  res.status(201).json({
    message: 'User created successfully',
    user: newUser,
    server: serverName,
    timestamp: new Date().toISOString(),
  });
});

// Simulate processing delay
app.get('/api/slow', (req, res) => {
  const delay = Math.floor(Math.random() * 2000) + 500; // 500-2500ms delay

  setTimeout(() => {
    res.json({
      message: 'Slow response completed',
      delay: `${delay}ms`,
      server: serverName,
      timestamp: new Date().toISOString(),
    });
  }, delay);
});

// Error simulation endpoint
app.get('/api/error', (req, res) => {
  const shouldError = Math.random() < 0.3; // 30% chance of error

  if (shouldError) {
    res.status(500).json({
      error: 'Simulated server error',
      server: serverName,
      timestamp: new Date().toISOString(),
    });
  } else {
    res.json({
      message: 'Success response',
      server: serverName,
      timestamp: new Date().toISOString(),
    });
  }
});

app.listen(port, () => {
  console.log(`${serverName} running on port ${port}`);
  console.log('Available endpoints:');
  console.log(`- GET  /health`);
  console.log(`- GET  /api/users`);
  console.log(`- GET  /api/users/:id`);
  console.log(`- POST /api/users`);
  console.log(`- GET  /api/slow (simulates processing delay)`);
  console.log(`- GET  /api/error (randomly returns errors)`);
});

process.on('SIGTERM', () => {
  console.log(`${serverName} shutting down gracefully...`);
  process.exit(0);
});