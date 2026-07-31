// APE ENGINE — Dailies
//
// The living window. After each slot, if the beat is shot-worthy (interesting
// score >= 25), we render one still: the subject in their location, in the
// clothes they're wearing, doing what the beat said. Anchored to the visual
// bible so faces and rooms stay consistent across the whole run.
//
// One image per shot-worthy beat. Never four. Storyboards belong to Phase C.
// Rendering happens behind the beat — the engine never blocks on it.
//
// Files land in /data/dailies as immutable JPEGs, served via /api/dailies/:id.
// A rolling index (dailies-index.json) preserves order and metadata.

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

const DIR = path.join(path.dirname(CFG.SAVE_PATH), "dailies");
try { fs.mkdirSync(DIR, { recursive: true }); } catch (_) {}

const INDEX_PATH = path.join(DIR, "index.json");
let INDEX = [];  // ordered array; newest last

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_PATH)) INDEX = JSON.parse(fs.readFileSync(INDEX_PATH, "utf8"));
  } catch (_) { INDEX = []; }
}
function persistIndex() {
  try { fs.writeFileSync(INDEX_PATH, JSON.stringify(INDEX)); } catch (_) {}
}

// ---- Shot picker ----
// Decides whether a beat deserves a frame, and if so what/where it depicts.
// Called with the beat's raw output from the agent call plus world context.
function isShotWorthy(beat) {
  if (!beat || !beat.act) return false;
  // Skip pure "none" acts with no thought and no said line — those are truly
  // routine and would produce identical frames.
  const said = beat.act.kind === "talk" && (beat.act.detail || "").length > 0;
  const acted = beat.act.kind !== "none" && (beat.act.detail || "").length > 0;
  const thought = (beat.think || "").length > 40;   // substantive thought
  // Roughly 50-70% of beats qualify. Trims the flat filler.
  return said || acted || thought;
}

function buildShotSpec({ agentName, agentLocation, agentThink, agentAct, agentSaid, otherPresent, visibleObjects, worldClock, weather, wardrobeString, thoughtElsewhere }) {
  // Determine grammar based on beat character:
  //   - said something: two-shot if company, medium if alone
  //   - did something with an object: hands + object insert-ish
  //   - just thought: face close-ish, hands, room over shoulder
  let grammar = "medium documentary still";
  if (agentSaid && otherPresent && otherPresent.length) grammar = "two-hander, both in frame, natural angle";
  else if (agentAct && !agentSaid) grammar = "medium shot with hands and object visible";
  else if (agentThink && !agentAct && !agentSaid) grammar = "quiet observational shot; face partially visible, weight of thought carried by posture";
  return {
    subject: agentName,
    location: agentLocation,
    grammar,
    thoughtSubtext: agentThink || "",
    action: agentAct || "",
    said: agentSaid || "",
    others: otherPresent || [],
    visibleObjects: visibleObjects || [],
    worldClock, weather,
    wardrobeString: wardrobeString || "",
    thoughtElsewhere: thoughtElsewhere || "",   // if their thought is about a place/thing NOT physically present
  };
}

// ---- Prompt ----
// Same shape as the storyboard prompt but a single shot. The bible layer
// (character portrait + room plate) is attached as inlineData in ape.js; here
// we only build the text.
function shotPromptText(spec) {
  const objs = spec.visibleObjects.length ? spec.visibleObjects.join(", ") : "only what the room plate already shows";
  const others = spec.others.length ? spec.others.join(" and ") + " also visible" : "";
  const subtext = spec.thoughtSubtext ? `Interior subtext (informs expression only, do not caption): "${spec.thoughtSubtext.slice(0, 200)}"` : "";

  // Hard wardrobe: same outfit every beat this sim-day. Do NOT let the model
  // reinterpret — pass the exact string.
  const wardrobeBlock = spec.wardrobeString
    ? `WARDROBE (locked for the entire sim-day, do NOT reinterpret): ${spec.subject} is wearing: ${spec.wardrobeString}. This is the exact same outfit shown in every other shot from today. Do not add, remove, or substitute any garment.`
    : `WARDROBE: Match the reference portrait exactly. Do not change any garment.`;

  // When the beat is a thought about something elsewhere, we still shoot the
  // subject where they physically are — never render the imagined place.
  const dislocationNote = spec.thoughtElsewhere
    ? `\n\nMIND vs BODY: The subject is thinking about "${spec.thoughtElsewhere}" but that is NOT what we see. We see them physically here in ${spec.location}, and only their expression carries the thought. Do not render the imagined subject or place.`
    : "";

  return `Documentary photograph, ${spec.grammar}. 35mm film aesthetic, natural practical light, subtle grain. No text, no logos, no captions.

MOMENT: ${spec.action || spec.said || spec.thoughtSubtext ? "" : "a quiet slice of life"} ${spec.action ? `Action: ${spec.action}.` : ""} ${spec.said ? `They are speaking: "${spec.said}".` : ""} ${subtext}${dislocationNote}

SUBJECT: ${spec.subject} must be clearly visible in the frame.

FACE (mandatory, non-negotiable): The reference portrait attached is the CANONICAL face of ${spec.subject}. Match the reference EXACTLY: same skin tone, same features, same ethnicity, same hair colour and texture, same face shape, same build. Do NOT reinterpret, restyle, age, or ethnically shift the subject in any direction. If in doubt, err toward the reference. Any deviation from the portrait's face is a failed render.

${wardrobeBlock}

Every person in the frame is fully clothed, ordinary everyday clothes, no bare torsos, no exposed skin above any counter or table crop.

${others ? "OTHERS PRESENT: " + others + ". Also from the reference portraits — same faces (same skin, features, ethnicity, hair), same fully-clothed wardrobe locked for the day." : ""}

SETTING: ${spec.location}. The FIRST reference image is the canonical room plate — match architecture, furniture, palette, and light logic exactly. Do NOT redesign the space. Time: ${spec.worldClock}. Weather / atmosphere: ${spec.weather}.

VISIBLE OBJECTS THIS MOMENT (limit strictly to these plus what the room plate shows): ${objs}. Do NOT invent props, brands, animals, or additional people.

Composition: single frame, cinematic but honest. The named subject MUST appear in the frame with their reference face. Real people doing everyday things in everyday clothes. Do not stage or dramatize. Do not aestheticize beyond documentary honesty.`;
}

// ---- Queue ----
// Ape.js pushes render jobs; a small worker drains them one at a time with
// pacing between calls so we never hit the image API rate limit.
const QUEUE = [];
let RUNNING = false;

function enqueue(job) {
  QUEUE.push(job);
  drain(job.driver);
}
function pending() { return QUEUE.length; }

async function drain(driver) {
  if (RUNNING || !QUEUE.length) return;
  RUNNING = true;
  try {
    while (QUEUE.length) {
      const job = QUEUE.shift();
      try {
        const buf = await driver(job.spec, job.refs);   // driver = image generation function provided by ape.js
        if (buf) {
          const fname = `daily_${job.entry.id}.jpg`;
          fs.writeFileSync(path.join(DIR, fname), buf);
          job.entry.file = fname;
          job.entry.state = "ready";
        } else {
          job.entry.state = "failed";
        }
        persistIndex();
      } catch (e) {
        job.entry.state = "failed";
        job.entry.error = String(e.message).slice(0, 200);
        persistIndex();
      }
      // Pace between calls
      await new Promise((r) => setTimeout(r, 4000));
    }
  } finally { RUNNING = false; }
}

// ---- Public API ----
function record({ day, slot, time, spec, campaignIds, driver, refs }) {
  const id = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const entry = {
    id, day, slot, time,
    subject: spec.subject,
    location: spec.location,
    action: spec.action, said: spec.said, thoughtSubtext: spec.thoughtSubtext,
    campaignIds: campaignIds || [],
    state: "rendering",
    createdAt: Date.now(),
  };
  INDEX.push(entry);
  // Retention: keep 400 most recent shots on disk. Older ones get their file
  // reaped (index entries stay so the timeline remains intact).
  if (INDEX.length > 400) {
    const stale = INDEX[INDEX.length - 400 - 1];
    if (stale?.file) {
      try { fs.unlinkSync(path.join(DIR, stale.file)); } catch (_) {}
      stale.file = null;
      stale.state = "reaped";
    }
  }
  persistIndex();
  enqueue({ entry, spec, refs, driver });
  return entry;
}

function list({ since = 0, limit = 60, campaignId = "" } = {}) {
  let items = INDEX.filter((e) => e.slot > since);
  if (campaignId) items = items.filter((e) => (e.campaignIds || []).includes(campaignId));
  return items.slice(-limit);
}

function file(id) {
  const e = INDEX.find((x) => x.id === id);
  if (!e || !e.file) return null;
  const p = path.join(DIR, e.file);
  if (!fs.existsSync(p)) return null;
  return { path: p, mime: "image/jpeg" };
}

module.exports = { loadIndex, isShotWorthy, buildShotSpec, shotPromptText, record, list, file, pending, DIR };
