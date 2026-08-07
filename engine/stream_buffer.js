// APE STREAM ENGINE — buffered playback ring.
//
// Producer (auto-capture loop) renders as fast as Nano Banana allows and
// appends each frame to a ring buffer on disk. Consumer (stream page)
// advances the playback pointer every N seconds and serves the frame at
// that pointer. Buffer target is 300 frames ahead of playback (~30 min at
// 6s per frame).
//
// This is the sleight of hand — while Truman sleeps for 8 real hours, the
// producer burns through the next day's worth of frames. When viewers watch,
// they never see a spinner because playback lags behind production.
//
// State model:
//   producerCursor: index of next frame to write (monotonic, only grows)
//   consumerCursor: index of next frame to display (advances every 6s)
//   Buffer is FIFO. Producer never overwrites frames the consumer hasn't
//   reached. If producer catches up (buffer full), it pauses rendering.
//   If consumer catches up (buffer empty), it holds the last frame.

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

const BUFFER_DIR = path.join(path.dirname(CFG.SAVE_PATH), "stream_buffer");
const STATE_PATH = path.join(BUFFER_DIR, "state.json");

// Target buffer size — how many frames producer should stay ahead. 300 frames
// at 6s per frame = 30 minutes of buffered stream. Producer pauses when
// buffer holds this many unconsumed frames.
const BUFFER_TARGET = parseInt(process.env.STREAM_BUFFER_TARGET || "40", 10);

// Retention — how many "already-consumed" frames to keep on disk for
// reference. Bounded to keep the volume tidy.
const CONSUMED_RETENTION = 20;

function ensureDir() {
  try { fs.mkdirSync(BUFFER_DIR, { recursive: true }); } catch (_) {}
}
ensureDir();

// State: { producerCursor, consumerCursor, consumerAdvancedAt (ms) }
let STATE = { producerCursor: 0, consumerCursor: 0, consumerAdvancedAt: Date.now() };
try {
  if (fs.existsSync(STATE_PATH)) {
    STATE = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
    STATE.consumerAdvancedAt = STATE.consumerAdvancedAt || Date.now();
    // On boot: if the consumer is more than 30 frames behind the producer,
    // fast-forward it. Prevents restarts from replaying stale buffer content.
    const staleBacklog = STATE.producerCursor - STATE.consumerCursor;
    if (staleBacklog > 30) {
      STATE.consumerCursor = Math.max(0, STATE.producerCursor - 5);
      console.log(`[stream-buffer] boot fast-forward: consumer jumped ${staleBacklog} → 5 frames behind`);
    }
  }
} catch (_) {}

function persistState() {
  try { fs.writeFileSync(STATE_PATH, JSON.stringify(STATE)); } catch (_) {}
}

// Frame JPEGs are stored in GCS at buffer/frame_XXXXXXXX.jpg. Meta stays
// local under BUFFER_DIR as small JSON files so status/lookup is cheap and
// sync — the meta is what /stream/status reads on every poll.
function frameObject(index) {
  return `buffer/frame_${String(index).padStart(8, "0")}.jpg`;
}
function metaFile(index) {
  return path.join(BUFFER_DIR, `frame_${String(index).padStart(8, "0")}.json`);
}

// Producer: append a new frame to the ring. Async because GCS upload is I/O.
//   Returns { queued: true, index } on success.
//   Returns { queued: false, reason } if buffer is at target (producer should back off).
async function appendFrame(bytes, meta = {}) {
  const backlog = STATE.producerCursor - STATE.consumerCursor;
  if (backlog >= BUFFER_TARGET) {
    return { queued: false, reason: `buffer full (${backlog} unconsumed frames)`, backlog };
  }
  const index = STATE.producerCursor;
  const objectPath = frameObject(index);
  const mp = metaFile(index);
  try {
    const GCS = require("./gcs");
    await GCS.upload(objectPath, bytes, "image/jpeg");
    fs.writeFileSync(mp, JSON.stringify({
      index,
      producedAt: Date.now(),
      objectPath,
      ...meta,
    }));
    STATE.producerCursor++;
    persistState();
    return { queued: true, index, backlog: backlog + 1 };
  } catch (e) {
    return { queued: false, reason: e.message };
  }
}

// Advance the consumer pointer if enough time has passed. Sync — no I/O.
// Called at the top of currentFrame() and currentMeta().
function tickConsumer(interval_ms) {
  const now = Date.now();
  const iv = interval_ms || 6000;
  if (now - STATE.consumerAdvancedAt >= iv && STATE.consumerCursor < STATE.producerCursor - 1) {
    STATE.consumerCursor++;
    STATE.consumerAdvancedAt = now;
    persistState();
    purgeConsumed();
  }
}

// Sync current-frame meta (used by /stream/status which polls constantly).
function currentMeta(interval_ms) {
  tickConsumer(interval_ms);
  let idx = STATE.consumerCursor;
  if (idx >= STATE.producerCursor) idx = STATE.producerCursor - 1;
  if (idx < 0) return null;
  const mp = metaFile(idx);
  let meta = {};
  if (fs.existsSync(mp)) {
    try { meta = JSON.parse(fs.readFileSync(mp, "utf8")); } catch (_) {}
  }
  return {
    meta,
    index: idx,
    backlog: STATE.producerCursor - STATE.consumerCursor,
    producerCursor: STATE.producerCursor,
    consumerCursor: STATE.consumerCursor,
  };
}

// Async current-frame bytes fetch from GCS. Used by /stream/latest.jpg.
async function currentFrame(interval_ms) {
  const info = currentMeta(interval_ms);
  if (!info) return null;
  try {
    const GCS = require("./gcs");
    const objectPath = info.meta.objectPath || frameObject(info.index);
    const bytes = await GCS.download(objectPath);
    if (!bytes) return null;
    return { ...info, bytes };
  } catch (_) { return null; }
}

// Delete GCS objects older than (consumerCursor - CONSUMED_RETENTION) AND
// their local meta. Fire-and-forget for the GCS deletes — a lag doesn't hurt.
function purgeConsumed() {
  const cutoff = STATE.consumerCursor - CONSUMED_RETENTION;
  if (cutoff <= 0) return;
  try {
    const names = fs.readdirSync(BUFFER_DIR);
    for (const n of names) {
      const m = n.match(/^frame_(\d+)\.json$/);
      if (!m) continue;
      const idx = parseInt(m[1], 10);
      if (idx < cutoff) {
        try { fs.unlinkSync(path.join(BUFFER_DIR, n)); } catch (_) {}
        // Fire-and-forget GCS delete
        try {
          const GCS = require("./gcs");
          GCS.del(frameObject(idx)).catch(() => {});
        } catch (_) {}
      }
    }
  } catch (_) {}
}

// Buffer status for /stream/status
function status() {
  return {
    producerCursor: STATE.producerCursor,
    consumerCursor: STATE.consumerCursor,
    backlog: STATE.producerCursor - STATE.consumerCursor,
    target: BUFFER_TARGET,
    healthy: STATE.producerCursor - STATE.consumerCursor > 3,
  };
}

module.exports = { appendFrame, currentFrame, currentMeta, status, BUFFER_TARGET, purgeConsumed };
