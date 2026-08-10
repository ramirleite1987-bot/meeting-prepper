/**
 * Query-level tests for the pre-meeting reminder SQL (issue #13):
 * getMeetingsDueForReminder / markReminderSent run against a real in-memory
 * SQLite database so the status/dedup/window filters are verified for real.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

process.env.DATABASE_PATH = ':memory:';

const { getDb, closeDb, queries } = await import('../../../src/db/index.js');

const FROM = '2026-06-10T14:50:00.000Z';
const TO = '2026-06-10T15:05:00.000Z'; // now + 15 min reminder lead

interface MeetingSeed {
  id: string;
  status: string;
  scheduledAt: string | null;
  briefing?: string | null;
  reminderSentAt?: string | null;
}

function insertMeeting(seed: MeetingSeed): void {
  getDb()
    .prepare(
      `INSERT INTO meetings (id, client_id, title, scheduled_at, status, briefing, reminder_sent_at)
       VALUES (?, 'c1', ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.id,
      `Meeting ${seed.id}`,
      seed.scheduledAt,
      seed.status,
      seed.briefing ?? null,
      seed.reminderSentAt ?? null,
    );
}

function dueIds(): string[] {
  const rows = queries.getMeetingsDueForReminder().all({ from: FROM, to: TO }) as Array<{
    id: string;
  }>;
  return rows.map((row) => row.id);
}

beforeAll(() => {
  queries.insertClient().run({
    id: 'c1',
    name: 'Acme Corp',
    kind: 'client',
    project: null,
    aliases: '{"domains":[],"emails":[],"keywords":[]}',
  });

  insertMeeting({
    id: 'm-briefed',
    status: 'scheduled',
    scheduledAt: '2026-06-10T14:55:00.000Z',
    briefing: '{"sections":[]}',
  });
  insertMeeting({ id: 'm-due', status: 'scheduled', scheduledAt: '2026-06-10T15:00:00.000Z' });
  insertMeeting({
    id: 'm-reminded',
    status: 'scheduled',
    scheduledAt: '2026-06-10T15:00:00.000Z',
    reminderSentAt: '2026-06-10T14:45:00.000Z',
  });
  insertMeeting({
    id: 'm-in-progress',
    status: 'in_progress',
    scheduledAt: '2026-06-10T15:00:00.000Z',
  });
  insertMeeting({
    id: 'm-completed',
    status: 'completed',
    scheduledAt: '2026-06-10T15:00:00.000Z',
  });
  insertMeeting({
    id: 'm-too-early',
    status: 'scheduled',
    scheduledAt: '2026-06-10T14:30:00.000Z',
  });
  insertMeeting({ id: 'm-too-late', status: 'scheduled', scheduledAt: '2026-06-10T15:30:00.000Z' });
  insertMeeting({ id: 'm-unscheduled', status: 'scheduled', scheduledAt: null });
});

afterAll(() => {
  closeDb();
});

describe('getMeetingsDueForReminder', () => {
  it('returns only scheduled, not-yet-reminded meetings inside the window', () => {
    expect(dueIds()).toEqual(['m-briefed', 'm-due']);
  });

  it('flags meetings that still need a briefing', () => {
    const rows = queries.getMeetingsDueForReminder().all({ from: FROM, to: TO }) as Array<{
      id: string;
      needs_briefing: number;
      client_name: string;
    }>;
    const byId = new Map(rows.map((row) => [row.id, row]));

    expect(byId.get('m-due')?.needs_briefing).toBe(1);
    expect(byId.get('m-briefed')?.needs_briefing).toBe(0);
    expect(byId.get('m-due')?.client_name).toBe('Acme Corp');
  });
});

describe('markReminderSent', () => {
  it('stamps reminder_sent_at so the meeting never reminds twice', () => {
    queries.markReminderSent().run('m-due');

    expect(dueIds()).toEqual(['m-briefed']);
    const row = getDb()
      .prepare('SELECT reminder_sent_at FROM meetings WHERE id = ?')
      .get('m-due') as { reminder_sent_at: string | null };
    expect(row.reminder_sent_at).not.toBeNull();
  });
});
