import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Create in-memory database and mock before importing app modules
let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schemaPath = join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  return db;
}

// Mock the database module
vi.mock('../../src/db/index.js', () => {
  // Lazy references to testDb (set in beforeEach)
  const getDb = () => testDb;

  const queries = {
    getAllClients: () => testDb.prepare('SELECT * FROM clients ORDER BY updated_at DESC'),
    getClientById: () => testDb.prepare('SELECT * FROM clients WHERE id = ?'),
    insertClient: () =>
      testDb.prepare('INSERT INTO clients (id, name, project) VALUES (@id, @name, @project)'),
    updateClient: () =>
      testDb.prepare(
        'UPDATE clients SET name = @name, project = @project, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
      ),
    getMeetingById: () => testDb.prepare('SELECT * FROM meetings WHERE id = ?'),
    getMeetingsByClient: () =>
      testDb.prepare('SELECT * FROM meetings WHERE client_id = ? ORDER BY scheduled_at DESC'),
    getMeetingsByStatus: () =>
      testDb.prepare('SELECT * FROM meetings WHERE status = ? ORDER BY scheduled_at ASC'),
    insertMeeting: () =>
      testDb.prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (@id, @clientId, @title, @scheduledAt, @status)',
      ),
    updateMeetingBriefing: () =>
      testDb.prepare(
        'UPDATE meetings SET briefing = @briefing, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
      ),
    updateMeetingPostCall: () =>
      testDb.prepare(
        "UPDATE meetings SET post_call_notes = @postCallNotes, status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = @id",
      ),
    insertMeetingSource: () =>
      testDb.prepare(
        'INSERT INTO meeting_sources (id, meeting_id, source, external_id, summary, decisions, risks, raw_data) VALUES (@id, @meetingId, @source, @externalId, @summary, @decisions, @risks, @rawData)',
      ),
    getMeetingSourcesByMeeting: () =>
      testDb.prepare('SELECT * FROM meeting_sources WHERE meeting_id = ?'),
    insertActionItem: () =>
      testDb.prepare(
        'INSERT INTO action_items (id, meeting_id, source, title, description, owner, deadline, priority, context_hash) VALUES (@id, @meetingId, @source, @title, @description, @owner, @deadline, @priority, @contextHash)',
      ),
    getActionItemsByMeeting: () =>
      testDb.prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at ASC'),
    getActionItemByHash: () => testDb.prepare('SELECT * FROM action_items WHERE context_hash = ?'),
    updateActionItemStatus: () =>
      testDb.prepare(
        'UPDATE action_items SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
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
    insertClientHistory: () =>
      testDb.prepare(
        'INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (@id, @clientId, @meetingId, @eventType, @eventData)',
      ),
    getClientHistory: () =>
      testDb.prepare('SELECT * FROM client_history WHERE client_id = ? ORDER BY occurred_at DESC'),
  };

  return { getDb, closeDb: vi.fn(), queries };
});

// Mock the logger
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
    linearWebhookSecret: 'test-secret',
  },
}));

// Mock notification service
vi.mock('../../src/services/notification.service.js', () => ({
  notificationService: {
    notify: vi.fn().mockResolvedValue(undefined),
    getRecentNotifications: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
}));

// Mock external services used by routes
vi.mock('../../src/services/client-context.service.js', () => ({
  ClientContextService: vi.fn().mockImplementation(() => ({
    getClientContext: vi.fn().mockResolvedValue([
      {
        source: 'test',
        type: 'commit',
        title: 'feat: shipped v2',
        content: 'New feature release',
        timestamp: new Date(),
      },
    ]),
  })),
}));

vi.mock('../../src/services/extraction.service.js', () => ({
  ExtractionService: vi.fn().mockImplementation(() => ({
    extract: vi.fn().mockResolvedValue({
      sources: [{ source: 'krisp', summary: 'Test meeting notes' }],
      actionItems: [],
      summary: 'Test summary',
    }),
  })),
}));

vi.mock('../../src/services/sync.service.js', () => ({
  SyncService: vi.fn().mockImplementation(() => ({
    syncActionItem: vi.fn().mockResolvedValue({
      actionItemId: 'item-1',
      linearIssueId: 'LIN-1',
      status: 'created',
      taskReference: { id: 'LIN-1', title: 'Test', status: 'todo' },
    }),
    syncAllActionItems: vi.fn().mockResolvedValue({
      meetingId: 'meeting-1',
      results: [],
      errors: [],
    }),
    handleLinearUpdate: vi.fn().mockResolvedValue(undefined),
  })),
}));

// Import after mocks
const { apiRouter } = await import('../../src/routes/api.js');
const { errorHandler } = await import('../../src/middleware/error-handler.js');

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use(errorHandler);
  return app;
}

describe('API Integration Tests', () => {
  let app: express.Express;

  beforeEach(() => {
    testDb = createTestDb();
    app = createApp();
  });

  // ──────────────────────────────────────────────
  // Clients CRUD
  // ──────────────────────────────────────────────

  describe('Clients', () => {
    it('POST /api/clients creates a new client', async () => {
      const res = await request(app)
        .post('/api/clients')
        .send({ name: 'Acme Corp', project: 'Project X' })
        .expect(201);

      expect(res.body.name).toBe('Acme Corp');
      expect(res.body.project).toBe('Project X');
      expect(res.body.id).toBeDefined();
    });

    it('POST /api/clients returns 400 when name is missing', async () => {
      const res = await request(app).post('/api/clients').send({ project: 'No Name' }).expect(400);

      expect(res.body.error).toMatch(/name is required/i);
    });

    it('GET /api/clients returns all clients', async () => {
      // Seed
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Client A');
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c2', 'Client B');

      const res = await request(app).get('/api/clients').expect(200);

      expect(res.body).toHaveLength(2);
    });

    it('GET /api/clients/:id returns a single client', async () => {
      testDb
        .prepare('INSERT INTO clients (id, name, project) VALUES (?, ?, ?)')
        .run('c1', 'Acme', 'Proj');

      const res = await request(app).get('/api/clients/c1').expect(200);

      expect(res.body.name).toBe('Acme');
      expect(res.body.project).toBe('Proj');
    });

    it('GET /api/clients/:id returns 404 for missing client', async () => {
      const res = await request(app).get('/api/clients/nonexistent').expect(404);

      expect(res.body.error).toMatch(/not found/i);
    });

    it('GET /api/clients/:id/timeline returns client history', async () => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
      testDb
        .prepare(
          'INSERT INTO client_history (id, client_id, event_type, event_data) VALUES (?, ?, ?, ?)',
        )
        .run('h1', 'c1', 'meeting', '{"note":"test"}');

      const res = await request(app).get('/api/clients/c1/timeline').expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].event_type).toBe('meeting');
    });

    it('GET /api/clients/:id/timeline returns 404 for missing client', async () => {
      await request(app).get('/api/clients/nonexistent/timeline').expect(404);
    });
  });

  // ──────────────────────────────────────────────
  // Meetings CRUD
  // ──────────────────────────────────────────────

  describe('Meetings', () => {
    beforeEach(() => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
    });

    it('POST /api/meetings creates a meeting', async () => {
      const res = await request(app)
        .post('/api/meetings')
        .send({ clientId: 'c1', title: 'Weekly Sync' })
        .expect(201);

      expect(res.body.title).toBe('Weekly Sync');
      expect(res.body.client_id).toBe('c1');
      expect(res.body.status).toBe('scheduled');
    });

    it('POST /api/meetings returns 400 without required fields', async () => {
      await request(app).post('/api/meetings').send({ title: 'No client' }).expect(400);
    });

    it('POST /api/meetings returns 404 for invalid clientId', async () => {
      const res = await request(app)
        .post('/api/meetings')
        .send({ clientId: 'nonexistent', title: 'Test' })
        .expect(404);

      expect(res.body.error).toMatch(/Client not found/i);
    });

    it('GET /api/meetings/:id returns a meeting', async () => {
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m1', 'c1', 'Sync', '2024-01-01', 'scheduled');

      const res = await request(app).get('/api/meetings/m1').expect(200);

      expect(res.body.title).toBe('Sync');
    });

    it('GET /api/meetings/:id returns 404 for missing meeting', async () => {
      await request(app).get('/api/meetings/nonexistent').expect(404);
    });

    it('GET /api/meetings filters by status', async () => {
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m1', 'c1', 'Sync 1', '2024-01-01', 'scheduled');
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m2', 'c1', 'Sync 2', '2024-01-02', 'completed');

      const res = await request(app).get('/api/meetings?status=completed').expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe('Sync 2');
    });

    it('GET /api/meetings filters by clientId', async () => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c2', 'Other');
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m1', 'c1', 'Acme Sync', '2024-01-01', 'scheduled');
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m2', 'c2', 'Other Sync', '2024-01-01', 'scheduled');

      const res = await request(app).get('/api/meetings?clientId=c1').expect(200);

      expect(res.body).toHaveLength(1);
      expect(res.body[0].title).toBe('Acme Sync');
    });
  });

  // ──────────────────────────────────────────────
  // Briefing generation via API
  // ──────────────────────────────────────────────

  describe('Briefing', () => {
    beforeEach(() => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m1', 'c1', 'Weekly', '2024-01-01', 'scheduled');
    });

    it('POST /api/meetings/:id/prepare generates a briefing', async () => {
      const res = await request(app).post('/api/meetings/m1/prepare').expect(200);

      expect(res.body).toBeDefined();
      expect(res.body.clientName).toBe('Acme');
      expect(res.body.meetingId).toBe('m1');
    });

    it('POST /api/meetings/:id/prepare returns 404 for missing meeting', async () => {
      await request(app).post('/api/meetings/nonexistent/prepare').expect(404);
    });

    it('GET /api/meetings/:id/briefing returns 404 when no briefing exists', async () => {
      const res = await request(app).get('/api/meetings/m1/briefing').expect(404);

      expect(res.body.error).toMatch(/no briefing/i);
    });

    it('GET /api/meetings/:id/briefing returns stored briefing', async () => {
      const briefingData = JSON.stringify({ clientName: 'Acme', sections: {} });
      testDb.prepare('UPDATE meetings SET briefing = ? WHERE id = ?').run(briefingData, 'm1');

      const res = await request(app).get('/api/meetings/m1/briefing').expect(200);

      expect(res.body.clientName).toBe('Acme');
    });
  });

  // ──────────────────────────────────────────────
  // Stats
  // ──────────────────────────────────────────────

  describe('Stats', () => {
    it('GET /api/stats returns the full payload shape', async () => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
      testDb
        .prepare('INSERT INTO meetings (id, client_id, title, status) VALUES (?, ?, ?, ?)')
        .run('m1', 'c1', 'M1', 'completed');

      const res = await request(app).get('/api/stats').expect(200);
      expect(res.body.clients.total).toBe(1);
      expect(res.body.meetings.total).toBe(1);
      expect(res.body).toHaveProperty('topClients');
      expect(res.body).toHaveProperty('topOwners');
      expect(res.body).toHaveProperty('averages');
      expect(res.body).toHaveProperty('linearSync');
    });
  });

  // ──────────────────────────────────────────────
  // Briefing markdown export
  // ──────────────────────────────────────────────

  describe('Briefing markdown export', () => {
    beforeEach(() => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status, briefing) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'm1',
          'c1',
          'Quarterly review',
          '2026-05-01T10:00:00Z',
          'scheduled',
          JSON.stringify({
            executiveSummary: 'Annual planning sync.',
            keyTopics: ['Roadmap', 'Hiring'],
          }),
        );
      testDb
        .prepare('INSERT INTO meetings (id, client_id, title, status) VALUES (?, ?, ?, ?)')
        .run('m2', 'c1', 'No briefing yet', 'scheduled');
    });

    it('GET /api/meetings/:id/briefing.md returns markdown with attachment header', async () => {
      const res = await request(app).get('/api/meetings/m1/briefing.md').expect(200);
      expect(res.headers['content-type']).toMatch(/text\/markdown/);
      expect(res.headers['content-disposition']).toMatch(/attachment/);
      expect(res.headers['content-disposition']).toMatch(/quarterly-review/);
      expect(res.text).toContain('# Quarterly review');
      expect(res.text).toContain('**Client:** Acme');
      expect(res.text).toContain('## Executive Summary');
      expect(res.text).toContain('## Key Topics');
      expect(res.text).toContain('- Roadmap');
    });

    it('GET /api/meetings/:id/briefing.md?inline=1 sets inline disposition', async () => {
      const res = await request(app).get('/api/meetings/m1/briefing.md?inline=1').expect(200);
      expect(res.headers['content-disposition']).toMatch(/inline/);
    });

    it('GET /api/meetings/:id/briefing.md returns 404 when no briefing exists', async () => {
      await request(app).get('/api/meetings/m2/briefing.md').expect(404);
    });

    it('GET /api/meetings/:id/briefing.md returns 404 for unknown meeting', async () => {
      await request(app).get('/api/meetings/nope/briefing.md').expect(404);
    });
  });

  // ──────────────────────────────────────────────
  // Agenda
  // ──────────────────────────────────────────────

  describe('Agenda', () => {
    it('GET /api/agenda returns buckets and a next field', async () => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
      const future = new Date(Date.now() + 60 * 60_000).toISOString();
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m1', 'c1', 'Soon', future, 'scheduled');

      const res = await request(app).get('/api/agenda').expect(200);
      expect(res.body).toHaveProperty('buckets');
      expect(res.body).toHaveProperty('next');
      expect(res.body.next?.id).toBe('m1');
    });
  });

  // ──────────────────────────────────────────────
  // Action items inbox
  // ──────────────────────────────────────────────

  describe('Action items inbox', () => {
    beforeEach(() => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c2', 'Globex');
      testDb
        .prepare('INSERT INTO meetings (id, client_id, title, status) VALUES (?, ?, ?, ?)')
        .run('m1', 'c1', 'Acme weekly', 'completed');
      testDb
        .prepare('INSERT INTO meetings (id, client_id, title, status) VALUES (?, ?, ?, ?)')
        .run('m2', 'c2', 'Globex sync', 'completed');

      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, description, owner, priority, status, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('a1', 'm1', 'manual', 'Ship dashboard', 'Build it', 'alice', 'high', 'pending', 'h1');
      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, description, owner, priority, status, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('a2', 'm1', 'manual', 'Update docs', null, 'bob', 'low', 'completed', 'h2');
      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, description, owner, priority, status, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run('a3', 'm2', 'manual', 'Renew contract', null, 'alice', 'medium', 'synced', 'h3');
    });

    it('GET /api/action-items returns all items joined with meeting + client', async () => {
      const res = await request(app).get('/api/action-items').expect(200);
      expect(res.body.total).toBe(3);
      expect(res.body.items).toHaveLength(3);
      const titles = res.body.items.map((i: { title: string }) => i.title).sort();
      expect(titles).toEqual(['Renew contract', 'Ship dashboard', 'Update docs']);
      expect(res.body.items[0]).toHaveProperty('client_name');
      expect(res.body.items[0]).toHaveProperty('meeting_title');
    });

    it('GET /api/action-items filters by status', async () => {
      const res = await request(app).get('/api/action-items?status=pending').expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].title).toBe('Ship dashboard');
    });

    it('GET /api/action-items filters by priority', async () => {
      const res = await request(app).get('/api/action-items?priority=high').expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].id).toBe('a1');
    });

    it('GET /api/action-items filters by owner', async () => {
      const res = await request(app).get('/api/action-items?owner=alice').expect(200);
      expect(res.body.total).toBe(2);
    });

    it('GET /api/action-items combines filters', async () => {
      const res = await request(app)
        .get('/api/action-items?owner=alice&status=pending')
        .expect(200);
      expect(res.body.total).toBe(1);
      expect(res.body.items[0].id).toBe('a1');
    });

    it('GET /api/action-items ignores invalid status', async () => {
      const res = await request(app).get('/api/action-items?status=bogus').expect(200);
      expect(res.body.total).toBe(3);
    });

    it('GET /api/action-items/owners returns distinct owners', async () => {
      const res = await request(app).get('/api/action-items/owners').expect(200);
      expect(res.body.owners).toEqual(['alice', 'bob']);
    });

    it('PATCH /api/action-items/:id/status updates status', async () => {
      const res = await request(app)
        .patch('/api/action-items/a1/status')
        .send({ status: 'completed' })
        .expect(200);
      expect(res.body.status).toBe('completed');

      const recheck = await request(app).get('/api/action-items?status=completed').expect(200);
      expect(recheck.body.total).toBe(2);
    });

    it('PATCH /api/action-items/:id/status rejects invalid status', async () => {
      const res = await request(app)
        .patch('/api/action-items/a1/status')
        .send({ status: 'in-flight' })
        .expect(400);
      expect(res.body.error).toMatch(/status must be/);
    });

    it('PATCH /api/action-items/:id/status returns 404 for unknown id', async () => {
      await request(app)
        .patch('/api/action-items/unknown/status')
        .send({ status: 'completed' })
        .expect(404);
    });
  });

  // ──────────────────────────────────────────────
  // Search
  // ──────────────────────────────────────────────

  describe('Search', () => {
    beforeEach(() => {
      testDb
        .prepare('INSERT INTO clients (id, name, project) VALUES (?, ?, ?)')
        .run('c1', 'Acme Corp', 'Project Apollo');
      testDb
        .prepare('INSERT INTO clients (id, name, project) VALUES (?, ?, ?)')
        .run('c2', 'Globex', 'Saturn');
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status, briefing) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'm1',
          'c1',
          'Apollo kickoff sync',
          '2026-04-30T10:00:00Z',
          'scheduled',
          JSON.stringify({ summary: 'Discuss launch plan for Apollo release' }),
        );
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m2', 'c2', 'Saturn weekly', '2026-04-30T11:00:00Z', 'scheduled');
      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, description, owner, priority, status, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'a1',
          'm1',
          'manual',
          'Ship Apollo dashboard',
          'Build the new analytics dashboard for the Apollo project',
          'alice',
          'high',
          'pending',
          'hash-1',
        );
      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, description, owner, priority, status, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .run(
          'a2',
          'm2',
          'manual',
          'Renew Saturn contract',
          null,
          'bob',
          'medium',
          'pending',
          'hash-2',
        );
    });

    it('GET /api/search returns matches across clients, meetings, and action items', async () => {
      const res = await request(app).get('/api/search?q=apollo').expect(200);

      expect(res.body.query).toBe('apollo');
      expect(res.body.total).toBeGreaterThanOrEqual(3);
      expect(res.body.counts.clients).toBeGreaterThanOrEqual(1);
      expect(res.body.counts.meetings).toBeGreaterThanOrEqual(1);
      expect(res.body.counts.action_items).toBeGreaterThanOrEqual(1);

      const types = res.body.results.map((r: { type: string }) => r.type);
      expect(types).toContain('client');
      expect(types).toContain('meeting');
      expect(types).toContain('action_item');
    });

    it('GET /api/search returns empty result for empty query', async () => {
      const res = await request(app).get('/api/search?q=').expect(200);
      expect(res.body.total).toBe(0);
      expect(res.body.results).toEqual([]);
    });

    it('GET /api/search matches action item owner', async () => {
      const res = await request(app).get('/api/search?q=alice').expect(200);
      const actionHits = res.body.results.filter((r: { type: string }) => r.type === 'action_item');
      expect(actionHits.length).toBeGreaterThanOrEqual(1);
      expect(actionHits[0].title).toBe('Ship Apollo dashboard');
    });

    it('GET /api/search escapes LIKE wildcards in user input', async () => {
      const res = await request(app).get('/api/search?q=%25').expect(200);
      expect(res.body.total).toBe(0);
    });
  });

  // ──────────────────────────────────────────────
  // Error responses
  // ──────────────────────────────────────────────

  describe('Error Responses', () => {
    it('returns JSON error format for all errors', async () => {
      const res = await request(app).get('/api/clients/nonexistent').expect(404);

      expect(res.body).toHaveProperty('error');
      expect(typeof res.body.error).toBe('string');
    });

    it('returns 404 for meeting action items on nonexistent meeting', async () => {
      await request(app).get('/api/meetings/nonexistent/action-items').expect(404);
    });

    it('returns 404 for post-call on nonexistent meeting', async () => {
      await request(app).get('/api/meetings/nonexistent/post-call').expect(404);
    });
  });
});
