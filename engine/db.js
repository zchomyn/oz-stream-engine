// APE ENGINE — SQLite adapter
//
// The DB is the source of truth for engine state as of v2.26 (Session 1 of
// the rebuild — see DESIGN.md). Every module that reads or writes durable
// state imports helpers from here rather than talking to better-sqlite3
// directly. That means:
//   - Schema changes have one gate (this file + the /schema migrations)
//   - Callers don't know or care about SQL
//   - Tests can swap in a memory DB with one line
//
// Sync API is a deliberate choice: the engine's world loop, save/load, and
// migration are already synchronous. Async DB would force every path to
// become async — noisy refactor with no gain.

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const CFG = require("./config");

const DB_PATH = process.env.OZ_DB_PATH || path.join(path.dirname(CFG.SAVE_PATH), "state.db");
const SCHEMA_DIR = path.join(__dirname, "schema");

let _db = null;

// Open (or reuse) the DB. Enables WAL mode + foreign keys as pragmas at open
// time. Idempotent — safe to call from every module.
function open() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  return _db;
}

// Run any pending migrations. Reads /schema/NNN_*.sql files in numeric order,
// checks schema_migrations table for what's already applied, applies the
// rest atomically. Called once at boot from server.js.
function migrate() {
  const db = open();
  // Ensure the tracking table exists before we look at it
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (datetime('now')))");

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => r.version)
  );

  const files = fs.readdirSync(SCHEMA_DIR)
    .filter((f) => /^\d+_.*\.sql$/.test(f))
    .sort();

  let ran = 0;
  for (const file of files) {
    const version = parseInt(file.split("_")[0], 10);
    if (applied.has(version)) continue;
    const sql = fs.readFileSync(path.join(SCHEMA_DIR, file), "utf8");
    // Each migration is applied in its own transaction. Failure = full
    // rollback of THIS migration only.
    const tx = db.transaction(() => {
      db.exec(sql);
    });
    try {
      tx();
      ran++;
      console.log(`[db] migration ${version} (${file}) applied`);
    } catch (e) {
      console.error(`[db] migration ${version} (${file}) FAILED: ${e.message}`);
      throw e;
    }
  }
  // Post-migrate housekeeping: recover any render jobs left in 'running'
  // state by a prior process death. They get requeued for retry.
  try {
    const recovered = recoverStuckRenderJobs();
    if (recovered) console.log(`[db] recovered ${recovered} stuck render job(s) — requeued`);
  } catch (_) { /* render_queue may not exist if migrations before 005 haven't run */ }

  return { ran, total: files.length };
}

// ─── World tick state ─────────────────────────────────────────────────────

// Read the single world row. Returns null if not yet initialized (first boot).
function getWorld() {
  const db = open();
  return db.prepare("SELECT * FROM world WHERE id = 1").get() || null;
}

// Upsert the world row. Called by save() every tick. Small write.
function setWorld(w) {
  const db = open();
  db.prepare(`
    INSERT INTO world (id, day, minutes, slot, paused, speed_ms, weather, headline,
                      money_checking, money_note, last_slot_wall_ms, updated_at)
    VALUES (1, @day, @minutes, @slot, @paused, @speed_ms, @weather, @headline,
            @money_checking, @money_note, @last_slot_wall_ms, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET
      day = excluded.day,
      minutes = excluded.minutes,
      slot = excluded.slot,
      paused = excluded.paused,
      speed_ms = excluded.speed_ms,
      weather = excluded.weather,
      headline = excluded.headline,
      money_checking = excluded.money_checking,
      money_note = excluded.money_note,
      last_slot_wall_ms = excluded.last_slot_wall_ms,
      updated_at = datetime('now')
  `).run({
    day: w.day,
    minutes: w.minutes,
    slot: w.slot,
    paused: w.paused ? 1 : 0,
    speed_ms: w.speed_ms || w.speedMs,
    weather: w.weather || (w.env && w.env.weather) || "clear",
    headline: w.headline || (w.env && w.env.headline) || null,
    money_checking: w.money_checking != null ? w.money_checking : (w.money ? w.money.checking : 0),
    money_note: w.money_note || (w.money ? w.money.note : null),
    last_slot_wall_ms: w.last_slot_wall_ms || w.lastSlotWall || null,
  });
}

// ─── Agents ───────────────────────────────────────────────────────────────

function getAgent(key) {
  return open().prepare("SELECT * FROM agents WHERE key = ?").get(key) || null;
}

function listAgents() {
  return open().prepare("SELECT * FROM agents ORDER BY key").all();
}

function upsertAgent(a) {
  open().prepare(`
    INSERT INTO agents (key, name, portrait_ref, wardrobe_day, wardrobe_night,
                       wake_hour, sleep_hour, believes, self_regard, set_point,
                       beliefs, wants, location, mood, asleep, updated_at)
    VALUES (@key, @name, @portrait_ref, @wardrobe_day, @wardrobe_night,
            @wake_hour, @sleep_hour, @believes, @self_regard, @set_point,
            @beliefs, @wants, @location, @mood, @asleep, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      name = excluded.name,
      portrait_ref = excluded.portrait_ref,
      wardrobe_day = excluded.wardrobe_day,
      wardrobe_night = excluded.wardrobe_night,
      wake_hour = excluded.wake_hour,
      sleep_hour = excluded.sleep_hour,
      believes = excluded.believes,
      self_regard = excluded.self_regard,
      set_point = excluded.set_point,
      beliefs = excluded.beliefs,
      wants = excluded.wants,
      location = excluded.location,
      mood = excluded.mood,
      asleep = excluded.asleep,
      updated_at = datetime('now')
  `).run({
    key: a.key,
    name: a.name || a.key,
    portrait_ref: a.portrait_ref || null,
    wardrobe_day: a.wardrobe_day ?? a.wardrobe?.day ?? "",
    wardrobe_night: a.wardrobe_night ?? a.wardrobe?.night ?? "",
    wake_hour: a.wake_hour ?? a.wake ?? 6,
    sleep_hour: a.sleep_hour ?? a.sleep ?? 23,
    believes: a.believes ?? a.senseOfSelf?.believes ?? 50,
    self_regard: a.self_regard ?? a.senseOfSelf?.selfRegard ?? 50,
    set_point: a.set_point ?? a.senseOfSelf?.setPoint ?? 50,
    beliefs: Array.isArray(a.beliefs) ? a.beliefs.join("\n") : (a.beliefs || ""),
    wants: Array.isArray(a.wants) ? a.wants.join("\n") : (a.wants || ""),
    location: a.location || "kitchen",
    mood: a.mood || "",
    asleep: a.asleep ? 1 : 0,
  });
}

// ─── Agent hot state ──────────────────────────────────────────────────────

// Get one field. Returns null if not set.
function getAgentField(agent_key, field) {
  const row = open().prepare("SELECT value_json FROM agent_state WHERE agent_key = ? AND field = ?").get(agent_key, field);
  if (!row) return null;
  try { return JSON.parse(row.value_json); } catch (_) { return null; }
}

// Get all hot state for one agent as an object { field: value, ... }.
function getAgentState(agent_key) {
  const rows = open().prepare("SELECT field, value_json FROM agent_state WHERE agent_key = ?").all(agent_key);
  const out = {};
  for (const r of rows) {
    try { out[r.field] = JSON.parse(r.value_json); } catch (_) {}
  }
  return out;
}

// Upsert one field. Value is JSON-serialized.
function setAgentField(agent_key, field, value) {
  open().prepare(`
    INSERT INTO agent_state (agent_key, field, value_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(agent_key, field) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = datetime('now')
  `).run(agent_key, field, JSON.stringify(value));
}

// Bulk set multiple hot-state fields for one agent in one transaction.
function setAgentStateBulk(agent_key, fields) {
  const db = open();
  const stmt = db.prepare(`
    INSERT INTO agent_state (agent_key, field, value_json, updated_at)
    VALUES (?, ?, ?, datetime('now'))
    ON CONFLICT(agent_key, field) DO UPDATE SET
      value_json = excluded.value_json,
      updated_at = datetime('now')
  `);
  const tx = db.transaction((entries) => {
    for (const [field, value] of entries) stmt.run(agent_key, field, JSON.stringify(value));
  });
  tx(Object.entries(fields));
}

// ─── Memories ─────────────────────────────────────────────────────────────

function addMemory({ agent_key, text, salience = 0.5, day, hour, kind = "perception" }) {
  return open().prepare(`
    INSERT INTO memories (agent_key, text, salience, day, hour, kind)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(agent_key, text, salience, day, hour, kind).lastInsertRowid;
}

function topMemories(agent_key, limit = 40) {
  return open().prepare(`
    SELECT * FROM memories WHERE agent_key = ?
    ORDER BY salience DESC LIMIT ?
  `).all(agent_key, limit);
}

function updateMemorySalience(id, salience) {
  open().prepare("UPDATE memories SET salience = ? WHERE id = ?").run(salience, id);
}

function pruneMemoriesBelow(agent_key, minSalience) {
  return open().prepare(`
    DELETE FROM memories WHERE agent_key = ? AND salience < ?
  `).run(agent_key, minSalience).changes;
}

// ─── Ledger ───────────────────────────────────────────────────────────────

function getLedger(agent_key, other_key) {
  return open().prepare(`
    SELECT * FROM ledger WHERE agent_key = ? AND other_key = ?
  `).get(agent_key, other_key) || null;
}

function getAgentLedger(agent_key) {
  const rows = open().prepare(`
    SELECT other_key, regard, trust FROM ledger WHERE agent_key = ?
  `).all(agent_key);
  const out = {};
  for (const r of rows) out[r.other_key] = { regard: r.regard, trust: r.trust };
  return out;
}

function upsertLedger(agent_key, other_key, { regard, trust }) {
  open().prepare(`
    INSERT INTO ledger (agent_key, other_key, regard, trust, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(agent_key, other_key) DO UPDATE SET
      regard = excluded.regard,
      trust = excluded.trust,
      updated_at = datetime('now')
  `).run(agent_key, other_key, regard, trust);
}

// ─── Beats ────────────────────────────────────────────────────────────────
// The truth log. Append-only. Every dispose event becomes one row here.

// Insert one beat. Returns the auto-assigned id.
function addBeat({ slot, day, time, location, actors, kind, text, topic }) {
  const info = open().prepare(`
    INSERT INTO beats (slot, day, time, location, actors_json, kind, text, topic)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    slot, day, time, location,
    JSON.stringify(actors || []),
    kind, text, topic || null
  );
  return info.lastInsertRowid;
}

// Bulk-insert an array of beats in one transaction. Called when a dispose
// step produces multiple events for the same slot.
function addBeatsBulk(beats) {
  if (!beats.length) return 0;
  const db = open();
  const stmt = db.prepare(`
    INSERT INTO beats (slot, day, time, location, actors_json, kind, text, topic)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((rows) => {
    for (const b of rows) {
      stmt.run(b.slot, b.day, b.time, b.location, JSON.stringify(b.actors || []), b.kind, b.text, b.topic || null);
    }
  });
  tx(beats);
  return beats.length;
}

// Row → beat object with actors parsed back into an array. Used by every reader.
function _rowToBeat(row) {
  if (!row) return null;
  let actors = [];
  try { actors = JSON.parse(row.actors_json || "[]"); } catch (_) {}
  return {
    id: row.id, slot: row.slot, day: row.day, time: row.time,
    location: row.location, actors, kind: row.kind, text: row.text, topic: row.topic,
  };
}

// Most recent beats, newest first. For the Live Dialogue feed.
function recentBeats(limit = 200) {
  const rows = open().prepare(`
    SELECT * FROM beats ORDER BY id DESC LIMIT ?
  `).all(limit);
  return rows.map(_rowToBeat);
}

// Beats from `sinceSlot` forward, oldest first. For the Director's scan.
function beatsSince(sinceSlot, limit = 500) {
  const rows = open().prepare(`
    SELECT * FROM beats WHERE slot >= ? ORDER BY id ASC LIMIT ?
  `).all(sinceSlot, limit);
  return rows.map(_rowToBeat);
}

// Beats at a specific location within a slot window. For location-aware
// scene planning and room-history summaries.
function beatsInLocation(location, sinceSlot, limit = 200) {
  const rows = open().prepare(`
    SELECT * FROM beats WHERE location = ? AND slot >= ? ORDER BY id ASC LIMIT ?
  `).all(location, sinceSlot, limit);
  return rows.map(_rowToBeat);
}

// Topic frequency for the fixation detector. Returns { topic: count } for the
// last `slotWindow` slots, ordered by count DESC.
function topicFrequency(slotWindow = 30) {
  const rows = open().prepare(`
    SELECT topic, COUNT(*) AS c FROM beats
    WHERE topic IS NOT NULL AND slot >= (
      SELECT COALESCE(MAX(slot), 0) - ? FROM beats
    )
    GROUP BY topic
    ORDER BY c DESC
  `).all(slotWindow);
  const out = {};
  for (const r of rows) out[r.topic] = r.c;
  return out;
}

function beatCount() {
  return open().prepare("SELECT COUNT(*) AS c FROM beats").get().c;
}

// Prune beats older than `keepLastNSlots`. Called by retention.
function pruneBeats(keepLastNSlots = 5000) {
  const info = open().prepare(`
    DELETE FROM beats WHERE slot < (
      SELECT COALESCE(MAX(slot), 0) - ? FROM beats
    )
  `).run(keepLastNSlots);
  return info.changes;
}

// ─── Scenes + Shots ───────────────────────────────────────────────────────
// Director-planned 4-shot storyboards. One row per scene, four in scene_shots.

// Row → JS object with JSON fields parsed.
function _rowToScene(row) {
  if (!row) return null;
  let actors = [], beats = [], breakdown = null;
  try { actors = JSON.parse(row.actors_json || "[]"); } catch (_) {}
  try { beats = JSON.parse(row.beats_json || "[]"); } catch (_) {}
  try { breakdown = row.breakdown_json ? JSON.parse(row.breakdown_json) : null; } catch (_) {}
  return {
    id: row.id, day: row.day,
    startSlot: row.start_slot, endSlot: row.end_slot,
    startTime: row.start_time, endTime: row.end_time,
    actors, score: row.score,
    title: row.title, logline: row.logline,
    status: row.status, origin: row.origin,
    poster: row.poster_ref, videoUrl: row.video_ref, videoStatus: row.video_status,
    beats, breakdown,
    createdAt: row.created_at, renderedAt: row.rendered_at,
    error: row.error,
  };
}

// Upsert a scene row. Called when the Director finds a candidate and when
// its status transitions through the render pipeline. Idempotent on id.
function upsertScene(scene) {
  open().prepare(`
    INSERT INTO scenes (
      id, day, start_slot, end_slot, start_time, end_time, actors_json,
      score, title, logline, status, origin, poster_ref, video_ref,
      video_status, beats_json, breakdown_json, rendered_at, error
    ) VALUES (
      @id, @day, @start_slot, @end_slot, @start_time, @end_time, @actors_json,
      @score, @title, @logline, @status, @origin, @poster_ref, @video_ref,
      @video_status, @beats_json, @breakdown_json, @rendered_at, @error
    )
    ON CONFLICT(id) DO UPDATE SET
      day = excluded.day,
      start_slot = excluded.start_slot,
      end_slot = excluded.end_slot,
      start_time = excluded.start_time,
      end_time = excluded.end_time,
      actors_json = excluded.actors_json,
      score = excluded.score,
      title = excluded.title,
      logline = excluded.logline,
      status = excluded.status,
      origin = excluded.origin,
      poster_ref = excluded.poster_ref,
      video_ref = excluded.video_ref,
      video_status = excluded.video_status,
      beats_json = excluded.beats_json,
      breakdown_json = excluded.breakdown_json,
      rendered_at = excluded.rendered_at,
      error = excluded.error
  `).run({
    id: scene.id,
    day: scene.day,
    start_slot: scene.startSlot ?? scene.start_slot ?? 0,
    end_slot: scene.endSlot ?? scene.end_slot ?? 0,
    start_time: scene.startTime ?? scene.start_time ?? "00:00",
    end_time: scene.endTime ?? scene.end_time ?? "00:00",
    actors_json: JSON.stringify(scene.actors || []),
    score: scene.score ?? 0,
    title: scene.title ?? null,
    logline: scene.logline ?? null,
    status: scene.status ?? "candidate",
    origin: scene.origin ?? "director",
    poster_ref: scene.poster ?? scene.poster_ref ?? null,
    video_ref: scene.videoUrl ?? scene.video_ref ?? null,
    video_status: scene.videoStatus ?? scene.video_status ?? null,
    beats_json: JSON.stringify(scene.beats || []),
    breakdown_json: scene.breakdown ? JSON.stringify(scene.breakdown) : null,
    rendered_at: scene.renderedAt ?? scene.rendered_at ?? null,
    error: scene.error ?? null,
  });
}

function getScene(id) {
  return _rowToScene(open().prepare("SELECT * FROM scenes WHERE id = ?").get(id));
}

function listScenes({ status, limit = 30, orderBy = "day_desc" } = {}) {
  const db = open();
  const orderClause = orderBy === "score_desc"
    ? "ORDER BY score DESC"
    : orderBy === "created_desc"
    ? "ORDER BY created_at DESC"
    : "ORDER BY day DESC, start_slot DESC";
  const rows = status
    ? db.prepare(`SELECT * FROM scenes WHERE status = ? ${orderClause} LIMIT ?`).all(status, limit)
    : db.prepare(`SELECT * FROM scenes ${orderClause} LIMIT ?`).all(limit);
  return rows.map(_rowToScene);
}

function scenesByStatuses(statuses, limit = 30) {
  if (!statuses.length) return [];
  const placeholders = statuses.map(() => "?").join(",");
  const rows = open().prepare(`
    SELECT * FROM scenes WHERE status IN (${placeholders})
    ORDER BY day DESC, start_slot DESC LIMIT ?
  `).all(...statuses, limit);
  return rows.map(_rowToScene);
}

function pruneScenes(keepCount = 50) {
  const info = open().prepare(`
    DELETE FROM scenes WHERE id NOT IN (
      SELECT id FROM scenes ORDER BY created_at DESC LIMIT ?
    )
  `).run(keepCount);
  return info.changes;
}

// Scene shots — one row per particle. Two-phase upsert: shot exists as
// 'queued' from the moment a scene is planned, then flips to 'ready' when
// its still is rendered, then 'animated' when Chunk C runs.
function upsertSceneShot(shot) {
  // Coerce subject to a string. In-flight particles carry `subject` as an
  // Identity object (with .name, .wardrobe, .portrait). Snapshotted particles
  // and DB-loaded rows carry it as a plain string. Both must upsert cleanly.
  const subjectStr = (typeof shot.subject === "object" && shot.subject !== null)
    ? String(shot.subject.name || "")
    : String(shot.subject || "");
  open().prepare(`
    INSERT INTO scene_shots (scene_id, shot_index, grammar, subject, moment,
                             directive, status, still_ref, video_ref, error)
    VALUES (@scene_id, @shot_index, @grammar, @subject, @moment,
            @directive, @status, @still_ref, @video_ref, @error)
    ON CONFLICT(scene_id, shot_index) DO UPDATE SET
      grammar = excluded.grammar,
      subject = excluded.subject,
      moment = excluded.moment,
      directive = excluded.directive,
      status = excluded.status,
      still_ref = excluded.still_ref,
      video_ref = excluded.video_ref,
      error = excluded.error
  `).run({
    scene_id: shot.sceneId ?? shot.scene_id,
    shot_index: shot.shotIndex ?? shot.shot_index,
    grammar: shot.grammar || "medium",
    subject: subjectStr,
    moment: shot.moment || null,
    directive: shot.directive || null,
    status: shot.status || "queued",
    still_ref: shot.stillPath ?? shot.still_ref ?? null,
    video_ref: shot.videoPath ?? shot.video_ref ?? null,
    error: shot.error ?? null,
  });
}

function getSceneShots(scene_id) {
  const rows = open().prepare(`
    SELECT * FROM scene_shots WHERE scene_id = ? ORDER BY shot_index ASC
  `).all(scene_id);
  return rows.map((r) => ({
    sceneId: r.scene_id, shotIndex: r.shot_index,
    grammar: r.grammar, subject: r.subject, moment: r.moment,
    directive: r.directive, status: r.status,
    stillPath: r.still_ref, videoPath: r.video_ref,
    error: r.error,
  }));
}

// ─── Moments ──────────────────────────────────────────────────────────────
// User-captured freeze-frames. Persist metadata + a ref to the hero image.

function _rowToMoment(row) {
  if (!row) return null;
  let actors = [], activity = [];
  try { actors = JSON.parse(row.actors_json || "[]"); } catch (_) {}
  try { activity = JSON.parse(row.activity_json || "[]"); } catch (_) {}
  return {
    id: row.id, location: row.location,
    day: row.day, slot: row.slot, time: row.time,
    actors, activityLines: activity,
    heroPath: row.hero_ref,
    storyboardSceneId: row.storyboard_scene_id,
    capturedAt: row.captured_at,
  };
}

function upsertMoment(moment) {
  open().prepare(`
    INSERT INTO moments (id, location, day, slot, time, actors_json,
                         activity_json, hero_ref, storyboard_scene_id)
    VALUES (@id, @location, @day, @slot, @time, @actors_json,
            @activity_json, @hero_ref, @storyboard_scene_id)
    ON CONFLICT(id) DO UPDATE SET
      location = excluded.location,
      day = excluded.day,
      slot = excluded.slot,
      time = excluded.time,
      actors_json = excluded.actors_json,
      activity_json = excluded.activity_json,
      hero_ref = excluded.hero_ref,
      storyboard_scene_id = excluded.storyboard_scene_id
  `).run({
    id: moment.id,
    location: moment.location,
    day: moment.day,
    slot: moment.slot,
    time: moment.time,
    actors_json: JSON.stringify(moment.actors || []),
    activity_json: JSON.stringify(moment.activityLines || moment.activity || []),
    hero_ref: moment.heroPath ?? moment.hero_ref ?? null,
    storyboard_scene_id: moment.storyboardSceneId ?? moment.storyboard_scene_id ?? null,
  });
}

function getMoment(id) {
  return _rowToMoment(open().prepare("SELECT * FROM moments WHERE id = ?").get(id));
}

function listMoments({ limit = 40 } = {}) {
  const rows = open().prepare(`
    SELECT * FROM moments ORDER BY captured_at DESC LIMIT ?
  `).all(limit);
  return rows.map(_rowToMoment);
}

function linkMomentToScene(moment_id, scene_id) {
  open().prepare(`
    UPDATE moments SET storyboard_scene_id = ? WHERE id = ?
  `).run(scene_id, moment_id);
}

function pruneMoments(keepCount = 40) {
  const info = open().prepare(`
    DELETE FROM moments WHERE id NOT IN (
      SELECT id FROM moments ORDER BY captured_at DESC LIMIT ?
    )
  `).run(keepCount);
  return info.changes;
}

// ─── Campaigns + Signals ─────────────────────────────────────────────────
// Campaigns are windows of the world's life bounded by brand + brief + start
// slot. Signals are the atomic unit of what happened during a campaign.
// Session 2c overflow — added after the nuke reminded us campaigns had no DB
// backing.

function _rowToCampaign(row) {
  if (!row) return null;
  const parse = (s, fallback) => { try { return JSON.parse(s); } catch (_) { return fallback; } };
  return {
    id: row.id,
    brand: row.brand,
    state: row.state,
    startSlot: row.start_slot,
    startDay: row.start_day,
    startAt: row.start_at,
    endSlot: row.end_slot,
    endDay: row.end_day,
    endAt: row.end_at,
    createdAt: row.created_at,
    deliveryInjection: row.delivery_injection,
    brief: parse(row.brief_json, {}),
    promise: parse(row.promise_json, {}),
    tracking: parse(row.tracking_json, {}),
    mediaPlan: row.media_plan_json ? parse(row.media_plan_json, null) : null,
    touches: parse(row.touches_json, []),
    purchases: parse(row.purchases_json, []),
    results: row.results_json ? parse(row.results_json, null) : null,
  };
}

function upsertCampaign(c) {
  open().prepare(`
    INSERT INTO campaigns (
      id, brand, state, start_slot, start_day, start_at,
      end_slot, end_day, end_at, created_at, delivery_injection,
      brief_json, promise_json, tracking_json, media_plan_json,
      touches_json, purchases_json, results_json
    ) VALUES (
      @id, @brand, @state, @start_slot, @start_day, @start_at,
      @end_slot, @end_day, @end_at, @created_at, @delivery_injection,
      @brief_json, @promise_json, @tracking_json, @media_plan_json,
      @touches_json, @purchases_json, @results_json
    )
    ON CONFLICT(id) DO UPDATE SET
      brand = excluded.brand,
      state = excluded.state,
      start_slot = excluded.start_slot,
      start_day = excluded.start_day,
      start_at = excluded.start_at,
      end_slot = excluded.end_slot,
      end_day = excluded.end_day,
      end_at = excluded.end_at,
      delivery_injection = excluded.delivery_injection,
      brief_json = excluded.brief_json,
      promise_json = excluded.promise_json,
      tracking_json = excluded.tracking_json,
      media_plan_json = excluded.media_plan_json,
      touches_json = excluded.touches_json,
      purchases_json = excluded.purchases_json,
      results_json = excluded.results_json
  `).run({
    id: c.id,
    brand: c.brand || "",
    state: c.state || "draft",
    start_slot: c.startSlot ?? null,
    start_day: c.startDay ?? null,
    start_at: c.startAt ?? null,
    end_slot: c.endSlot ?? null,
    end_day: c.endDay ?? null,
    end_at: c.endAt ?? null,
    created_at: c.createdAt || new Date().toISOString(),
    delivery_injection: c.deliveryInjection || "",
    brief_json: JSON.stringify(c.brief || {}),
    promise_json: JSON.stringify(c.promise || {}),
    tracking_json: JSON.stringify(c.tracking || {}),
    media_plan_json: c.mediaPlan ? JSON.stringify(c.mediaPlan) : null,
    touches_json: JSON.stringify(c.touches || []),
    purchases_json: JSON.stringify(c.purchases || []),
    results_json: c.results ? JSON.stringify(c.results) : null,
  });
}

function getCampaign(id) {
  return _rowToCampaign(open().prepare("SELECT * FROM campaigns WHERE id = ?").get(id));
}

function listCampaigns() {
  const rows = open().prepare("SELECT * FROM campaigns ORDER BY created_at DESC").all();
  return rows.map(_rowToCampaign);
}

function deleteCampaign(id) {
  // Signals cascade via FK
  return open().prepare("DELETE FROM campaigns WHERE id = ?").run(id).changes;
}

// Signals
function addSignal({ campaign_id, kind, lens, text, actor, slot, day }) {
  return open().prepare(`
    INSERT INTO signals (campaign_id, kind, lens, text, actor, slot, day)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(campaign_id, kind, lens ?? null, text, actor ?? null, slot ?? null, day ?? null).lastInsertRowid;
}

function signalsFor(campaign_id) {
  const rows = open().prepare(`
    SELECT * FROM signals WHERE campaign_id = ? ORDER BY id ASC
  `).all(campaign_id);
  return rows.map((r) => ({
    id: r.id, kind: r.kind, lens: r.lens, text: r.text,
    actor: r.actor, slot: r.slot, day: r.day, createdAt: r.created_at,
  }));
}

// ─── Render Queue ─────────────────────────────────────────────────────────
// The ONE interface between the world loop (producer) and the render worker
// (consumer). Session 3 substrate. See DESIGN.md Section 7.

function _rowToJob(row) {
  if (!row) return null;
  let payload = {};
  try { payload = JSON.parse(row.payload_json); } catch (_) {}
  return {
    id: row.id,
    kind: row.kind,
    payload,
    status: row.status,
    priority: row.priority,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
    error: row.error,
    resultMediaId: row.result_media_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

// Enqueue a render job. Returns the new job id. Called from the world loop
// or from the render pipeline as it decomposes work into sub-jobs.
function enqueueRender({ kind, payload, priority = 5, maxAttempts = 3 }) {
  const info = open().prepare(`
    INSERT INTO render_queue (kind, payload_json, priority, max_attempts)
    VALUES (?, ?, ?, ?)
  `).run(kind, JSON.stringify(payload || {}), priority, maxAttempts);
  return info.lastInsertRowid;
}

// Pick the next job to run. Atomic: SELECT + UPDATE in a transaction so two
// workers never pick the same job. Returns the picked job (with 'running'
// status) or null if nothing queued. Increments attempts.
function pickNextRenderJob() {
  const db = open();
  const tx = db.transaction(() => {
    const row = db.prepare(`
      SELECT * FROM render_queue
      WHERE status = 'queued'
      ORDER BY priority DESC, id ASC LIMIT 1
    `).get();
    if (!row) return null;
    db.prepare(`
      UPDATE render_queue
      SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
      WHERE id = ?
    `).run(row.id);
    // Return the updated row shape
    return db.prepare("SELECT * FROM render_queue WHERE id = ?").get(row.id);
  });
  return _rowToJob(tx());
}

// Mark a job succeeded with an optional media reference.
function completeRenderJob(id, { mediaId } = {}) {
  open().prepare(`
    UPDATE render_queue
    SET status = 'success', finished_at = datetime('now'), result_media_id = ?, error = NULL
    WHERE id = ?
  `).run(mediaId ?? null, id);
}

// Mark a job failed. If attempts < max_attempts, requeue for retry;
// otherwise final-fail.
function failRenderJob(id, errorMessage) {
  const db = open();
  const row = db.prepare("SELECT attempts, max_attempts FROM render_queue WHERE id = ?").get(id);
  if (!row) return;
  const finalFail = row.attempts >= row.max_attempts;
  db.prepare(`
    UPDATE render_queue
    SET status = ?, error = ?, ${finalFail ? "finished_at = datetime('now')" : "started_at = NULL"}
    WHERE id = ?
  `).run(finalFail ? "failed" : "queued", errorMessage?.slice(0, 500), id);
  return { finalFail };
}

function getRenderJob(id) {
  return _rowToJob(open().prepare("SELECT * FROM render_queue WHERE id = ?").get(id));
}

function listRenderJobs({ status, limit = 50 } = {}) {
  const rows = status
    ? open().prepare("SELECT * FROM render_queue WHERE status = ? ORDER BY id DESC LIMIT ?").all(status, limit)
    : open().prepare("SELECT * FROM render_queue ORDER BY id DESC LIMIT ?").all(limit);
  return rows.map(_rowToJob);
}

function renderQueueStats() {
  const db = open();
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS c FROM render_queue GROUP BY status
  `).all();
  const out = { queued: 0, running: 0, success: 0, failed: 0, cancelled: 0 };
  for (const r of rows) out[r.status] = r.c;
  return out;
}

// Prune old finished/failed jobs to keep the table bounded.
function pruneRenderQueue(keepLastN = 500) {
  const info = open().prepare(`
    DELETE FROM render_queue
    WHERE status IN ('success', 'failed', 'cancelled')
    AND id NOT IN (
      SELECT id FROM render_queue
      WHERE status IN ('success', 'failed', 'cancelled')
      ORDER BY id DESC LIMIT ?
    )
  `).run(keepLastN);
  return info.changes;
}

// Recovery: if the process died mid-render, jobs stay 'running' forever
// unless we requeue them at boot. Reset any 'running' rows back to 'queued'.
// Called from migrate() at engine boot.
function recoverStuckRenderJobs() {
  const info = open().prepare(`
    UPDATE render_queue
    SET status = 'queued', started_at = NULL
    WHERE status = 'running'
  `).run();
  return info.changes;
}

// ─── Media inventory ──────────────────────────────────────────────────────
// Every file the worker writes gets a row here. Retention runs as SQL.

function registerMedia({ kind, path, bytes, sha256, scene_id, shot_index, moment_id, metadata }) {
  const info = open().prepare(`
    INSERT INTO media (kind, path, bytes, sha256, scene_id, shot_index, moment_id, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET
      kind = excluded.kind,
      bytes = excluded.bytes,
      sha256 = excluded.sha256,
      scene_id = excluded.scene_id,
      shot_index = excluded.shot_index,
      moment_id = excluded.moment_id,
      metadata_json = excluded.metadata_json
  `).run(kind, path, bytes || 0, sha256 || null, scene_id || null, shot_index ?? null, moment_id || null, metadata ? JSON.stringify(metadata) : null);
  return info.lastInsertRowid;
}

function getMedia(id) {
  const row = open().prepare("SELECT * FROM media WHERE id = ?").get(id);
  if (!row) return null;
  let metadata = null;
  try { metadata = row.metadata_json ? JSON.parse(row.metadata_json) : null; } catch (_) {}
  return { ...row, metadata };
}

function mediaByScene(scene_id) {
  return open().prepare("SELECT * FROM media WHERE scene_id = ? ORDER BY shot_index ASC").all(scene_id);
}

function mediaStats() {
  const db = open();
  const total = db.prepare("SELECT COUNT(*) AS c, COALESCE(SUM(bytes), 0) AS b FROM media").get();
  const byKind = db.prepare("SELECT kind, COUNT(*) AS c, COALESCE(SUM(bytes), 0) AS b FROM media GROUP BY kind").all();
  const perKind = {};
  for (const r of byKind) perKind[r.kind] = { count: r.c, bytes: r.b };
  return { count: total.c, bytes: total.b, perKind };
}

// Prune oldest media rows until total bytes drops below target. Returns
// { deletedRows, deletedBytes, remainingBytes }. Does NOT delete the actual
// files — that's the caller's job (worker or retention module) so this stays
// pure database.
function pruneMediaToTarget(targetBytes) {
  const db = open();
  const current = db.prepare("SELECT COALESCE(SUM(bytes), 0) AS b FROM media").get().b;
  if (current <= targetBytes) return { deletedRows: 0, deletedBytes: 0, remainingBytes: current };

  const toDelete = [];
  let running = current;
  const rows = db.prepare("SELECT id, path, bytes FROM media ORDER BY created_at ASC").all();
  for (const r of rows) {
    if (running <= targetBytes) break;
    toDelete.push(r);
    running -= r.bytes;
  }
  if (!toDelete.length) return { deletedRows: 0, deletedBytes: 0, remainingBytes: current };

  const stmt = db.prepare("DELETE FROM media WHERE id = ?");
  const tx = db.transaction(() => { for (const r of toDelete) stmt.run(r.id); });
  tx();

  return {
    deletedRows: toDelete.length,
    deletedBytes: toDelete.reduce((a, r) => a + r.bytes, 0),
    deletedPaths: toDelete.map((r) => r.path),
    remainingBytes: running,
  };
}

// ─── Utility ──────────────────────────────────────────────────────────────

// Close the DB. Called on process shutdown so WAL flushes.
function close() {
  if (_db) { _db.close(); _db = null; }
}

// Backup: copy the DB file to a snapshot path. SQLite's online backup API
// via better-sqlite3's `backup` method. Non-blocking to writers.
function backup(destPath) {
  return open().backup(destPath);
}

// Report DB stats — used by the storage health surface and admin endpoints.
function stats() {
  const db = open();
  const memCount = db.prepare("SELECT COUNT(*) AS c FROM memories").get().c;
  const agentCount = db.prepare("SELECT COUNT(*) AS c FROM agents").get().c;
  const migrationCount = db.prepare("SELECT COUNT(*) AS c FROM schema_migrations").get().c;
  let beatCount = 0, sceneCount = 0, momentCount = 0, campaignCount = 0, signalCount = 0;
  let renderQueueSize = 0, mediaCount = 0;
  try { beatCount = db.prepare("SELECT COUNT(*) AS c FROM beats").get().c; } catch (_) {}
  try { sceneCount = db.prepare("SELECT COUNT(*) AS c FROM scenes").get().c; } catch (_) {}
  try { momentCount = db.prepare("SELECT COUNT(*) AS c FROM moments").get().c; } catch (_) {}
  try { campaignCount = db.prepare("SELECT COUNT(*) AS c FROM campaigns").get().c; } catch (_) {}
  try { signalCount = db.prepare("SELECT COUNT(*) AS c FROM signals").get().c; } catch (_) {}
  try { renderQueueSize = db.prepare("SELECT COUNT(*) AS c FROM render_queue WHERE status IN ('queued', 'running')").get().c; } catch (_) {}
  try { mediaCount = db.prepare("SELECT COUNT(*) AS c FROM media").get().c; } catch (_) {}
  const fileSize = (() => { try { return fs.statSync(DB_PATH).size; } catch (_) { return null; } })();
  return { memCount, agentCount, beatCount, sceneCount, momentCount, campaignCount, signalCount, renderQueueSize, mediaCount, migrationCount, fileSize, path: DB_PATH };
}

module.exports = {
  open, migrate, close, backup, stats,
  DB_PATH,
  // World
  getWorld, setWorld,
  // Agents
  getAgent, listAgents, upsertAgent,
  // Hot state
  getAgentField, getAgentState, setAgentField, setAgentStateBulk,
  // Memories
  addMemory, topMemories, updateMemorySalience, pruneMemoriesBelow,
  // Ledger
  getLedger, getAgentLedger, upsertLedger,
  // Beats
  addBeat, addBeatsBulk, recentBeats, beatsSince, beatsInLocation, topicFrequency, beatCount, pruneBeats,
  // Scenes + shots
  upsertScene, getScene, listScenes, scenesByStatuses, pruneScenes,
  upsertSceneShot, getSceneShots,
  // Moments
  upsertMoment, getMoment, listMoments, linkMomentToScene, pruneMoments,
  // Campaigns + signals
  upsertCampaign, getCampaign, listCampaigns, deleteCampaign,
  addSignal, signalsFor,
  // Render queue
  enqueueRender, pickNextRenderJob, completeRenderJob, failRenderJob,
  getRenderJob, listRenderJobs, renderQueueStats, pruneRenderQueue, recoverStuckRenderJobs,
  // Media inventory
  registerMedia, getMedia, mediaByScene, mediaStats, pruneMediaToTarget,
};
