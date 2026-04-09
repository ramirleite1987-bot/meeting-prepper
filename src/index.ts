import express from 'express';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { getDb, closeDb } from './db/index.js';
import { errorHandler } from './middleware/error-handler.js';
import { logger } from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

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
  res.json({ status: 'ok' });
});

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
