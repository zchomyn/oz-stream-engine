// APE ENGINE — Promise dimensions
// The ten dimensions every consumer product promises movement in.
// Every campaign's promise, every character's active-campaign tracking, and
// every scoring pass speaks this vocabulary. This file is the source of truth.

const DIMENSIONS = [
  { id: "energy",      label: "Energy",             prompt: "Ability to do what they wanted to do; physical vitality; not-tired." },
  { id: "confidence",  label: "Confidence",         prompt: "Feeling like themselves; comfort in their own skin; self-trust in this moment." },
  { id: "connection",  label: "Warmth / Connection", prompt: "Warmth toward the people they love; capacity to show up for them; felt closeness." },
  { id: "calm",        label: "Calm / Relief",      prompt: "Softening of the day's pressure; ease; less anxious tension." },
  { id: "control",     label: "Control / Competence", prompt: "Feeling capable of their life; on top of things; a sense of agency." },
  { id: "belonging",   label: "Belonging",          prompt: "Feeling part of something; not alone; seen by their world." },
  { id: "pleasure",    label: "Pleasure / Reward",  prompt: "A genuine small joy; enjoyment; a moment worth having had." },
  { id: "identity",    label: "Identity",           prompt: "The sense of who they are being affirmed or shifted; alignment with self-image." },
  { id: "freedom",     label: "Freedom",            prompt: "Release from a constraint; a felt sense of options opening." },
  { id: "focus",       label: "Focus",              prompt: "Clarity; the noise clearing so they can attend to what matters." },
];

const IDS = DIMENSIONS.map((d) => d.id);
const BY_ID = Object.fromEntries(DIMENSIONS.map((d) => [d.id, d]));

// Neutral baseline — every dimension starts at 50 (0-100 scale) when a
// character enters campaign-tracking. Movements are relative to this.
function blankState() {
  const s = {};
  for (const id of IDS) s[id] = 50;
  return s;
}

function clamp(v) { return Math.max(0, Math.min(100, v)); }

// Apply per-slot decay toward the character's set-point so a lift or dip
// doesn't stick forever without repeated cause. Set-point is the mean of
// self-regard and 50 — a shorthand for personality's resting temperature.
function driftToward(state, setPoint = 50, rate = 0.03) {
  for (const id of IDS) state[id] = state[id] + (setPoint - state[id]) * rate;
  return state;
}

module.exports = { DIMENSIONS, IDS, BY_ID, blankState, driftToward, clamp };
