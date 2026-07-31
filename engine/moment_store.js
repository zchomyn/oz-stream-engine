// APE ENGINE — Moment Store
//
// Storage for user-captured "living moments" — freeze-frames of a specific
// room at a specific slot showing who was there doing what. Distinct from
// Director-planned scenes: moments are user-initiated, single-frame, and
// (for now) don't automatically expand into storyboards unless the user
// asks. When Chunk B storyboard-expansion lands on top of this module, a
// moment becomes the seed of a scene rather than the whole thing.
//
// File structure on disk:
//   /data/moments/
//     moment_<id>/
//       hero.jpg     — the captured living moment render
//       meta.json    — { location, day, slot, time, actors, descriptor, capturedAt }
//       storyboard/  — later: shot_0..3.jpg + final.mp4 if user expanded

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

const DIR = path.join(path.dirname(CFG.SAVE_PATH), "moments");

// Ensure the moments dir exists. Called at every write path rather than only
// at import time — that way if the volume mounts after the module loads (a
// real timing issue on Railway) we still recover cleanly on the first write.
// Errors are surfaced, not swallowed, so disk problems are diagnosable.
function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true });
}
try { ensureDir(); } catch (e) {
  // Log but don't crash — write path retries below.
  console.warn(`[moment_store] initial mkdir failed: ${e.message}`);
}

// Retention: keep the N most recent moments on disk. Older ones get their
// directory pruned. Users can always re-capture — moments are lightweight
// and the value is in what's on disk right now, not archival.
const RETENTION_COUNT = parseInt(process.env.MOMENT_RETENTION_COUNT || "40", 10);

function newId() {
  return Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 6);
}

function momentDir(id) {
  ensureDir();   // idempotent — creates DIR if missing
  const d = path.join(DIR, "moment_" + id);
  fs.mkdirSync(d, { recursive: true });
  return d;
}

async function writeHero(id, bytes) {
  const p = path.join(momentDir(id), "hero.jpg");
  await fs.promises.writeFile(p, bytes);
  return p;
}

function writeMeta(id, meta) {
  const p = path.join(momentDir(id), "meta.json");
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
  return p;
}

function readMeta(id) {
  try { return JSON.parse(fs.readFileSync(path.join(momentDir(id), "meta.json"), "utf8")); }
  catch (_) { return null; }
}

function heroPath(id) {
  return path.join(momentDir(id), "hero.jpg");
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch (_) { return false; }
}

// List all moments, newest first, with lightweight metadata (no image bytes).
function list({ limit = 40 } = {}) {
  let entries;
  try {
    entries = fs.readdirSync(DIR)
      .filter((n) => n.startsWith("moment_"))
      .map((name) => {
        const p = path.join(DIR, name);
        try {
          const st = fs.statSync(p);
          if (!st.isDirectory()) return null;
          const id = name.replace(/^moment_/, "");
          const meta = readMeta(id);
          return { id, mtime: st.mtimeMs, meta };
        } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) { return []; }
  entries.sort((a, b) => b.mtime - a.mtime);
  return entries.slice(0, limit);
}

// Purge older moment directories beyond RETENTION_COUNT. Called after each
// new capture so the disk stays bounded.
function purgeStale() {
  let entries;
  try {
    entries = fs.readdirSync(DIR)
      .filter((n) => n.startsWith("moment_"))
      .map((name) => {
        const p = path.join(DIR, name);
        try {
          const st = fs.statSync(p);
          if (!st.isDirectory()) return null;
          return { name, path: p, mtime: st.mtimeMs };
        } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) { return []; }
  if (entries.length <= RETENTION_COUNT) return [];
  entries.sort((a, b) => b.mtime - a.mtime);
  const stale = entries.slice(RETENTION_COUNT);
  const deleted = [];
  for (const s of stale) {
    try { fs.rmSync(s.path, { recursive: true, force: true }); deleted.push(s.name); } catch (_) {}
  }
  return deleted;
}

// Return the most recent moment as { id, meta, b64 }. Loads the hero JPEG
// bytes from disk. Used by /stream/latest.jpg to serve the current frame.
function latest() {
  const entries = list({ limit: 1 });
  if (!entries.length) return null;
  const { id, meta } = entries[0];
  const p = heroPath(id);
  if (!exists(p)) return { id, meta, b64: null };
  try {
    const b64 = fs.readFileSync(p).toString("base64");
    return { id, meta, b64 };
  } catch (_) {
    return { id, meta, b64: null };
  }
}

module.exports = {
  DIR,
  newId,
  momentDir,
  writeHero,
  writeMeta,
  readMeta,
  heroPath,
  exists,
  list,
  latest,
  purgeStale,
  RETENTION_COUNT,
};
