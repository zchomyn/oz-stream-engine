// APE ENGINE — Render Worker
//
// Session 3 of the rebuild (see DESIGN.md Section 7). The worker is the ONE
// consumer of the render_queue table. It polls every POLL_MS, picks the
// highest-priority queued job, dispatches to a per-kind handler, records
// success/failure back to the queue.
//
// CURRENT COVERAGE (as of v2.35):
//   Through the queue:
//     - 'still'  — scene shot renders (renderSceneStoryboard shot loop)
//   Still inline (call genImage directly):
//     - captureLivingMoment (user-triggered moment hero frame)
//     - renderSceneVideos (Chunk C: Omni animate + FFmpeg edit)
//     - ensurePlate, ensureCutaway (cache-on-miss, called synchronously
//       from other render paths — moving these through the queue would
//       create a self-blocking pattern in the single-worker model)
//     - renderObjectFocus (Observer Camera Layer 3)
//
// The queue-vs-inline decision was made deliberately: the queue's value is
// managing contention and providing retry logic. Inline paths are either
// (a) cache-on-miss one-offs that don't benefit from queuing, or (b) called
// synchronously from other renders in a way the single-worker model can't
// resolve without a second worker. Sessions 3d+ will migrate the remaining
// user-triggered paths (moment capture, video) when the payoff justifies
// the debugging cost.
//
// This file is the SUBSTRATE. Session 3a ships the polling loop, the
// dispatch structure, and a stub handler that just marks jobs complete
// without doing real work — enough to prove the queue plumbing end-to-end
// without touching any of the real render paths.
//
// Session 3b wires the first REAL handler (scene stills through genImage).
// Session 3c migrates the other paths (plate, cutaway, portrait, moment,
// video, edit) one at a time.
//
// The worker runs in the same Node process as the engine. That means:
//   - No IPC needed — direct DB access
//   - No child_process complexity
//   - The event loop is shared, but since renders are I/O-bound (network
//     calls to Nano Banana / Omni), awaiting a render doesn't block the
//     world loop from ticking
//
// If we ever need real process isolation (e.g. FFmpeg CPU pinning), splitting
// this into a spawned worker.js is straightforward — the interface is
// already the DB, so no code change is required except the entrypoint.

const DB = require("./db");
const BUS = require("./bus");

const POLL_MS = parseInt(process.env.WORKER_POLL_MS || "500", 10);

// Handler map. Each kind ∈ {still, video, edit, cutaway, plate, portrait,
// moment, object_focus} has one async handler here. Signature:
//   async (job, ctx) => { path, bytes, sha256?, sceneId?, shotIndex?,
//                         momentId?, metadata? }
// Returning a truthy result registers media + completes the job. Throwing
// an error fails the job (which triggers retry or final fail per queue
// logic in db.js).
const HANDLERS = {
  // Session 3a stub: log and complete without doing real work. Every
  // handler will be replaced in 3b/3c with the actual render call. The
  // stub proves the plumbing works.
  __stub: async (job, ctx) => {
    ctx.log(`WORKER stub handled ${job.kind} #${job.id} — no work done`);
    return null;  // no media registered, no failure
  },
};

// Register a real handler. Called by ape.js (or wherever) to wire the
// actual render implementations. Session 3b replaces __stub for 'still'.
function register(kind, handler) {
  HANDLERS[kind] = handler;
}

let _running = false;
let _timer = null;
let _log = console.log.bind(console);
let _cycleCount = 0;
let _successCount = 0;
let _failCount = 0;

async function _processOne() {
  const job = DB.pickNextRenderJob();
  if (!job) return { picked: false };

  const handler = HANDLERS[job.kind] || HANDLERS.__stub;
  const usedStub = !HANDLERS[job.kind];

  const ctx = {
    log: _log,
    // Placeholder for extensibility. Handlers get access to olog-style
    // logging + eventually the DB module for finer-grained writes.
    db: DB,
  };

  try {
    const result = await handler(job, ctx);
    let mediaId = null;
    if (result && result.path) {
      mediaId = DB.registerMedia({
        kind: job.kind,
        path: result.path,
        bytes: result.bytes || 0,
        sha256: result.sha256,
        scene_id: result.sceneId,
        shot_index: result.shotIndex,
        moment_id: result.momentId,
        metadata: result.metadata,
      });
    }
    DB.completeRenderJob(job.id, { mediaId });
    _successCount++;
    _log(`WORKER ✓ #${job.id} ${job.kind}${usedStub ? " [stub]" : ""}${mediaId ? ` → media #${mediaId}` : ""}`);
    try {
      BUS.emit("render_progress", {
        queue_id: job.id, kind: job.kind, status: "success",
        media_id: mediaId, attempts: job.attempts,
      });
    } catch (_) {}
    return { picked: true, ok: true, jobId: job.id, mediaId };
  } catch (e) {
    const msg = String(e.message || e).slice(0, 500);
    const failResult = DB.failRenderJob(job.id, msg);
    _failCount++;
    _log(`WORKER ✗ #${job.id} ${job.kind} — ${msg}${failResult?.finalFail ? " [FINAL FAIL after " + job.attempts + " attempt(s)]" : " [will retry]"}`);
    try {
      BUS.emit("render_progress", {
        queue_id: job.id, kind: job.kind,
        status: failResult?.finalFail ? "failed" : "retrying",
        error: msg, attempts: job.attempts,
      });
    } catch (_) {}
    return { picked: true, ok: false, jobId: job.id, error: msg, finalFail: failResult?.finalFail };
  }
}

function _tick() {
  if (!_running) return;
  _cycleCount++;
  _processOne()
    .catch((e) => _log(`WORKER cycle error: ${e.message?.slice(0, 200)}`))
    .finally(() => {
      if (_running) _timer = setTimeout(_tick, POLL_MS);
    });
}

function start({ log } = {}) {
  if (_running) return { alreadyRunning: true };
  _running = true;
  if (log) _log = log;
  _log(`WORKER start — polling every ${POLL_MS}ms, ${Object.keys(HANDLERS).length} handler(s) registered`);
  _tick();
  return { started: true };
}

function stop() {
  _running = false;
  if (_timer) { clearTimeout(_timer); _timer = null; }
  return { stopped: true };
}

function stats() {
  return {
    running: _running,
    pollMs: POLL_MS,
    handlers: Object.keys(HANDLERS).filter((k) => k !== "__stub"),
    cycleCount: _cycleCount,
    successCount: _successCount,
    failCount: _failCount,
    queue: DB.renderQueueStats(),
  };
}

// Wait for a specific job to reach a terminal state (success or failed).
// Returns { ok, mediaId, error, job }. Polls DB every WAIT_POLL_MS. This is
// used during the queue migration (Session 3b) so existing awaited callers
// can transition to queue-based rendering without changing their shape.
// Sessions 3c/4 replace waiters with fire-and-forget + event notification.
async function waitForJob(id, { pollMs = 250, timeoutMs = 5 * 60 * 1000 } = {}) {
  const started = Date.now();
  while (true) {
    const job = DB.getRenderJob(id);
    if (!job) return { ok: false, error: `job ${id} not found` };
    if (job.status === "success") return { ok: true, mediaId: job.resultMediaId, job };
    if (job.status === "failed" || job.status === "cancelled") {
      return { ok: false, error: job.error || `job ${job.status}`, job };
    }
    if (Date.now() - started > timeoutMs) {
      return { ok: false, error: `job ${id} timed out after ${timeoutMs}ms`, job };
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
}

module.exports = { start, stop, register, stats, waitForJob, HANDLERS };
