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
  return db;
}

vi.mock('../../src/config.js', () => ({
  config: {
    gogBin: 'gog',
    gogGmailLabel: 'Processes',
    googleSyncLookbackDays: 14,
    googleSyncMaxResults: 10,
  },
}));

vi.mock('../../src/utils/logger.js', () => ({
  logger: {
    child: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
  },
}));

vi.mock('../../src/db/index.js', () => {
  const getDb = () => testDb;
  const queries = {
    getClientById: () => testDb.prepare('SELECT * FROM clients WHERE id = ?'),
    getAllClients: () => testDb.prepare('SELECT * FROM clients ORDER BY updated_at DESC'),
    upsertExternalContext: () =>
      testDb.prepare(
        `INSERT INTO external_context (id, client_id, source, external_id, title, content, occurred_at, metadata)
         VALUES (@id, @clientId, @source, @externalId, @title, @content, @occurredAt, @metadata)
         ON CONFLICT(source, external_id, client_id) DO UPDATE SET
           title = excluded.title,
           content = excluded.content,
           occurred_at = excluded.occurred_at,
           metadata = excluded.metadata`,
      ),
    getExternalContextByClientName: () =>
      testDb.prepare(
        'SELECT ec.* FROM external_context ec JOIN clients c ON c.id = ec.client_id WHERE lower(c.name) = lower(?) ORDER BY ec.occurred_at DESC LIMIT ?',
      ),
    getExternalContextByClientNameSince: () =>
      testDb.prepare(
        'SELECT ec.* FROM external_context ec JOIN clients c ON c.id = ec.client_id WHERE lower(c.name) = lower(?) AND ec.occurred_at >= ? ORDER BY ec.occurred_at DESC LIMIT ?',
      ),
  };
  return { getDb, queries };
});

const { GoogleContextService } = await import('../../src/services/google-context.service.js');
const { DbExternalContextAdapter } = await import('../../src/adapters/db-external-context.adapter.js');
const { buildAliasTerms } = await import('../../src/services/client-aliases.js');

describe('GoogleContextService', () => {
  beforeEach(() => {
    testDb = createTestDb();
    testDb.prepare('INSERT INTO clients (id, name, kind, project, aliases) VALUES (?, ?, ?, ?, ?)').run(
      'c1',
      'Acme',
      'prospect',
      'Launch',
      JSON.stringify({
        domains: ['acme.com'],
        emails: ['buyer@acme.com'],
        keywords: ['pricing review'],
      }),
    );
  });

  it('builds Gmail queries constrained to the Processes label and aliases', () => {
    const client = testDb.prepare('SELECT * FROM clients WHERE id = ?').get('c1') as {
      id: string;
      name: string;
      kind: 'client' | 'prospect';
      project: string;
      aliases: string;
    };
    const service = new GoogleContextService({ runJson: vi.fn(), status: vi.fn() } as never);

    expect(buildAliasTerms(client)).toEqual([
      'Acme',
      'Launch',
      'acme.com',
      'buyer@acme.com',
      'pricing review',
    ]);
    expect(service.buildGmailQuery(client, 7)).toContain('label:Processes newer_than:7d');
    expect(service.buildGmailQuery(client, 7)).toContain('"buyer@acme.com"');
  });

  it('imports Gmail and matching Calendar rows with idempotent external IDs', async () => {
    const runJson = vi.fn()
      .mockResolvedValueOnce([
        {
          id: 'gmail-1',
          subject: 'Pricing review',
          body: 'Acme process details',
          date: '2026-04-01T10:00:00.000Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 'cal-1',
          summary: 'Acme launch sync',
          description: 'Discuss acme.com rollout',
          start: { dateTime: '2026-04-02T10:00:00.000Z' },
        },
      ]);
    const service = new GoogleContextService({ runJson, status: vi.fn() } as never);

    await expect(service.sync({ clientId: 'c1', lookbackDays: 7 })).resolves.toMatchObject({
      imported: 2,
      clientsChecked: 1,
    });
    await service.sync({ clientId: 'c1', lookbackDays: 7 });

    const rows = testDb.prepare('SELECT * FROM external_context ORDER BY occurred_at DESC').all();
    expect(rows).toHaveLength(2);
  });

  it('maps DB-backed external context to recency-sorted context entries', async () => {
    testDb.prepare(
      `INSERT INTO external_context (id, client_id, source, external_id, title, content, occurred_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('e1', 'c1', 'gmail', 'g1', 'Older', 'old', '2026-04-01T00:00:00.000Z', '{}');
    testDb.prepare(
      `INSERT INTO external_context (id, client_id, source, external_id, title, content, occurred_at, metadata)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run('e2', 'c1', 'calendar', 'c1', 'Newer', 'new', '2026-04-03T00:00:00.000Z', '{}');

    const adapter = new DbExternalContextAdapter();
    const entries = await adapter.getClientContext('Acme');

    expect(entries.map((entry) => entry.title)).toEqual(['Newer', 'Older']);
    expect(entries[0].type).toBe('event');
  });
});
