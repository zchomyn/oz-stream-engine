// APE STREAM ENGINE — plate curator + multi-candidate picker.
//
// Two responsibilities:
//   1. bankAllPlates() — at boot, generate N candidate images for every
//      Seahaven location, pick the best via LLM vision pass, lock as the
//      canonical plate in BIBLE. Run once ever (idempotent — skips if plate
//      already banked).
//   2. pickBest(candidates, refs, criteria) — used per-capture to render
//      N candidate frames and pick the best one.
//
// This is what separates "AI slop" from "curated stream." Every reference
// image locked to the volume is generated 4× and the best pick is kept. Every
// live frame is rendered 3× and the best pick lands in the buffer.

const CANDIDATE_SCHEMA = {
  type: "object",
  properties: {
    best_index: { type: "integer" },
    reason: { type: "string" },
    all_acceptable: { type: "boolean" },
  },
  required: ["best_index", "reason"],
};

// Prompt for the LLM to compare N candidate images and pick the best. The
// criteria object tells it what "best" means for this call — architectural
// consistency for a plate, subject clarity + framing for a frame, etc.
function pickBestPrompt(count, criteria) {
  return `You are shown ${count} candidate images labeled 1 through ${count}. Pick the ONE that best matches these criteria:

${criteria}

Reject candidates that:
- Have visible anatomical errors (extra fingers, warped faces, merged bodies).
- Have obvious text/logo garbage or unreadable timestamps.
- Are lit inconsistently (harsh flash, blown highlights that don't match the described time of day).
- Have compositional problems (subject clipped in half by furniture, floating body parts).
- Have a fundamentally different room/environment than described (wrong wall color, wrong furniture layout, wrong architectural style).

Return JSON with:
- best_index (1-based index of the best candidate)
- reason (one sentence why)
- all_acceptable (true if you'd be happy with any of them, false if it was a compromise)`;
}

// Render N candidates for a given prompt + reference parts. Uses the same
// genImage function as the rest of the engine. Sequential to avoid rate
// limits.
async function renderCandidates(genImage, promptText, refParts, safePrompt, count, spacingMs) {
  const candidates = [];
  for (let i = 0; i < count; i++) {
    try {
      const parts = [...refParts, { text: safePrompt(promptText) }];
      const img = await genImage(parts);
      if (img?.data) candidates.push({ b64: img.data, mime: img.mimeType || "image/jpeg" });
      if (spacingMs > 0 && i < count - 1) await new Promise((r) => setTimeout(r, spacingMs));
    } catch (e) {
      // swallow individual failures — as long as we get 2+ candidates, we can still pick
    }
  }
  return candidates;
}

// Ask the LLM to pick the best candidate. Returns { index, reason, all_acceptable }.
// index is 0-based (adjusted from 1-based LLM output).
async function pickBest(gemini, textModel, candidates, criteria) {
  if (!candidates.length) return null;
  if (candidates.length === 1) return { index: 0, reason: "only candidate", all_acceptable: true };
  try {
    const parts = candidates.map((c) => ({ inlineData: { mimeType: c.mime, data: c.b64 } }));
    parts.push({ text: pickBestPrompt(candidates.length, criteria) });
    const data = await gemini(textModel, {
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: CANDIDATE_SCHEMA, temperature: 0.2 },
    });
    let t = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    t = t.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(t);
    const idx = Math.max(0, Math.min(candidates.length - 1, (parsed.best_index || 1) - 1));
    return { index: idx, reason: parsed.reason, all_acceptable: parsed.all_acceptable !== false };
  } catch (e) {
    // If pick fails, take the first candidate (all are equal in absence of judgment)
    return { index: 0, reason: `picker failed: ${e.message}`, all_acceptable: true };
  }
}

// Bank every location plate. Called once at boot after portrait bootstrap.
// For each canonical location:
//   1. Check BIBLE — skip if already banked
//   2. Render N candidates (each is a full plate generation)
//   3. Ask LLM to pick the best
//   4. Lock the winner in BIBLE
//
// Idempotent. Safe to call every boot. Only new/missing plates get generated.
async function bankAllPlates({
  BIBLE, LOCATIONS, plateId, platePrompt, genImage, gemini, safePrompt, olog,
  textModel, candidatesPerPlate = 3, spacingMs = 4000,
}) {
  const locKeys = Object.keys(LOCATIONS.LOCATIONS).filter((k) => {
    // Skip transitional walking/route states — no captures happen there.
    if (k.startsWith("walking ")) return false;
    if (k.includes("route")) return false;
    if (k === "lunch at his desk") return false;
    if (k === "opening rex's barbershop") return false;
    if (k === "the paperboy dispatch") return false;
    return true;
  });
  let banked = 0;
  let skipped = 0;
  const startedAt = Date.now();
  olog(`PLATE-CURATOR: banking canonical plates for ${locKeys.length} locations, ${candidatesPerPlate} candidates each...`);
  for (const key of locKeys) {
    const id = plateId(key);
    const existing = BIBLE.get(id);
    if (existing) { skipped++; continue; }
    const loc = LOCATIONS.LOCATIONS[key];
    const isHome = loc.home === true;
    const promptText = platePrompt(key, isHome);
    olog(`PLATE-CURATOR: rendering ${candidatesPerPlate} candidates for "${key}"...`);
    const candidates = await renderCandidates(genImage, promptText, [], safePrompt, candidatesPerPlate, spacingMs);
    if (!candidates.length) {
      olog(`PLATE-CURATOR: NO candidates for "${key}" — will retry next boot`);
      continue;
    }
    const criteria = `The canonical reference photo of "${key}" — ${loc.description || key} in the town of Seahaven, 1998. Pick the candidate that best captures a clean, consistent, believable interior/exterior of this specific place. The chosen image will be used as the LOCKED reference for every future frame at this location — it must look like a real, specific place, not a generic AI-rendered room. It must have coherent lighting, coherent architecture, coherent color palette. Empty of people. Clean composition.`;
    const pick = await pickBest(gemini, textModel, candidates, criteria);
    if (!pick) {
      olog(`PLATE-CURATOR: pick failed for "${key}" — falling back to first candidate`);
      BIBLE.put(id, "set", key, candidates[0].b64, 0);
    } else {
      olog(`PLATE-CURATOR: locked "${key}" (candidate ${pick.index + 1}/${candidates.length}) — ${pick.reason.slice(0, 80)}`);
      BIBLE.put(id, "set", key, candidates[pick.index].b64, 0);
    }
    banked++;
  }
  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
  olog(`PLATE-CURATOR: done in ${elapsed}s — ${banked} banked, ${skipped} already present`);
  return { banked, skipped };
}

module.exports = {
  bankAllPlates,
  renderCandidates,
  pickBest,
  CANDIDATE_SCHEMA,
};
