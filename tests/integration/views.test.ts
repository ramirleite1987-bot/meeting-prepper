import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schemaPath = join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  db.exec(schema);
  return db;
}

vi.mock('../../src/db/index.js', () => {
  const getDb = () => testDb;

  const queries = {
    getAllClients: () => testDb.prepare('SELECT * FROM clients ORDER BY updated_at DESC'),
    getClientById: () => testDb.prepare('SELECT * FROM clients WHERE id = ?'),
    insertClient: () =>
      testDb.prepare('INSERT INTO clients (id, name, project) VALUES (@id, @name, @project)'),
    getMeetingById: () => testDb.prepare('SELECT * FROM meetings WHERE id = ?'),
    getMeetingsByClient: () =>
      testDb.prepare('SELECT * FROM meetings WHERE client_id = ? ORDER BY scheduled_at DESC'),
    getMeetingsByStatus: () =>
      testDb.prepare('SELECT * FROM meetings WHERE status = ? ORDER BY scheduled_at ASC'),
    getMeetingsByStatusWithClient: () =>
      testDb.prepare(
        'SELECT m.*, c.name AS client_name FROM meetings m LEFT JOIN clients c ON m.client_id = c.id WHERE m.status = ? ORDER BY m.scheduled_at ASC',
      ),
    getAllMeetings: () => testDb.prepare('SELECT * FROM meetings ORDER BY scheduled_at DESC'),
    getAllMeetingsWithClient: () =>
      testDb.prepare(
        'SELECT m.*, c.name AS client_name FROM meetings m LEFT JOIN clients c ON m.client_id = c.id ORDER BY m.scheduled_at DESC',
      ),
    getMeetingsWithClient: () =>
      testDb.prepare(
        'SELECT m.*, c.name AS client_name FROM meetings m LEFT JOIN clients c ON m.client_id = c.id WHERE m.status = ? ORDER BY m.scheduled_at ASC',
      ),
    getMeetingWithClient: () =>
      testDb.prepare(
        'SELECT m.*, c.name AS client_name FROM meetings m LEFT JOIN clients c ON m.client_id = c.id WHERE m.id = ?',
      ),
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

vi.mock('../../src/config.js', () => ({
  config: {
    port: 3000,
    nodeEnv: 'test',
    databasePath: ':memory:',
    logLevel: 'error',
  },
}));

vi.mock('../../src/services/notification.service.js', () => ({
  notificationService: {
    notify: vi.fn().mockResolvedValue(undefined),
    getRecentNotifications: vi.fn().mockReturnValue([]),
    subscribe: vi.fn().mockReturnValue(() => {}),
  },
}));

vi.mock('../../src/services/client-context.service.js', () => ({
  ClientContextService: vi.fn().mockImplementation(() => ({
    registerAdapter: vi.fn(),
    getClientContext: vi.fn().mockResolvedValue([]),
    // Read directly from testDb so seeded client_history shows up
    getClientTimeline: (clientId: string) =>
      testDb
        .prepare('SELECT * FROM client_history WHERE client_id = ? ORDER BY occurred_at DESC')
        .all(clientId),
  })),
}));

vi.mock('../../src/services/extraction.service.js', () => ({
  ExtractionService: vi.fn().mockImplementation(() => ({
    extract: vi.fn().mockResolvedValue({ sources: [], actionItems: [] }),
  })),
}));

vi.mock('../../src/services/sync.service.js', () => ({
  SyncService: vi.fn().mockImplementation(() => ({
    syncActionItem: vi.fn(),
    syncAllActionItems: vi.fn(),
    handleLinearUpdate: vi.fn(),
  })),
}));

// Prevent eager TokenManager singleton from calling getDb() before testDb is ready
vi.mock('../../src/utils/token-manager.js', () => ({
  tokenManager: {
    getValidToken: vi.fn().mockResolvedValue(null),
    storeToken: vi.fn(),
    registerRefreshFunction: vi.fn(),
    removeToken: vi.fn(),
  },
}));

vi.mock('../../src/utils/mcp-client.js', () => ({
  createMCPClient: vi.fn(),
}));

vi.mock('../../src/routes/api.js', () => ({
  clientContextService: {
    registerAdapter: vi.fn(),
    getClientContext: vi.fn().mockResolvedValue([]),
    getClientTimeline: (clientId: string) =>
      testDb
        .prepare('SELECT * FROM client_history WHERE client_id = ? ORDER BY occurred_at DESC')
        .all(clientId),
  },
  briefingService: {
    generateBriefing: vi.fn().mockResolvedValue(undefined),
  },
  meetingContextService: {
    getAttachedContextEntries: vi.fn().mockReturnValue([]),
    searchCandidates: vi.fn().mockResolvedValue([]),
    attachSelections: vi.fn().mockResolvedValue(0),
  },
}));

const { viewRouter } = await import('../../src/routes/views.js');
const { errorHandler } = await import('../../src/middleware/error-handler.js');

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  app.use('/', viewRouter);
  app.use(errorHandler);
  return app;
}

function seedData(): { clientId: string; meetingId: string } {
  testDb
    .prepare('INSERT INTO clients (id, name, project) VALUES (?, ?, ?)')
    .run('c1', 'Acme Corp', 'Project Phoenix');
  testDb
    .prepare(
      'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    )
    .run('m1', 'c1', 'Q2 Review', '2026-04-20T10:00:00Z', 'scheduled');
  return { clientId: 'c1', meetingId: 'm1' };
}

describe('HTML View Integration Tests', () => {
  let app: express.Express;

  beforeEach(() => {
    testDb = createTestDb();
    app = createApp();
  });

  describe('Dashboard', () => {
    it('GET / renders dashboard with meetings and clients', async () => {
      seedData();
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Acme Corp');
      expect(res.text).toContain('Q2 Review');
      expect(res.text).toContain('Generate Briefing');
    });

    it('GET / shows client_name next to each meeting', async () => {
      seedData();
      const res = await request(app).get('/').expect(200);
      // Client name should appear right before the middot
      expect(res.text).toMatch(/Acme Corp\s*&middot;/);
    });

    it('GET / shows "View Briefing" link when briefing exists', async () => {
      seedData();
      testDb
        .prepare('UPDATE meetings SET briefing = ? WHERE id = ?')
        .run(JSON.stringify({ clientName: 'Acme Corp', sections: {} }), 'm1');

      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('Briefing');
      expect(res.text).not.toContain('{{');
      expect(res.text).not.toContain('}}');
    });

    it('GET / shows "No upcoming meetings" when no meetings exist', async () => {
      testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Empty Corp');
      const res = await request(app).get('/').expect(200);
      expect(res.text).toContain('No meetings yet');
    });

    it('GET / does not leak raw template syntax', async () => {
      seedData();
      const res = await request(app).get('/').expect(200);
      expect(res.text).not.toMatch(/\{\{#if/);
      expect(res.text).not.toMatch(/\{\{#each/);
      expect(res.text).not.toMatch(/\{\{\/if/);
      expect(res.text).not.toMatch(/\{\{\/each/);
      expect(res.text).not.toMatch(/\{\{else/);
    });
  });

  describe('Briefing view', () => {
    it('GET /briefing/:id renders briefing sections from real BriefingService structure', async () => {
      seedData();
      const briefing = {
        clientName: 'Acme Corp',
        meetingId: 'm1',
        generatedAt: new Date().toISOString(),
        sections: {
          lastDeliveries: { title: 'Last Deliveries', items: ['Shipped v2'] },
          openItemsAndRisks: { title: 'Open Items & Risks', items: [] },
          recentAgreements: { title: 'Recent Agreements', items: [] },
          suggestedNextSteps: { title: 'Suggested Next Steps', items: ['Follow up on tasks'] },
          recommendedQuestions: {
            title: 'Recommended Questions',
            items: ['What are the priorities?'],
          },
        },
      };
      testDb
        .prepare('UPDATE meetings SET briefing = ? WHERE id = ?')
        .run(JSON.stringify(briefing), 'm1');

      const res = await request(app).get('/briefing/m1').expect(200);

      expect(res.text).toContain('Last Deliveries');
      expect(res.text).toContain('Shipped v2');
      expect(res.text).toContain('Recommended Questions');
      expect(res.text).toContain('What are the priorities?');
      expect(res.text).toContain('Suggested Next Steps');
      expect(res.text).toContain('Acme Corp');
      // Should not show "No briefing" when briefing exists
      expect(res.text).not.toContain('No briefing has been generated yet');
    });

    it('GET /briefing/:id hides empty sections', async () => {
      seedData();
      const briefing = {
        clientName: 'Acme Corp',
        meetingId: 'm1',
        generatedAt: new Date().toISOString(),
        sections: {
          lastDeliveries: { title: 'Last Deliveries', items: [] },
          openItemsAndRisks: { title: 'Open Items & Risks', items: [] },
          recentAgreements: { title: 'Recent Agreements', items: [] },
          suggestedNextSteps: { title: 'Suggested Next Steps', items: [] },
          recommendedQuestions: { title: 'Recommended Questions', items: ['Q1'] },
        },
      };
      testDb
        .prepare('UPDATE meetings SET briefing = ? WHERE id = ?')
        .run(JSON.stringify(briefing), 'm1');

      const res = await request(app).get('/briefing/m1').expect(200);

      // Only Recommended Questions section header should appear
      expect(res.text).not.toMatch(/<h2[^>]*>Last Deliveries<\/h2>/);
      expect(res.text).toMatch(/<h2[^>]*>Recommended Questions<\/h2>/);
    });

    it('GET /briefing/:id shows "No briefing" when none generated', async () => {
      seedData();
      const res = await request(app).get('/briefing/m1').expect(200);
      expect(res.text).toContain('No briefing has been generated yet');
    });

    it('GET /briefing/:id does not leak raw template tags', async () => {
      seedData();
      testDb.prepare('UPDATE meetings SET briefing = ? WHERE id = ?').run(
        JSON.stringify({
          clientName: 'Acme Corp',
          meetingId: 'm1',
          sections: {
            lastDeliveries: { title: 'Last', items: ['x'] },
            openItemsAndRisks: { title: 'Risks', items: [] },
            recentAgreements: { title: 'Agreements', items: [] },
            suggestedNextSteps: { title: 'Steps', items: [] },
            recommendedQuestions: { title: 'Q', items: ['q'] },
          },
        }),
        'm1',
      );
      const res = await request(app).get('/briefing/m1').expect(200);
      expect(res.text).not.toMatch(/\{\{#if/);
      expect(res.text).not.toMatch(/\{\{#each/);
      expect(res.text).not.toMatch(/\{\{\/if/);
      expect(res.text).not.toMatch(/\{\{\/each/);
    });

    it('GET /briefing/:id returns 404 for missing meeting', async () => {
      const res = await request(app).get('/briefing/nonexistent').expect(404);
      expect(res.text).toContain('Meeting not found');
    });
  });

  describe('Post-call view', () => {
    it('GET /post-call/:id renders post-call data and action items', async () => {
      seedData();
      testDb.prepare('UPDATE meetings SET post_call_notes = ? WHERE id = ?').run(
        JSON.stringify({
          summary: 'Discussed roadmap',
          decisions: ['Ship v2'],
          risks: ['Q2 deadline tight'],
        }),
        'm1',
      );
      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, priority, context_hash) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('ai-1', 'm1', 'krisp', 'Update docs', 'high', 'hash-1');

      const res = await request(app).get('/post-call/m1').expect(200);

      expect(res.text).toContain('Consolidated Summary');
      expect(res.text).toContain('Discussed roadmap');
      expect(res.text).toContain('Decisions');
      expect(res.text).toContain('Ship v2');
      expect(res.text).toContain('Risks');
      expect(res.text).toContain('Q2 deadline tight');
      expect(res.text).toContain('Update docs');
    });

    it('GET /post-call/:id uses correct sync button URLs', async () => {
      seedData();
      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, priority, context_hash) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('ai-1', 'm1', 'krisp', 'Task', 'high', 'hash-1');

      const res = await request(app).get('/post-call/m1').expect(200);

      // Sync buttons are now JS onclick-based; check correct function calls
      expect(res.text).toContain("syncItem('m1', 'ai-1')");
      expect(res.text).toContain("syncAll('m1')");
      // Bug URLs should not appear
      expect(res.text).not.toContain('/api/linear/sync');
      expect(res.text).not.toContain('/api/linear/sync-all');
    });

    it('GET /post-call/:id shows no post-call message when empty', async () => {
      seedData();
      const res = await request(app).get('/post-call/m1').expect(200);
      expect(res.text).toContain('No post-call review is available yet');
    });

    it('GET /post-call/:id displays client_name', async () => {
      seedData();
      const res = await request(app).get('/post-call/m1').expect(200);
      expect(res.text).toMatch(/Acme Corp\s*&middot;/);
    });

    it('GET /post-call/:id does not leak raw template tags', async () => {
      seedData();
      testDb
        .prepare('UPDATE meetings SET post_call_notes = ? WHERE id = ?')
        .run(JSON.stringify({ summary: 'x', decisions: ['d'], risks: ['r'] }), 'm1');
      testDb
        .prepare(
          'INSERT INTO action_items (id, meeting_id, source, title, priority, context_hash) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('ai-1', 'm1', 'krisp', 'Task', 'high', 'h1');

      const res = await request(app).get('/post-call/m1').expect(200);
      expect(res.text).not.toMatch(/\{\{#if/);
      expect(res.text).not.toMatch(/\{\{#each/);
      expect(res.text).not.toMatch(/\{\{\/if/);
      expect(res.text).not.toMatch(/\{\{\/each/);
      expect(res.text).not.toMatch(/\{\{else/);
    });
  });

  describe('Client detail view', () => {
    it('GET /clients/:id renders timeline events', async () => {
      seedData();
      testDb
        .prepare(
          'INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          'h1',
          'c1',
          'm1',
          'meeting',
          JSON.stringify({ title: 'Q2 Review', description: 'Great meeting' }),
        );
      testDb
        .prepare(
          'INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (?, ?, ?, ?, ?)',
        )
        .run(
          'h2',
          'c1',
          'm1',
          'task_created',
          JSON.stringify({ title: 'Fix', linear_issue_id: 'LIN-99' }),
        );

      const res = await request(app).get('/clients/c1').expect(200);
      expect(res.text).toContain('Acme Corp');
      expect(res.text).toContain('Q2 Review');
      expect(res.text).toContain('Great meeting');
      expect(res.text).toContain('Linear: LIN-99');
      expect(res.text).toContain('/briefing/m1');
    });

    it('GET /clients/:id shows empty state when no events', async () => {
      seedData();
      const res = await request(app).get('/clients/c1').expect(200);
      expect(res.text).toContain('No timeline events yet');
    });

    it('GET /clients/:id does not leak raw template tags', async () => {
      seedData();
      testDb
        .prepare(
          'INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (?, ?, ?, ?, ?)',
        )
        .run('h1', 'c1', 'm1', 'meeting', JSON.stringify({ title: 'Meet' }));
      const res = await request(app).get('/clients/c1').expect(200);
      expect(res.text).not.toMatch(/\{\{#if/);
      expect(res.text).not.toMatch(/\{\{#each/);
      expect(res.text).not.toMatch(/\{\{\/if/);
      expect(res.text).not.toMatch(/\{\{\/each/);
    });

    it('GET /clients/:id returns 404 for missing client', async () => {
      const res = await request(app).get('/clients/nonexistent').expect(404);
      expect(res.text).toContain('Client not found');
    });
  });
});
