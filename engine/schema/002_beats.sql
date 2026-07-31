-- APE ENGINE — Migration 002
--
-- The beats table. What used to be W.truthLog (an unbounded in-memory array
-- serialized wholesale to JSON on every save) becomes append-only rows here.
--
-- Query patterns this table supports:
--   1. Live feed:      SELECT * FROM beats ORDER BY id DESC LIMIT 200
--   2. Director scan:  SELECT * FROM beats WHERE slot >= ? ORDER BY id ASC
--   3. Location beats: SELECT * FROM beats WHERE location = ? AND slot >= ?
--   4. Topic history:  SELECT topic, COUNT(*) FROM beats
--                       WHERE slot >= ? GROUP BY topic ORDER BY 2 DESC
--   5. Actor mentions: SELECT * FROM beats
--                       WHERE actors_json LIKE ? AND slot >= ?
--
-- Indexes below cover 1-4. Query 5 uses LIKE against actors_json which is a
-- linear scan — acceptable for the Director's scoring window (last few
-- hundred beats), but if it becomes hot we'd normalize into a beat_actors
-- junction table. Session 5 or later.

CREATE TABLE IF NOT EXISTS beats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slot INTEGER NOT NULL,
    day INTEGER NOT NULL,
    time TEXT NOT NULL,                    -- 'HH:MM' clock at the beat
    location TEXT NOT NULL,
    actors_json TEXT NOT NULL DEFAULT '[]',
    kind TEXT NOT NULL,                    -- talk | action | ambient | arrival | departure | text
    text TEXT NOT NULL,
    topic TEXT,                            -- may be null for legacy/ambient beats
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Live feed + Director scans hit this
CREATE INDEX IF NOT EXISTS beats_by_slot_desc ON beats (slot DESC);

-- Location filtering (room views, scene planners)
CREATE INDEX IF NOT EXISTS beats_by_location_slot ON beats (location, slot DESC);

-- Topic fixation detector counts across recent slots
CREATE INDEX IF NOT EXISTS beats_by_topic_slot ON beats (topic, slot DESC) WHERE topic IS NOT NULL;

INSERT OR IGNORE INTO schema_migrations (version) VALUES (2);
