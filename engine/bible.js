// APE ENGINE — Visual Bible
// The asset registry that makes renders consistent: canonical reference images
// for characters and rooms, established once, versioned when the world changes
// them. Lives next to the save file (on Railway: the /data volume), so the
// world's look survives redeploys.
//
// Three-layer continuity model:
//   Identity (these images, slow) — who a person is, what a room is.
//   State (text, fast)            — what's visible right now, queried from world state.
//   Verification (vision pass)    — generated shots checked against identity.

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

const DIR = path.join(path.dirname(CFG.SAVE_PATH), "bible");
const INDEX_PATH = path.join(DIR, "index.json");
let INDEX = {};

function init() {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(INDEX_PATH)) {
    try { INDEX = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8")); } catch (_) { INDEX = {}; }
  }
  // Seed the three locked portraits from the anchors folder, once.
  for (const n of ["marcus", "lena", "theo"]) {
    const id = "char_" + n;
    if (!INDEX[id]) {
      const src = path.join(CFG.ANCHORS_DIR, n + ".jpeg");
      if (fs.existsSync(src)) {
        const file = id + "_v1.jpg";
        fs.copyFileSync(src, path.join(DIR, file));
        INDEX[id] = { id, type: "character", version: 1, desc: "locked portrait", file, updatedDay: 0 };
      }
    }
  }
  persist();
}

function persist() { try { fs.writeFileSync(INDEX_PATH, JSON.stringify(INDEX, null, 1)); } catch (_) {} }

function get(id) {
  const e = INDEX[id];
  if (!e) return null;
  try { return { entry: e, b64: fs.readFileSync(path.join(DIR, e.file)).toString("base64") }; }
  catch (_) { return null; }
}

// Store a new version of an asset (version 1 = establishment, 2+ = the world changed it).
function put(id, type, desc, b64, day) {
  const version = (INDEX[id] ? INDEX[id].version : 0) + 1;
  const file = `${id}_v${version}.jpg`;
  fs.writeFileSync(path.join(DIR, file), Buffer.from(b64, "base64"));
  INDEX[id] = { id, type, version, desc, file, updatedDay: day };
  persist();
  return INDEX[id];
}

function list() { return Object.values(INDEX).map((e) => ({ ...e })); }

module.exports = { init, get, put, list, DIR };
