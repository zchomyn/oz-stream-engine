// APE ENGINE — Budget & consent gates
//
// Protects against runaway spend. Every image or video generation checks a
// budget before firing. Auto-render defaults OFF. Peek-window requests are
// deliberate, single-shot spends. Daily cap is a hard stop — no override.
//
// State lives on disk next to world-state.json so the cap survives restarts.

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

const STATE_PATH = path.join(path.dirname(CFG.SAVE_PATH), "budget.json");

// Rough per-generation costs (USD). Update as pricing evolves.
const COSTS = {
  image_pro:        0.04,   // Nano Banana Pro still
  image_std:        0.02,   // Nano Banana standard
  video_omni_flash: 0.80,   // Omni Flash, 8s clip ($0.10/sec × 8)
  video_omni:       6.00,   // legacy Omni long-clip (kept for pipeline HTML compat)
  text:             0.001,  // negligible
};

const DAILY_CAP_DEFAULT = parseFloat(process.env.DAILY_BUDGET_USD || "10.00");

const B = {
  dailyCapUsd: DAILY_CAP_DEFAULT,
  today: todayKey(),
  spentToday: 0,
  spentTotal: 0,
  ledger: [],           // last 200 spends: { ts, kind, cost, note }
  autoRender: false,    // auto-render defaults OFF
  runLiveUntil: 0,      // demo mode: run-live toggle expires at this epoch
};

function todayKey() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

function load() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      Object.assign(B, s);
      // Reset today's spend counter if the day rolled over.
      const k = todayKey();
      if (B.today !== k) { B.today = k; B.spentToday = 0; }
    }
  } catch (_) {}
}
function persist() { try { fs.writeFileSync(STATE_PATH, JSON.stringify(B)); } catch (_) {} }

// Rolls to a new day if needed. Called on every check.
function ensureFreshDay() {
  const k = todayKey();
  if (B.today !== k) { B.today = k; B.spentToday = 0; persist(); }
}

// canSpend returns { ok, reason } — check before every generation.
function canSpend(kind, overrideCost) {
  ensureFreshDay();
  const cost = overrideCost != null ? overrideCost : (COSTS[kind] ?? 0);
  if (cost <= 0) return { ok: true };
  const remaining = B.dailyCapUsd - B.spentToday;
  if (cost > remaining) return { ok: false, reason: `daily cap reached — spent $${B.spentToday.toFixed(2)} of $${B.dailyCapUsd.toFixed(2)} (needed $${cost.toFixed(2)})` };
  return { ok: true, remaining };
}

function recordSpend(kind, note = "") {
  ensureFreshDay();
  const cost = COSTS[kind] ?? 0;
  B.spentToday += cost;
  B.spentTotal += cost;
  B.ledger.push({ ts: Date.now(), kind, cost, note: (note || "").slice(0, 200) });
  if (B.ledger.length > 200) B.ledger.shift();
  persist();
  return cost;
}

function shouldAutoRender() {
  ensureFreshDay();
  if (B.autoRender) return true;
  if (B.runLiveUntil > Date.now()) return true;
  return false;
}

function setAutoRender(on) { B.autoRender = !!on; persist(); }
function setRunLiveMinutes(min) { B.runLiveUntil = Date.now() + Math.max(0, min) * 60 * 1000; persist(); }
function setDailyCap(usd) { B.dailyCapUsd = Math.max(0, parseFloat(usd) || 0); persist(); }

function snapshot() {
  ensureFreshDay();
  return {
    dailyCapUsd: B.dailyCapUsd,
    spentToday: B.spentToday,
    spentTotal: B.spentTotal,
    remainingToday: Math.max(0, B.dailyCapUsd - B.spentToday),
    autoRender: B.autoRender,
    runLiveUntil: B.runLiveUntil,
    runLiveActive: B.runLiveUntil > Date.now(),
    runLiveRemainingSec: Math.max(0, Math.floor((B.runLiveUntil - Date.now()) / 1000)),
    recentSpends: B.ledger.slice(-20),
    costs: COSTS,
  };
}

module.exports = { load, canSpend, recordSpend, shouldAutoRender, setAutoRender, setRunLiveMinutes, setDailyCap, snapshot, COSTS };
