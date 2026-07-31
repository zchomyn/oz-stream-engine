-- APE ENGINE — Migration 003
--
-- Scenes and moments: the two rendered artifacts of the world.
--
-- Scenes are Director-planned 4-shot storyboards, either from an arc the
-- scanner found or from a moment the operator expanded. Each has a title, a
-- logline, and 4 rows in scene_shots for the individual particles.
--
-- Moments are user-initiated freeze-frames of a specific room at a specific
-- slot. Lighter-weight — just a hero image + metadata. A moment can be
-- expanded into a scene, at which point moments.storyboard_scene_id links.
--
-- Media files themselves (jpg/mp4) stay on disk. DB stores paths as refs.
-- Session 3's media table adds proper accounting; for now paths suffice.

CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,                    -- 'scene_dNN_sSSS_EEE'
    day INTEGER NOT NULL,
    start_slot INTEGER NOT NULL,
    end_slot INTEGER NOT NULL,
    start_time TEXT NOT NULL,               -- 'HH:MM'
    end_time TEXT NOT NULL,
    actors_json TEXT NOT NULL DEFAULT '[]',
    score INTEGER NOT NULL DEFAULT 0,
    title TEXT,
    logline TEXT,
    status TEXT NOT NULL DEFAULT 'candidate',
    -- candidate | planning | rendering | storyboarded | storyboarded_partial | expired | render_failed | plan_failed
    origin TEXT NOT NULL DEFAULT 'director',
    -- director | moment_expansion
    poster_ref TEXT,                        -- path or URL fragment
    video_ref TEXT,                         -- path or URL fragment
    video_status TEXT,                      -- animating | editing | ready | edit_failed | budget_gated | null
    beats_json TEXT NOT NULL DEFAULT '[]',
    breakdown_json TEXT,                    -- Director score breakdown
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    rendered_at TEXT,
    error TEXT
);

CREATE INDEX IF NOT EXISTS scenes_by_status ON scenes (status);
CREATE INDEX IF NOT EXISTS scenes_by_day ON scenes (day DESC, start_slot DESC);
CREATE INDEX IF NOT EXISTS scenes_by_score ON scenes (score DESC) WHERE status IN ('candidate', 'storyboarded');

CREATE TABLE IF NOT EXISTS scene_shots (
    scene_id TEXT NOT NULL,
    shot_index INTEGER NOT NULL,
    grammar TEXT NOT NULL,                  -- wide | medium | close_up | reaction | detail
    subject TEXT NOT NULL,                  -- character name of the shot's subject
    moment TEXT,                            -- what this shot depicts
    directive TEXT,                         -- LLM cinematographer's framing note
    status TEXT NOT NULL DEFAULT 'queued',
    -- queued | rendering | ready | failed | animating | animated
    still_ref TEXT,                         -- path to shot_N.jpg
    video_ref TEXT,                         -- path to shot_N.mp4 (Chunk C output)
    error TEXT,
    PRIMARY KEY (scene_id, shot_index),
    FOREIGN KEY (scene_id) REFERENCES scenes(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS moments (
    id TEXT PRIMARY KEY,                    -- opaque id from MOMENT_STORE.newId()
    location TEXT NOT NULL,
    day INTEGER NOT NULL,
    slot INTEGER NOT NULL,
    time TEXT NOT NULL,
    actors_json TEXT NOT NULL DEFAULT '[]',
    activity_json TEXT NOT NULL DEFAULT '[]',  -- array of activity descriptor lines
    hero_ref TEXT NOT NULL,                    -- path to hero.jpg
    storyboard_scene_id TEXT,                  -- set when expanded to a scene
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (storyboard_scene_id) REFERENCES scenes(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS moments_by_captured ON moments (captured_at DESC);
CREATE INDEX IF NOT EXISTS moments_by_day_slot ON moments (day DESC, slot DESC);

INSERT OR IGNORE INTO schema_migrations (version) VALUES (3);
