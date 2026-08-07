// APE ENGINE — Scene storage
//
// The rendered stills and eventually video clips for auto-directed scenes live
// here, in their own directory alongside dailies. Chunk B writes the 4-shot
// stills; Chunk C will add the animated clips + the finished edit.
//
// File structure on disk:
//   /data/scenes/
//     scene_dNN_sXXXX_YYYY/
//       shot_0.jpg   (poster / wide)
//       shot_1.jpg   (medium)
//       shot_2.jpg   (close-up)
//       shot_3.jpg   (reaction)
//       shot_0.mp4   (later, Chunk C)
//       ...
//       final.mp4    (later, Chunk C — the edited scene)
//       meta.json    (title, logline, shot descriptions, timestamps)

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

const DIR = path.join(path.dirname(CFG.SAVE_PATH), "scenes");
try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}

function sceneDir(sceneId) {
  const d = path.join(DIR, sceneId);
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

async function writeShotStill(sceneId, shotIndex, imageBytes) {
  const GCS = require("./gcs");
  const objectPath = `scenes/${sceneId}/shot_${shotIndex}.jpg`;
  await GCS.upload(objectPath, imageBytes, "image/jpeg");
  return objectPath;
}

async function writeShotVideo(sceneId, shotIndex, videoBytes) {
  const GCS = require("./gcs");
  const objectPath = `scenes/${sceneId}/shot_${shotIndex}.mp4`;
  await GCS.upload(objectPath, videoBytes, "video/mp4");
  return objectPath;
}

async function writeFinalVideo(sceneId, videoBytes) {
  const GCS = require("./gcs");
  const objectPath = `scenes/${sceneId}/final.mp4`;
  await GCS.upload(objectPath, videoBytes, "video/mp4");
  return objectPath;
}

function writeMeta(sceneId, meta) {
  const p = path.join(sceneDir(sceneId), "meta.json");
  fs.writeFileSync(p, JSON.stringify(meta, null, 2));
  return p;
}

function readMeta(sceneId) {
  const p = path.join(sceneDir(sceneId), "meta.json");
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch (_) { return null; }
}

// Read a shot's still bytes for later Omni animation
function readShotStill(sceneId, shotIndex) {
  const p = path.join(sceneDir(sceneId), `shot_${shotIndex}.jpg`);
  try { return fs.readFileSync(p); } catch (_) { return null; }
}

// URL-style path a server route can serve
function shotStillPath(sceneId, shotIndex) {
  return path.join(sceneDir(sceneId), `shot_${shotIndex}.jpg`);
}
function shotVideoPath(sceneId, shotIndex) {
  return path.join(sceneDir(sceneId), `shot_${shotIndex}.mp4`);
}
function finalVideoPath(sceneId) {
  return path.join(sceneDir(sceneId), `final.mp4`);
}

function exists(filePath) {
  try { fs.accessSync(filePath); return true; } catch (_) { return false; }
}

// ---- Retention ----
// The scene store fills up quickly at ~1MB per finished scene (4 stills), and
// will fill faster once Chunk C adds videos (~4MB per scene). Without a
// retention policy, Railway's volume fills within a few days of continuous
// rendering, and every subsequent render fails with ENOSPC.
//
// Policy: keep the N most recent scene directories on disk. When a new scene
// is rendered, sort all scene directories by mtime, and delete any beyond N.
// Metadata for older scenes is preserved (their entries stay in W.__scenes)
// but their files are gone — the cockpit shows "expired" instead of a poster.
//
// Default retention (SCENE_RETENTION_COUNT) is generous but bounded. Adjust
// via env var if you want more or fewer scenes kept.

const SCENE_RETENTION_COUNT = parseInt(process.env.SCENE_RETENTION_COUNT || "50", 10);

// Purge stale scenes. When aggressive=true, retention count is cut in half —
// used when the storage layer reports pressure (≥80% volume usage). Returns
// the list of scene IDs whose files were deleted so callers can update their
// in-memory state to reflect the loss.
function purgeStale({ aggressive = false, keepCount = null } = {}) {
  const keep = keepCount != null
    ? Math.max(0, keepCount)
    : (aggressive ? Math.floor(SCENE_RETENTION_COUNT / 2) : SCENE_RETENTION_COUNT);
  let entries;
  try {
    entries = fs.readdirSync(DIR)
      .map((name) => {
        const p = path.join(DIR, name);
        try {
          const st = fs.statSync(p);
          if (!st.isDirectory()) return null;
          return { id: name, path: p, mtime: st.mtimeMs };
        } catch (_) { return null; }
      })
      .filter(Boolean);
  } catch (_) { return []; }

  if (entries.length <= keep) return [];

  entries.sort((a, b) => b.mtime - a.mtime);   // newest first
  const stale = entries.slice(keep);
  const deleted = [];
  for (const s of stale) {
    try {
      fs.rmSync(s.path, { recursive: true, force: true });
      deleted.push(s.id);
    } catch (_) { /* if we can't delete, we can't; move on */ }
  }
  return deleted;
}

// Approximate disk usage of the scene store, in bytes. Cheap enough to call
// on every render so the engine log can surface it. If we ever want to gate
// renders behind a disk budget, this is the number we'd read.
function diskUsageBytes() {
  let total = 0;
  try {
    for (const name of fs.readdirSync(DIR)) {
      const p = path.join(DIR, name);
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) {
          for (const f of fs.readdirSync(p)) {
            try { total += fs.statSync(path.join(p, f)).size; } catch (_) {}
          }
        }
      } catch (_) {}
    }
  } catch (_) {}
  return total;
}

module.exports = {
  DIR, sceneDir,
  writeShotStill, writeShotVideo, writeFinalVideo,
  writeMeta, readMeta,
  readShotStill,
  shotStillPath, shotVideoPath, finalVideoPath,
  exists,
  purgeStale, diskUsageBytes, SCENE_RETENTION_COUNT,
};
