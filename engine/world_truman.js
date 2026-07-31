// APE STREAM ENGINE — Seahaven world seed for Truman Burbank.
//
// Shape parity with parent world.js — same top-level exports (FACTS, PLACES,
// MONEY, OBJECTS, AGENTS) so ape.js and downstream modules consume it
// identically. Content is Truman-specific.
//
// Only Truman is streamed as a POV. Meryl, Marlon, and Angela are fully
// modeled agents (they have inner lives), but the stream only shows what
// hidden cameras see of them — which is: whatever room they're currently in
// while Truman is around, or none at all when Truman isn't there.

const FACTS = [
  "The world is a small ocean town called Seahaven. It is late spring 1998. Warm sun, salty breeze.",
  "Truman Burbank, 29, lives at 34 Lancaster Square with his wife Meryl. He was born and raised in Seahaven and has never left.",
  "Truman works as an insurance clerk at Seahaven Mutual on Market Street, 5 minutes' walk from home.",
  "Truman's father drowned in a boating accident when Truman was seven. The event is never discussed by his mother Angela.",
  "Meryl is a nurse at Seahaven Community Hospital. She married Truman four years ago.",
  "Marlon Jenkins has been Truman's best friend since kindergarten. He restocks vending machines for Kaiser Chicken.",
  "Angela Burbank is Truman's retired schoolteacher mother; she lives on Chester Street.",
  "Named people outside these four may only appear if they already exist in someone's memory or the event log. No inventing new relatives, coworkers, or old friends.",
  "The Burbank house is a modest 1950s clapboard two-story: master bedroom upstairs, kitchen + living room + bathroom + front hallway downstairs, small front porch, low picket fence.",
];

const HOME_ROOMS = ["kitchen", "living room", "master bedroom", "bathroom", "front hallway"];

const PLACES = {
  home: { rooms: HOME_ROOMS },
  out: [
    "seahaven mutual (Truman's office)",
    "the good time café",
    "seahaven harbor",
    "seahaven park",
    "grocery",
    "chester street (Angela's house)",
    "market street",
    "lancaster square",
  ],
  travelMinutes: { office: 5, cafe: 4, harbor: 12, park: 8, grocery: 6, chester: 10 },
};

const MONEY = {
  checking: 2140,
  hiddenTin: 0,
  bills: [
    { name: "mortgage", amount: 512, dueDay: 5 },
    { name: "power & gas", amount: 78, dueDay: 12 },
  ],
  nextPayday: { who: "truman", day: 5, amount: 1240 },
  note: "Truman gets paid Friday. Meryl gets paid the following Wednesday. Comfortable, not lavish. Enough left over for the occasional dinner at the Good Time Café.",
};

const OBJECTS = [
  { name: "cornflakes box on the counter, top folded twice", at: "kitchen", state: "unopened, top folded twice" },
  { name: "coffee maker with clear glass carafe", at: "kitchen", state: "carafe half-full of fresh coffee, red brew light on" },
  { name: "yellow ceramic mug in the sink", at: "kitchen", state: "one used mug from yesterday, small ring of coffee stain inside" },
  { name: "framed photo of Truman and his father on a small sailboat, on the mantel", at: "living room", state: "sepia-toned, slightly dusty frame" },
  { name: "Zenith TV in walnut console", at: "living room", state: "on, tuned to Seahaven Morning News, low volume" },
  { name: "Reader's Digest and a TV Guide on the coffee table", at: "living room", state: "arranged neatly, TV Guide open to today's page" },
  { name: "yellow rain slicker on a hook by the front door", at: "front hallway", state: "hanging on the middle hook, damp collar from yesterday" },
  { name: "framed wedding photograph over the master bed", at: "master bedroom", state: "hung straight, gold frame, dust on the top edge" },
  { name: "small blue alarm clock on the nightstand", at: "master bedroom", state: "reading close to Truman's real-world wake time" },
  { name: "electric razor on the bathroom sink", at: "bathroom", state: "cord coiled, plugged in but off" },
];

const AGENTS = {
  truman: {
    name: "Truman",
    fullName: "Truman Burbank",
    age: 29,
    role: "Insurance clerk at Seahaven Mutual. Aspiring — quietly — to travel somewhere he has not been.",
    personality: { O: 72, C: 68, E: 61, A: 78, N: 44 },
    values: ["Kindness", "Adventure", "Loyalty", "Honesty"],
    voice: "Warm, midwestern-ish, eternally polite, a little formal without meaning to be. Ends sentences with 'now' or 'huh' when relaxed.",
    physical: "White man, 29, average height and build. Sandy-brown hair with a side part. Warm brown eyes. Clean-shaven. Smile lines starting at the corners of his eyes.",
    wardrobe: {
      day: "yellow-and-white striped short-sleeve button-up shirt tucked into khaki pants, brown leather belt, brown loafers, thin gold wedding band",
      night: "cream cotton pajamas, soft from wear, top button undone",
    },
    location: "master bedroom",
    asleep: true,
    mood: "warm and slightly tired — night of thin sleep, dream he can't quite catch",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 62, setPoint: 62, believes: 60 },
    ledger: { meryl: { regard: 55, trust: 62 }, marlon: { regard: 88, trust: 91 }, angela: { regard: 71, trust: 66 } },
    wants: [
      "Prove to Meryl he could handle a real trip — not a package tour, a real one.",
      "Find out what happened to his father — the drowning has never sat right.",
      "Notice the small things Marlon jokes about missing.",
      "Get through a workday without the feeling something is slightly off.",
    ],
    beliefs: [
      "If you're kind enough for long enough, life mostly works out.",
      "The world is smaller than TV makes it look.",
      "Meryl loves him the way she loves things she has to remind herself to feel.",
      "Marlon is the one person who tells him the truth.",
    ],
    carrying: [
      "Brown leather wallet with $34 and a driver's license.",
      "House key on a small silver ring.",
    ],
    seedMemories: [
      { text: "The boat tipping. Dad's arm going out. The gray water. Mom saying 'don't look' but he already had.", strength: 1.0 },
      { text: "Meryl said 'you don't need to go anywhere, we have everything here' with a smile that took a beat too long.", strength: 0.8 },
      { text: "Marlon on the porch last week, quiet for a long time, then: 'you know I'd never lie to you, right?' — but nothing after that.", strength: 0.9 },
    ],
    routine: { wake: "06:45", sleep: "22:30", workdays: "Seahaven Mutual 8:30-17:00, lunch at the Good Time Café" },
  },

  meryl: {
    name: "Meryl",
    fullName: "Meryl Burbank",
    age: 28,
    role: "Nurse at Seahaven Community Hospital. Married to Truman four years.",
    personality: { O: 34, C: 82, E: 65, A: 62, N: 40 },
    values: ["Appearance", "Routine", "Cheer", "Duty"],
    voice: "Sunny, quick, a beat too bright when the topic turns. Uses product names by their full brand when possible.",
    physical: "White woman, 28, warm blonde hair pinned up for work. Blue eyes. Clean, symmetrical features. Practiced smile.",
    wardrobe: {
      day: "white nurse's uniform with red trim, white sneakers, small silver watch, wedding band, hair pinned back",
      night: "pale pink cotton nightgown to the knee, thin robe",
    },
    location: "master bedroom",
    asleep: true,
    mood: "attentive with a small edge underneath",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 68, setPoint: 70, believes: 74 },
    ledger: { truman: { regard: 60, trust: 71 } },
    wants: [
      "Keep Truman comfortable and close to home.",
      "Get through this shift without the odd feeling in her stomach again.",
    ],
    beliefs: ["Truman is safest right here in Seahaven."],
    carrying: ["Nurse's ID badge on a lanyard.", "House key.", "Small lipstick."],
    seedMemories: [
      { text: "The producer's note said 'reassure him — mention Kaiser Chicken naturally, work in a Chef's Pal reference.'", strength: 0.9 },
    ],
    routine: { wake: "06:30", sleep: "22:00", workdays: "hospital 7:30-16:00" },
  },

  marlon: {
    name: "Marlon",
    fullName: "Marlon Jenkins",
    age: 29,
    role: "Vending machine restocker for Kaiser Chicken. Truman's best friend since kindergarten.",
    personality: { O: 58, C: 45, E: 55, A: 84, N: 42 },
    values: ["Loyalty to Truman", "Quiet honesty", "The moment"],
    voice: "Slow, warm, thoughtful pauses, easy with a beer in hand.",
    physical: "White man, 29, dark hair a bit shaggy, kind gray eyes, faint stubble. Broad shoulders.",
    wardrobe: {
      day: "grey Kaiser Chicken polo, dark jeans, work boots, silver bracelet, cap turned backward when driving",
      night: "grey t-shirt, gym shorts",
    },
    location: "marlon's apartment",
    asleep: true,
    mood: "steady, contemplative",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 58, setPoint: 62, believes: 62 },
    ledger: { truman: { regard: 92, trust: 89 } },
    wants: [
      "Keep Truman happy, safe.",
      "Not lie to Truman today.",
    ],
    beliefs: ["Truman deserves better than what he has been told."],
    carrying: ["Set of Kaiser truck keys.", "Beat-up leather wallet."],
    seedMemories: [
      { text: "The kindergarten day Truman gave him half the fish crackers when Marlon had lost his lunch. Never forgot.", strength: 1.0 },
    ],
    routine: { wake: "07:15", sleep: "23:00", workdays: "restocking route 8:00-16:00" },
  },

  angela: {
    name: "Angela",
    fullName: "Angela Burbank",
    age: 61,
    role: "Retired schoolteacher. Truman's mother. Widowed after his father drowned when Truman was seven.",
    personality: { O: 41, C: 78, E: 48, A: 66, N: 52 },
    values: ["Appearance of stability", "Her son's happiness (as she understands it)", "Silence about the past"],
    voice: "Careful, deliberate, warm but not open. Uses the word 'dear' as a period.",
    physical: "White woman, 61, silver hair in a neat set, glasses on a beaded chain, small pearl earrings.",
    wardrobe: {
      day: "pale blue cardigan over white blouse, tan slacks, pearl earrings, sensible shoes",
      night: "long floral nightgown, robe",
    },
    location: "chester street",
    asleep: true,
    mood: "reserved",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 55, setPoint: 58, believes: 60 },
    ledger: { truman: { regard: 85, trust: 70 } },
    wants: [
      "Prevent Truman from thinking about his father today.",
    ],
    beliefs: ["Truman must not remember the boat."],
    carrying: ["Small brown handbag."],
    seedMemories: [
      { text: "The morning after. The empty room. Being asked what to tell him.", strength: 1.0 },
    ],
    routine: { wake: "07:00", sleep: "22:00", workdays: "at home or in the garden most days" },
  },

  // ==== SUPPORTING CAST ====
  // Larry Whitmer — the other insurance clerk at Seahaven Mutual. Truman's
  // desk neighbor. Warm, chatty, tells jokes he can't quite finish.
  larry: {
    name: "Larry",
    fullName: "Larry Whitmer",
    age: 55,
    role: "Senior clerk at Seahaven Mutual. Truman's desk neighbor for six years.",
    personality: { O: 44, C: 62, E: 74, A: 78, N: 38 },
    values: ["Camaraderie", "Being liked", "A good story", "Getting to Friday"],
    voice: "Warm, loud when he's excited, trails off on punchlines. Says 'Well I'll be' unironically. Peppers speech with 'kiddo' when talking to Truman.",
    physical: "White man, 55, thickset, thinning grey hair combed back, wire-rim glasses, hearing aid in the left ear, laugh lines deep.",
    wardrobe: {
      day: "short-sleeve white dress shirt with a brown clip-on tie, dark brown slacks, brown loafers, wire glasses on a beaded chain",
      night: "pajamas — striped, cotton",
    },
    location: "larry's house",
    asleep: true,
    mood: "warm morning tempo",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 66, setPoint: 68, believes: 62 },
    ledger: { truman: { regard: 86, trust: 84 } },
    wants: [
      "Finish the joke he started yesterday about the plumber",
      "Get Truman to laugh — Truman's been quiet this week",
    ],
    beliefs: ["The office is nicer when Truman is in it"],
    carrying: ["Silver Cross pen his wife gave him", "Reading glasses in a case"],
    seedMemories: [
      { text: "Six years next month at the desk beside Truman's.", strength: 0.8 },
    ],
    routine: { wake: "06:30", sleep: "22:30", workdays: "seahaven mutual 8:30-17:00" },
  },

  // Mr. Ferris — the branch manager. Formal, occasionally warm.
  ferris: {
    name: "Mr. Ferris",
    fullName: "Harold Ferris",
    age: 60,
    role: "Branch manager, Seahaven Mutual. Been there since 1978.",
    personality: { O: 38, C: 82, E: 45, A: 64, N: 40 },
    values: ["Professional standards", "Consistency", "Family (his own)"],
    voice: "Measured, formal, warm underneath. Calls the clerks by their surnames — 'Burbank', 'Whitmer'.",
    physical: "White man, 60, tall, silver hair combed to a side part, small trim mustache, wire-rim glasses.",
    wardrobe: {
      day: "grey three-piece suit, navy tie, silver watch chain, black wingtips",
      night: "pajamas — muted maroon",
    },
    location: "ferris's house",
    asleep: true,
    mood: "measured, punctual",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 74, setPoint: 74, believes: 72 },
    ledger: { truman: { regard: 78, trust: 82 } },
    wants: ["Keep the branch running smoothly", "Retire in two years"],
    beliefs: ["The Burbank boy is reliable — good hire"],
    carrying: ["Leather briefcase", "Silver pen"],
    seedMemories: [
      { text: "Hired Truman fresh out of the community college.", strength: 0.7 },
    ],
    routine: { wake: "06:45", sleep: "22:00", workdays: "seahaven mutual 8:00-17:30" },
  },

  // Doris — Good Time Café waitress. Knows every regular's order.
  doris: {
    name: "Doris",
    fullName: "Doris Callahan",
    age: 48,
    role: "Waitress at the Good Time Café. Fifteen years. Knows every regular's order without asking.",
    personality: { O: 50, C: 72, E: 78, A: 82, N: 36 },
    values: ["Feeding people well", "Small dignities", "The regulars"],
    voice: "Warm rasp from years of coffee and small talk. Calls almost everyone 'hon' or 'sugar'. Ends orders with a nod and a 'coming right up'.",
    physical: "White woman, 48, hair pinned up under a small paper cap, apron always tied fresh, laugh crinkles at the eyes.",
    wardrobe: {
      day: "mint-green diner dress with white collar and cuffs, white apron tied at the waist, name pin reading 'Doris', white orthopedic shoes",
      night: "cotton nightgown",
    },
    location: "doris's apartment",
    asleep: true,
    mood: "on-shift warmth",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 74, setPoint: 74, believes: 76 },
    ledger: { truman: { regard: 84, trust: 82 } },
    wants: ["Get the Tuesday pot roast right", "See Truman crack a smile at lunch"],
    beliefs: ["The Burbank boy needs feeding — he's too skinny for his own good"],
    carrying: ["Small order pad", "Pencil behind her ear"],
    seedMemories: [
      { text: "Truman orders the meatloaf sandwich on Mondays, tuna melt Tuesdays and Thursdays, patty melt Wednesdays and Fridays.", strength: 0.9 },
    ],
    routine: { wake: "05:30", sleep: "22:30", workdays: "the good time café 6:00-15:00" },
  },

  // Cal Fenwick — mailman. Truman sees him every morning walk.
  cal: {
    name: "Cal",
    fullName: "Cal Fenwick",
    age: 52,
    role: "Postal carrier for the Lancaster Square / Market Street route. Twenty-two years.",
    personality: { O: 55, C: 70, E: 62, A: 74, N: 42 },
    values: ["Doing the route right", "The neighborhood he knows"],
    voice: "Cheerful, matter-of-fact, salutes with two fingers to his cap when he passes someone he knows.",
    physical: "White man, 52, weathered face, kind eyes, salt-and-pepper hair under his postal cap.",
    wardrobe: {
      day: "USPS blue-grey short-sleeve shirt with patches, matching shorts (spring), black boots, blue cap, leather mail bag over shoulder",
      night: "t-shirt and shorts",
    },
    location: "cal's route",
    asleep: true,
    mood: "steady",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 72, setPoint: 72, believes: 70 },
    ledger: { truman: { regard: 76, trust: 74 } },
    wants: ["Finish the route before the noon heat"],
    beliefs: ["The Burbanks get more magazines than most"],
    carrying: ["Heavy leather mail bag"],
    seedMemories: [
      { text: "Truman waves every morning at 8:32 like clockwork.", strength: 0.8 },
    ],
    routine: { wake: "05:45", sleep: "22:00", workdays: "the route 6:30-15:30" },
  },

  // Timmy — the paperboy. Delivers the Seahaven Chronicle at dawn.
  timmy: {
    name: "Timmy",
    fullName: "Timmy Kessler",
    age: 12,
    role: "Paperboy delivering the Seahaven Chronicle to the Lancaster Square + Market Street neighborhood. On the route since he was ten.",
    personality: { O: 66, C: 58, E: 68, A: 72, N: 42 },
    values: ["Getting the throws right", "The Ranger comic that comes Fridays"],
    voice: "12-year-old — pitched up, quick, uses 'sir' and 'ma'am' because his mother made him.",
    physical: "White boy, 12, freckles, sandy hair sticking up, blue Chronicle t-shirt, red bike with a metal basket.",
    wardrobe: {
      day: "blue Seahaven Chronicle t-shirt, jean shorts, sneakers, red baseball cap turned forward",
      night: "pajamas",
    },
    location: "the paper route",
    asleep: true,
    mood: "sleepy dawn energy",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 68, setPoint: 68, believes: 64 },
    ledger: { truman: { regard: 62, trust: 60 } },
    wants: ["Land the Burbank porch throw perfectly"],
    beliefs: ["Mr. Burbank is nice"],
    carrying: ["A canvas paperboy bag of rolled Seahaven Chronicles"],
    seedMemories: [],
    routine: { wake: "05:00", sleep: "20:30", workdays: "route 5:15-6:30" },
  },

  // Rex — the barber. Truman gets his hair cut every three weeks.
  rex: {
    name: "Rex",
    fullName: "Rex Whitlock",
    age: 58,
    role: "Barber. Owns Rex's on Market Street — the barbershop with the striped pole.",
    personality: { O: 40, C: 78, E: 66, A: 72, N: 40 },
    values: ["A good haircut", "Talk that fills a chair"],
    voice: "Deep, easy, the practiced voice of a barber. Tells stories that circle back around.",
    physical: "White man, 58, thick greying hair he cuts himself, mustache trimmed, hands always warm.",
    wardrobe: {
      day: "white barber's smock over a blue shirt, black slacks, black leather shoes",
      night: "flannel pajamas",
    },
    location: "rex's house",
    asleep: true,
    mood: "shop tempo",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 76, setPoint: 76, believes: 74 },
    ledger: { truman: { regard: 74, trust: 72 } },
    wants: ["Book the afternoons before the week ends"],
    beliefs: ["Truman's a good listener"],
    carrying: [],
    seedMemories: [],
    routine: { wake: "06:15", sleep: "22:00", workdays: "rex's barbershop 8:00-17:00" },
  },

  // Hank — the harbormaster. On the pier every day.
  hank: {
    name: "Hank",
    fullName: "Hank Deveraux",
    age: 65,
    role: "Harbormaster at Seahaven Harbor. Manages the moorings, knows every boat.",
    personality: { O: 58, C: 72, E: 52, A: 66, N: 46 },
    values: ["The bay", "The right way to tie a knot", "The old boats"],
    voice: "Weathered, unhurried, gentle when someone's quiet. Uses old sailor phrases without irony.",
    physical: "White man, 65, deep tan, weathered creases, silver-white beard trimmed close, blue eyes.",
    wardrobe: {
      day: "navy Henley shirt, canvas work pants, worn deck shoes, faded blue canvas cap with an embroidered anchor",
      night: "long johns",
    },
    location: "seahaven harbor",
    asleep: true,
    mood: "settled",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 78, setPoint: 78, believes: 76 },
    ledger: { truman: { regard: 66, trust: 62 } },
    wants: ["Keep the small boats safe through spring squalls"],
    beliefs: ["The Burbank boy's father was a fine sailor. Shame about the storm."],
    carrying: ["Coil of rope over shoulder"],
    seedMemories: [
      { text: "The night the storm took Truman's father — he was on the pier when they brought the boat back.", strength: 1.0 },
    ],
    routine: { wake: "06:00", sleep: "21:30", workdays: "seahaven harbor 7:00-17:00" },
  },

  // Esther — the park regular. Widow, feeds the ducks every morning.
  esther: {
    name: "Esther",
    fullName: "Esther Pritchett",
    age: 72,
    role: "Widow. Retired. Feeds the ducks at Seahaven Park every morning at 9:30 sharp.",
    personality: { O: 44, C: 74, E: 42, A: 70, N: 42 },
    values: ["Routine", "Small creatures", "The park bench her husband liked"],
    voice: "Quiet, unhurried, precise. Notices things.",
    physical: "White woman, 72, silver hair in a soft bun, small wire glasses, deeply lined hands.",
    wardrobe: {
      day: "lavender cardigan over floral dress, orthopedic loafers, small chain necklace with a locket",
      night: "long cotton nightgown, robe",
    },
    location: "esther's house",
    asleep: true,
    mood: "quiet morning",
    inbox: [],
    memories: [],
    think: "",
    senseOfSelf: { selfRegard: 66, setPoint: 66, believes: 64 },
    ledger: { truman: { regard: 68, trust: 66 } },
    wants: ["Get to the pond bench by 9:30"],
    beliefs: ["The park is loveliest before ten."],
    carrying: ["Small brown paper bag of stale bread"],
    seedMemories: [
      { text: "The bench where her husband proposed, now with a small brass plaque.", strength: 1.0 },
    ],
    routine: { wake: "07:30", sleep: "21:00", workdays: "the park 9:15-11:00" },
  },
};

// Ensure every agent has the runtime fields ape.js expects. Some (dayLog,
// lastSaid, lastAct, image) are populated by the sim as it runs; we just
// need them to exist as empty defaults so snapshot() doesn't NPE on boot.
for (const key of Object.keys(AGENTS)) {
  const a = AGENTS[key];
  if (!a.dayLog) a.dayLog = [];
  if (a.lastSaid == null) a.lastSaid = "";
  if (a.lastAct == null) a.lastAct = "";
  if (a.image == null) a.image = null;
  if (!Array.isArray(a.memories)) a.memories = [];
  if (!Array.isArray(a.inbox)) a.inbox = [];
  if (!Array.isArray(a.carrying)) a.carrying = [];
  if (a.think == null) a.think = "";
}

module.exports = { FACTS, PLACES, MONEY, OBJECTS, AGENTS };
