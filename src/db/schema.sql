CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'client',
  project TEXT,
  aliases TEXT NOT NULL DEFAULT '{"domains":[],"emails":[],"keywords":[]}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  scheduled_at DATETIME,
  status TEXT DEFAULT 'scheduled', -- scheduled, in_progress, completed
  briefing TEXT, -- JSON
  post_call_notes TEXT, -- JSON
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS meeting_sources (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  source TEXT NOT NULL, -- 'krisp', 'granola', 'manual'
  external_id TEXT, -- ID in the source system
  summary TEXT,
  decisions TEXT, -- JSON array
  risks TEXT, -- JSON array
  raw_data TEXT, -- Full JSON response
  fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS external_context (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  occurred_at DATETIME NOT NULL,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(source, external_id, client_id)
);

CREATE TABLE IF NOT EXISTS action_items (
  id TEXT PRIMARY KEY,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  source TEXT NOT NULL, -- 'krisp', 'granola', 'manual'
  title TEXT NOT NULL,
  description TEXT,
  owner TEXT,
  deadline DATETIME,
  priority TEXT DEFAULT 'medium',
  context_hash TEXT, -- SHA-256 for idempotent matching
  status TEXT DEFAULT 'pending', -- pending, synced, completed
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS linear_sync (
  id TEXT PRIMARY KEY,
  action_item_id TEXT REFERENCES action_items(id) ON DELETE SET NULL,
  meeting_id TEXT NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  linear_issue_id TEXT NOT NULL,
  source TEXT NOT NULL, -- 'krisp', 'granola', 'manual'
  sync_status TEXT DEFAULT 'created', -- created, updated, closed
  last_synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(meeting_id, linear_issue_id)
);

CREATE TABLE IF NOT EXISTS client_history (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  meeting_id TEXT REFERENCES meetings(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL, -- 'meeting', 'task_created', 'task_updated', 'status_change'
  event_data TEXT NOT NULL, -- JSON
  occurred_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indices for fast lookups
CREATE INDEX IF NOT EXISTS idx_meetings_client ON meetings(client_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_meeting_sources_unique_external
  ON meeting_sources(meeting_id, source, external_id)
  WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_meetings_status ON meetings(status);
CREATE INDEX IF NOT EXISTS idx_action_items_meeting ON action_items(meeting_id);
CREATE INDEX IF NOT EXISTS idx_action_items_hash ON action_items(context_hash);
CREATE INDEX IF NOT EXISTS idx_linear_sync_issue ON linear_sync(linear_issue_id);
CREATE INDEX IF NOT EXISTS idx_linear_sync_meeting ON linear_sync(meeting_id);
CREATE INDEX IF NOT EXISTS idx_client_history_client ON client_history(client_id);
CREATE INDEX IF NOT EXISTS idx_external_context_client ON external_context(client_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_external_context_source ON external_context(source, external_id);
CREATE INDEX IF NOT EXISTS idx_meetings_scheduled ON meetings(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_action_items_deadline ON action_items(deadline);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status);
