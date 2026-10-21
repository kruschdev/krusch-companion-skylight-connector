-- @krusch/companion-skylight-connector: Local SQLite Sync & Twin Schema v1
-- Compatible with Krusch Companion SQLite WAL database (data/companion.db)

-- 1. Sync Runs Audit Log (Tracks bidirectional sync snapshots, row counts, redactions, and errors)
CREATE TABLE IF NOT EXISTS skylight_sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  domain TEXT NOT NULL,
  frame_id TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'push',
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  rows_synced INTEGER DEFAULT 0,
  rows_redacted INTEGER DEFAULT 0,
  error_message TEXT,
  metadata_json TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_skylight_sync_runs_domain ON skylight_sync_runs(domain, frame_id);
CREATE INDEX IF NOT EXISTS idx_skylight_sync_runs_status ON skylight_sync_runs(status);

-- 2. Bidirectional Entity Mapping Ledger (Maps Companion local IDs <-> Skylight Cloud IDs)
CREATE TABLE IF NOT EXISTS skylight_sync_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type TEXT NOT NULL, -- 'chore' | 'event' | 'list_item' | 'meal'
  local_id TEXT NOT NULL,
  skylight_id TEXT NOT NULL,
  frame_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  completed INTEGER DEFAULT 0,
  direction TEXT DEFAULT 'bidirectional',
  last_synced_at TEXT DEFAULT (datetime('now')),
  metadata_json TEXT DEFAULT '{}',
  UNIQUE(entity_type, local_id, frame_id),
  UNIQUE(entity_type, skylight_id, frame_id)
);

CREATE INDEX IF NOT EXISTS idx_skylight_map_lookup ON skylight_sync_map(entity_type, frame_id);

-- 3. Sovereign Local Twin Cache (Offline & sub-millisecond mirror of Skylight Frame items)
CREATE TABLE IF NOT EXISTS skylight_local_twin (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  frame_id TEXT NOT NULL,
  entity_type TEXT NOT NULL, -- 'frame' | 'category' | 'chore' | 'event' | 'list' | 'list_item' | 'meal' | 'reward'
  skylight_id TEXT NOT NULL,
  title TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  date TEXT,
  category_label TEXT,
  payload_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE(frame_id, entity_type, skylight_id)
);

CREATE INDEX IF NOT EXISTS idx_skylight_twin_type_date ON skylight_local_twin(frame_id, entity_type, date);
