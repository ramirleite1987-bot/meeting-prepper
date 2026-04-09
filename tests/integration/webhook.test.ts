import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBHOOK_SECRET = 'test-webhook-secret-123';

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
    insertLinearSync: () =>
      testDb.prepare(
        'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (@id, @actionItemId, @meetingId, @linearIssueId, @source, @syncStatus)',
      ),
    getLinearSyncByIssue: () =>
      testDb.prepare('SELECT * FROM linear_sync WHERE linear_issue_id = ?'),
    getLinearSyncByMeeting: () =>
      testDb.prepare('SELECT * FROM linear_sync WHERE meeting_id = ?'),
    updateLinearSyncStatus: () =>
      testDb.prepare(
        'UPDATE linear_sync SET sync_status = @syncStatus, last_synced_at = CURRENT_TIMESTAMP WHERE id = @id',
      ),
    updateActionItemStatus: () =>
      testDb.prepare(
        'UPDATE action_items SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
      ),
    insertActionItem: () =>
      testDb.prepare(
        'INSERT INTO action_items (id, meeting_id, source, title, description, owner, deadline, priority, context_hash) VALUES (@id, @meetingId, @source, @title, @description, @owner, @deadline, @priority, @contextHash)',
      ),
    getActionItemsByMeeting: () =>
      testDb.prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at ASC'),
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

// Mock config with webhook secret
vi.mock('../../src/config.js', () => ({
  config: {
    port: 3000,
    nodeEnv: 'test',
    databasePath: ':memory:',
    logLevel: 'error',
    linearWebhookSecret: WEBHOOK_SECRET,
  },
}));

// Mock Linear adapter
vi.mock('../../src/adapters/linear.adapter.js', () => ({
  LinearAdapter: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Mock ReconciliationService
vi.mock('../../src/services/reconciliation.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/reconciliation.service.js')>();
  return {
    ...original,
    ReconciliationService: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      findExisting: vi.fn().mockResolvedValue(null),
      storeCrossReference: vi.fn(),
    })),
  };
});

const webhookRouter = (await import('../../src/routes/webhooks.js')).default;

function signPayload(body: object): string {
  const bodyStr = JSON.stringify(body);
  return crypto.createHmac('sha256', WEBHOOK_SECRET).update(bodyStr).digest('hex');
}

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/webhooks', webhookRouter);
  return app;
}

function seedData(): void {
  testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
  testDb
    .prepare(
      "INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)",
    )
    .run('m1', 'c1', 'Weekly', '2024-01-01', 'scheduled');
  testDb
    .prepare(
      "INSERT INTO action_items (id, meeting_id, source, title, context_hash, status) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run('ai-1', 'm1', 'krisp', 'Fix bug', 'hash-1', 'pending');
  testDb
    .prepare(
      "INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run('sync-1', 'ai-1', 'm1', 'linear-issue-1', 'linear', 'synced');
}

describe('Webhook Integration Tests', () => {
  let app: express.Express;

  beforeEach(() => {
    testDb = createTestDb();
    app = createApp();
  });

  describe('Signature Verification', () => {
    it('accepts request with valid signature', async () => {
      const payload = {
        type: 'Issue',
        action: 'update',
        data: { id: 'linear-issue-1', state: { name: 'Done' } },
      };

      const res = await request(app)
        .post('/webhooks/linear')
        .set('linear-signature', signPayload(payload))
        .send(payload);

      expect(res.status).toBe(200);
    });

    it('rejects request with missing signature', async () => {
      const payload = {
        type: 'Issue',
        action: 'update',
        data: { id: 'test-1', state: { name: 'Done' } },
      };

      const res = await request(app).post('/webhooks/linear').send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/missing signature/i);
    });

    it('rejects request with invalid signature', async () => {
      const payload = {
        type: 'Issue',
        action: 'update',
        data: { id: 'test-1', state: { name: 'Done' } },
      };

      const res = await request(app)
        .post('/webhooks/linear')
        .set('linear-signature', 'deadbeef'.repeat(8))
        .send(payload);

      expect(res.status).toBe(401);
      expect(res.body.error).toMatch(/invalid signature/i);
    });
  });

  describe('Status Update Processing', () => {
    it('returns 200 immediately for valid webhook', async () => {
      seedData();

      const payload = {
        type: 'Issue',
        action: 'update',
        data: { id: 'linear-issue-1', state: { name: 'In Progress' } },
      };

      const res = await request(app)
        .post('/webhooks/linear')
        .set('linear-signature', signPayload(payload))
        .send(payload);

      expect(res.status).toBe(200);
    });

    it('ignores non-Issue webhook types', async () => {
      const payload = {
        type: 'Comment',
        action: 'create',
        data: { id: 'comment-1' },
      };

      const res = await request(app)
        .post('/webhooks/linear')
        .set('linear-signature', signPayload(payload))
        .send(payload);

      expect(res.status).toBe(200);
    });

    it('handles webhook with missing state gracefully', async () => {
      const payload = {
        type: 'Issue',
        action: 'update',
        data: { id: 'linear-issue-1' },
      };

      const res = await request(app)
        .post('/webhooks/linear')
        .set('linear-signature', signPayload(payload))
        .send(payload);

      // Should still return 200 (async processing)
      expect(res.status).toBe(200);
    });
  });

  describe('Duplicate Event Handling', () => {
    it('handles duplicate webhook events without error', async () => {
      seedData();

      const payload = {
        type: 'Issue',
        action: 'update',
        data: { id: 'linear-issue-1', state: { name: 'Done' } },
      };

      const signature = signPayload(payload);

      // Send the same event twice
      const res1 = await request(app)
        .post('/webhooks/linear')
        .set('linear-signature', signature)
        .send(payload);

      const res2 = await request(app)
        .post('/webhooks/linear')
        .set('linear-signature', signature)
        .send(payload);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
    });

    it('processes webhook for unknown issue without crashing', async () => {
      const payload = {
        type: 'Issue',
        action: 'update',
        data: { id: 'unknown-issue-999', state: { name: 'Done' } },
      };

      const res = await request(app)
        .post('/webhooks/linear')
        .set('linear-signature', signPayload(payload))
        .send(payload);

      expect(res.status).toBe(200);
    });
  });
});
