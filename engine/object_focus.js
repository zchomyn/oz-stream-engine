// APE ENGINE — Object Focus
//
// The third zoom layer of the Observer Camera. Click an object inside a room
// view → Nano Banana Pro renders a close-up of that specific object in the
// specific room, using the room's canonical plate as reference to preserve
// architectural continuity.
//
// Two kinds of objects can be focused:
//
//   1. Fixtures — permanent room features (coffee maker, fridge, couch,
//      Captain's bowl). Named in the FIXTURES table below, per room.
//   2. Runtime objects — items the world is currently tracking in a specific
//      room (an unopened hydro bill on the microwave, yellow boots by the
//      front door). Pulled live from W.objects when their `at` matches.
//
// State-aware caching: fresh renders are cached with a timestamp. Repeat
// clicks return the cached bytes if the render is under FRESHNESS_MS old.
// If a runtime object's state changed since the cached render, we regenerate.
//
// The Pixar viewer opening this file should see: table of fixtures per room,
// one small render function, one small cache. Nothing scattered.

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

// ─── Fixture inventory per room ─────────────────────────────────────────────
// The permanent, always-clickable objects in each room. State notes describe
// what these things characteristically look like in this specific home — the
// coffee maker is described as leaking under a dish towel, not generic.

const FIXTURES = {
  kitchen: [
    { key: "coffee_maker", name: "the coffee maker",       state: "cheap plastic drip machine on the counter, small brown puddle underneath partly caught by a yellowed folded dish towel wedged under its front lip" },
    { key: "fridge",       name: "the refrigerator",       state: "old white fridge, a green magnet holding a stack of takeout menus and one utility bill, a child's crayon drawing taped to the door" },
    { key: "stove",        name: "the gas stove",          state: "four-burner white enamel stove with cast-iron grates, one pot lid drying on the back left burner" },
    { key: "sink",         name: "the kitchen sink",       state: "single-basin stainless sink, one damp rag folded on the divider, the tap has a slow drip" },
    { key: "table",        name: "the kitchen table",      state: "small round wooden table with three mismatched chairs, a paper napkin folded in half at one place, a coffee ring on the surface" },
  ],
  "living room": [
    { key: "couch",     name: "the couch",              state: "old sagging three-seater in muted olive, one cushion visibly compressed on the left end where Marcus sits, a folded blanket over the armrest" },
    { key: "coffee_table", name: "the coffee table",    state: "low wooden table, mail piled in a small stack on one corner (bills mostly), a coaster with a coffee ring, a paperback novel face-down" },
    { key: "tv",        name: "the TV",                 state: "small flat-screen on a low stand, dark screen, one loose HDMI cable visible" },
    { key: "laptop",    name: "Lena's laptop workspace", state: "silver laptop on the side table by the couch, a small notebook and a pen beside it, one Post-it note stuck to the trackpad edge" },
    { key: "lamp",      name: "the lamp",               state: "single practical floor lamp beside the couch, warm bulb, worn fabric shade" },
  ],
  "master bedroom": [
    { key: "bed",       name: "the bed",                state: "double bed, mismatched linens, one pillow flat-crushed, one pillow still puffed" },
    { key: "dresser",   name: "the dresser",            state: "wooden dresser with peeling veneer, a jewelry dish with two rings and a hair tie, a folded pair of socks on top" },
    { key: "photo",     name: "the framed photograph",  state: "small framed photograph on the wall: Marcus and Lena young, before Theo, sitting on a canal wall" },
    { key: "radiator",  name: "the painted radiator",   state: "cast-iron radiator painted the same off-white as the wall, a flannel shirt draped over its top" },
  ],
  "theo's bedroom": [
    { key: "bed",       name: "Theo's bed",             state: "single bed with a dinosaur-patterned duvet, one plush toy tucked under the covers, a book face-down beside the pillow" },
    { key: "desk",      name: "Theo's desk",            state: "small wooden desk with a math workbook open to a fractions worksheet, a black marker, three index cards" },
    { key: "captain",   name: "Captain's fish bowl",    state: "round glass bowl on a low shelf, one small goldfish visible, a hand-drawn maze on an index card taped to the glass" },
    { key: "drawings",  name: "the wall of drawings",   state: "a corkboard with about a dozen crayon and marker drawings tacked up — dinosaurs, mazes, a family portrait" },
  ],
  bathroom: [
    { key: "sink",      name: "the bathroom sink",      state: "pedestal sink with a chipped edge, three toothbrushes in a ceramic cup, a small dish of soap" },
    { key: "tub",       name: "the tub",                state: "old cast-iron clawfoot tub with a plastic curtain on a ring, one child's rubber duck on the ledge" },
    { key: "cabinet",   name: "the medicine cabinet",   state: "wall-mounted mirrored medicine cabinet with a slightly crooked hinge, showing the room reflected" },
  ],
  "front hallway": [
    { key: "coat_rack", name: "the coat rack",          state: "tall wooden coat rack, one adult jacket and one child's coat hanging, a knitted toque on a hook" },
    { key: "boots",     name: "the yellow boots",       state: "a pair of small yellow rain boots pushed under the coat rack, one boot slightly tipped over" },
    { key: "mail",      name: "the mail drop",          state: "small wall shelf with a bowl of keys, a folded newspaper, and two pieces of unopened mail" },
  ],
  "back porch": [
    { key: "chair",     name: "the folding chair",      state: "one metal folding chair on the concrete stoop, slightly weathered" },
    { key: "plant",     name: "the potted plant",       state: "a leggy potted plant, some yellowed lower leaves, sitting on the concrete beside the chair" },
  ],
};

// ─── Cache ──────────────────────────────────────────────────────────────────
// One directory of freshness-tracked render bytes.
const CACHE_DIR = path.join(path.dirname(CFG.SAVE_PATH), "object_focus");
try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (_) {}

// A cached render is fresh for ~30 sim-min. Beyond that, next click re-renders
// to pick up state changes (chores handled, objects moved, day advanced).
// Real-time equivalent depends on sim speed; at default this is roughly 60s.
const FRESHNESS_MS = 90 * 1000;

function safeKey(location, objectKey) {
  return (location + "__" + objectKey).replace(/[^a-z0-9_]+/gi, "_").toLowerCase();
}

function cacheGet(location, objectKey) {
  const p = path.join(CACHE_DIR, safeKey(location, objectKey) + ".jpg");
  try {
    const stat = fs.statSync(p);
    if (Date.now() - stat.mtimeMs > FRESHNESS_MS) return null;
    return fs.readFileSync(p);
  } catch (_) { return null; }
}

function cacheSet(location, objectKey, bytes) {
  const p = path.join(CACHE_DIR, safeKey(location, objectKey) + ".jpg");
  try { fs.writeFileSync(p, bytes); return p; } catch (_) { return null; }
}

// ─── Public API ─────────────────────────────────────────────────────────────

// List of clickable objects in a room, combining permanent fixtures and any
// runtime W.objects whose `at` matches this location.
function listInRoom(location, worldObjects) {
  const fixtures = FIXTURES[location] || [];
  const runtime = (worldObjects || []).filter((o) => (o.at || "").toLowerCase() === location.toLowerCase());
  return {
    fixtures: fixtures.map((f) => ({ ...f, kind: "fixture" })),
    runtime: runtime.map((o) => ({
      key: "runtime_" + (o.name || "").replace(/\W+/g, "_").toLowerCase(),
      name: o.name,
      state: `currently in the ${location} — recently placed here`,
      kind: "runtime",
    })),
  };
}

// Prompt for the close-up render. Room plate goes in first as reference so
// the render is architecturally consistent with the space.
function objectFocusPrompt(location, objectDescriptor) {
  return `Close-up detail shot of ${objectDescriptor.name} in the ${location} of a working-class 2-bedroom rental duplex in Saint-Henri, Montréal.

The object as it looks right now: ${objectDescriptor.state}.

35mm documentary aesthetic, natural practical light, film grain, honest working-class texture — worn, real, unglamorized. Shallow depth of field, the object is the subject and reads clearly, background is the room around it subtly out of focus. No text, no logos, no captions, no on-screen typography.

Reference image (first attached): the canonical look of this room. Match its palette, light logic, and architectural texture exactly — this is a close-up WITHIN that same room.`;
}

module.exports = {
  FIXTURES,
  listInRoom,
  objectFocusPrompt,
  cacheGet,
  cacheSet,
  CACHE_DIR,
  FRESHNESS_MS,
};
