// APE STREAM ENGINE — stream director.
//
// The auto-capture worker doesn't just pick "whoever's awake"; it consults
// this director to pick THE most showable subject right now. This is what
// separates "surveillance footage" from "a show." Truman touching his collar
// for the 5th time is boring; Truman handing money to Doris across the
// counter is interesting.
//
// Scoring rules (rule-based v1):
//
//   +20  subject is with another named character (an interaction is possible)
//   +15  subject's lastAct mentions a specific object interaction (touch, hold,
//        pick up, drink, read, hand, take, give, open, close)
//   +12  subject has a fresh spoken line (lastSaid populated and non-trivial)
//   +8   subject is in a public location (café, office, park, harbor) — town life
//   +5   subject is Truman (still the hero)
//   -25  same subject was captured in the last 3 frames
//   -15  subject's lastAct is nearly identical to the previous capture
//   -30  subject is asleep
//
// Return the highest-scoring viable subject. Ties broken by preferring Truman
// then most recently updated.
//
// Called from ape.js auto-capture loop before each render.

const INTERESTING_ACTIONS = [
  "touch", "hold", "pick up", "drink", "read", "hand", "take", "give",
  "open", "close", "pour", "sip", "shake", "wave", "walk in", "walk out",
  "arrive", "greet", "hug", "kiss", "point", "reach", "answer", "ring",
  "knock", "sit", "stand", "lean", "unfold", "set down", "lift",
];

const PUBLIC_LOCATIONS = [
  "the good time café", "seahaven mutual", "seahaven park",
  "seahaven harbor", "market street", "grocery", "rex's barbershop",
];

// Keywords we track for cross-subject rate limiting. If any of these appears
// in 3+ of the recent captures, penalize new captures that mention them.
// This is what stops "Truman pours coffee, then Larry pours coffee, then
// Doris pours coffee" — the whole world converging on the same beat.
const RATE_LIMITED_KEYWORDS = [
  "coffee", "carafe", "mug", "pour",
  "coat", "jacket", "slicker", "hook",
  "shave", "razor",
  "newspaper", "chronicle",
  "cereal", "cornflakes",
  "wallet", "keys",
  "collar", "tie",
];

function scoreSubject(agent, key, W, recentCaptures) {
  if (agent.asleep) return -30;
  let score = 0;
  const loc = String(agent.location || "").toLowerCase();
  const act = String(agent.lastAct || "").toLowerCase();
  const said = String(agent.lastSaid || "").trim();

  // Is there anyone else in the same location? Interaction possibility.
  const roommates = Object.entries(W.agents).filter(([k, a]) =>
    k !== key && !a.asleep && String(a.location || "").toLowerCase() === loc
  );
  if (roommates.length > 0) score += 20;

  // Object interaction words
  if (INTERESTING_ACTIONS.some((w) => act.includes(w))) score += 15;

  // Fresh spoken line
  if (said && said.length > 6) score += 12;

  // Public location = town texture
  if (PUBLIC_LOCATIONS.some((p) => loc.includes(p))) score += 8;

  // Truman is the hero
  if (key === "truman") score += 5;

  // Anti-repetition: if this subject was captured recently, penalize
  const recentSameSubj = recentCaptures.filter((r) => r.subjectKey === key).length;
  if (recentSameSubj >= 2) score -= 25;

  // Anti-repetition: if the current lastAct matches a recent capture's, hard penalty
  const actNormalized = act.replace(/[^a-z ]/g, "").trim();
  if (actNormalized && recentCaptures.some((r) => r.actNormalized === actNormalized)) {
    score -= 15;
  }

  // Cross-subject rate limit: if any tracked keyword appears in >=3 recent
  // captures AND the current subject's action mentions it, HEAVY penalty.
  // This stops the world from converging on one beat across all subjects.
  for (const kw of RATE_LIMITED_KEYWORDS) {
    if (!act.includes(kw)) continue;
    const recentHits = recentCaptures.filter((r) => r.actNormalized.includes(kw)).length;
    if (recentHits >= 3) score -= 40;
    else if (recentHits >= 2) score -= 20;
    else if (recentHits >= 1) score -= 8;
  }

  return score;
}

// Choose the next subject to capture. Returns { key, agent } or null.
//   W: world state
//   recentCaptures: array of { subjectKey, actNormalized } from the last ~5
//     buffer entries. This is what enforces variety.
function pickNextSubject(W, recentCaptures = []) {
  const candidates = Object.entries(W.agents).map(([key, agent]) => ({
    key, agent, score: scoreSubject(agent, key, W, recentCaptures),
  })).filter((c) => c.score > -20);

  if (!candidates.length) return null;

  // Story engine: boost candidates that intersect with active narrative
  // threads. Failing silently if the story engine isn't ready.
  try {
    const ape = require("./ape");
    const SE = ape.getStoryEngine ? ape.getStoryEngine() : null;
    if (SE) {
      const enriched = candidates.map((c) => ({
        subjectKey: c.key,
        actNormalized: String(c.agent.lastAct || "").toLowerCase().replace(/[^a-z ]/g, "").trim(),
        location: c.agent.location,
      }));
      const curated = SE.curateFor(enriched);
      for (let i = 0; i < candidates.length; i++) {
        candidates[i].score += curated[i].storyBonus || 0;
        candidates[i].storyBonus = curated[i].storyBonus || 0;
      }
    }
  } catch (_) { /* story engine not ready; proceed unweighted */ }

  // Sort highest first, then Truman-preferred at ties, then whoever was
  // updated most recently (dayLog longest = most active this day).
  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.key === "truman" && b.key !== "truman") return -1;
    if (b.key === "truman" && a.key !== "truman") return 1;
    return (b.agent.dayLog?.length || 0) - (a.agent.dayLog?.length || 0);
  });

  // Take from the top, but with a little randomness so we get variety even
  // when scores are close. Top 3 candidates weighted by score.
  const top = candidates.slice(0, 3);
  const total = top.reduce((s, c) => s + Math.max(1, c.score), 0);
  let r = Math.random() * total;
  for (const c of top) {
    r -= Math.max(1, c.score);
    if (r <= 0) return c;
  }
  return top[0];
}

// Build the recentCaptures summary array from a list of buffer meta objects.
// Helper for the auto-capture loop to feed in the last N meta entries.
function summarizeRecent(recentMetas) {
  return (recentMetas || []).map((m) => ({
    subjectKey: (m.subject || "").toLowerCase().split(/\s+/)[0],
    actNormalized: String((m.activityLines || [])[0] || "")
      .toLowerCase().replace(/[^a-z ]/g, "").trim(),
  }));
}

module.exports = { pickNextSubject, summarizeRecent, INTERESTING_ACTIONS, PUBLIC_LOCATIONS };
