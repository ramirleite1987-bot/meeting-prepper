import { describe, it, expect, vi, beforeEach } from 'vitest';
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
    getLinearSyncByMeeting: () =>
      testDb.prepare('SELECT * FROM linear_sync WHERE meeting_id = ?'),
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

// Mock external services with spies we can inspect
const mockGetClientContext = vi.fn().mockResolvedValue([
  {
    source: 'github',
    type: 'commit',
    title: 'feat: shipped v2',
    content: 'New feature release',
    timestamp: new Date(),
  },
]);

const mockExtract = vi.fn().mockResolvedValue({
  sources: [{ source: 'krisp', summary: 'Discussed roadmap and Q2 goals' }],
  actionItems: [
    {
      id: 'ai-1',
      title: 'Update roadmap doc',
      description: 'Reflect Q2 priorities',
      owner: 'Alice',
      priority: 'high',
      source: 'krisp',
    },
  ],
  summary: 'Roadmap review meeting',
});

const mockSyncActionItem = vi.fn().mockResolvedValue({
  actionItemId: 'ai-1',
  linearIssueId: 'LIN-42',
  status: 'created',
  taskReference: { id: 'LIN-42', title: 'Update roadmap doc', status: 'todo' },
});

const mockSyncAllActionItems = vi.fn().mockResolvedValue({
  meetingId: 'meeting-1',
  results: [
    {
      actionItemId: 'ai-1',
      linearIssueId: 'LIN-42',
      status: 'created',
    },
  ],
  errors: [],
});

const mockHandleLinearUpdate = vi.fn().mockResolvedValue(undefined);

vi.mock('../../src/services/client-context.service.js', () => ({
  ClientContextService: vi.fn().mockImplementation(() => ({
    getClientContext: mockGetClientContext,
  })),
}));

vi.mock('../../src/services/extraction.service.js', () => ({
  ExtractionService: vi.fn().mockImplementation(() => ({
    extract: mockExtract,
  })),
}));

vi.mock('../../src/services/sync.service.js', () => ({
  SyncService: vi.fn().mockImplementation(() => ({
    syncActionItem: mockSyncActionItem,
    syncAllActionItems: mockSyncAllActionItems,
    handleLinearUpdate: mockHandleLinearUpdate,
  })),
}));

// Mock webhook verify middleware to pass through
vi.mock('../../src/middleware/webhook-verify.js', () => ({
  webhookVerify: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Import after mocks
const { apiRouter } = await import('../../src/routes/api.js');
const webhookRouter = (await import('../../src/routes/webhooks.js')).default;
const { errorHandler } = await import('../../src/middleware/error-handler.js');

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use('/webhooks', webhookRouter);
  app.use(errorHandler);
  return app;
}

describe('E2E Full Meeting Lifecycle', () => {
  let app: express.Express;

  beforeEach(() => {
    testDb = createTestDb();
    app = createApp();
    vi.clearAllMocks();

    // Re-set default mock implementations after clearAllMocks
    mockGetClientContext.mockResolvedValue([
      {
        source: 'github',
        type: 'commit',
        title: 'feat: shipped v2',
        content: 'New feature release',
        timestamp: new Date(),
      },
    ]);
    mockExtract.mockResolvedValue({
      sources: [{ source: 'krisp', summary: 'Discussed roadmap and Q2 goals' }],
      actionItems: [
        {
          id: 'ai-1',
          title: 'Update roadmap doc',
          description: 'Reflect Q2 priorities',
          owner: 'Alice',
          priority: 'high',
          source: 'krisp',
        },
      ],
      summary: 'Roadmap review meeting',
    });
    mockSyncActionItem.mockResolvedValue({
      actionItemId: 'ai-1',
      linearIssueId: 'LIN-42',
      status: 'created',
      taskReference: { id: 'LIN-42', title: 'Update roadmap doc', status: 'todo' },
    });
    mockSyncAllActionItems.mockResolvedValue({
      meetingId: 'meeting-1',
      results: [{ actionItemId: 'ai-1', linearIssueId: 'LIN-42', status: 'created' }],
      errors: [],
    });
    mockHandleLinearUpdate.mockResolvedValue(undefined);
  });

  it('completes the full meeting lifecycle', async () => {
    // Step 1: Create client
    const clientRes = await request(app)
      .post('/api/clients')
      .send({ name: 'Acme Corp', project: 'Project Phoenix' })
      .expect(201);

    const clientId = clientRes.body.id;
    expect(clientRes.body.name).toBe('Acme Corp');
    expect(clientId).toBeDefined();

    // Step 2: Create meeting
    const meetingRes = await request(app)
      .post('/api/meetings')
      .send({ clientId, title: 'Q2 Roadmap Review', scheduledAt: '2026-04-15T10:00:00Z' })
      .expect(201);

    const meetingId = meetingRes.body.id;
    expect(meetingRes.body.title).toBe('Q2 Roadmap Review');
    expect(meetingRes.body.status).toBe('scheduled');

    // Step 3: Generate briefing
    const briefingRes = await request(app)
      .post(`/api/meetings/${meetingId}/prepare`)
      .expect(200);

    expect(briefingRes.body.clientName).toBe('Acme Corp');
    expect(briefingRes.body.meetingId).toBe(meetingId);
    expect(mockGetClientContext).toHaveBeenCalledWith('Acme Corp');

    // Step 4: Trigger extraction (mocked MCP)
    const extractRes = await request(app)
      .post(`/api/meetings/${meetingId}/extract`)
      .expect(200);

    expect(extractRes.body.summary).toBe('Roadmap review meeting');
    expect(extractRes.body.sources).toHaveLength(1);
    expect(mockExtract).toHaveBeenCalledWith(meetingId);

    // Step 5: Sync action items to Linear (mocked SDK)
    // First seed an action item in DB so sync endpoint works
    testDb
      .prepare(
        "INSERT INTO action_items (id, meeting_id, source, title, description, owner, priority, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run('ai-1', meetingId, 'krisp', 'Update roadmap doc', 'Reflect Q2 priorities', 'Alice', 'high', 'hash-abc');

    const syncRes = await request(app)
      .post(`/api/meetings/${meetingId}/action-items/ai-1/sync`)
      .expect(200);

    expect(syncRes.body.linearIssueId).toBe('LIN-42');
    expect(syncRes.body.status).toBe('created');
    expect(mockSyncActionItem).toHaveBeenCalledWith(meetingId, 'ai-1');

    // Step 6: Receive webhook status update
    const webhookRes = await request(app)
      .post('/webhooks/linear')
      .send({
        type: 'Issue',
        action: 'update',
        data: {
          id: 'LIN-42',
          state: { name: 'In Progress' },
        },
      })
      .expect(200);

    // Webhook processes asynchronously via setImmediate; wait for it
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockHandleLinearUpdate).toHaveBeenCalledWith({
      linearIssueId: 'LIN-42',
      status: 'In Progress',
    });

    // Step 7: Verify client history timeline
    // Seed history entries that would be created by the services
    testDb
      .prepare(
        "INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (?, ?, ?, ?, ?)",
      )
      .run('h1', clientId, meetingId, 'meeting', JSON.stringify({ title: 'Q2 Roadmap Review' }));
    testDb
      .prepare(
        "INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (?, ?, ?, ?, ?)",
      )
      .run('h2', clientId, meetingId, 'task_created', JSON.stringify({ title: 'Update roadmap doc', linearIssueId: 'LIN-42' }));
    testDb
      .prepare(
        "INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (?, ?, ?, ?, ?)",
      )
      .run('h3', clientId, meetingId, 'status_change', JSON.stringify({ linearIssueId: 'LIN-42', status: 'In Progress' }));

    const timelineRes = await request(app)
      .get(`/api/clients/${clientId}/timeline`)
      .expect(200);

    expect(timelineRes.body).toHaveLength(3);
    const eventTypes = timelineRes.body.map((e: { event_type: string }) => e.event_type);
    expect(eventTypes).toContain('meeting');
    expect(eventTypes).toContain('task_created');
    expect(eventTypes).toContain('status_change');
  });

  // ──────────────────────────────────────────────
  // Idempotent Re-sync
  // ──────────────────────────────────────────────

  it('handles idempotent re-sync of action items', async () => {
    // Setup: create client, meeting, action item
    testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
    testDb
      .prepare(
        "INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run('m1', 'c1', 'Weekly', '2026-04-15', 'scheduled');
    testDb
      .prepare(
        "INSERT INTO action_items (id, meeting_id, source, title, description, owner, priority, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run('ai-1', 'm1', 'krisp', 'Fix bug', 'Critical fix', 'Bob', 'high', 'hash-123');

    // First sync
    mockSyncActionItem.mockResolvedValue({
      actionItemId: 'ai-1',
      linearIssueId: 'LIN-99',
      status: 'created',
      taskReference: { id: 'LIN-99', title: 'Fix bug', status: 'todo' },
    });

    const firstSync = await request(app)
      .post('/api/meetings/m1/action-items/ai-1/sync')
      .expect(200);

    expect(firstSync.body.status).toBe('created');

    // Second sync (idempotent) — service should handle gracefully
    mockSyncActionItem.mockResolvedValue({
      actionItemId: 'ai-1',
      linearIssueId: 'LIN-99',
      status: 'updated',
      taskReference: { id: 'LIN-99', title: 'Fix bug', status: 'todo' },
    });

    const secondSync = await request(app)
      .post('/api/meetings/m1/action-items/ai-1/sync')
      .expect(200);

    expect(secondSync.body.linearIssueId).toBe('LIN-99');
    expect(mockSyncActionItem).toHaveBeenCalledTimes(2);
  });

  // ──────────────────────────────────────────────
  // Graceful Degradation
  // ──────────────────────────────────────────────

  it('degrades gracefully when extraction service fails', async () => {
    testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
    testDb
      .prepare(
        "INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run('m1', 'c1', 'Weekly', '2026-04-15', 'scheduled');

    mockExtract.mockRejectedValue(new Error('MCP connection timeout'));

    const res = await request(app)
      .post('/api/meetings/m1/extract')
      .expect(500);

    expect(res.body.error).toBeDefined();
  });

  it('degrades gracefully when sync service fails', async () => {
    testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
    testDb
      .prepare(
        "INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run('m1', 'c1', 'Weekly', '2026-04-15', 'scheduled');
    testDb
      .prepare(
        "INSERT INTO action_items (id, meeting_id, source, title, description, owner, priority, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .run('ai-1', 'm1', 'krisp', 'Task', 'Desc', 'Owner', 'medium', 'hash-x');

    mockSyncActionItem.mockRejectedValue(new Error('Linear API unavailable'));

    const res = await request(app)
      .post('/api/meetings/m1/action-items/ai-1/sync')
      .expect(500);

    expect(res.body.error).toBeDefined();
  });

  it('degrades gracefully when client context service fails during briefing', async () => {
    testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
    testDb
      .prepare(
        "INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)",
      )
      .run('m1', 'c1', 'Weekly', '2026-04-15', 'scheduled');

    mockGetClientContext.mockRejectedValue(new Error('GitHub API rate limited'));

    const res = await request(app)
      .post('/api/meetings/m1/prepare')
      .expect(500);

    expect(res.body.error).toBeDefined();
  });

  it('ignores non-Issue webhook payloads', async () => {
    await request(app)
      .post('/webhooks/linear')
      .send({
        type: 'Comment',
        action: 'create',
        data: { id: 'comment-1' },
      })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockHandleLinearUpdate).not.toHaveBeenCalled();
  });

  it('handles webhook with missing state gracefully', async () => {
    await request(app)
      .post('/webhooks/linear')
      .send({
        type: 'Issue',
        action: 'update',
        data: { id: 'LIN-99' },
      })
      .expect(200);

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(mockHandleLinearUpdate).toHaveBeenCalledWith({
      linearIssueId: 'LIN-99',
      status: 'Unknown',
    });
  });
});
