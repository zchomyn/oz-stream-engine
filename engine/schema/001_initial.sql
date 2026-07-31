-- APE ENGINE — Migration 001
--
-- The foundational tables. Session 1 scope: world tick state, agents,
-- their hot state, memories, and the between-character ledger.
--
-- Later migrations add: beats (Session 2), scenes/scene_shots/moments
-- (Session 2), render_queue (Session 3), locations/location_threads (moved
-- from JS seed data in Session 5).
--
-- Design rules:
--   - Everything typed. No blob-of-JSON columns unless the field is genuinely
--     variable (agent_state.value_json). Even then, the caller must know
--     the shape by field name.
--   - Every table has explicit primary key + created_at/updated_at where
--     relevant. Indexes only where queries prove they help.
--   - Migrations are one-way. No rollbacks. Down-migration is a restore
--     from backup — SQLite makes backups trivial (copy the file).

PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;   -- write-ahead log; concurrent reads while a writer works

-- Version tracking. Every migration inserts one row here so we know what
-- has run. The db.js migrate() function reads this to decide what to apply.
CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── world ──────────────────────────────────────────────────────────────────
-- One row, id=1. The tick state. Everything the world loop reads to decide
-- what happens in the next slot.
CREATE TABLE IF NOT EXISTS world (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    day INTEGER NOT NULL DEFAULT 1,
    minutes INTEGER NOT NULL DEFAULT 360,   -- 06:00 in sim minutes
    slot INTEGER NOT NULL DEFAULT 0,
    paused INTEGER NOT NULL DEFAULT 1,      -- SQLite bool as int
    speed_ms INTEGER NOT NULL DEFAULT 2000,
    weather TEXT NOT NULL DEFAULT 'clear',
    headline TEXT,
    money_checking INTEGER NOT NULL DEFAULT 236,
    money_note TEXT,
    last_slot_wall_ms INTEGER,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── agents ─────────────────────────────────────────────────────────────────
-- Three rows: marcus, lena, theo. Fields that change infrequently (once per
-- sim-day at most) live here. Hot fields — lastAct, lastSaid, mood, and so
-- on — live in agent_state so we don't rewrite this whole row every tick.
CREATE TABLE IF NOT EXISTS agents (
    key TEXT PRIMARY KEY,                    -- 'marcus' | 'lena' | 'theo'
    name TEXT NOT NULL,
    portrait_ref TEXT,                       -- future: media table id; today: null
    wardrobe_day TEXT NOT NULL DEFAULT '',
    wardrobe_night TEXT NOT NULL DEFAULT '',
    wake_hour REAL NOT NULL,
    sleep_hour REAL NOT NULL,

    -- Sense of self — the character's own self-appraisal.
    believes INTEGER NOT NULL DEFAULT 50,
    self_regard INTEGER NOT NULL DEFAULT 50,
    set_point INTEGER NOT NULL DEFAULT 50,

    -- Beliefs, wants stored as newline-separated text (small enough not to
    -- warrant their own tables in this migration; Session 2 may split them).
    beliefs TEXT NOT NULL DEFAULT '',
    wants TEXT NOT NULL DEFAULT '',

    -- Meters, mood — updated frequently but small; keep here for now.
    location TEXT NOT NULL DEFAULT 'kitchen',
    mood TEXT NOT NULL DEFAULT '',
    asleep INTEGER NOT NULL DEFAULT 0,

    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ─── agent_state ────────────────────────────────────────────────────────────
-- Hot per-tick key-value store per agent. Fields like lastAct, lastSaid,
-- innerMonologue, ritualPressure — things overwritten each turn.
-- value_json is small (usually a string, sometimes a small object).
-- (agent_key, field) is the natural key; use INSERT OR REPLACE.
CREATE TABLE IF NOT EXISTS agent_state (
    agent_key TEXT NOT NULL,
    field TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_key, field),
    FOREIGN KEY (agent_key) REFERENCES agents(key) ON DELETE CASCADE
);

-- ─── memories ──────────────────────────────────────────────────────────────
-- Append-only. Salience decays via reflection; retention prunes low-salience
-- ones. Query pattern: SELECT * FROM memories WHERE agent_key=? ORDER BY
-- salience DESC LIMIT 40 — indexed to make that fast.
CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    agent_key TEXT NOT NULL,
    text TEXT NOT NULL,
    salience REAL NOT NULL DEFAULT 0.5,
    day INTEGER NOT NULL,
    hour REAL NOT NULL,
    kind TEXT NOT NULL DEFAULT 'perception',   -- perception | reflection | location_residue | ...
    retold INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (agent_key) REFERENCES agents(key) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS memories_by_agent_salience
    ON memories (agent_key, salience DESC);
CREATE INDEX IF NOT EXISTS memories_by_day
    ON memories (day);

-- ─── ledger ─────────────────────────────────────────────────────────────────
-- How each character sees each other. 3 × 2 = 6 rows total, one per ordered
-- pair (marcus→lena, marcus→theo, lena→marcus, lena→theo, theo→marcus,
-- theo→lena). regard = warmth of feeling; trust = reliance. Both 0-100.
CREATE TABLE IF NOT EXISTS ledger (
    agent_key TEXT NOT NULL,
    other_key TEXT NOT NULL,
    regard INTEGER NOT NULL DEFAULT 50,
    trust INTEGER NOT NULL DEFAULT 50,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (agent_key, other_key),
    FOREIGN KEY (agent_key) REFERENCES agents(key) ON DELETE CASCADE,
    FOREIGN KEY (other_key) REFERENCES agents(key) ON DELETE CASCADE,
    CHECK (agent_key != other_key)
);

-- ─── Mark migration applied ────────────────────────────────────────────────
INSERT OR IGNORE INTO schema_migrations (version) VALUES (1);
