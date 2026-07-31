// APE ENGINE — Physiological meters
//
// Four numeric meters per character that decay over sim time and get topped up
// by specific acts (eating, drinking, sleeping, showering). Each meter has
// three bands with different beat-pressure intensity. Extreme values (crisis
// band) become MANDATORY pressure the agent turn cannot ignore.
//
// Scale: 0 = fine, 100 = severe. Higher = more urgent.
//
// Design principle from Zack's brief: "why aren't they drinking water, taking
// a snack, cleaning? where are the consequences when they don't?" — meters ARE
// the consequences. Deferred hunger becomes irritability at dinner. Skipped
// showers become self-consciousness on a video call. Chronic low energy
// compounds into snapping at family.

const METER_DEFAULTS = { hunger: 30, thirst: 25, energy: 20, cleanliness: 15 };

// Decay per sim-minute. Sim slot is 15 min, so multiply by 15 for per-slot.
// Numbers tuned so a normal day looks like: wake at 20 → dinner-time ~70 →
// meal drops it back to 15 → bedtime ~35 → sleep restores to 20.
const DECAY_PER_MIN = {
  hunger:      0.06,   // ~5.4/hr; noon = 60 if no breakfast
  thirst:      0.09,   // ~8/hr; empty stomach + morning coffee, spikes fast
  energy:      0.04,   // ~4/hr awake; sleeping RESTORES (see sleepRestore)
  cleanliness: 0.03,   // ~3/hr baseline; work day adds a bigger bump (see below)
};

// Bands (thresholds). Below LOW = fine. LOW-HIGH = noticing. HIGH-CRISIS = urgent. CRISIS+ = mandatory.
const BANDS = {
  hunger:      { low: 40, high: 65, crisis: 85 },
  thirst:      { low: 35, high: 60, crisis: 80 },
  energy:      { low: 45, high: 70, crisis: 85 },
  cleanliness: { low: 40, high: 65, crisis: 85 },
};

function clamp(v) { return Math.max(0, Math.min(100, v)); }

// Initialize meters on a character if not already present.
function ensure(agent) {
  if (!agent.meters) agent.meters = { ...METER_DEFAULTS };
  for (const k of Object.keys(METER_DEFAULTS)) {
    if (agent.meters[k] == null) agent.meters[k] = METER_DEFAULTS[k];
  }
}

// Apply per-slot decay. Skip decay categories when sleeping (energy restores,
// hunger/thirst pause, cleanliness stays roughly steady).
function decay(agent, slotMinutes) {
  ensure(agent);
  const m = agent.meters;
  if (agent.asleep) {
    // Sleep restores energy fast, other meters barely move
    m.energy      = clamp(m.energy - (slotMinutes * 0.4));  // ~24/hr recovery
    m.hunger      = clamp(m.hunger + slotMinutes * 0.01);   // very slow rise
    m.thirst      = clamp(m.thirst + slotMinutes * 0.02);
    m.cleanliness = clamp(m.cleanliness + slotMinutes * 0.005);
    return;
  }
  for (const k of Object.keys(DECAY_PER_MIN)) {
    m[k] = clamp(m[k] + slotMinutes * DECAY_PER_MIN[k]);
  }
}

// Interpret an act and top up meters. Called after dispose so the act's
// realness is confirmed. Returns array of {meter, delta} for logging.
function topupFromAct(agent, act) {
  ensure(agent);
  if (!act || !act.detail) return [];
  const t = act.detail.toLowerCase();
  const changes = [];
  const drop = (meter, amt) => {
    agent.meters[meter] = clamp(agent.meters[meter] - amt);
    changes.push({ meter, delta: -amt });
  };

  // FOOD — hunger down (and thirst mildly if wet food)
  if (/\b(eat|ate|eating|bite|meal|breakfast|lunch|dinner|snack|cereal|toast|sandwich|soup|leftover|pasta|rice|egg|fruit|apple|banana|cheese|yogurt)\b/.test(t)) {
    drop("hunger", 45);
    if (/\b(soup|yogurt|fruit|apple|banana)\b/.test(t)) drop("thirst", 12);
  }

  // DRINK — thirst down (coffee/tea/caffeine also give energy nudge)
  if (/\b(drink|drank|sip|sipped|water|glass of|bottle|refill|hydrate)\b/.test(t)) {
    drop("thirst", 40);
  }
  if (/\b(coffee|espresso|latte|cappuccino|tea|caffeine|energy drink|monster|red bull)\b/.test(t)) {
    drop("thirst", 30);
    drop("energy", 15);
  }

  // SHOWER / WASH — cleanliness down
  if (/\b(shower|showered|showering|bath|bathe|wash|washed|washing) (up|face|hands|off)?\b/.test(t) ||
      /\b(brush|brushed|brushing) (my |his |her )?(teeth|hair)\b/.test(t) ||
      /\bshower\b/.test(t)) {
    if (/\bshower|bath\b/.test(t)) drop("cleanliness", 70);
    else drop("cleanliness", 15);
  }

  // NAP / REST — small energy bump if explicitly resting (sleeping is handled by decay)
  if (/\b(nap|napped|rest|resting|lie down|lay down|couch|close his eyes|close her eyes)\b/.test(t)) {
    drop("energy", 10);
  }

  return changes;
}

// Called when a character's dayLog shows they consumed something during dispose
// even if their own act didn't say so (e.g. Lena poured Marcus coffee).
function topupFromEvent(agent, eventText) {
  ensure(agent);
  const t = eventText.toLowerCase();
  const name = agent.name.toLowerCase().split(" ")[0];
  // Only apply if the character was the receiver
  if (!t.includes(name)) return [];
  return topupFromAct(agent, { detail: eventText });
}

// Which band is a meter currently in?
function band(agent, meter) {
  ensure(agent);
  const v = agent.meters[meter];
  const b = BANDS[meter];
  if (v < b.low) return "fine";
  if (v < b.high) return "noticing";
  if (v < b.crisis) return "urgent";
  return "crisis";
}

// Build the beat-pressure text that goes into the agent turn prompt.
// Only mention meters that are actually pressing. Crisis meters are non-negotiable.
function pressureText(agent) {
  ensure(agent);
  if (agent.asleep) return "";
  const lines = [];
  const m = agent.meters;

  // Hunger
  if (m.hunger >= BANDS.hunger.crisis) {
    lines.push(`HUNGER (crisis): you are painfully hungry. Concentration is shot. This must be resolved this slot — eat something concrete, or the pain colors every thought.`);
  } else if (m.hunger >= BANDS.hunger.high) {
    lines.push(`hunger (urgent): your stomach is empty and it's distracting. If you don't eat within the next slot or two, you'll get snappy.`);
  } else if (m.hunger >= BANDS.hunger.low) {
    lines.push(`hunger (noticing): you're hungry-not-hungry — the edge of it in the background.`);
  }

  // Thirst
  if (m.thirst >= BANDS.thirst.crisis) {
    lines.push(`THIRST (crisis): your mouth is bone-dry, you have a low headache. Get water this slot.`);
  } else if (m.thirst >= BANDS.thirst.high) {
    lines.push(`thirst (urgent): you're actually thirsty — reach for water or coffee this slot or next.`);
  } else if (m.thirst >= BANDS.thirst.low) {
    lines.push(`thirst (noticing): mouth's a bit dry.`);
  }

  // Energy
  if (m.energy >= BANDS.energy.crisis) {
    lines.push(`ENERGY (crisis): you are wrecked. Eyes stinging. Any conversation right now goes badly — you may snap at people you love. Consider rest, caffeine, or ending this activity.`);
  } else if (m.energy >= BANDS.energy.high) {
    lines.push(`energy (urgent): heavily tired. Simple tasks feel like more than they should. Small acts of care come out rougher than intended.`);
  } else if (m.energy >= BANDS.energy.low) {
    lines.push(`energy (noticing): tired around the edges. Not sharp.`);
  }

  // Cleanliness
  if (m.cleanliness >= BANDS.cleanliness.crisis) {
    lines.push(`CLEANLINESS (crisis): you feel physically grimy — smell on your shirt, oil in your hair. Self-conscious in front of anyone. Video call = disaster.`);
  } else if (m.cleanliness >= BANDS.cleanliness.high) {
    lines.push(`cleanliness (urgent): you need a shower. It's starting to show.`);
  } else if (m.cleanliness >= BANDS.cleanliness.low) {
    lines.push(`cleanliness (noticing): a bit gross around the collar and hands.`);
  }

  if (!lines.length) return "";
  return "\nBODILY STATE (feed this honestly into perception, thought, and act):\n" + lines.map((l) => "  - " + l).join("\n");
}

// A compact snapshot for state API + logging.
function snapshot(agent) {
  ensure(agent);
  return {
    hunger: Math.round(agent.meters.hunger),
    thirst: Math.round(agent.meters.thirst),
    energy: Math.round(agent.meters.energy),
    cleanliness: Math.round(agent.meters.cleanliness),
    bands: {
      hunger: band(agent, "hunger"),
      thirst: band(agent, "thirst"),
      energy: band(agent, "energy"),
      cleanliness: band(agent, "cleanliness"),
    },
  };
}

module.exports = { ensure, decay, topupFromAct, topupFromEvent, band, pressureText, snapshot, BANDS };
