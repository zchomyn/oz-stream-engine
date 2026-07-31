// APE ENGINE — Event Bus
//
// The internal pub/sub the engine uses to emit change events. Session 4a
// of the rebuild (see DESIGN.md Section 6). Sync emit — matches the engine's
// existing sync patterns (world tick, save/load). Subscribers receive every
// event; type filtering happens at the subscriber. Fanout is small (a few
// WebSocket clients), so no optimization is warranted yet.
//
// EVENT VOCABULARY (from DESIGN.md, canonical list):
//   tick                 { day, minutes, slot, clock, paused }
//   beat                 { id, slot, actor, kind, location, text, topic }
//   agent_updated        { key, changes: { location?, mood?, lastAct?, ... } }
//   scene_planning       { scene_id, title, actors }
//   scene_shot_ready     { scene_id, shot_index, still_url }
//   scene_ready          { scene_id, poster_url }
//   scene_video_ready    { scene_id, video_url }
//   moment_captured      { moment_id, location, hero_url }
//   render_progress      { queue_id, kind, status, progress? }
//   storage_status       { pct, level }
//
// Every emit gets a unique auto-incrementing id + ISO timestamp so subscribers
// can dedupe on reconnect (which will re-send anything in the buffer they
// haven't seen). The HISTORY buffer is the reconnect-safety net — new
// subscribers can call recent() to catch up on events that happened while
// they were disconnected.

const HISTORY_LIMIT = 400;
const HISTORY = [];
let _nextId = 1;

const subscribers = new Set();

// Emit an event to every subscriber + record to history. Type is a canonical
// string from the vocabulary above (or any string; unknown types just flow
// through — subscribers ignore what they don't handle).
function emit(type, payload) {
  const event = {
    id: _nextId++,
    type,
    payload: payload || {},
    ts: Date.now(),
  };
  HISTORY.push(event);
  if (HISTORY.length > HISTORY_LIMIT) HISTORY.shift();

  for (const fn of subscribers) {
    try { fn(event); }
    catch (e) {
      // A subscriber's error must not break other subscribers or the emitter.
      // Log to console (not olog — bus.js has no olog dependency to keep it clean)
      console.error(`[bus] subscriber error on ${type}:`, e.message);
    }
  }
  return event;
}

// Subscribe to all events. Returns an unsubscribe function.
// Subscribers are functions of (event) => void. They should be non-blocking
// (a slow subscriber slows every emit — since emit is sync, the whole world
// waits). Real WebSocket sends are async-buffered so this is fine.
function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

// Recent events, newest last (so subscribers can replay forward). Used by
// WebSocket reconnect flow in 4c.
function recent(limit = 100) {
  return HISTORY.slice(-Math.max(1, Math.min(limit, HISTORY_LIMIT)));
}

// Events since a specific event id — used by clients that reconnect and
// know their last-seen id, so they only get new events.
function since(afterId) {
  if (typeof afterId !== "number") return recent();
  return HISTORY.filter((e) => e.id > afterId);
}

function subscriberCount() { return subscribers.size; }

function stats() {
  return {
    historySize: HISTORY.length,
    historyLimit: HISTORY_LIMIT,
    subscribers: subscribers.size,
    nextId: _nextId,
    lastEventId: HISTORY.length ? HISTORY[HISTORY.length - 1].id : 0,
    lastEventTs: HISTORY.length ? HISTORY[HISTORY.length - 1].ts : null,
  };
}

module.exports = { emit, subscribe, recent, since, subscriberCount, stats };
