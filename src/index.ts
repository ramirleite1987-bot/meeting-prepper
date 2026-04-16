import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { traceId } from './middleware/trace-id.js';
import { apiRouter } from './routes/api.js';
import { viewRouter } from './routes/views.js';
import webhookRouter from './routes/webhooks.js';
import { logger } from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(traceId);

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    logger.info('HTTP request', {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - start,
      traceId: req.traceId,
    });
  });
  next();
});

// CORS for development
if (config.nodeEnv === 'development') {
  app.use((_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (_req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
  });
}

// Static files
app.use(express.static(join(__dirname, '..', 'public')));

// Health check
app.get('/health', (_req, res) => {
  try {
    const db = getDb();
    db.prepare('SELECT 1').get();
    res.json({ status: 'ok', database: 'connected' });
  } catch {
    res.status(503).json({ status: 'error', database: 'disconnected' });
  }
});

// Webhook routes
app.use('/webhooks', webhookRouter);

// API routes
app.use('/api', apiRouter);

// View routes
app.use('/', viewRouter);

// Error handler (must be last)
app.use(errorHandler);

// Initialize database and start server
function start(): void {
  getDb();

  const server = app.listen(config.port, () => {
    logger.info('Server started', { port: config.port, env: config.nodeEnv });
  });

  const shutdown = (): void => {
    logger.info('Shutting down...');
    server.close(() => {
      closeDb();
      process.exit(0);
    });
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

start();

export { app };
