import Database, { type Statement } from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { logger } from '../utils/logger.js';

let db: Database.Database | null = null;

function initializeSchema(database: Database.Database): void {
  const schemaPath = join(dirname(fileURLToPath(import.meta.url)), 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf-8');
  database.exec(schema);
}

export function getDb(): Database.Database {
  if (db) {
    return db;
  }

  const dbPath = config.databasePath;
  const dbDir = dirname(dbPath);

  mkdirSync(dbDir, { recursive: true });

  db = new Database(dbPath);

  // Enable WAL mode for concurrent reads during writes
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  initializeSchema(db);

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

// Prepared statement helpers for common queries
export const queries: Record<string, () => Statement> = {
  // Clients
  getClientById: () => getDb().prepare('SELECT * FROM clients WHERE id = ?'),
  getAllClients: () => getDb().prepare('SELECT * FROM clients ORDER BY updated_at DESC'),
  insertClient: () => getDb().prepare(
    'INSERT INTO clients (id, name, project) VALUES (@id, @name, @project)'
  ),
  updateClient: () => getDb().prepare(
    'UPDATE clients SET name = @name, project = @project, updated_at = CURRENT_TIMESTAMP WHERE id = @id'
  ),

  // Meetings
  getMeetingById: () => getDb().prepare('SELECT * FROM meetings WHERE id = ?'),
  getMeetingsByClient: () => getDb().prepare(
    'SELECT * FROM meetings WHERE client_id = ? ORDER BY scheduled_at DESC'
  ),
  getMeetingsByStatus: () => getDb().prepare(
    'SELECT * FROM meetings WHERE status = ? ORDER BY scheduled_at ASC'
  ),
  insertMeeting: () => getDb().prepare(
    'INSERT INTO meetings (id, client_id, title, scheduled_at, status) VALUES (@id, @clientId, @title, @scheduledAt, @status)'
  ),
  updateMeetingBriefing: () => getDb().prepare(
    'UPDATE meetings SET briefing = @briefing, updated_at = CURRENT_TIMESTAMP WHERE id = @id'
  ),
  updateMeetingPostCall: () => getDb().prepare(
    'UPDATE meetings SET post_call_notes = @postCallNotes, status = \'completed\', updated_at = CURRENT_TIMESTAMP WHERE id = @id'
  ),

  // Meeting Sources
  insertMeetingSource: () => getDb().prepare(
    'INSERT INTO meeting_sources (id, meeting_id, source, external_id, summary, decisions, risks, raw_data) VALUES (@id, @meetingId, @source, @externalId, @summary, @decisions, @risks, @rawData)'
  ),
  getMeetingSourcesByMeeting: () => getDb().prepare(
    'SELECT * FROM meeting_sources WHERE meeting_id = ?'
  ),

  // Action Items
  insertActionItem: () => getDb().prepare(
    'INSERT INTO action_items (id, meeting_id, source, title, description, owner, deadline, priority, context_hash) VALUES (@id, @meetingId, @source, @title, @description, @owner, @deadline, @priority, @contextHash)'
  ),
  getActionItemsByMeeting: () => getDb().prepare(
    'SELECT * FROM action_items WHERE meeting_id = ? ORDER BY created_at ASC'
  ),
  getActionItemByHash: () => getDb().prepare(
    'SELECT * FROM action_items WHERE context_hash = ?'
  ),
  updateActionItemStatus: () => getDb().prepare(
    'UPDATE action_items SET status = @status, updated_at = CURRENT_TIMESTAMP WHERE id = @id'
  ),

  // Linear Sync
  insertLinearSync: () => getDb().prepare(
    'INSERT INTO linear_sync (id, action_item_id, meeting_id, linear_issue_id, source, sync_status) VALUES (@id, @actionItemId, @meetingId, @linearIssueId, @source, @syncStatus)'
  ),
  getLinearSyncByIssue: () => getDb().prepare(
    'SELECT * FROM linear_sync WHERE linear_issue_id = ?'
  ),
  getLinearSyncByMeeting: () => getDb().prepare(
    'SELECT * FROM linear_sync WHERE meeting_id = ?'
  ),
  updateLinearSyncStatus: () => getDb().prepare(
    'UPDATE linear_sync SET sync_status = @syncStatus, last_synced_at = CURRENT_TIMESTAMP WHERE id = @id'
  ),

  // Client History
  insertClientHistory: () => getDb().prepare(
    'INSERT INTO client_history (id, client_id, meeting_id, event_type, event_data) VALUES (@id, @clientId, @meetingId, @eventType, @eventData)'
  ),
  getClientHistory: () => getDb().prepare(
    'SELECT * FROM client_history WHERE client_id = ? ORDER BY occurred_at DESC'
  ),
};
