-- APE ENGINE — Migration 004
--
-- Campaigns + signals. Session 2c overflow — the nuke deleted /data/campaigns/
-- and that reminded us campaigns weren't in DB, only on disk. Fixing that.
--
-- Campaigns table shape: typed columns for the scalar + date fields the
-- engine actually queries on (state, startDay, createdAt), JSON blob columns
-- for the genuinely flexible nested data (brief, promise, tracking, mediaPlan,
-- touches, purchases). Not full normalization — the queries are cheap and
-- few, and the nested shape changes as the campaign feature evolves.
--
-- Signals: one row per signal, foreign-keyed to campaign. Signals are the
-- atomic unit the dashboard renders. Queried by campaign_id ORDER BY id ASC
-- (chronological within a campaign) — indexed for that.

CREATE TABLE IF NOT EXISTS campaigns (
    id TEXT PRIMARY KEY,
    brand TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL DEFAULT 'draft',   -- draft | running | ended
    start_slot INTEGER,
    start_day INTEGER,
    start_at TEXT,
    end_slot INTEGER,
    end_day INTEGER,
    end_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    delivery_injection TEXT NOT NULL DEFAULT '',
    -- Flexible nested data as JSON. Queries never SELECT on inside these.
    brief_json TEXT NOT NULL DEFAULT '{}',
    promise_json TEXT NOT NULL DEFAULT '{}',
    tracking_json TEXT NOT NULL DEFAULT '{}',
    media_plan_json TEXT,
    touches_json TEXT NOT NULL DEFAULT '[]',
    purchases_json TEXT NOT NULL DEFAULT '[]',
    results_json TEXT
);

CREATE INDEX IF NOT EXISTS campaigns_by_state ON campaigns (state);
CREATE INDEX IF NOT EXISTS campaigns_by_created ON campaigns (created_at DESC);

CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    campaign_id TEXT NOT NULL,
    kind TEXT NOT NULL,                     -- lifecycle | thought | said | done | relational | emotional | ...
    lens TEXT,                              -- meta | thought | said | done | ...
    text TEXT NOT NULL,
    actor TEXT,                             -- lowercase first name, may be null for lifecycle signals
    slot INTEGER,
    day INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (campaign_id) REFERENCES campaigns(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS signals_by_campaign ON signals (campaign_id, id ASC);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (4);
