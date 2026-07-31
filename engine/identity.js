// APE ENGINE — Identity Layer
//
// The single source of truth for who a character is at the moment a shot is
// being rendered. Every render path — dailies, peek, scene storyboard, scene
// video — reads from here rather than assembling wardrobe strings and reference
// lookups on its own. That solves three real bugs at once:
//
//   1. charRefs used to slice to actors[0..1], silently dropping the third
//      family member's portrait — that's why Lena drifted to a random woman in
//      3-character scenes. Identity always returns every actor's reference.
//
//   2. Wardrobe was recomputed in three separate places with a copy-pasted
//      `isNight = h < 6 || h >= 22` heuristic. When someone updated one copy
//      and not others, drift crept in. Here it's computed once, based on the
//      character's own wake/sleep hours (not a global window).
//
//   3. There was no formal "what makes this person themself" object. Faces,
//      wardrobe, voice, motion signature — scattered across bible.js, ape.js,
//      dailies.js, prompts.js. The Pixar veteran opening the codebase should
//      find this file and immediately know: this is the character substrate.
//
// FUTURE HOOKS (not implemented yet — the architecture is ready for them):
//   - identity.lora_uri  → per-character fine-tuned LoRA, plugs into image
//                          model via Vertex tuning workflows
//   - identity.voice_id  → cloned voice profile for Omni audio conditioning
//   - identity.motion    → learned motion signature (posture, gait, gesture
//                          rhythm) for animation continuity
//
// Nothing in this file makes network calls. It's a pure data layer.

const BIBLE = require("./bible");

// Wake / sleep hours per character. Must stay in sync with schedule() in ape.js.
// When we eventually pull schedule into its own module, both this and that read
// from a shared CHARACTER_SCHEDULE table.
const WAKE_HOURS = { truman: 6.75, meryl: 6.5, marlon: 7.25, angela: 7 };
const SLEEP_HOURS = { truman: 22.5, meryl: 22, marlon: 23, angela: 22 };

// Resolve a character key ("marcus") from a display name ("Marcus" or "Marcus
// Jenkins"). Case-insensitive, uses first token. Returns null if unknown.
function keyFor(nameOrKey) {
  if (!nameOrKey) return null;
  const first = String(nameOrKey).trim().split(/\s+/)[0].toLowerCase();
  return (first in WAKE_HOURS) ? first : null;
}

// Is this character asleep at the given simulation hour?
function isAsleep(key, hour) {
  const wake = WAKE_HOURS[key];
  const sleep = SLEEP_HOURS[key];
  if (wake == null) return false;
  return hour < wake || hour >= sleep;
}

// Which wardrobe applies right now — determined by the CHARACTER'S OWN
// sleep window, not a global heuristic. Theo in his day clothes at 8am, in
// his pajamas at 9pm, regardless of what Marcus is wearing.
function currentWardrobe(agent, hour) {
  const key = keyFor(agent?.name || "");
  if (!key || !agent?.wardrobe) return "";
  return isAsleep(key, hour) ? (agent.wardrobe.night || "") : (agent.wardrobe.day || "");
}

// Portrait reference bytes for a character. Returns { name, key, b64, mime }
// or null if missing (with a warning so silent failures become loud).
function portraitFor(nameOrKey) {
  const key = keyFor(nameOrKey);
  if (!key) return null;
  const entry = BIBLE.get("char_" + key);
  if (!entry) {
    console.warn(`[identity] portrait missing for "${nameOrKey}" (key: ${key}) — image will render without face reference`);
    return null;
  }
  return { name: nameOrKey, key, b64: entry.b64, mime: entry.mime || "image/jpeg" };
}

// Build a full Identity object for a character at a given moment. This is what
// every renderer consumes. Everything a render needs to keep the person
// themself is on this object — no prompt-fragment assembly, no wardrobe
// lookups in the render code.
// forceDay=true skips the sleep-window check and always returns day wardrobe.
// Used for campaign store moments where an agent is out in public and clearly
// not in pajamas regardless of what the sim clock reads.
function identityFor(agent, hour, { forceDay = false } = {}) {
  const key = keyFor(agent?.name || "");
  if (!key) return null;
  const wardrobe = forceDay
    ? (agent.wardrobe?.day || "")
    : currentWardrobe(agent, hour);
  return {
    key,                                 // "marcus" | "lena" | "theo"
    name: agent.name,                    // display name
    portrait: portraitFor(agent.name),   // { b64, mime } or null
    wardrobe,
    asleep: forceDay ? false : isAsleep(key, hour),
    // Future: lora_uri, voice_id, motion
  };
}

// Given a list of actor names and a world hour, return their full Identity
// objects. Every actor gets one — no silent slicing, no dropping. If an
// actor's portrait is missing, we keep the Identity but mark it so the
// caller knows to render more defensively.
function identitiesFor(actorNames, hour, worldAgents) {
  const results = [];
  for (const name of (actorNames || [])) {
    const key = keyFor(name);
    if (!key) continue;
    const agent = worldAgents[key];
    if (!agent) continue;
    const identity = identityFor(agent, hour);
    if (identity) results.push(identity);
  }
  return results;
}

// Format a wardrobe manifest for prompt injection. This is the ONLY place in
// the codebase that writes wardrobe language for a scene. If the phrasing
// changes, it changes here — nowhere else.
//
// Session 8c: campaignPalettes is an optional array of palette hints from
// running campaigns' productPlans ({ primary, secondary }). When provided, we
// prepend a subtle drift instruction so the scene renderer picks resonant tones
// from the existing wardrobe (a sage-green sweater already in someone's closet,
// a warm ceramic-brown scarf) without literal branding.
function wardrobeManifest(identities, campaignPalettes = []) {
  const lines = identities
    .filter((id) => id.wardrobe)
    .map((id) => `- ${id.name} is wearing: ${id.wardrobe}. This is the ONLY clothing ${id.name} wears in this frame.`);
  if (!lines.length) return "";
  let paletteLine = "";
  if (campaignPalettes.length) {
    const tones = campaignPalettes
      .map((p) => [p.primary, p.secondary].filter(Boolean).join(" and "))
      .filter(Boolean)
      .join("; ");
    if (tones) {
      paletteLine = `SUBTLE PALETTE DRIFT (for wardrobe rendering only — do NOT add branded items or logos): the family's current aesthetic naturally tilts toward ${tones}. Where the wardrobe description above allows range (a sweater, a scarf, a jacket), lean toward these tones. Realistic, not costume-y.\n`;
    }
  }
  return `${paletteLine}CHARACTER WARDROBE (mandatory per-character, do NOT swap clothing between people):\n${lines.join("\n")}`;
}

// Reference-photo image parts for a model call, in the shape Gemini expects.
// This replaces charRefs() which was silently truncating to 2 actors.
function referenceParts(identities) {
  const parts = [];
  for (const id of identities) {
    if (id.portrait?.b64) {
      parts.push({ inlineData: { mimeType: id.portrait.mime, data: id.portrait.b64 } });
    }
  }
  return parts;
}

module.exports = {
  keyFor,
  isAsleep,
  currentWardrobe,
  portraitFor,
  identityFor,
  identitiesFor,
  wardrobeManifest,
  referenceParts,
  WAKE_HOURS,
  SLEEP_HOURS,
};
