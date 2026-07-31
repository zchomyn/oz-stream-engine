// APE ENGINE — Shot Particle
//
// The atomic unit of scene rendering. A Particle is not a prompt string, it's
// a stateful object that flows through pipeline stages:
//
//   emit → plan → render_still → animate_still → edit → finalize
//
// Each stage reads the particle's current state, does its work, mutates the
// particle in place, and hands off. If a stage fails, the particle carries
// its own error and the pipeline continues with the others (a partial scene
// is still a scene). No stage assembles its own wardrobe or portrait logic —
// everything a stage needs is either on the Particle itself or resolved from
// the Identity Layer.
//
// The Pixar veteran looking at this file should recognize the pattern from
// how frame graphs / render passes work in production animation pipelines.
// Small, self-describing units of work that compose.
//
// FUTURE STAGES (architecture ready, not implemented tonight):
//   - color_grade: LUT applied per-shot for scene-consistent look
//   - upscale: post-generation super-res pass
//   - motion_refinement: second Omni pass with previous_interaction_id for edits
//   - continuity_verify: post-hoc identity classifier ("does this look like Marcus?")
//     with automatic re-roll if it doesn't

const IDENTITY = require("./identity");

// Grammar → canonical framing directive. These are the vocabulary a scene
// planner LLM can use, and they map to specific image-prompt fragments
// that the still renderer will honor. Keeping the vocabulary small and
// canonical is the point — a Pixar person would say "yes, that's how a
// shotlist reads."
const GRAMMAR_FRAMINGS = {
  wide:      "wide establishing shot, characters visible in full context of the room, environment reads clearly",
  medium:    "medium shot from waist up, clean framing that shows expression and body language together",
  close_up:  "close-up on the subject's face, tight framing, eyes and expression are the subject",
  reaction:  "reaction shot — the subject's face registering the moment, tight framing, expression carries the meaning",
  detail:    "detail shot — a specific object or hands or texture in the frame, no faces required, the object is the subject",
};

// Construct a Particle from a Director shot-plan entry + the scene it belongs to.
// The scene provides the pool of Identities that might appear in this shot;
// the shot names which one is the primary subject.
function emit({ scene, shotIndex, plannedShot, sceneHour, worldAgents }) {
  const subjectIdentity = worldAgents[IDENTITY.keyFor(plannedShot.subject)]
    ? IDENTITY.identityFor(worldAgents[IDENTITY.keyFor(plannedShot.subject)], sceneHour)
    : null;

  // Context identities: every actor in the SCENE, so wardrobe locks apply
  // even for characters who might drift into the frame. This is the fix for
  // "Marcus rendered in Theo's tee" — even if a shot is nominally about
  // Marcus, if Theo is in the scene we lock Theo's clothing too.
  const contextIdentities = IDENTITY.identitiesFor(scene.actors, sceneHour, worldAgents);

  return {
    id: `${scene.id}_shot_${shotIndex}`,
    sceneId: scene.id,
    shotIndex,
    grammar: plannedShot.grammar,
    framing: GRAMMAR_FRAMINGS[plannedShot.grammar] || GRAMMAR_FRAMINGS.medium,
    subject: subjectIdentity,          // Identity of the primary subject
    context: contextIdentities,        // Identities of all scene actors (for wardrobe locks)
    moment: plannedShot.moment,        // Which beat this shot captures
    directive: plannedShot.prompt,     // Cinematographer's framing/mood note (scope-guarded by planner)
    location: pickLocation(scene, plannedShot),
    sceneHour,
    weather: null,                     // Filled in by pipeline when it has world state
    stillPath: null,                   // Filled by render_still stage
    videoPath: null,                   // Filled by animate_still stage
    status: "queued",                  // queued → planning → rendering → ready → failed
    error: null,
  };
}

// Which room does the shot happen in? Prefer the location of the beat that
// mentions the subject; fall back to scene's first beat's location.
function pickLocation(scene, plannedShot) {
  const subjectFirst = String(plannedShot.subject || "").split(" ")[0];
  const beat = scene.beats.find((b) => (b.actors || []).some((a) => a.startsWith(subjectFirst)));
  return beat?.location || scene.beats[0]?.location || "kitchen";
}

// Canonical image-style rules for every scene shot. This is the visual voice.
// One place. Change it here, every scene render inherits.
const IMAGE_STYLE = `35mm documentary short-film aesthetic, natural practical light, film grain, honest domestic staging. No text, no logos, no captions, no on-screen typography. Never staged or dramatized — real people doing everyday things.`;

// Build the full prompt for a Particle's still-image render. This is the ONE
// place a still prompt is assembled for scene rendering — no fragments
// scattered across ape.js.
function stillPromptFor(particle) {
  // Session 8c: pull campaign palettes for wardrobe drift. Lazy require to
  // avoid circular dep (ape → shot_particle → campaigns → ape).
  let campaignPalettes = [];
  try {
    const CAMPAIGNS = require("./campaigns");
    campaignPalettes = CAMPAIGNS.running()
      .map((c) => c.productPlan?.palette)
      .filter((p) => p?.primary);
  } catch (_) { /* no drift if campaigns not loadable here */ }
  const wardrobeBlock = IDENTITY.wardrobeManifest(particle.context, campaignPalettes);
  const otherNames = particle.context
    .filter((id) => id.key !== particle.subject?.key)
    .map((id) => id.name)
    .join(", ");
  return `${IMAGE_STYLE}

SCENE: ${particle.location} at ${formatHour(particle.sceneHour)}. ${particle.weather ? `Weather: ${particle.weather}. ` : ""}Documentary honesty.

PRIMARY SUBJECT: ${particle.subject?.name || "the person named in the beat"}. Face and features match the reference photograph exactly.
${otherNames ? `OTHERS IN FRAME (also match their reference photographs): ${otherNames}` : ""}

${wardrobeBlock}

FRAMING SAFETY (non-negotiable):
- Never crop a person at chest level with bare skin above the crop.
- If framing shows someone behind a counter, table, or piece of furniture, their clothing must be clearly visible above the crop edge.
- Bodies must not clip or intersect with counters, tables, or walls — a person is either fully in front of or fully behind furniture, never merged into it.
- Hands and fingers must render cleanly, correct count, natural anatomy.

SHOT GRAMMAR (${particle.grammar}): ${particle.framing}
CINEMATOGRAPHER NOTE: ${particle.directive}
MOMENT CAPTURED: ${particle.moment}`;
}

// Build the full Omni Flash prompt for animating a Particle's rendered still.
// FIRST_FRAME pattern seeds the video with the still we already rendered so
// face/wardrobe/room continuity is guaranteed frame-zero.
function videoPromptFor(particle, beat, durationSeconds = 6) {
  const line = beat?.said || null;
  const action = beat?.action || particle.moment;
  const audioBlock = line
    ? `Audio: ${particle.subject?.name} speaking the line in a natural conversational Montréal English accent, in-time with lip motion. Subtle room tone (soft radiator hum, distant traffic, whatever the room quietly is). No music.`
    : `Audio: subtle room tone only. No dialogue. No music.`;

  return `<FIRST_FRAME> ${particle.subject?.name || "The subject"} in the ${particle.location}, ${formatHour(particle.sceneHour)}. Continuous, unbroken handheld shot, ${durationSeconds} seconds. 35mm film aesthetic, natural practical light, subtle handheld motion, documentary honesty.

[0-1.5s] settling into the moment — a small breath, a shift of weight, a look. Do not rush.
[1.5-${durationSeconds - 1.5}s] ${action}${line ? `. Dialogue: "${line}"` : ""}
[${durationSeconds - 1.5}-${durationSeconds}s] aftermath of the moment — small expression, breath, quiet. Do not freeze; life continues.

Keep everything else the same as the first frame: same face, same wardrobe, same room, same light. Do not change the person. Do not change the clothing. Do not add new objects or people.

${audioBlock}

No dialogue other than what is specified. No music. No text overlays. No captions. No scene cuts. Use the full ${durationSeconds} seconds — do not condense.`;
}

function formatHour(hour) {
  const h = Math.floor(hour);
  const m = Math.round((hour - h) * 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// A snapshot of a particle safe to expose over the API. Strips b64 bytes.
function snapshot(particle) {
  return {
    id: particle.id,
    sceneId: particle.sceneId,
    shotIndex: particle.shotIndex,
    grammar: particle.grammar,
    subject: particle.subject?.name || null,
    moment: particle.moment,
    location: particle.location,
    status: particle.status,
    hasStill: !!particle.stillPath,
    hasVideo: !!particle.videoPath,
    error: particle.error,
  };
}

module.exports = {
  emit,
  stillPromptFor,
  videoPromptFor,
  snapshot,
  GRAMMAR_FRAMINGS,
  IMAGE_STYLE,
};
