// APE ENGINE — Household chores backlog
//
// Household-level (not per-character) state tracking the specific things a
// family lets pile up or handles. Every chore has a "last done" day, a
// staleness function that generates consequence text based on how deferred it
// is, and a top-up detector that matches beat acts to reset it.
//
// Design principle from Zack: "where are the consequences when they choose
// not to do these?" — chores ARE the consequences. Grocery deferred 5 days
// isn't just a number; it's "the fridge is down to eggs, mustard, and a lemon"
// as a specific pressure line in the agent turn prompt. Somebody in the
// family has to attend to it, or Marcus opens the fridge before work and
// there's nothing to pack. That's the friction of a real life.
//
// The list is intentionally SPECIFIC to the Jenkins family in Saint-Henri,
// Montréal, early spring. When we relocate to the Aakres in Truman, MN,
// the chore list swaps: garbage day is different, dépanneur becomes gas
// station, etc.

const HOUSE_KEY = "__house";

// Chore definitions — each with staleness bands and consequence text keyed by
// how many days since last done. `topupPatterns` are regexes matched against
// beat text (acts + events) to detect when a chore is being handled.
const CHORES = {
  groceries: {
    label: "grocery run",
    cadenceDays: 4,      // healthy interval
    startingDaysSince: 2, // where the world begins
    stagesFn: (d) => {
      if (d < 3) return null;
      if (d < 5) return "fridge is getting low — some staples missing (butter running out, no bread, half onion left)";
      if (d < 7) return "fridge is nearly empty — eggs, mustard, half a lemon, some leftover rice, that's about it. Someone needs to go to the Metro before dinner is impossible.";
      return "the family is genuinely out of food. Coffee is done, no milk, no bread. This is a crisis — someone must go to the store this beat or the family goes hungry.";
    },
    topupPatterns: [
      /\b(went|come home) from (the )?(metro|grocery|dépanneur|corner store|maxi)\b/i,
      /\bgroceries?\b.*\b(bag|carry|unload|put away)\b/i,
      /\b(unpack|unload|put away)\b.*\b(groceries|the shopping|the bag)\b/i,
    ],
    handledCost: 60,     // $60 average grocery run, drawn from checking
  },

  laundry: {
    label: "laundry",
    cadenceDays: 3,
    startingDaysSince: 1,
    stagesFn: (d) => {
      if (d < 3) return null;
      if (d < 5) return "laundry pile in the basket is high — Theo is running out of clean joggers, Marcus's work shirts are down to two";
      if (d < 7) return "laundry has taken over the bedroom floor. Marcus is wearing yesterday's shirt to the depot. Kari's favorite work top is dirty.";
      return "no clean underwear situation. Someone is doing an emergency wash cycle tonight or facing a hard morning.";
    },
    topupPatterns: [
      /\b(load|start|run|put in|switch|fold|folding|put away) (a load of )?(laundry|wash|the whites|the darks|clothes)\b/i,
      /\b(washer|dryer|laundromat)\b.*\b(load|start|run|switch)\b/i,
    ],
  },

  garbage: {
    label: "garbage / recycling to the curb",
    cadenceDays: 3,   // Tuesday and Friday pickup in Saint-Henri
    startingDaysSince: 1,
    stagesFn: (d) => {
      if (d < 2) return null;
      if (d < 4) return "garbage bag under the sink is full — starting to smell. Tomorrow's collection day.";
      if (d < 6) return "bag hasn't been taken out. Kitchen smells. Collection day was missed and it's another 2 days.";
      return "raccoons got into the porch bag last night. There's a mess to clean before Kari sees it.";
    },
    topupPatterns: [
      /\b(take|took|taking|drag|dragged) (the )?(bag|garbage|trash|recycling|bin)\b.*\b(out|to the curb|to the porch|down)\b/i,
      /\bcurb\b.*\b(garbage|trash|bag|bin|recycling)\b/i,
    ],
  },

  hallway_bulb: {
    label: "burnt-out hallway bulb",
    cadenceDays: 999,  // one-shot chore; once done, done
    startingDaysSince: 4,  // has been out for four days
    stagesFn: (d) => {
      if (d < 3) return null;
      if (d < 6) return "the hallway bulb between the bedrooms has been out for days. Every trip to the bathroom at night is by phone flashlight.";
      if (d < 10) return "still no bulb. Kari almost tripped on Theo's boots at 2am. It's become the thing that isn't getting done.";
      return "the bulb has been out over a week. It's a symbol of drift now. Someone should just do it.";
    },
    topupPatterns: [
      /\b(change|changed|swap|swapped|replace|replaced|screw|screwed in) (the |a )?(bulb|light bulb|hallway light)\b/i,
    ],
  },

  sister_text: {
    label: "unanswered text from Marcus's sister Christine",
    cadenceDays: 999,  // one-shot until Christine sends again
    startingDaysSince: 3,
    stagesFn: (d) => {
      if (d < 2) return null;
      if (d < 5) return "Christine texted Marcus three days ago and he hasn't replied. It's sitting on his phone, unread badge glowing every time he looks. He knows he needs to send something.";
      if (d < 9) return "Christine's text is now over a week old. Marcus feels guilty every time he sees his phone. His sister is going to be quietly hurt.";
      return "Marcus's silence with Christine is now a thing. She's stopped expecting a reply. That's worse than a fight.";
    },
    topupPatterns: [
      /\b(text|texted|reply|replied|write|wrote back)\b.*\b(christine|his sister|my sister)\b/i,
      /\bmarcus\b.*\b(sister|christine)\b.*\b(text|reply|message)\b/i,
    ],
    onlyOwnedBy: "marcus",  // this chore is Marcus-specific
  },

  hydro_bill: {
    label: "the hydro bill on the microwave",
    cadenceDays: 999,
    startingDaysSince: 2,
    stagesFn: (d) => {
      if (d < 3) return null;
      if (d < 6) return "the paper hydro bill has been sitting under the green magnet by the microwave for days. Nobody wants to open it.";
      if (d < 10) return "the bill is still there, still unopened. Marcus checks around it every morning like it's radioactive.";
      return "the auto-pay date hits tomorrow. If Marcus hasn't done the math on it by then, the account overdrafts.";
    },
    topupPatterns: [
      /\b(open|opened|paid|pay|check|checked|look at|opens) (the |that )?(hydro bill|hydro|utility bill|bill)\b/i,
    ],
  },
};

// Ensure the household chore state exists in W.
function ensure(W) {
  if (!W.__chores) {
    W.__chores = {};
    for (const [id, def] of Object.entries(CHORES)) {
      W.__chores[id] = { lastDoneDay: W.day - def.startingDaysSince };
    }
  }
}

// Days since a chore was last handled.
function daysSince(W, id) {
  ensure(W);
  return Math.max(0, W.day - (W.__chores[id]?.lastDoneDay ?? W.day));
}

// Try to detect chore top-ups from a text (an act or event). Returns array of
// chore ids that were handled.
function topupFromText(W, text, actorFirstName) {
  ensure(W);
  if (!text) return [];
  const handled = [];
  for (const [id, def] of Object.entries(CHORES)) {
    if (def.onlyOwnedBy && def.onlyOwnedBy !== actorFirstName) continue;
    for (const rx of def.topupPatterns) {
      if (rx.test(text)) {
        W.__chores[id].lastDoneDay = W.day;
        handled.push(id);
        // Grocery run costs money
        if (id === "groceries" && def.handledCost) {
          W.money.checking = Math.round((W.money.checking - def.handledCost) * 100) / 100;
        }
        break;
      }
    }
  }
  return handled;
}

// Build the pressure text for a specific character. For most chores it's
// household-wide (any adult can act); for chores with `onlyOwnedBy` it only
// pressures that character.
function pressureText(W, agentFirstName) {
  ensure(W);
  const lines = [];
  for (const [id, def] of Object.entries(CHORES)) {
    if (def.onlyOwnedBy && def.onlyOwnedBy !== agentFirstName) continue;
    const d = daysSince(W, id);
    const consequence = def.stagesFn(d);
    if (consequence) lines.push(`  - ${consequence}`);
  }
  if (!lines.length) return "";
  return "\nHOUSEHOLD BACKLOG (specific things this household is behind on — attend to one if the moment fits, or defer with awareness):\n" + lines.join("\n");
}

// Snapshot for state API / cockpit display
function snapshot(W) {
  ensure(W);
  const out = {};
  for (const [id, def] of Object.entries(CHORES)) {
    const d = daysSince(W, id);
    out[id] = {
      label: def.label,
      daysSince: d,
      stage: def.stagesFn(d),
      urgent: !!def.stagesFn(d),
    };
  }
  return out;
}

module.exports = { ensure, daysSince, topupFromText, pressureText, snapshot, CHORES };
