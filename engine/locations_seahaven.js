// APE STREAM ENGINE — Seahaven locations.
// Preserves the parent module's public interface: KEYS, LOCATIONS,
// resolveKey, get, contextFor. Sim substrate consumes these identically.

// KEYS: normalized location keys. What ape.js compares against.
const KEYS = {
  home: "home",
  bedroom: "master bedroom",
  kitchen: "kitchen",
  livingRoom: "living room",
  bathroom: "bathroom",
  hallway: "front hallway",
  frontStep: "front step",
  office: "seahaven mutual",
  cafe: "the good time café",
  harbor: "seahaven harbor",
  park: "seahaven park",
  grocery: "grocery",
  chester: "chester street",
  market: "market street",
  square: "lancaster square",
};

// LOCATIONS: metadata for each named place. contextFor reads this to enrich
// the agent turn prompt when the character is at that location.
const LOCATIONS = {
  "master bedroom": {
    indoor: true, home: true,
    description: "master bedroom of the Burbank house at 34 Lancaster Square. Twin-window south wall. Framed wedding photo. Wooden dresser with an oval mirror.",
  },
  "kitchen": {
    indoor: true, home: true,
    description: "kitchen of the Burbank house. Yellow tile counter. Cornflakes box. Coffee maker with glass carafe. Small pine table for two.",
  },
  "living room": {
    indoor: true, home: true,
    description: "living room of the Burbank house. Zenith TV in walnut console. Framed photo of Truman and his father on the mantel. Faded floral couch.",
  },
  "bathroom": {
    indoor: true, home: true,
    description: "downstairs bathroom of the Burbank house. Pale pink tile. Small pedestal sink with an electric razor on the shelf.",
  },
  "front hallway": {
    indoor: true, home: true,
    description: "front hallway of the Burbank house. Yellow rain slicker on a hook. Small oval mirror. Runner rug.",
  },
  "front step": {
    indoor: false, home: false,
    description: "front step of 34 Lancaster Square. Two potted geraniums. The morning paper (Seahaven Chronicle).",
  },
  "lancaster square": {
    indoor: false, home: false,
    description: "Lancaster Square — the picture-perfect cul-de-sac Truman has lived on his whole life. Trimmed lawns, white picket fences, one blooming dogwood.",
  },
  "market street": {
    indoor: false, home: false,
    description: "Market Street — Seahaven's brick-fronted commercial strip. Storefronts, striped awnings, a barber, a bakery, Seahaven Mutual.",
  },
  "seahaven mutual": {
    indoor: true, home: false,
    description: "Seahaven Mutual — a small insurance office on Market Street. Wooden desks, green banker's lamps, a fern by the window, an old rotary phone at the reception.",
  },
  "the good time café": {
    indoor: true, home: false,
    description: "The Good Time Café — a diner on Market Street with red vinyl booths, a chrome counter, a jukebox in the corner, a slice of pie always in the pie case.",
  },
  "seahaven harbor": {
    indoor: false, home: false,
    description: "Seahaven Harbor — a small crescent bay. Wooden pier. A dozen fishing boats. Salt-air rope smell. The seawall Truman avoids without knowing why.",
  },
  "seahaven park": {
    indoor: false, home: false,
    description: "Seahaven Park — a green square with a white bandstand at the center, old oaks, a duck pond, benches donated by townspeople.",
  },
  "grocery": {
    indoor: true, home: false,
    description: "Seahaven Grocers — mid-century supermarket. Checkerboard floor. Kaiser Chicken vending machine at the entrance. Fluorescent light.",
  },
  "chester street": {
    indoor: false, home: false,
    description: "Chester Street — a quieter residential street where Angela lives. Older homes, larger lots, a magnolia tree on her front lawn.",
  },
};

// resolveKey — take a raw location string and return the canonical key, or
// null. Used by dispose(), captureLivingMoment, and event routing.
function resolveKey(rawLocation) {
  if (!rawLocation) return null;
  const s = String(rawLocation).toLowerCase().trim();
  if (LOCATIONS[s]) return s;
  // Fuzzy match: substring against the KEYS values.
  for (const k of Object.values(KEYS)) {
    if (s.includes(k)) return k;
  }
  // Common variants
  if (/^bedroom|master bedroom/.test(s)) return "master bedroom";
  if (/^kitchen/.test(s)) return "kitchen";
  if (/^living/.test(s)) return "living room";
  if (/^bath/.test(s)) return "bathroom";
  if (/^hall|entry/.test(s)) return "front hallway";
  if (/^porch|step/.test(s)) return "front step";
  if (/mutual|insurance|office/.test(s)) return "seahaven mutual";
  if (/café|cafe|diner|good time/.test(s)) return "the good time café";
  if (/harbor|pier|bay|dock/.test(s)) return "seahaven harbor";
  if (/park|bandstand|pond/.test(s)) return "seahaven park";
  if (/grocer|market|supermarket/.test(s)) return "grocery";
  return null;
}

function get(rawLocation) {
  const k = resolveKey(rawLocation);
  return k ? LOCATIONS[k] : null;
}

// Location-layer context injected into the agent turn prompt when the
// character is at a non-home location. Home rooms get empty (their concerns
// are the character's own state, not the room's).
function contextFor(rawLocation, characterKey, worldHour) {
  const loc = get(rawLocation);
  if (!loc || loc.home) return "";
  return `Location context: You are at ${loc.description}`;
}

// The parent engine has residue + threads systems for locations (an unfinished
// conversation from earlier at the café, a package left at the office). For
// the stream MVP these are no-ops. Can be added back when we want the town
// to have narrative accumulation across days.
function registerResidue() {}
function advanceThreads() {}

module.exports = {
  KEYS,
  LOCATIONS,
  resolveKey,
  get,
  contextFor,
  registerResidue,
  advanceThreads,
};
