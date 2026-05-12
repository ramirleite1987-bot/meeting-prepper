import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import express from 'express';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mockGoogleStatus = vi.hoisted(() => vi.fn());
const mockGoogleSync = vi.hoisted(() => vi.fn());
const mockSearchCandidates = vi.hoisted(() => vi.fn());
const mockAttachSelections = vi.hoisted(() => vi.fn());
const mockGetAttachedContextEntries = vi.hoisted(() => vi.fn());
const mockGetRecentNotifications = vi.hoisted(() => vi.fn());
const mockSubscribe = vi.hoisted(() => vi.fn());

let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schemaPath = join(__dirname, '..', '..', 'src', 'db', 'schema.sql');
  db.exec(readFileSync(schemaPath, 'utf-8'));
  return db;
}

vi.mock('../../src/db/index.js', () => {
  const queries = {
    insertClient: () =>
      testDb.prepare(
        'INSERT INTO clients (id, name, kind, project, aliases) VALUES (@id, @name, @kind, @project, @aliases)',
      ),
    getClientById: () => testDb.prepare('SELECT * FROM clients WHERE id = ?'),
    getMeetingById: () => testDb.prepare('SELECT * FROM meetings WHERE id = ?'),
  };

  return { getDb: () => testDb, closeDb: vi.fn(), queries };
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
    linearWebhookSecret: 'test-secret',
    gogBin: 'gog',
    gogGmailLabel: 'Processes',
    googleSyncLookbackDays: 30,
    googleSyncMaxResults: 25,
  },
}));

vi.mock('../../src/services/notification.service.js', () => ({
  notificationService: {
    notify: vi.fn().mockResolvedValue(undefined),
    getRecentNotifications: mockGetRecentNotifications,
    subscribe: mockSubscribe,
  },
}));

vi.mock('../../src/services/client-context.service.js', () => ({
  ClientContextService: vi.fn().mockImplementation(() => ({
    registerAdapter: vi.fn(),
    getClientContext: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../src/services/briefing.service.js', () => ({
  BriefingService: vi.fn().mockImplementation(() => ({
    generateBriefing: vi.fn().mockResolvedValue({ sections: {} }),
  })),
}));

vi.mock('../../src/services/extraction.service.js', () => ({
  ExtractionService: vi.fn().mockImplementation(() => ({
    extract: vi.fn().mockResolvedValue({ sources: [], actionItems: [], summary: '' }),
  })),
}));

vi.mock('../../src/services/google-context.service.js', () => ({
  GoogleContextService: vi.fn().mockImplementation(() => ({
    getStatus: mockGoogleStatus,
    sync: mockGoogleSync,
  })),
}));

vi.mock('../../src/services/linear-context.service.js', () => ({
  LinearContextService: vi.fn().mockImplementation(() => ({
    listProjects: vi.fn().mockResolvedValue([]),
    importProjectContext: vi.fn().mockResolvedValue({ imported: 0, projectId: '' }),
  })),
}));

vi.mock('../../src/services/meeting-context.service.js', () => ({
  MeetingContextService: vi.fn().mockImplementation(() => ({
    searchCandidates: mockSearchCandidates,
    attachSelections: mockAttachSelections,
    getAttachedContextEntries: mockGetAttachedContextEntries,
  })),
}));

vi.mock('../../src/services/sync.service.js', () => ({
  SyncService: vi.fn().mockImplementation(() => ({
    syncActionItem: vi.fn(),
    syncAllActionItems: vi.fn(),
    handleLinearUpdate: vi.fn(),
  })),
}));

const { apiRouter } = await import('../../src/routes/api.js');
const { errorHandler } = await import('../../src/middleware/error-handler.js');

function createApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use('/api', apiRouter);
  app.use(errorHandler);
  return app;
}

describe('API context scenario flows', () => {
  let app: express.Express;

  beforeEach(() => {
    testDb = createTestDb();
    mockGoogleStatus.mockReset().mockResolvedValue({ available: true, accountConfigured: false });
    mockGoogleSync.mockReset().mockResolvedValue({ imported: 2, clientsChecked: 1, errors: [] });
    mockSearchCandidates.mockReset().mockResolvedValue([
      {
        source: 'krisp',
        meetingId: 'source-1',
        title: 'Prior call',
        date: '2026-04-01',
        summary: 'Useful prep summary',
      },
    ]);
    mockAttachSelections.mockReset().mockResolvedValue(1);
    mockGetAttachedContextEntries.mockReset().mockReturnValue([]);
    mockGetRecentNotifications.mockReset().mockReturnValue([
      {
        id: 'n1',
        type: 'briefing_generated',
        title: 'Briefing ready',
      },
    ]);
    mockSubscribe.mockReset().mockReturnValue(() => {});
    app = createApp();
  });

  it('persists client kind and aliases for prospect prep matching', async () => {
    const aliases = {
      domains: ['acme.com'],
      emails: ['buyer@acme.com'],
      keywords: ['pricing review'],
    };

    const res = await request(app)
      .post('/api/clients')
      .send({ name: 'Acme Prospect', project: 'Pilot', kind: 'prospect', aliases })
      .expect(201);

    expect(res.body.kind).toBe('prospect');
    expect(JSON.parse(res.body.aliases)).toEqual(aliases);
  });

  it('returns Google setup state without exposing secrets', async () => {
    const res = await request(app).get('/api/google/status').expect(200);

    expect(res.body).toEqual({ available: true, accountConfigured: false });
    expect(JSON.stringify(res.body)).not.toMatch(/token|secret|password/i);
    expect(mockGoogleStatus).toHaveBeenCalledOnce();
  });

  it('passes scoped Google sync options to the service', async () => {
    const res = await request(app)
      .post('/api/google/sync')
      .send({ clientId: 'c1', lookbackDays: 7 })
      .expect(200);

    expect(res.body).toEqual({ imported: 2, clientsChecked: 1, errors: [] });
    expect(mockGoogleSync).toHaveBeenCalledWith({ clientId: 'c1', lookbackDays: 7 });
  });

  it('searches selected meeting context candidates', async () => {
    seedMeeting();

    const res = await request(app)
      .get('/api/meetings/m1/context-candidates?source=krisp&query=Acme&tags=handoff&limit=5')
      .expect(200);

    expect(res.body).toHaveLength(1);
    expect(res.body[0].title).toBe('Prior call');
    expect(mockSearchCandidates).toHaveBeenCalledWith({
      source: 'krisp',
      query: 'Acme',
      tags: ['handoff'],
      limit: 5,
    });
  });

  it('validates the selected meeting context source', async () => {
    seedMeeting();

    await request(app).get('/api/meetings/m1/context-candidates?source=calendar').expect(400);
    expect(mockSearchCandidates).not.toHaveBeenCalled();
  });

  it('attaches selected meeting context sources', async () => {
    seedMeeting();

    const res = await request(app)
      .post('/api/meetings/m1/context-sources')
      .send({ selections: [{ source: 'granola', externalId: 'note-1' }] })
      .expect(201);

    expect(res.body).toEqual({ attached: 1 });
    expect(mockAttachSelections).toHaveBeenCalledWith('m1', [
      { source: 'granola', externalId: 'note-1' },
    ]);
  });

  it('validates meeting context selections before attachment', async () => {
    seedMeeting();

    await request(app).post('/api/meetings/m1/context-sources').send({}).expect(400);
    await request(app)
      .post('/api/meetings/m1/context-sources')
      .send({ selections: [{ source: 'calendar', externalId: 'bad' }] })
      .expect(400);
  });

  it('returns recent notifications', async () => {
    const res = await request(app).get('/api/notifications').expect(200);

    expect(res.body).toEqual([
      {
        id: 'n1',
        type: 'briefing_generated',
        title: 'Briefing ready',
      },
    ]);
    expect(mockGetRecentNotifications).toHaveBeenCalledOnce();
  });
});

function seedMeeting(): void {
  testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
  testDb
    .prepare(
      'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    )
    .run('m1', 'c1', 'Weekly', '2024-01-01', 'scheduled');
}
