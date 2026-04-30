import { describe, it, expect, vi, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let testDb: Database.Database;

vi.mock('../../src/db/index.js', () => {
  const getDb = () => testDb;
  return { getDb, closeDb: vi.fn(), queries: {} };
});

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

const { buildAgenda } = await import('../../src/services/agenda.service.js');

function isoOffset(now: Date, deltaMinutes: number): string {
  return new Date(now.getTime() + deltaMinutes * 60_000).toISOString();
}

describe('buildAgenda', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    const schema = readFileSync(join(__dirname, '..', '..', 'src', 'db', 'schema.sql'), 'utf-8');
    testDb.exec(schema);
    testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
  });

  it('groups meetings into today / tomorrow / later buckets', () => {
    const now = new Date('2026-04-30T12:00:00Z');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m1', 'c1', 'Today afternoon', isoOffset(now, 60), 'scheduled');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m2', 'c1', 'Tomorrow morning', isoOffset(now, 24 * 60 + 60), 'scheduled');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m3', 'c1', 'Three days out', isoOffset(now, 3 * 24 * 60), 'scheduled');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m4', 'c1', 'Far future', isoOffset(now, 30 * 24 * 60), 'scheduled');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m5', 'c1', 'Yesterday', isoOffset(now, -2 * 24 * 60), 'scheduled');
    testDb
      .prepare('INSERT INTO meetings (id, client_id, title, status) VALUES (?, ?, ?, ?)')
      .run('m6', 'c1', 'No date', 'scheduled');

    const agenda = buildAgenda(now);
    const labels = agenda.buckets.map((b) => b.bucket);

    expect(labels).toContain('today');
    expect(labels).toContain('tomorrow');
    expect(labels).toContain('overdue');
    expect(labels).toContain('unscheduled');

    const today = agenda.buckets.find((b) => b.bucket === 'today')!;
    expect(today.meetings.map((m) => m.id)).toEqual(['m1']);

    const tomorrow = agenda.buckets.find((b) => b.bucket === 'tomorrow')!;
    expect(tomorrow.meetings.map((m) => m.id)).toEqual(['m2']);

    const overdue = agenda.buckets.find((b) => b.bucket === 'overdue')!;
    expect(overdue.meetings.map((m) => m.id)).toEqual(['m5']);

    const unscheduled = agenda.buckets.find((b) => b.bucket === 'unscheduled')!;
    expect(unscheduled.meetings.map((m) => m.id)).toEqual(['m6']);
  });

  it('reports the next upcoming non-completed meeting', () => {
    const now = new Date('2026-04-30T09:00:00Z');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m1', 'c1', 'Soon', isoOffset(now, 30), 'scheduled');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m2', 'c1', 'Later today', isoOffset(now, 240), 'scheduled');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m3', 'c1', 'Already done', isoOffset(now, 5), 'completed');

    const agenda = buildAgenda(now);
    expect(agenda.next?.id).toBe('m1');
    expect(agenda.next?.starts_in_minutes).toBe(30);
  });

  it('returns no next when nothing is upcoming', () => {
    const now = new Date('2026-04-30T09:00:00Z');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m1', 'c1', 'Done', isoOffset(now, -60), 'completed');

    const agenda = buildAgenda(now);
    expect(agenda.next).toBeNull();
  });

  it('flags has_briefing and has_post_call', () => {
    const now = new Date('2026-04-30T09:00:00Z');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status, briefing) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('m1', 'c1', 'With briefing', isoOffset(now, 60), 'scheduled', '{"x":1}');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status, post_call_notes) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('m2', 'c1', 'With post-call', isoOffset(now, -120), 'completed', '{"y":1}');

    const agenda = buildAgenda(now);
    const all = agenda.buckets.flatMap((b) => b.meetings);
    expect(all.find((m) => m.id === 'm1')?.has_briefing).toBe(true);
    expect(all.find((m) => m.id === 'm2')?.has_post_call).toBe(true);
  });
});
