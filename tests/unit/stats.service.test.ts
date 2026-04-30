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

const { buildStats } = await import('../../src/services/stats.service.js');

describe('buildStats', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    testDb.pragma('foreign_keys = ON');
    const schema = readFileSync(join(__dirname, '..', '..', 'src', 'db', 'schema.sql'), 'utf-8');
    testDb.exec(schema);
  });

  it('returns zeros for an empty workspace', () => {
    const stats = buildStats(new Date('2026-04-30T12:00:00Z'));
    expect(stats.clients.total).toBe(0);
    expect(stats.meetings.total).toBe(0);
    expect(stats.actionItems.total).toBe(0);
    expect(stats.meetings.briefingCoveragePct).toBe(0);
    expect(stats.averages.actionItemsPerCompletedMeeting).toBeNull();
    expect(stats.topClients).toEqual([]);
    expect(stats.topOwners).toEqual([]);
  });

  it('aggregates counts and computes briefing coverage', () => {
    const now = new Date('2026-04-30T12:00:00Z');
    testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c1', 'Acme');
    testDb.prepare('INSERT INTO clients (id, name) VALUES (?, ?)').run('c2', 'Globex');

    const recent = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000).toISOString();
    const old = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000).toISOString();

    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status, briefing) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('m1', 'c1', 'Recent', recent, 'completed', '{"x":1}');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m2', 'c1', 'Recent2', recent, 'scheduled');
    testDb
      .prepare(
        'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
      )
      .run('m3', 'c2', 'Old', old, 'completed');

    testDb
      .prepare(
        'INSERT INTO action_items (id, meeting_id, source, title, owner, priority, status, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('a1', 'm1', 'manual', 'Task 1', 'alice', 'high', 'pending', 'h1');
    testDb
      .prepare(
        'INSERT INTO action_items (id, meeting_id, source, title, owner, priority, status, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run('a2', 'm1', 'manual', 'Task 2', 'alice', 'medium', 'completed', 'h2');
    testDb
      .prepare(
        'INSERT INTO action_items (id, meeting_id, source, title, owner, priority, status, context_hash, deadline) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'a3',
        'm3',
        'manual',
        'Overdue',
        'bob',
        'high',
        'pending',
        'h3',
        new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      );

    const stats = buildStats(now);
    expect(stats.clients.total).toBe(2);
    expect(stats.meetings.total).toBe(3);
    expect(stats.meetings.scheduled).toBe(1);
    expect(stats.meetings.completed).toBe(2);
    expect(stats.meetings.withBriefing).toBe(1);
    expect(stats.meetings.briefingCoveragePct).toBe(33);

    expect(stats.actionItems.total).toBe(3);
    expect(stats.actionItems.pending).toBe(2);
    expect(stats.actionItems.completed).toBe(1);
    expect(stats.actionItems.high).toBe(2);
    expect(stats.actionItems.overdue).toBe(1);

    expect(stats.topClients.length).toBe(1);
    expect(stats.topClients[0].id).toBe('c1');
    expect(stats.topClients[0].meetings_30d).toBe(2);

    expect(stats.topOwners.length).toBe(2);
    const owners = stats.topOwners.map((o) => o.owner).sort();
    expect(owners).toEqual(['alice', 'bob']);
    expect(stats.topOwners.every((o) => o.open_items === 1)).toBe(true);

    // m1 has 2 items, m3 has 1 (m2 is scheduled, excluded). Avg = 1.5.
    expect(stats.averages.actionItemsPerCompletedMeeting).toBe(1.5);
  });
});
