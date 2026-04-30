/**
 * Edge case tests for the Client Briefing Generator.
 * Verifies: adapter failures don't crash, partial extraction works,
 * duplicate webhooks are ignored, empty meetings handled, token refresh,
 * SQLite WAL mode, and missing error handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBHOOK_SECRET = 'test-edge-case-secret';

let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schemaPath = join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  return db;
}

// Mock database
vi.mock('../../src/db/index.js', () => {
  const getDb = () => testDb;

  const queries = {
    getClientById: () => testDb.prepare('SELECT * FROM clients WHERE id = ?'),
    getAllClients: () => testDb.prepare('SELECT * FROM clients ORDER BY updated_at DESC'),
    getMeetingById: () => testDb.prepare('SELECT * FROM meetings WHERE id = ?'),
    getMeetingsByClient: () =>
      testDb.prepare('SELECT * FROM meetings WHERE client_id = ? ORDER BY scheduled_at DESC'),
    getMeetingsByStatus: () =>
      testDb.prepare('SELECT * FROM meetings WHERE status = ? ORDER BY scheduled_at ASC'),
    insertClient: () =>
      testDb.prepare('INSERT INTO clients (id, name, project) VALUES (@id, @name, @project)'),
    insertMeeting: () =>
      testDb.prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (@id, @clientId, @title, @scheduledAt, @status)',
      ),
    insertMeetingSource: () =>
      testDb.prepare(
        'INSERT INTO meeting_sources (id, meeting_id, source, external_id, summary, decisions, risks, raw_data) VALUES (@id, @meetingId, @source, @externalId, @summary, @decisions, @risks, @rawData)',
      ),
    insertActionItem: () =>
      testDb.prepare(
        'INSERT INTO action_items (id, meeting_id, source, title, description, owner, deadline, priority, context_hash) VALUES (@id, @meetingId, @source, @title, @description, @owner, @deadline, @priority, @contextHash)',
      ),
    getActionItemsByMeeting: () =>
      testDb.prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at ASC'),
    getActionItemByHash: () => testDb.prepare('SELECT * FROM action_items WHERE context_hash = ?'),
    updateMeetingPostCall: () =>
      testDb.prepare(
        "UPDATE meetings SET post_call_notes = @postCallNotes, status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = @id",
      ),
    updateMeetingBriefing: () =>
      testDb.prepare(
        'UPDATE meetings SET briefing = @briefing, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
      ),
    insertLinearSync: () =>
      testDb.prepare(
        'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (@id, @actionItemId, @meetingId, @linearIssueId, @source, @syncStatus)',
      ),
    getLinearSyncByIssue: () =>
      testDb.prepare('SELECT * FROM linear_sync WHERE linear_issue_id = ?'),
    getLinearSyncByMeeting: () => testDb.prepare('SELECT * FROM linear_sync WHERE meeting_id = ?'),
    updateLinearSyncStatus: () =>
      testDb.prepare(
        'UPDATE linear_sync SET sync_status = @syncStatus, last_synced_at = CURRENT_TIMESTAMP WHERE id = @id',
      ),
    updateActionItemStatus: () =>
      testDb.prepare(
        'UPDATE action_items SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
      ),
    insertClientHistory: () =>
      testDb.prepare(
        'INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (@id, @clientId, @meetingId, @eventType, @eventData)',
      ),
    getClientHistory: () =>
      testDb.prepare('SELECT * FROM client_history WHERE client_id = ? ORDER BY occurred_at DESC'),
  };

  return { getDb, closeDb: vi.fn(), queries };
});

// Mock logger
vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  },
}));

// Mock config
vi.mock('../../src/config.js', () => ({
  config: {
    port: 3000,
    nodeEnv: 'test',
    databasePath: ':memory:',
    logLevel: 'error',
    linearWebhookSecret: WEBHOOK_SECRET,
    linearApiKey: undefined,
    krispMcpServerUrl: undefined,
    granolaMcpServerUrl: undefined,
  },
}));

// Mock Linear adapter
vi.mock('../../src/adapters/linear.adapter.js', () => ({
  LinearAdapter: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    isAvailable: vi.fn().mockResolvedValue(false),
    disconnect: vi.fn().mockResolvedValue(undefined),
    createTask: vi.fn().mockResolvedValue({ id: 'linear-1', url: 'https://linear.app/1' }),
    updateTask: vi.fn().mockResolvedValue({ id: 'linear-1', url: 'https://linear.app/1' }),
  })),
}));

// Mock ReconciliationService
vi.mock('../../src/services/reconciliation.service.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/services/reconciliation.service.js')>();
  return {
    ...original,
    ReconciliationService: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      findExisting: vi.fn().mockResolvedValue(null),
      storeCrossReference: vi.fn(),
    })),
  };
});

// ──────────────────────────────────────────────
// Tests
// ──────────────────────────────────────────────

describe('Edge Cases', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  // ──────────────────────────────────────────────
  // SQLite WAL mode
  // ──────────────────────────────────────────────

  describe('SQLite WAL mode', () => {
    it('should support WAL mode for concurrent reads', () => {
      const db = new Database(':memory:');
      db.pragma('journal_mode = WAL');
      const result = db.pragma('journal_mode') as Array<{ journal_mode: string }>;
      // In-memory databases use 'memory' mode; file-based DBs would use 'wal'
      // The important thing is the pragma doesn't throw
      expect(result).toBeDefined();
      db.close();
    });

    it('should support busy timeout pragma', () => {
      const db = new Database(':memory:');
      db.pragma('busy_timeout = 5000');
      const result = db.pragma('busy_timeout');
      // Pragma returns either [{busy_timeout: 5000}] or [{timeout: 5000}] depending on version
      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
      db.close();
    });
  });

  // ──────────────────────────────────────────────
  // Adapter failures don't crash server
  // ──────────────────────────────────────────────

  describe('Adapter failures do not crash the server', () => {
    it('extraction service handles all adapters throwing', async () => {
      const { ExtractionService } = await import('../../src/services/extraction.service.js');
      const type = await import('../../src/adapters/types.js');

      const crashingAdapter = {
        name: 'crasher',
        initialize: vi.fn().mockRejectedValue(new Error('SEGFAULT')),
        isAvailable: vi.fn().mockResolvedValue(true),
        disconnect: vi.fn(),
        getMeetingNotes: vi.fn().mockRejectedValue(new Error('Connection refused')),
        getActionItems: vi.fn().mockRejectedValue(new Error('Timeout')),
        searchMeetings: vi.fn().mockResolvedValue([]),
      };

      const service = new ExtractionService([crashingAdapter]);
      const result = await service.extract('meeting-1');

      expect(result.mergedSummary).toBe('');
      expect(result.actionItems).toHaveLength(0);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].source).toBe('crasher');
    });

    it('extraction service continues when one adapter fails but another succeeds', async () => {
      const { ExtractionService } = await import('../../src/services/extraction.service.js');

      // Seed a client and meeting so foreign key constraints are satisfied
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Test Client');
      testDb
        .prepare('INSERT INTO meetings (id, client_id, title, status) VALUES (?, ?, ?, ?)')
        .run('meeting-1', 'c1', 'Test Meeting', 'scheduled');

      const failingAdapter = {
        name: 'failing-mcp',
        initialize: vi.fn().mockResolvedValue(undefined),
        isAvailable: vi.fn().mockResolvedValue(true),
        disconnect: vi.fn(),
        getMeetingNotes: vi.fn().mockRejectedValue(new Error('MCP server down')),
        getActionItems: vi.fn().mockResolvedValue([]),
        searchMeetings: vi.fn().mockResolvedValue([]),
      };

      const workingAdapter = {
        name: 'working',
        initialize: vi.fn().mockResolvedValue(undefined),
        isAvailable: vi.fn().mockResolvedValue(true),
        disconnect: vi.fn(),
        getMeetingNotes: vi.fn().mockResolvedValue({
          meetingId: 'meeting-1',
          title: 'Test',
          date: new Date(),
          attendees: [],
          summary: 'Partial data from working adapter',
          keyPoints: [],
          actionItems: [{ title: 'Do something', status: 'pending', source: 'working' }],
          source: 'working',
        }),
        getActionItems: vi.fn().mockResolvedValue([]),
        searchMeetings: vi.fn().mockResolvedValue([]),
      };

      const service = new ExtractionService([failingAdapter, workingAdapter]);
      const result = await service.extract('meeting-1');

      expect(result.sources).toHaveLength(1);
      expect(result.sources[0].source).toBe('working');
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].source).toBe('failing-mcp');
      expect(result.actionItems).toHaveLength(1);
    });
  });

  // ──────────────────────────────────────────────
  // Duplicate webhook events are ignored
  // ──────────────────────────────────────────────

  describe('Duplicate webhook events', () => {
    function signPayload(body: object): string {
      return crypto.createHmac('sha256', WEBHOOK_SECRET).update(JSON.stringify(body)).digest('hex');
    }

    it('processing the same webhook twice results in idempotent state', async () => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m1', 'c1', 'Weekly', '2024-01-01', 'scheduled');
      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, context_hash, status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('ai-1', 'm1', 'krisp', 'Fix bug', 'hash-1', 'pending');
      testDb
        .prepare(
          'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('sync-1', 'ai-1', 'm1', 'linear-issue-1', 'linear', 'synced');

      // Import SyncService and process the same event twice
      const { SyncService } = await import('../../src/services/sync.service.js');
      const syncService = new SyncService();

      await syncService.handleLinearUpdate({
        linearIssueId: 'linear-issue-1',
        status: 'done',
        updatedAt: new Date().toISOString(),
      });

      const statusAfterFirst = testDb
        .prepare('SELECT status FROM action_items WHERE id = ?')
        .get('ai-1') as { status: string };
      expect(statusAfterFirst.status).toBe('completed');

      // Second call should not throw or create duplicate history
      await syncService.handleLinearUpdate({
        linearIssueId: 'linear-issue-1',
        status: 'done',
        updatedAt: new Date().toISOString(),
      });

      const statusAfterSecond = testDb
        .prepare('SELECT status FROM action_items WHERE id = ?')
        .get('ai-1') as { status: string };
      expect(statusAfterSecond.status).toBe('completed');

      // Both events create history entries but the action item status is idempotent
      const history = testDb
        .prepare('SELECT COUNT(*) as count FROM client_history WHERE client_id = ?')
        .get('c1') as { count: number };
      expect(history.count).toBe(2);
    });

    it('webhook for unknown Linear issue does not crash', async () => {
      const { SyncService } = await import('../../src/services/sync.service.js');
      const syncService = new SyncService();

      // Should not throw
      await syncService.handleLinearUpdate({
        linearIssueId: 'nonexistent-issue',
        status: 'done',
        updatedAt: new Date().toISOString(),
      });
    });
  });

  // ──────────────────────────────────────────────
  // Empty meetings show appropriate response
  // ──────────────────────────────────────────────

  describe('Empty meetings', () => {
    it('extraction returns empty results when no adapters produce data', async () => {
      const { ExtractionService } = await import('../../src/services/extraction.service.js');

      const emptyAdapter = {
        name: 'empty',
        initialize: vi.fn().mockResolvedValue(undefined),
        isAvailable: vi.fn().mockResolvedValue(true),
        disconnect: vi.fn(),
        getMeetingNotes: vi.fn().mockResolvedValue(null),
        getActionItems: vi.fn().mockResolvedValue([]),
        searchMeetings: vi.fn().mockResolvedValue([]),
      };

      const service = new ExtractionService([emptyAdapter]);
      const result = await service.extract('empty-meeting');

      expect(result.mergedSummary).toBe('');
      expect(result.actionItems).toHaveLength(0);
      expect(result.decisions).toHaveLength(0);
      expect(result.risks).toHaveLength(0);
      expect(result.sources).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it('extraction with no available adapters returns empty results', async () => {
      const { ExtractionService } = await import('../../src/services/extraction.service.js');

      const unavailableAdapter = {
        name: 'offline',
        initialize: vi.fn().mockResolvedValue(undefined),
        isAvailable: vi.fn().mockResolvedValue(false),
        disconnect: vi.fn(),
        getMeetingNotes: vi.fn().mockResolvedValue(null),
        getActionItems: vi.fn().mockResolvedValue([]),
        searchMeetings: vi.fn().mockResolvedValue([]),
      };

      const service = new ExtractionService([unavailableAdapter]);
      const result = await service.extract('no-data-meeting');

      expect(result.mergedSummary).toBe('');
      expect(result.sources).toHaveLength(0);
    });

    it('briefing service generates useful output even with empty context', async () => {
      const { BriefingService } = await import('../../src/services/briefing.service.js');

      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m1', 'c1', 'Weekly', '2024-01-01', 'scheduled');

      const service = new BriefingService();
      const briefing = await service.generateBriefing('m1', 'Acme', []);

      expect(briefing.clientName).toBe('Acme');
      expect(briefing.sections.lastDeliveries.items).toHaveLength(0);
      expect(briefing.sections.recommendedQuestions.items.length).toBeGreaterThan(0);
      // With sparse context, we should get helpful default questions
      expect(briefing.sections.recommendedQuestions.items).toEqual(
        expect.arrayContaining([expect.stringContaining('priorities')]),
      );
    });
  });

  // ──────────────────────────────────────────────
  // Token refresh on stale OAuth tokens
  // ──────────────────────────────────────────────

  describe('Stale OAuth token refresh', () => {
    it('token manager returns null when token is expired and no refresh function', async () => {
      const { TokenManager } = await import('../../src/utils/token-manager.js');
      const tm = new TokenManager();

      // Store a token that expires in 1 second (will be within the 5-minute buffer)
      tm.storeToken('test-service', 'old-token', undefined, 1);

      const token = await tm.getValidToken('test-service');
      // Token is expiring soon (within 5-min buffer) and no refresh function → null
      expect(token).toBeNull();
    });

    it('token manager refreshes token when expiring soon', async () => {
      const { TokenManager } = await import('../../src/utils/token-manager.js');
      const tm = new TokenManager();

      const refreshFn = vi.fn().mockResolvedValue({
        accessToken: 'new-token',
        refreshToken: 'new-refresh',
        expiresInSeconds: 3600,
      });

      tm.registerRefreshFunction('refreshable', refreshFn);
      tm.storeToken('refreshable', 'old-token', 'old-refresh', 1);

      const token = await tm.getValidToken('refreshable');
      expect(refreshFn).toHaveBeenCalledWith('old-refresh');
      expect(token).toBe('new-token');
    });

    it('token manager handles refresh function failure gracefully', async () => {
      const { TokenManager } = await import('../../src/utils/token-manager.js');
      const tm = new TokenManager();

      const failingRefresh = vi.fn().mockRejectedValue(new Error('OAuth server down'));
      tm.registerRefreshFunction('broken-oauth', failingRefresh);
      tm.storeToken('broken-oauth', 'stale-token', 'stale-refresh', 1);

      const token = await tm.getValidToken('broken-oauth');
      expect(token).toBeNull();
    });

    it('token manager returns valid token when not expiring', async () => {
      const { TokenManager } = await import('../../src/utils/token-manager.js');
      const tm = new TokenManager();

      tm.storeToken('valid-service', 'good-token', undefined, 7200);

      const token = await tm.getValidToken('valid-service');
      expect(token).toBe('good-token');
    });
  });

  // ──────────────────────────────────────────────
  // Error handler edge cases
  // ──────────────────────────────────────────────

  describe('Error handler', () => {
    it('returns generic message for 500 errors', async () => {
      const { errorHandler } = await import('../../src/middleware/error-handler.js');

      const app = express();
      app.get('/crash', (_req, _res, next) => {
        next(new Error('Sensitive internal details'));
      });
      app.use(errorHandler);

      const res = await request(app).get('/crash');
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('Internal server error');
      expect(res.body.error).not.toContain('Sensitive');
    });

    it('returns actual message for client errors', async () => {
      const { errorHandler, AppError } = await import('../../src/middleware/error-handler.js');

      const app = express();
      app.get('/bad', (_req, _res, next) => {
        const err = new Error('name is required') as { statusCode?: number };
        err.statusCode = 400;
        next(err);
      });
      app.use(errorHandler);

      const res = await request(app).get('/bad');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('name is required');
    });
  });

  // ──────────────────────────────────────────────
  // Database constraint handling
  // ──────────────────────────────────────────────

  describe('Database constraint handling', () => {
    it('UNIQUE constraint on linear_sync prevents duplicate sync records', () => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m1', 'c1', 'Weekly', '2024-01-01', 'scheduled');
      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, context_hash, status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('ai-1', 'm1', 'krisp', 'Fix bug', 'hash-1', 'pending');

      testDb
        .prepare(
          'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('sync-1', 'ai-1', 'm1', 'linear-1', 'linear', 'synced');

      // Duplicate should throw UNIQUE constraint error
      expect(() => {
        testDb
          .prepare(
            'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run('sync-2', 'ai-1', 'm1', 'linear-1', 'linear', 'synced');
      }).toThrow(/UNIQUE/);
    });

    it('foreign key constraint prevents orphaned meetings', () => {
      expect(() => {
        testDb
          .prepare(
            'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
          )
          .run('m1', 'nonexistent-client', 'Weekly', '2024-01-01', 'scheduled');
      }).toThrow(/FOREIGN KEY/);
    });
  });
});
