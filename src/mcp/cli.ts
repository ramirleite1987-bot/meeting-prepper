/**
 * Bootstrap for `npm run mcp`. Starts an MCP server over StreamableHTTP
 * with bearer-token auth on a dedicated port.
 *
 * Required env:
 *   MCP_SERVER_TOKEN — non-empty bearer token. Without it, the server
 *                      refuses to start (no public default).
 *
 * Optional env:
 *   MCP_PORT — default 3001.
 *
 * The transport runs in stateless mode (no session IDs); a single user
 * with sequential calls is the assumed shape. If you need multi-client
 * concurrency or resumption, switch to stateful mode with a session
 * generator.
 */

import express from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { closeDb, getDb } from '../db/index.js';
import { logger } from '../utils/logger.js';
import { createMcpServer } from './server.js';

const log = logger.child('McpServer');

async function main(): Promise<void> {
  const token = process.env.MCP_SERVER_TOKEN;
  if (!token) {
    log.error('MCP_SERVER_TOKEN is required. Set it before starting the MCP server.');
    process.exit(1);
  }

  const port = Number(process.env.MCP_PORT ?? '3001');
  if (!Number.isFinite(port) || port <= 0) {
    log.error('Invalid MCP_PORT', { value: process.env.MCP_PORT });
    process.exit(1);
  }

  // Touch the DB once up front so migrations run before the first request.
  getDb();

  const mcp = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
  });
  await mcp.connect(transport);

  const app = express();
  app.use(express.json({ limit: '1mb' }));

  // Bearer auth on the /mcp endpoint. Use timingSafeEqual-style compare
  // to avoid timing leaks on the token.
  const expectedHeader = `Bearer ${token}`;
  app.use('/mcp', (req, res, next) => {
    const provided = req.headers.authorization ?? '';
    if (provided.length !== expectedHeader.length) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    let mismatch = 0;
    for (let i = 0; i < provided.length; i++) {
      mismatch |= provided.charCodeAt(i) ^ expectedHeader.charCodeAt(i);
    }
    if (mismatch !== 0) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    next();
  });

  app.post('/mcp', async (req, res) => {
    try {
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log.error('MCP request failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      if (!res.headersSent) {
        res.status(500).json({ error: 'Internal MCP error' });
      }
    }
  });

  const server = app.listen(port, () => {
    log.info('MCP server listening', { port });
  });

  const shutdown = async (): Promise<void> => {
    log.info('Shutting down MCP server...');
    server.close();
    await mcp.close();
    closeDb();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  logger.child('McpServer').error('Failed to start', {
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
});
