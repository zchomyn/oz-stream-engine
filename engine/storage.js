// APE ENGINE — Storage utility
//
// Single source of truth for volume state. Used by:
//   - render paths (headroom gates: refuse if above 90%)
//   - retention systems (aggressive prune above 80%)
//   - cockpit health badge (green/yellow/red indicator)
//
// Volume capacity is read from the kernel via fs.statfs when available (Node
// 18+), so the pct math always reflects the actual mount size — no env var
// tuning needed when you resize the volume on Railway. Falls back to
// VOLUME_CAPACITY_BYTES env if statfs unsupported, then a 5GB default.

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

const DATA_ROOT = path.dirname(CFG.SAVE_PATH);
const FALLBACK_CAPACITY = parseInt(process.env.VOLUME_CAPACITY_BYTES || String(5 * 1024 * 1024 * 1024), 10);

// Cached statfs result — the mount size doesn't change without a remount, so
// asking the kernel every render is wasteful. Refreshed at boot.
let _cachedCapacity = null;

function readVolumeCapacity() {
  if (_cachedCapacity != null) return _cachedCapacity;
  try {
    // fs.statfsSync exists in Node 18.15+. Returns bsize + blocks + bavail.
    if (typeof fs.statfsSync === "function") {
      const s = fs.statfsSync(DATA_ROOT);
      _cachedCapacity = s.blocks * s.bsize;
      return _cachedCapacity;
    }
  } catch (_) { /* fall through to fallback */ }
  _cachedCapacity = FALLBACK_CAPACITY;
  return _cachedCapacity;
}

function readVolumeFreeBytes() {
  try {
    if (typeof fs.statfsSync === "function") {
      const s = fs.statfsSync(DATA_ROOT);
      return s.bavail * s.bsize;   // available to unprivileged users, honest free
    }
  } catch (_) {}
  return null;
}

// Walk a directory tree summing file sizes. Bounded traversal.
function dirSize(dirPath, budget = 100000) {
  let total = 0;
  let remaining = budget;
  const walk = (p) => {
    if (remaining <= 0) return;
    let entries;
    try { entries = fs.readdirSync(p, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      if (remaining <= 0) return;
      remaining--;
      const full = path.join(p, entry.name);
      try {
        if (entry.isDirectory()) walk(full);
        else if (entry.isFile()) total += fs.statSync(full).size;
      } catch (_) {}
    }
  };
  walk(dirPath);
  return total;
}

// Return current storage state. When statfs works, we use kernel-truth numbers
// (bavail-based free space). When it doesn't, we approximate with dirSize.
function status() {
  const capacityBytes = readVolumeCapacity();
  const freeBytes = readVolumeFreeBytes();

  let usedBytes;
  if (freeBytes != null) {
    usedBytes = Math.max(0, capacityBytes - freeBytes);
  } else {
    usedBytes = dirSize(DATA_ROOT);
  }
  const pct = capacityBytes > 0 ? Math.min(100, Math.round((usedBytes / capacityBytes) * 100)) : 0;

  const breakdown = {};
  try {
    for (const entry of fs.readdirSync(DATA_ROOT, { withFileTypes: true })) {
      if (entry.isDirectory()) breakdown[entry.name] = dirSize(path.join(DATA_ROOT, entry.name));
    }
  } catch (_) {}

  return {
    usedBytes,
    freeBytes,
    capacityBytes,
    pct,
    breakdown,
    level: pct >= 90 ? "critical" : pct >= 75 ? "warning" : "ok",
    source: freeBytes != null ? "statfs" : "walk",
  };
}

function checkRenderHeadroom() {
  const s = status();
  if (s.pct >= 90) return { ok: false, reason: `volume at ${s.pct}% — renders refused until pruned or resized`, status: s };
  return { ok: true, status: s };
}

function shouldAggressivelyPrune() {
  return status().pct >= 80;
}

module.exports = {
  status,
  checkRenderHeadroom,
  shouldAggressivelyPrune,
  DATA_ROOT,
  readVolumeCapacity,
  readVolumeFreeBytes,
};
