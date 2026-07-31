-- APE ENGINE — Migration 005
--
-- Render queue + media inventory. Session 3 of the rebuild (see DESIGN.md
-- Section 7). The queue is the ONE interface between the world loop and
-- the worker: engine INSERTs, worker SELECTs and UPDATEs. Media rows track
-- every file the worker writes so retention runs as SQL instead of walking
-- directories.
--
-- Queue semantics:
--   Engine emits render need → INSERT INTO render_queue (status='queued')
--   Worker picks next job → SELECT WHERE status='queued' ORDER BY priority DESC, id ASC LIMIT 1
--     → UPDATE status='running', started_at=NOW
--   On success → INSERT INTO media, UPDATE queue status='success', finished_at=NOW
--     → emit an event (Session 4's WebSocket bus will pick this up)
--   On failure → UPDATE attempts=attempts+1, error=...
--     → if attempts < max_attempts: status='queued' (retry)
--     → else: status='failed', finished_at=NOW
--
-- Priority levels are numeric so ORDER BY sorts naturally. Higher number =
-- runs first. Aligned with DESIGN.md Section 7:
--   10 — moment capture (user just clicked; must feel snappy)
--    5 — scene stills (Director planned, no rush)
--    3 — scene videos (heavy, sequential, ~1min each)
--    1 — cutaway, plate, portrait (one-time cached; regenerate on miss)

CREATE TABLE IF NOT EXISTS render_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    -- still | video | edit | cutaway | plate | portrait | moment | object_focus
    payload_json TEXT NOT NULL,
    -- kind-specific parameters the worker needs to execute. Shape by kind:
    --   still:        { scene_id, shot_index, particle }
    --   video:        { scene_id, shot_index }
    --   edit:         { scene_id }
    --   cutaway:      { }
    --   plate:        { location, is_home }
    --   portrait:     { agent_key }
    --   moment:       { location, day, slot, actors, activity, prompt }
    --   object_focus: { location, object_key }
    status TEXT NOT NULL DEFAULT 'queued',
    -- queued | running | success | failed | cancelled
    priority INTEGER NOT NULL DEFAULT 5,
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    error TEXT,
    result_media_id INTEGER,    -- populated on success, references media.id
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    started_at TEXT,
    finished_at TEXT
);

-- Fast picker query: WHERE status='queued' ORDER BY priority DESC, id ASC
CREATE INDEX IF NOT EXISTS render_queue_picker ON render_queue (status, priority DESC, id ASC);
-- For retention + admin views
CREATE INDEX IF NOT EXISTS render_queue_by_finished ON render_queue (finished_at DESC) WHERE finished_at IS NOT NULL;

-- Media inventory. Every file the worker writes gets a row here. Retention
-- runs against this table with `DELETE ... ORDER BY created_at ASC` until
-- total bytes drop below the target. Scene shots reference media by id.
CREATE TABLE IF NOT EXISTS media (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    -- still | video | edit | cutaway | plate | portrait | moment | object_focus
    path TEXT NOT NULL UNIQUE,
    bytes INTEGER NOT NULL DEFAULT 0,
    sha256 TEXT,                 -- optional; populated when we care about dedup
    scene_id TEXT,               -- populated for scene stills/videos, null otherwise
    shot_index INTEGER,          -- populated for scene shots
    moment_id TEXT,              -- populated for moment captures
    metadata_json TEXT,          -- kind-specific extras (agent_key for portraits, etc.)
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS media_by_kind ON media (kind);
CREATE INDEX IF NOT EXISTS media_by_created ON media (created_at ASC);
CREATE INDEX IF NOT EXISTS media_by_scene ON media (scene_id) WHERE scene_id IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version) VALUES (5);
