import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

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

// Mock database
vi.mock('../../src/db/index.js', () => {
  const getDb = () => testDb;

  const queries = {
    getClientById: () => testDb.prepare('SELECT * FROM clients WHERE id = ?'),
    getClientByName: () => testDb.prepare('SELECT * FROM clients WHERE lower(name) = lower(?)'),
    getAllClients: () => testDb.prepare('SELECT * FROM clients ORDER BY updated_at DESC'),
    insertClient: () =>
      testDb.prepare(
        'INSERT INTO clients (id, name, kind, project, aliases) VALUES (@id, @name, @kind, @project, @aliases)',
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
    getAllLinearSync: () => testDb.prepare('SELECT * FROM linear_sync ORDER BY last_synced_at ASC'),
    getActionItemById: () => testDb.prepare('SELECT * FROM action_items WHERE id = ?'),
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
    gogBin: 'gog',
    gogGmailLabel: 'Processes',
    googleSyncLookbackDays: 30,
    googleSyncMaxResults: 25,
  },
}));

// Mock Linear adapter to avoid real API calls
const mockGetTaskStatus = vi.fn().mockResolvedValue('todo');
const mockCreateTask = vi
  .fn()
  .mockImplementation((task: { title: string; meetingId?: string }) => ({
    id: `linear-${randomUUID().slice(0, 8)}`,
    externalId: 'LIN-123',
    source: 'linear',
    title: task.title,
    status: 'todo',
    meetingId: task.meetingId,
    createdAt: new Date(),
    updatedAt: new Date(),
  }));

vi.mock('../../src/adapters/linear.adapter.js', () => ({
  LinearAdapter: vi.fn().mockImplementation(() => ({
    initialize: vi.fn().mockResolvedValue(undefined),
    createTask: mockCreateTask,
    getTaskStatus: mockGetTaskStatus,
    updateTask: vi.fn().mockImplementation((id: string) => ({
      id,
      externalId: 'LIN-123',
      source: 'linear',
      title: 'Updated',
      status: 'in-progress',
      createdAt: new Date(),
      updatedAt: new Date(),
    })),
  })),
}));

// Mock ReconciliationService - default to no existing match
const mockFindExisting = vi.fn().mockResolvedValue(null);
const mockStoreCrossReference = vi.fn();

vi.mock('../../src/services/reconciliation.service.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/services/reconciliation.service.js')>();
  return {
    ...original,
    ReconciliationService: vi.fn().mockImplementation(() => ({
      initialize: vi.fn().mockResolvedValue(undefined),
      findExisting: mockFindExisting,
      storeCrossReference: mockStoreCrossReference,
    })),
  };
});

const { SyncService } = await import('../../src/services/sync.service.js');
const { queries } = await import('../../src/db/index.js');

function seedBasicData() {
  testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme Corp');
  testDb
    .prepare(
      'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    )
    .run('m1', 'c1', 'Weekly Sync', '2024-01-01', 'scheduled');
}

function seedActionItem(id: string, meetingId: string, title: string, contextHash: string): void {
  testDb
    .prepare(
      'INSERT INTO action_items (id, meeting_id, source, title, description, owner, priority, context_hash, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      id,
      meetingId,
      'krisp',
      title,
      'Description',
      'owner@test.com',
      'high',
      contextHash,
      'pending',
    );
}

describe('Sync Flow Integration Tests', () => {
  let syncService: InstanceType<typeof SyncService>;

  beforeEach(() => {
    testDb = createTestDb();
    syncService = new SyncService();
    mockCreateTask.mockClear();
    mockGetTaskStatus.mockReset().mockResolvedValue('todo');
    mockFindExisting.mockReset().mockResolvedValue(null);
    mockStoreCrossReference.mockReset();
  });

  describe('Action Item → Linear Sync', () => {
    it('creates a Linear issue for a new action item', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Fix authentication bug', 'hash-1');

      const result = await syncService.syncActionItem('m1', 'ai-1');

      expect(result.actionItemId).toBe('ai-1');
      expect(result.linearIssueId).toBeDefined();
      expect(result.status).toBe('created');
      expect(result.taskReference).toBeDefined();
    });

    it('adds new action items to the selected Linear project', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Fix authentication bug', 'hash-1');

      await syncService.syncActionItem('m1', 'ai-1', { projectId: 'project-1' });

      expect(mockCreateTask).toHaveBeenCalledWith(
        expect.objectContaining({
          metadata: { linearProjectId: 'project-1' },
        }),
      );
    });

    it('stores cross-reference after creating a Linear issue', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Deploy new feature', 'hash-2');

      await syncService.syncActionItem('m1', 'ai-1');

      expect(mockStoreCrossReference).toHaveBeenCalledWith(
        expect.objectContaining({
          meetingId: 'm1',
          source: 'linear',
          linearIssueId: expect.any(String),
        }),
        'ai-1',
      );
    });

    it('updates existing Linear issue when reconciliation finds match', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Update docs', 'hash-3');

      mockFindExisting.mockResolvedValueOnce({
        id: 'existing-linear-id',
        externalId: 'LIN-99',
        source: 'linear',
        title: 'Update docs',
        status: 'todo',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await syncService.syncActionItem('m1', 'ai-1');

      expect(result.status).toBe('updated');
      expect(result.linearIssueId).toBe('existing-linear-id');
    });

    it('throws error for nonexistent action item', async () => {
      seedBasicData();

      await expect(syncService.syncActionItem('m1', 'nonexistent')).rejects.toThrow(/not found/i);
    });
  });

  describe('Batch sync', () => {
    it('syncs all action items for a meeting', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Task 1', 'hash-a');
      seedActionItem('ai-2', 'm1', 'Task 2', 'hash-b');

      const result = await syncService.syncAllActionItems('m1');

      expect(result.meetingId).toBe('m1');
      expect(result.results).toHaveLength(2);
      expect(result.errors).toHaveLength(0);
    });

    it('returns empty results for meeting with no action items', async () => {
      seedBasicData();

      const result = await syncService.syncAllActionItems('m1');

      expect(result.results).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe('Idempotent re-sync', () => {
    it('does not create duplicate cross-references on re-sync', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Idempotent task', 'hash-idem');

      // First sync: creates
      await syncService.syncActionItem('m1', 'ai-1');
      const firstCallCount = mockStoreCrossReference.mock.calls.length;

      // Second sync: reconciliation finds existing, so it updates instead
      mockFindExisting.mockResolvedValueOnce({
        id: 'linear-existing',
        externalId: 'LIN-1',
        source: 'linear',
        title: 'Idempotent task',
        status: 'todo',
        createdAt: new Date(),
        updatedAt: new Date(),
      });

      const result = await syncService.syncActionItem('m1', 'ai-1');

      expect(result.status).toBe('updated');
      // storeCrossReference should NOT be called again on update
      expect(mockStoreCrossReference.mock.calls.length).toBe(firstCallCount);
    });
  });

  describe('Webhook → Action Item Status Update', () => {
    it('updates action item status from Linear webhook', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Task to update', 'hash-wh');

      // Insert sync record
      testDb
        .prepare(
          'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('sync-1', 'ai-1', 'm1', 'linear-issue-1', 'linear', 'synced');

      await syncService.handleLinearUpdate({
        linearIssueId: 'linear-issue-1',
        status: 'done',
        updatedAt: new Date().toISOString(),
      });

      const actionItem = testDb
        .prepare('SELECT * FROM action_items WHERE id = ?')
        .get('ai-1') as Record<string, unknown>;

      expect(actionItem.status).toBe('completed');
    });

    it('records client_history event on status change', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Task for history', 'hash-hist');

      testDb
        .prepare(
          'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('sync-1', 'ai-1', 'm1', 'linear-issue-2', 'linear', 'synced');

      await syncService.handleLinearUpdate({
        linearIssueId: 'linear-issue-2',
        status: 'in-progress',
        updatedAt: new Date().toISOString(),
      });

      const history = testDb
        .prepare('SELECT * FROM client_history WHERE client_id = ?')
        .all('c1') as Array<Record<string, unknown>>;

      expect(history).toHaveLength(1);
      expect(history[0].event_type).toBe('linear_status_change');

      const eventData = JSON.parse(history[0].event_data as string);
      expect(eventData.linearIssueId).toBe('linear-issue-2');
      expect(eventData.newStatus).toBe('in-progress');
    });

    it('silently ignores webhook for unknown Linear issue', async () => {
      seedBasicData();

      // Should not throw
      await syncService.handleLinearUpdate({
        linearIssueId: 'unknown-issue',
        status: 'done',
        updatedAt: new Date().toISOString(),
      });

      const history = testDb.prepare('SELECT COUNT(*) as count FROM client_history').get() as {
        count: number;
      };

      expect(history.count).toBe(0);
    });

    it('updates sync record timestamp on webhook', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Timestamp task', 'hash-ts');

      testDb
        .prepare(
          'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('sync-1', 'ai-1', 'm1', 'linear-ts-1', 'linear', 'created');

      await syncService.handleLinearUpdate({
        linearIssueId: 'linear-ts-1',
        status: 'todo',
        updatedAt: new Date().toISOString(),
      });

      const syncRecord = testDb
        .prepare('SELECT * FROM linear_sync WHERE id = ?')
        .get('sync-1') as Record<string, unknown>;

      expect(syncRecord.sync_status).toBe('synced');
    });
  });

  describe('Linear → Action Item Reconciliation (polling)', () => {
    function seedSync(syncId: string, actionItemId: string, issueId: string): void {
      testDb
        .prepare(
          'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(syncId, actionItemId, 'm1', issueId, 'linear', 'created');
    }

    it('marks local action items completed when Linear issue is done', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Closed in Linear', 'hash-r1');
      seedSync('sync-1', 'ai-1', 'linear-r1');
      mockGetTaskStatus.mockResolvedValue('done');

      const result = await syncService.reconcileFromLinear();

      expect(result.checked).toBe(1);
      expect(result.updated).toBe(1);
      expect(result.errors).toHaveLength(0);

      const item = testDb.prepare('SELECT * FROM action_items WHERE id = ?').get('ai-1') as Record<
        string,
        unknown
      >;
      expect(item.status).toBe('completed');

      const history = testDb
        .prepare('SELECT * FROM client_history WHERE client_id = ?')
        .all('c1') as Array<Record<string, unknown>>;
      expect(history).toHaveLength(1);
      const eventData = JSON.parse(history[0].event_data as string);
      expect(eventData.via).toBe('reconciliation');
      expect(eventData.newStatus).toBe('done');
    });

    it('does not write history when status is unchanged', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Still pending', 'hash-r2');
      seedSync('sync-1', 'ai-1', 'linear-r2');
      mockGetTaskStatus.mockResolvedValue('todo'); // maps to pending, same as seeded

      const result = await syncService.reconcileFromLinear();

      expect(result.updated).toBe(0);
      const history = testDb.prepare('SELECT COUNT(*) as count FROM client_history').get() as {
        count: number;
      };
      expect(history.count).toBe(0);
    });

    it('scopes reconciliation to a meeting when meetingId is given', async () => {
      seedBasicData();
      testDb
        .prepare(
          'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
        )
        .run('m2', 'c1', 'Other Meeting', '2024-01-02', 'scheduled');
      seedActionItem('ai-1', 'm1', 'In scope', 'hash-r3');
      seedActionItem('ai-2', 'm2', 'Out of scope', 'hash-r4');
      seedSync('sync-1', 'ai-1', 'linear-r3');
      testDb
        .prepare(
          'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('sync-2', 'ai-2', 'm2', 'linear-r4', 'linear', 'created');
      mockGetTaskStatus.mockResolvedValue('done');

      const result = await syncService.reconcileFromLinear('m1');

      expect(result.checked).toBe(1);
      const outOfScope = testDb
        .prepare('SELECT * FROM action_items WHERE id = ?')
        .get('ai-2') as Record<string, unknown>;
      expect(outOfScope.status).toBe('pending');
    });

    it('collects per-issue errors without aborting the run', async () => {
      seedBasicData();
      seedActionItem('ai-1', 'm1', 'Errors', 'hash-r5');
      seedActionItem('ai-2', 'm1', 'Works', 'hash-r6');
      seedSync('sync-1', 'ai-1', 'linear-err');
      seedSync('sync-2', 'ai-2', 'linear-ok');
      mockGetTaskStatus
        .mockRejectedValueOnce(new Error('issue not found'))
        .mockResolvedValueOnce('done');

      const result = await syncService.reconcileFromLinear();

      expect(result.checked).toBe(2);
      expect(result.updated).toBe(1);
      expect(result.errors).toEqual([{ linearIssueId: 'linear-err', error: 'issue not found' }]);
    });
  });
});
