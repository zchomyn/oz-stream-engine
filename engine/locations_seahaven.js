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

  // Supporting-cast homes and routes. These exist as valid resolve targets
  // so agents don't fall through to null and get grouped with whoever's at
  // Truman's location.
  "larry's house":          { indoor: true, home: false, description: "Larry Whitmer's modest cape cod at the end of Elm Street" },
  "ferris's house":         { indoor: true, home: false, description: "Mr. Ferris's colonial on Sycamore Road" },
  "doris's apartment":      { indoor: true, home: false, description: "Doris Callahan's small apartment above the Seahaven Drug Store" },
  "cal's route":            { indoor: false, home: false, description: "Cal Fenwick walking his USPS route through Seahaven" },
  "cal's route (upper lancaster)":  { indoor: false, home: false, description: "Cal on the upper end of Lancaster Square" },
  "cal's route (market street)":    { indoor: false, home: false, description: "Cal on Market Street delivering to the storefronts" },
  "cal's route (chester and points north)": { indoor: false, home: false, description: "Cal on Chester Street and beyond" },
  "the paperboy dispatch":  { indoor: true, home: false, description: "the small newspaper drop shed behind the Seahaven Chronicle office" },
  "the paper route":        { indoor: false, home: false, description: "Timmy Kessler on his red bike, tossing rolled Chronicles onto porches" },
  "seahaven elementary":    { indoor: true, home: false, description: "Seahaven Elementary School classroom" },
  "rex's house":            { indoor: true, home: false, description: "Rex Whitlock's bungalow on Sycamore Road" },
  "rex's barbershop":       { indoor: true, home: false, description: "Rex's Barbershop on Market Street — striped pole, two chairs, mirrored wall" },
  "opening rex's barbershop": { indoor: true, home: false, description: "Rex opening the shop for the day — flipping the closed sign, sweeping the entry" },
  "esther's house":         { indoor: true, home: false, description: "Esther Pritchett's small tidy cottage on Chester Street" },
  "hank's house":           { indoor: true, home: false, description: "Hank Deveraux's small clapboard house near the harbor" },
  "marlon's apartment":     { indoor: true, home: false, description: "Marlon Jenkins's small apartment above the auto parts store" },
  "angela's house":         { indoor: true, home: false, description: "Angela Burbank's tidy cottage on Chester Street — mother of Truman" },
  "cal's house":            { indoor: true, home: false, description: "Cal Fenwick's small ranch-style home on Elm Street" },
  "timmy's house":          { indoor: true, home: false, description: "Timmy Kessler's family home — a modest two-story on Pine Street" },
  "seahaven community hospital": { indoor: true, home: false, description: "Seahaven Community Hospital — a small mid-century building" },

  // Transitional walking states — outdoor so home cameras won't fire on them
  "walking to work along market street":  { indoor: false, home: false, description: "Truman walking east down Market Street toward Seahaven Mutual" },
  "walking home from work":               { indoor: false, home: false, description: "Truman walking west down Market Street toward home" },
  "walking to the hospital":              { indoor: false, home: false, description: "Meryl walking toward the hospital" },
  "walking home from the hospital":       { indoor: false, home: false, description: "Meryl walking home from the hospital shift" },
  "walking to the harbor":                { indoor: false, home: false, description: "Hank walking down to the harbor" },
  "walking to seahaven mutual":           { indoor: false, home: false, description: "Mr. Ferris walking to work" },
  "walking to the good time café":        { indoor: false, home: false, description: "Doris walking her short commute to the café" },
  "walking home from the café":           { indoor: false, home: false, description: "Doris walking home from her shift" },
  "walking to the park with the bread bag": { indoor: false, home: false, description: "Esther walking to the park with her bread bag" },
  "walking home from the park":           { indoor: false, home: false, description: "Esther walking home from the park bench" },
  "restocking route (kaiser chicken vending)": { indoor: false, home: false, description: "Marlon in his Kaiser Chicken truck restocking vending machines" },
  "lunch at his desk":                    { indoor: true, home: false, description: "Mr. Ferris at his desk with a sandwich from home" },
};

// resolveKey — take a raw location string and return the canonical key, or
// null. Used by dispose(), captureLivingMoment, and event routing.
function resolveKey(rawLocation) {
  if (!rawLocation) return null;
  const s = String(rawLocation).toLowerCase().trim();
  // Exact match first — every canonical location wins immediately
  if (LOCATIONS[s]) return s;
  // Common variants that stream schedule doesn't always spell canonically
  if (/^bedroom|master bedroom/.test(s)) return "master bedroom";
  if (/^kitchen/.test(s)) return "kitchen";
  if (/^living/.test(s)) return "living room";
  if (/^bath/.test(s)) return "bathroom";
  if (/^hall|entry/.test(s)) return "front hallway";
  if (/^porch|step/.test(s)) return "front step";
  if (/mutual|insurance|office/.test(s) && !s.includes("post")) return "seahaven mutual";
  if (/good time|café|cafe|diner/.test(s)) return "the good time café";
  if (/harbor|pier|seawall/.test(s)) return "seahaven harbor";
  if (/park|bandstand|pond|duck/.test(s)) return "seahaven park";
  if (/grocer|supermarket|seahaven grocer/.test(s)) return "grocery";
  if (/barbershop|barber shop/.test(s)) return "rex's barbershop";
  if (/hospital/.test(s)) return "seahaven community hospital";
  if (/elementary|school/.test(s)) return "seahaven elementary";
  if (/paper route|paperboy/.test(s)) return "the paper route";
  if (/mail|route.*mail|postal/.test(s)) return "cal's route";
  if (/restocking|kaiser chicken/.test(s)) return "restocking route (kaiser chicken vending)";
  // No match — return null. The caller decides what to do; occupants filter
  // will now correctly exclude an agent whose location doesn't resolve.
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
