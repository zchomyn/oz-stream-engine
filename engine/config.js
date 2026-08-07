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
  // Stream engine: sim runs FAST (produces buffer content quickly). Playback
  // is smooth from buffer at STREAM_PLAYBACK_MS intervals. Producer + consumer
  // are decoupled — sim can churn through Truman's day in real minutes while
  // the viewer sees smooth 6-second playback.
  SLOT_SIM_MINUTES: 30,          // each slot = 30 sim-min — clock advances smoothly, buffered frames feel continuous
  SLOT_REAL_MS: 3000,            // 1 slot per 3s real (baseline; actual limited by agent turn latency)
  DIRECTOR_EVERY_SLOTS: 3,       // director every ~90 sim-min
  STREAM_AUTO_CAPTURE: process.env.STREAM_AUTO_CAPTURE !== "false",
  STREAM_PARALLEL: parseInt(process.env.STREAM_PARALLEL || "2", 10),
  STREAM_REALTIME_SYNC: process.env.STREAM_REALTIME_SYNC !== "false",
  STREAM_PLAYBACK_MS: parseInt(process.env.STREAM_PLAYBACK_MS || "6000", 10),   // consumer tick
  STREAM_CANDIDATES_PER_FRAME: parseInt(process.env.STREAM_CANDIDATES_PER_FRAME || "2", 10),  // renders per beat — 2 keeps producer ahead of 6s playback; 3 was starving the buffer
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
