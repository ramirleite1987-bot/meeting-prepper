/**
 * End-to-end tests for the MCP server: spin up the server + an in-memory
 * transport pair, talk to it as a real MCP client would, and assert that
 * each tool round-trips. This covers wiring (registration, schema
 * validation, JSON serialization) without a real HTTP listener.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

let testDb: Database.Database;

function createTestDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  const schemaPath = join(__dirname, '..', '..', '..', 'src', 'db', 'schema.sql');
  db.exec(readFileSync(schemaPath, 'utf-8'));
  return db;
}

vi.mock('../../../src/db/index.js', () => {
  const getDb = () => testDb;
  const queries = {
    getAllClients: () => testDb.prepare('SELECT * FROM clients ORDER BY updated_at DESC'),
    getClientById: () => testDb.prepare('SELECT * FROM clients WHERE id = ?'),
    getMeetingById: () => testDb.prepare('SELECT * FROM meetings WHERE id = ?'),
    getMeetingsByClient: () =>
      testDb.prepare('SELECT * FROM meetings WHERE client_id = ? ORDER BY scheduled_at DESC'),
    getMeetingsByStatus: () =>
      testDb.prepare('SELECT * FROM meetings WHERE status = ? ORDER BY scheduled_at ASC'),
    getActionItemsByMeeting: () =>
      testDb.prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at ASC'),
    updateActionItemStatus: () =>
      testDb.prepare(
        'UPDATE action_items SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
      ),
    getClientHistory: () =>
      testDb.prepare('SELECT * FROM client_history WHERE client_id = ? ORDER BY occurred_at DESC'),
    getLinearSyncByMeeting: () => testDb.prepare('SELECT * FROM linear_sync WHERE meeting_id = ?'),
  };
  return { getDb, closeDb: vi.fn(), queries };
});

beforeAll(() => {
  testDb = createTestDb();
});

afterAll(() => {
  testDb.close();
});

beforeEach(() => {
  testDb.exec(`
    DELETE FROM linear_sync;
    DELETE FROM client_history;
    DELETE FROM action_items;
    DELETE FROM meeting_sources;
    DELETE FROM meetings;
    DELETE FROM clients;
  `);

  testDb
    .prepare('INSERT INTO clients (id, name, project) VALUES (?, ?, ?)')
    .run('cli-1', 'Acme Corp', 'Migration project');

  testDb
    .prepare(
      'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (?, ?, ?, ?, ?)',
    )
    .run('mtg-1', 'cli-1', 'Kickoff', new Date(Date.now() + 3600_000).toISOString(), 'scheduled');

  testDb
    .prepare(
      'INSERT INTO action_items (id, meeting_id, source, title, owner, priority, status, context_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run('ai-1', 'mtg-1', 'manual', 'Send proposal', 'alice', 'high', 'pending', 'hash-1');
});

async function connectInMemory(): Promise<Client> {
  // Import lazily so vi.mock has applied to the dependency chain first.
  const { createMcpServer } = await import('../../../src/mcp/server.js');
  const server = createMcpServer({ name: 'test', version: '0.0.0-test' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);

  const client = new Client({ name: 'test-client', version: '0.0.0-test' });
  await client.connect(b);
  return client;
}

function parseFirstTextContent(result: { content: unknown }): unknown {
  const content = result.content as Array<{ type: string; text: string }>;
  expect(content[0]?.type).toBe('text');
  return JSON.parse(content[0].text);
}

describe('MCP server', () => {
  it('exposes the expected tools', async () => {
    const client = await connectInMemory();
    const list = await client.listTools();
    const names = list.tools.map((t) => t.name).sort();

    expect(names).toEqual(
      [
        'get_client_timeline',
        'get_meeting',
        'get_stats',
        'get_upcoming_meetings',
        'list_action_item_owners',
        'list_action_items',
        'list_clients',
        'list_meetings_by_client',
        'mark_action_item_status',
        'search',
      ].sort(),
    );
  });

  it('list_clients returns seeded clients', async () => {
    const client = await connectInMemory();
    const result = await client.callTool({ name: 'list_clients', arguments: {} });
    const clients = parseFirstTextContent(result) as Array<{ id: string; name: string }>;
    expect(clients).toHaveLength(1);
    expect(clients[0].name).toBe('Acme Corp');
  });

  it('get_meeting returns the seeded meeting', async () => {
    const client = await connectInMemory();
    const result = await client.callTool({
      name: 'get_meeting',
      arguments: { meetingId: 'mtg-1' },
    });
    const meeting = parseFirstTextContent(result) as { id: string; title: string };
    expect(meeting.id).toBe('mtg-1');
    expect(meeting.title).toBe('Kickoff');
  });

  it('get_meeting returns isError for unknown ID', async () => {
    const client = await connectInMemory();
    const result = (await client.callTool({
      name: 'get_meeting',
      arguments: { meetingId: 'does-not-exist' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('No meeting found');
  });

  it('list_action_items returns seeded items with filters', async () => {
    const client = await connectInMemory();
    const all = await client.callTool({ name: 'list_action_items', arguments: {} });
    const items = parseFirstTextContent(all) as Array<{ id: string; status: string }>;
    expect(items).toHaveLength(1);
    expect(items[0].status).toBe('pending');

    const noneCompleted = await client.callTool({
      name: 'list_action_items',
      arguments: { status: 'completed' },
    });
    expect(parseFirstTextContent(noneCompleted)).toHaveLength(0);
  });

  it('mark_action_item_status updates a known item', async () => {
    const client = await connectInMemory();
    const result = await client.callTool({
      name: 'mark_action_item_status',
      arguments: { actionItemId: 'ai-1', status: 'completed' },
    });
    const updated = parseFirstTextContent(result) as { id: string; status: string };
    expect(updated.id).toBe('ai-1');
    expect(updated.status).toBe('completed');
  });

  it('mark_action_item_status rejects an invalid status', async () => {
    const client = await connectInMemory();
    const result = (await client.callTool({
      name: 'mark_action_item_status',
      arguments: { actionItemId: 'ai-1', status: 'bogus' },
    })) as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Invalid status');
  });

  it('search returns structured results', async () => {
    const client = await connectInMemory();
    const result = await client.callTool({
      name: 'search',
      arguments: { query: 'Acme' },
    });
    const response = parseFirstTextContent(result) as {
      query: string;
      total: number;
      results: Array<{ type: string; title: string }>;
    };
    expect(response.query).toBe('Acme');
    expect(response.total).toBeGreaterThan(0);
    expect(response.results.some((r) => r.type === 'client')).toBe(true);
  });

  it('get_upcoming_meetings returns the agenda buckets', async () => {
    const client = await connectInMemory();
    const result = await client.callTool({ name: 'get_upcoming_meetings', arguments: {} });
    const agenda = parseFirstTextContent(result) as {
      buckets: Array<{ bucket: string; count: number }>;
    };
    expect(Array.isArray(agenda.buckets)).toBe(true);
  });
});
