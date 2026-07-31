// APE ENGINE — config
// Secrets live in the environment, never in this file. For local runs, create
// engine/.env (gitignored) with KEY=value lines.

// Minimal zero-dependency .env loader
const fs = require("fs");
const path = require("path");
try {
  const envPath = path.join(__dirname, ".env");
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
} catch (_) {}

module.exports = {
  APP_VERSION: "SEAHAVEN 1.0 · Truman lives (Phase 1 spine)",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  TEXT_MODEL: process.env.GEMINI_MODEL || "gemini-flash-latest",
  IMAGE_MODEL: process.env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image",
  BASE_URL: "https://generativelanguage.googleapis.com/v1beta",

  PORT: parseInt(process.env.PORT || "8090", 10),

  // Sim pacing
  // Stream engine: real-time sync. 1 sim-minute per slot, 1 slot per real-
  // minute — Truman's whole day plays out at real-world pace. If it's 3:47pm
  // in Seahaven right now, Truman is doing whatever a 3:47pm actually is.
  SLOT_SIM_MINUTES: 1,
  SLOT_REAL_MS: 60000,           // 1 slot per real minute
  DIRECTOR_EVERY_SLOTS: 90,      // director pass every ~90 sim-minutes
  STREAM_AUTO_CAPTURE: process.env.STREAM_AUTO_CAPTURE !== "false",
  STREAM_PARALLEL: 1,            // serial by design — next frame is next moment
  STREAM_REALTIME_SYNC: process.env.STREAM_REALTIME_SYNC !== "false",   // sim clock mirrors real clock
  REFLECT_HOUR: 23,              // nightly reflection

  // Images
  RENDER_STORYBOARDS: true,      // toggleable in the debug UI too
  VERIFY_SHOTS: process.env.VERIFY_SHOTS !== "0",  // vision continuity pass, one retry on real mismatch
  IMAGE_SPACING_MS: 13000,
  // Path to locked identity anchors (the same faces the cockpit uses).
  // Point this at proxy/project-oz/public/assets/profiles or leave as-is if you
  // copy the three jpegs into engine/anchors/.
  ANCHORS_DIR: process.env.ANCHORS_DIR || __dirname + "/anchors",

  // Persistence — point SAVE_PATH at a mounted volume (e.g. /data/world-state.json)
  // on hosts with ephemeral container filesystems, and the world survives redeploys.
  SAVE_PATH: process.env.SAVE_PATH || __dirname + "/world-state.json",
  SAVE_EVERY_SLOTS: 4,
};
