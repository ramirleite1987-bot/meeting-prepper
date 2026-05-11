import Database, { type Statement } from 'better-sqlite3';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';
import { runMigrations } from './migrate.js';

let db: Database.Database | null = null;

/**
 * Returns the process-wide SQLite handle, opening it lazily on first call.
 * The connection is reused for the lifetime of the process; call `closeDb()`
 * during shutdown. Pending migrations are applied automatically on first open.
 */

function initializeSchema(database: Database.Database): void {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  database.exec(schema);
  migrateExistingSchema(database);
}

function columnExists(
  database: Database.Database,
  tableName: string,
  columnName: string,
): boolean {
  const rows = database.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
  return rows.some((row) => row.name === columnName);
}

function migrateExistingSchema(database: Database.Database): void {
  if (!columnExists(database, 'clients', 'kind')) {
    database.exec("ALTER TABLE clients ADD COLUMN kind TEXT NOT NULL DEFAULT 'client'");
  }

  if (!columnExists(database, 'clients', 'aliases')) {
    database.exec(
      'ALTER TABLE clients ADD COLUMN aliases TEXT NOT NULL DEFAULT \'{"domains":[],"emails":[],"keywords":[]}\'',
    );
  }
}
export function getDb(): Database.Database {
  if (db) {
    return db;
  }

  const dbPath = config.databasePath;
  // ":memory:" has no directory to create.
  if (dbPath !== ':memory:') {
    mkdirSync(dirname(dbPath), { recursive: true });
  }

  db = new Database(dbPath);

  // Enable WAL mode for concurrent reads during writes
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  initializeSchema(db);
  runMigrations(db);

  logger.info('Database initialized', { path: dbPath });

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
    logger.info('Database connection closed');
  }
}

/**
 * Prepared statement factories. Each property returns a fresh `Statement`
 * bound to the current DB handle — call `.run(...)`, `.get(...)`, or
 * `.all(...)` on the result. Re-preparation is cheap because better-sqlite3
 * caches statements internally.
 */
export const queries: Record<string, () => Statement> = {
  // Clients
  getClientById: () => getDb().prepare('SELECT * FROM clients WHERE id = ?'),
  getClientByName: () => getDb().prepare('SELECT * FROM clients WHERE lower(name) = lower(?)'),
  getAllClients: () => getDb().prepare('SELECT * FROM clients ORDER BY updated_at DESC'),
  insertClient: () =>
    getDb().prepare(
      'INSERT INTO clients (id, name, kind, project, aliases) VALUES (@id, @name, @kind, @project, @aliases)',
    ),
  updateClient: () =>
    getDb().prepare(
      'UPDATE clients SET name = @name, kind = @kind, project = @project, aliases = @aliases, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
    ),
  deleteClient: () => getDb().prepare('DELETE FROM clients WHERE id = ?'),

  // Meetings
  getMeetingById: () => getDb().prepare('SELECT * FROM meetings WHERE id = ?'),
  getAllMeetings: () =>
    getDb().prepare(
      'SELECT m.*, c.name AS client_name FROM meetings m JOIN clients c ON m.client_id = c.id ORDER BY m.scheduled_at DESC',
    ),
  getAllMeetingsWithClient: () =>
    getDb().prepare(
      'SELECT m.*, c.name AS client_name FROM meetings m JOIN clients c ON m.client_id = c.id ORDER BY m.scheduled_at DESC',
    ),
  getMeetingsByClient: () =>
    getDb().prepare('SELECT * FROM meetings WHERE client_id = ? ORDER BY scheduled_at DESC'),
  getMeetingsByStatus: () =>
    getDb().prepare('SELECT * FROM meetings WHERE status = ? ORDER BY scheduled_at ASC'),
  getMeetingsByStatusWithClient: () =>
    getDb().prepare(
      'SELECT m.*, c.name AS client_name FROM meetings m JOIN clients c ON m.client_id = c.id WHERE m.status = ? ORDER BY m.scheduled_at ASC',
    ),
  getMeetingsWithClient: () =>
    getDb().prepare(
      "SELECT m.*, c.name AS client_name FROM meetings m JOIN clients c ON m.client_id = c.id WHERE m.status = ? ORDER BY m.scheduled_at ASC",
    ),
  getMeetingWithClient: () =>
    getDb().prepare(
      'SELECT m.*, c.name AS client_name FROM meetings m JOIN clients c ON m.client_id = c.id WHERE m.id = ?',
    ),
  insertMeeting: () =>
    getDb().prepare(
      'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (@id, @clientId, @title, @scheduledAt, @status)',
    ),
  updateMeetingBriefing: () =>
    getDb().prepare(
      'UPDATE meetings SET briefing = @briefing, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
    ),
  updateMeetingPostCall: () =>
    getDb().prepare(
      "UPDATE meetings SET post_call_notes = @postCallNotes, status = 'completed', updated_at = CURRENT_TIMESTAMP WHERE id = @id",
    ),

  // Meeting Sources
  insertMeetingSource: () =>
    getDb().prepare(
      'INSERT INTO meeting_sources (id, meeting_id, source, external_id, summary, decisions, risks, raw_data) VALUES (@id, @meetingId, @source, @externalId, @summary, @decisions, @risks, @rawData)',
    ),
  getMeetingSourcesByMeeting: () =>
    getDb().prepare('SELECT * FROM meeting_sources WHERE meeting_id = ?'),
  upsertMeetingSource: () =>
    getDb().prepare(
      `INSERT INTO meeting_sources (id, meeting_id, source, external_id, summary, decisions, risks, raw_data)
       VALUES (@id, @meetingId, @source, @externalId, @summary, @decisions, @risks, @rawData)
       ON CONFLICT(meeting_id, source, external_id) WHERE external_id IS NOT NULL
       DO UPDATE SET summary = excluded.summary, decisions = excluded.decisions, risks = excluded.risks, raw_data = excluded.raw_data`,
    ),

  // External Context
  upsertExternalContext: () =>
    getDb().prepare(
      `INSERT INTO external_context (id, client_id, source, external_id, title, content, occurred_at, metadata)
       VALUES (@id, @clientId, @source, @externalId, @title, @content, @occurredAt, @metadata)
       ON CONFLICT(source, external_id, client_id) DO UPDATE SET
         title = excluded.title,
         content = excluded.content,
         occurred_at = excluded.occurred_at,
         metadata = excluded.metadata,
         updated_at = CURRENT_TIMESTAMP`,
    ),
  getExternalContextByClient: () =>
    getDb().prepare('SELECT * FROM external_context WHERE client_id = ? ORDER BY occurred_at DESC LIMIT ?'),
  getExternalContextByClientSince: () =>
    getDb().prepare('SELECT * FROM external_context WHERE client_id = ? AND occurred_at >= ? ORDER BY occurred_at DESC LIMIT ?'),
  getExternalContextByClientName: () =>
    getDb().prepare(
      `SELECT ec.* FROM external_context ec
       JOIN clients c ON c.id = ec.client_id
       WHERE lower(c.name) = lower(?)
       ORDER BY ec.occurred_at DESC
       LIMIT ?`,
    ),
  getExternalContextByClientNameSince: () =>
    getDb().prepare(
      `SELECT ec.* FROM external_context ec
       JOIN clients c ON c.id = ec.client_id
       WHERE lower(c.name) = lower(?) AND ec.occurred_at >= ?
       ORDER BY ec.occurred_at DESC
       LIMIT ?`,
    ),

  // Action Items
  insertActionItem: () =>
    getDb().prepare(
      'INSERT INTO action_items (id, meeting_id, source, title, description, owner, deadline, priority, context_hash) VALUES (@id, @meetingId, @source, @title, @description, @owner, @deadline, @priority, @contextHash)',
    ),
  getActionItemsByMeeting: () =>
    getDb().prepare('SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at ASC'),
  getActionItemByHash: () => getDb().prepare('SELECT * FROM action_items WHERE context_hash = ?'),
  updateActionItemStatus: () =>
    getDb().prepare(
      'UPDATE action_items SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id',
    ),

  // Linear Sync
  insertLinearSync: () =>
    getDb().prepare(
      'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (@id, @actionItemId, @meetingId, @linearIssueId, @source, @syncStatus)',
    ),
  getLinearSyncByIssue: () =>
    getDb().prepare('SELECT * FROM linear_sync WHERE linear_issue_id = ?'),
  getLinearSyncByMeeting: () => getDb().prepare('SELECT * FROM linear_sync WHERE meeting_id = ?'),
  updateLinearSyncStatus: () =>
    getDb().prepare(
      'UPDATE linear_sync SET sync_status = @syncStatus, last_synced_at = CURRENT_TIMESTAMP WHERE id = @id',
    ),

  // Client History
  insertClientHistory: () =>
    getDb().prepare(
      'INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (@id, @clientId, @meetingId, @eventType, @eventData)',
    ),
  getClientHistory: () =>
    getDb().prepare('SELECT * FROM client_history WHERE client_id = ? ORDER BY occurred_at DESC'),
};
