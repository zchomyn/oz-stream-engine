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
  { name: "cornflakes box on the counter, top folded twice", at: "kitchen" },
  { name: "coffee maker with clear glass carafe, half-full", at: "kitchen" },
  { name: "yellow ceramic mug in the sink from yesterday", at: "kitchen" },
  { name: "framed photo of Truman and his father on a small sailboat, on the mantel", at: "living room" },
  { name: "Zenith TV in walnut console, tuned to the morning news", at: "living room" },
  { name: "Reader's Digest and a TV Guide on the coffee table", at: "living room" },
  { name: "yellow rain slicker on a hook by the front door", at: "front hallway" },
  { name: "framed wedding photograph over the master bed", at: "master bedroom" },
  { name: "small blue alarm clock on the nightstand", at: "master bedroom" },
  { name: "electric razor on the bathroom sink, cord coiled", at: "bathroom" },
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
