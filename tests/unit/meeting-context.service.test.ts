import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(readFileSync(join(__dirname, '..', '..', 'src', 'db', 'schema.sql'), 'utf-8'));
  db.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
  db.prepare('INSERT INTO meetings (id, client_id, title) VALUES (?, ?, ?)').run('m1', 'c1', 'Prep');
  return db;
}

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../src/db/index.js', () => {
  const queries = {
    upsertMeetingSource: () =>
      testDb.prepare(
        `INSERT INTO meeting_sources (id, meeting_id, source, external_id, summary, decisions, risks, raw_data)
         VALUES (@id, @meetingId, @source, @externalId, @summary, @decisions, @risks, @rawData)
         ON CONFLICT(meeting_id, source, external_id) WHERE external_id IS NOT NULL
         DO UPDATE SET summary = excluded.summary, decisions = excluded.decisions, risks = excluded.risks, raw_data = excluded.raw_data`,
      ),
    getMeetingSourcesByMeeting: () =>
      testDb.prepare('SELECT * FROM meeting_sources WHERE meeting_id = ?'),
  };
  return { getDb: () => testDb, queries };
});

vi.mock('../../src/adapters/krisp.adapter.js', () => ({
  KrispAdapter: vi.fn(),
}));

vi.mock('../../src/adapters/granola.adapter.js', () => ({
  GranolaAdapter: vi.fn(),
}));

const { MeetingContextService } = await import('../../src/services/meeting-context.service.js');

describe('MeetingContextService', () => {
  beforeEach(() => {
    testDb = createTestDb();
  });

  it('attaches selected notes without creating action items', async () => {
    const adapter = {
      name: 'krisp',
      initialize: vi.fn().mockResolvedValue(undefined),
      isAvailable: vi.fn().mockResolvedValue(true),
      disconnect: vi.fn().mockResolvedValue(undefined),
      searchMeetings: vi.fn().mockResolvedValue([]),
      getActionItems: vi.fn().mockResolvedValue([{ title: 'Do not import', status: 'pending', source: 'krisp' }]),
      getMeetingNotes: vi.fn().mockResolvedValue({
        meetingId: 'source-1',
        title: 'Prior call',
        date: new Date('2026-04-01T00:00:00.000Z'),
        attendees: ['a@example.com'],
        summary: 'Useful prep summary',
        keyPoints: ['Decision: Use pilot scope', 'Risk: Tight timeline'],
        actionItems: [{ title: 'Do not import', status: 'pending', source: 'krisp' }],
        source: 'krisp',
      }),
    };
    const service = new MeetingContextService({ krisp: adapter });

    await expect(service.attachSelections('m1', [{ source: 'krisp', externalId: 'source-1' }])).resolves.toBe(1);
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM meeting_sources').get()).toMatchObject({ count: 1 });
    expect(testDb.prepare('SELECT COUNT(*) AS count FROM action_items').get()).toMatchObject({ count: 0 });
  });

  it('passes Krisp tags through candidate search query', async () => {
    const searchMeetings = vi.fn().mockResolvedValue([]);
    const adapter = {
      name: 'krisp',
      initialize: vi.fn().mockResolvedValue(undefined),
      isAvailable: vi.fn().mockResolvedValue(true),
      disconnect: vi.fn().mockResolvedValue(undefined),
      searchMeetings,
      getActionItems: vi.fn().mockResolvedValue([]),
      getMeetingNotes: vi.fn().mockResolvedValue(null),
    };
    const service = new MeetingContextService({ krisp: adapter });

    await service.searchCandidates({ source: 'krisp', query: 'Acme', tags: ['handoff'], limit: 5 });
    expect(searchMeetings).toHaveBeenCalledWith('Acme handoff', { limit: 5 });
  });
});
