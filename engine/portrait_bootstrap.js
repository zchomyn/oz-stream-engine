// APE STREAM ENGINE — portrait bootstrap for the Truman cast.
//
// On boot, checks that each cast member has a portrait in BIBLE. If missing,
// generates one via Nano Banana and persists. Idempotent: existing portraits
// are skipped. Runs sequentially with pacing so the first boot doesn't blast
// the model API with 4 concurrent generations.
//
// Portraits are locked once written (as any BIBLE entry) — the same reference
// image is used across every render for identity continuity. If you want to
// regenerate one, delete its file from the BIBLE directory and restart.

const BIBLE = require("./bible");
const SEED = require("./world");
const CFG = require("./config");

// Portrait prompt for a specific character. Rich enough for the model to
// consistently reproduce this face across renders. Short enough to fit within
// context without diluting other prompt content.
function portraitPrompt(agent) {
  const physical = agent.physical || "";
  const wardrobe = agent.wardrobe?.day || "";
  return `Passport-style portrait photograph. Straight-on head-and-shoulders. Neutral cream studio background. Warm even lighting. Direct-to-camera gaze.

SUBJECT: ${agent.fullName || agent.name}, age ${agent.age}. ${agent.role || ""}

APPEARANCE: ${physical}

WARDROBE: ${wardrobe}

POSE: Hands NOT visible in frame, or resting naturally out of shot. No hand near the face, neck, collar, or hair. No touching, adjusting, or gesturing of any kind — this is a plain identity photo, not a candid moment. Relaxed neutral shoulders, arms down. This constraint matters: this photo becomes a locked reference used in hundreds of future scenes, and any incidental gesture here will get echoed into every one of them.

STYLE: 35mm portrait, honest color, natural skin texture. No stylization. No cinematic grading. No smile if not natural to the person. This image will be used as a face-reference for continuity across many future renders — the face must be sharp, clearly readable, and consistent-looking.`;
}

// Optional forced regeneration for specific characters — set
// PORTRAIT_FORCE_REGEN=doris,esther (comma-separated agent keys) to make
// bootstrapAll regenerate those portraits even though one already exists.
// Useful when an existing locked portrait has an unwanted incidental pose
// that's been bleeding into every scene that character appears in. Remove
// the env var after the fix lands — leaving it set would regenerate (and
// re-spend) on every boot.
function forceRegenKeys() {
  return new Set(
    String(process.env.PORTRAIT_FORCE_REGEN || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

// Ensure a portrait exists in BIBLE for one character. Returns { generated, id }.
// If already present, returns { generated: false }. If generation fails, logs
// and returns { generated: false, error }.
async function ensurePortrait(agentKey, agent, genImage, safePrompt, forceSet) {
  const bibleId = "char_" + agentKey;
  const existing = BIBLE.get(bibleId);
  const forced = forceSet && forceSet.has(agentKey.toLowerCase());
  if (existing && !forced) return { generated: false, id: bibleId };
  try {
    const prompt = portraitPrompt(agent);
    const img = await genImage([{ text: safePrompt(prompt) }]);
    if (!img?.data) return { generated: false, error: "no image returned" };
    BIBLE.put(bibleId, "character", `portrait of ${agent.name}`, img.data, 0);
    console.log(`[portrait-bootstrap] ${forced ? "REGENERATED (forced)" : "wrote"} portrait for ${agent.name} (${bibleId})`);
    return { generated: true, id: bibleId };
  } catch (e) {
    console.error(`[portrait-bootstrap] failed for ${agent.name}: ${e.message}`);
    return { generated: false, error: e.message };
  }
}

// Bootstrap all cast members. Called once at boot from server.js after
// APE.start(). Sequential with pacing to be gentle on the model API. Runs
// in the background — the sim starts ticking immediately, portraits arrive
// when they arrive.
async function bootstrapAll(genImage, safePrompt) {
  console.log("[portrait-bootstrap] checking portraits for cast...");
  const agents = SEED.AGENTS;
  const forceSet = forceRegenKeys();
  if (forceSet.size) console.log(`[portrait-bootstrap] force-regen requested for: ${[...forceSet].join(", ")}`);
  const results = [];
  for (const [key, agent] of Object.entries(agents)) {
    const r = await ensurePortrait(key, agent, genImage, safePrompt, forceSet);
    results.push({ key, ...r });
    if (r.generated) {
      // Pace between generations. Nano Banana rate-limit-friendly spacing.
      await new Promise((r) => setTimeout(r, 6000));
    }
  }
  const generated = results.filter((r) => r.generated).length;
  const already = results.filter((r) => !r.generated && !r.error).length;
  const failed = results.filter((r) => r.error).length;
  console.log(`[portrait-bootstrap] done: ${generated} generated, ${already} already present, ${failed} failed`);
  return results;
}

module.exports = { bootstrapAll, ensurePortrait, portraitPrompt };
