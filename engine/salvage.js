// APE ENGINE — Save-file salvage
//
// One-shot recovery for corrupt world-state.json. Runs at boot when the
// primary save is unreadable but a `.corrupt.*` backup exists.
//
// Strategy: the corruption is almost always a truncation — the volume filled
// or the process died mid-write. The bytes before the truncation are usually
// valid JSON structure. We walk backward from the corruption point looking
// for a safe cut point: a `}` at low nesting depth that could be the end of
// the outer object. Try JSON.parse there. If it succeeds AND the shape looks
// right, we've recovered.
//
// "Looks right" means the parsed object has the expected top-level fields:
// W.agents.marcus, W.agents.lena, W.agents.theo, W.day, W.minutes. Without
// those, no game — better to refuse recovery than boot with a mangled world.
//
// This module is pure. No file writes, no side effects. Caller decides what
// to do with what we return.

const fs = require("fs");

// Try to parse `text` as JSON. Return { ok, value, error }.
function tryParse(text) {
  try { return { ok: true, value: JSON.parse(text) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// Does this parsed object have the shape we need to boot? Defensive: we'd
// rather refuse and reseed than boot with an object missing critical fields.
function shapeIsValid(obj) {
  if (!obj || typeof obj !== "object") return false;
  const w = obj.W;
  if (!w || typeof w !== "object") return false;
  if (!w.agents || typeof w.agents !== "object") return false;
  if (!w.agents.marcus || !w.agents.lena || !w.agents.theo) return false;
  if (typeof w.day !== "number" || typeof w.minutes !== "number") return false;
  return true;
}

// Given a raw corrupt-file text, walk forward tracking bracket depth and
// string state to find "safe cut points" — offsets where, if we truncated
// AND appended the correct closing brackets, the result would be valid JSON.
//
// A safe cut point is any offset AFTER a complete key-value pair inside an
// object (i.e., right after a `,` or right before a `}`). We track the
// bracket stack so we know what closing sequence to append.
//
// Returns an array of { offset, closeSequence } candidates, later-first (so
// we try to preserve as much data as possible).
function findSafeCuts(text) {
  const candidates = [];
  const stack = [];   // e.g. ['{', '{', '[', '{'] — one entry per open bracket
  let inString = false;
  let escape = false;
  let afterCommaOrOpen = true;   // are we in a position where a fresh value could START (or END)?

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (escape) { escape = false; continue; }
    if (inString) {
      if (c === "\\") { escape = true; continue; }
      if (c === '"') { inString = false; continue; }
      continue;
    }
    if (c === '"') { inString = true; afterCommaOrOpen = false; continue; }

    if (c === "{" || c === "[") { stack.push(c); afterCommaOrOpen = true; continue; }
    if (c === "}" || c === "]") {
      stack.pop();
      // Right after closing a value, we CAN safely cut here + close outer wrappers
      const closeSeq = stack.slice().reverse().map((b) => b === "{" ? "}" : "]").join("");
      candidates.push({ offset: i + 1, closeSequence: closeSeq });
      afterCommaOrOpen = false;
      continue;
    }
    if (c === ",") {
      // After a comma at any depth, we're between values. A safe cut is
      // BEFORE the comma — so record offset i (not i+1) + closing brackets.
      // BUT: JSON doesn't allow trailing commas, so cutting AT the comma
      // leaves a valid object if we close immediately.
      const closeSeq = stack.slice().reverse().map((b) => b === "{" ? "}" : "]").join("");
      candidates.push({ offset: i, closeSequence: closeSeq });
      afterCommaOrOpen = true;
      continue;
    }
    // Any other non-whitespace character means we're inside a primitive value
    // (number, bool, null) — not a safe cut point mid-way.
  }

  // Later cuts first — preserve more data
  return candidates.reverse();
}

// Main entry point. Takes a corrupt file's raw text, returns:
//   { ok: true, value: <parsed>, bytesRecovered, cutAt, method } — recovery ok
//   { ok: false, reason }                                          — refused
//
// Options:
//   maxAttempts — cap on how many candidate cuts we try (default 200).
function salvage(rawText, { maxAttempts = 200 } = {}) {
  // First: maybe it parses as-is
  const asIs = tryParse(rawText);
  if (asIs.ok && shapeIsValid(asIs.value)) {
    return { ok: true, value: asIs.value, bytesRecovered: rawText.length, cutAt: rawText.length, method: "as-is" };
  }

  const candidates = findSafeCuts(rawText);
  if (!candidates.length) {
    return { ok: false, reason: "no safe cut points found — file structurally broken from the start" };
  }

  let tried = 0;
  for (const { offset, closeSequence } of candidates) {
    if (tried++ >= maxAttempts) break;
    const attempt = rawText.slice(0, offset) + closeSequence;
    const parsed = tryParse(attempt);
    if (parsed.ok && shapeIsValid(parsed.value)) {
      return {
        ok: true, value: parsed.value,
        bytesRecovered: offset,
        cutAt: offset,
        bytesDiscarded: rawText.length - offset,
        closeSequenceAppended: closeSequence,
        method: closeSequence.length ? "truncate+close" : "truncate",
        attemptsTried: tried,
      };
    }
  }

  return { ok: false, reason: `tried ${tried} cut points, none produced valid shape`, candidatesFound: candidates.length };
}

// Convenience: read a file from disk and try to salvage it. Wraps salvage()
// with fs concerns so callers can just do `salvageFromFile(path)`.
function salvageFromFile(path) {
  let raw;
  try { raw = fs.readFileSync(path, "utf8"); }
  catch (e) { return { ok: false, reason: `cannot read ${path}: ${e.message}` }; }
  return salvage(raw);
}

module.exports = { salvage, salvageFromFile, shapeIsValid };
