// APE STREAM ENGINE — Household chores backlog
//
// Household-level (not per-character) state tracking the specific things the
// Burbank household lets pile up or handles. Every chore has a "last done"
// day, a staleness function that generates consequence text based on how
// deferred it is, and a top-up detector that matches beat acts to reset it.
//
// Design principle: chores ARE the consequences of an ordinary life. Grocery
// deferred 5 days isn't just a number; it's "the fridge is down to eggs,
// mustard, and a lemon" as a specific pressure line in the agent turn
// prompt. Someone in the household has to attend to it, or Truman opens the
// fridge before work and there's nothing to pack. That's the friction of a
// real, ordinary day.
//
// Specific to the Burbank household — Truman and Meryl, Seahaven.

const HOUSE_KEY = "__house";

const CHORES = {
  groceries: {
    label: "grocery run",
    cadenceDays: 4,
    startingDaysSince: 2,
    stagesFn: (d) => {
      if (d < 3) return null;
      if (d < 5) return "fridge is getting low — some staples missing (butter running low, no fresh bread, half an onion left)";
      if (d < 7) return "fridge is nearly empty — eggs, mustard, half a lemon, some leftover rice, that's about it. Someone needs to go to Seahaven Grocers before dinner is impossible.";
      return "the house is genuinely out of food. Coffee is done, no milk, no bread. This is a crisis — someone must go to the store this beat or supper doesn't happen.";
    },
    topupPatterns: [
      /\b(went|come home) from (the )?(seahaven grocers|the store|the grocer)\b/i,
      /\bgroceries?\b.*\b(bag|carry|unload|put away)\b/i,
      /\b(unpack|unload|put away)\b.*\b(groceries|the shopping|the bag)\b/i,
    ],
    handledCost: 24,
  },

  laundry: {
    label: "laundry",
    cadenceDays: 3,
    startingDaysSince: 1,
    stagesFn: (d) => {
      if (d < 3) return null;
      if (d < 5) return "laundry basket is getting full — Truman's down to his last two clean work shirts";
      if (d < 7) return "laundry has piled up on the bedroom chair. Truman's wearing yesterday's shirt to the office. Meryl's uniform whites are in the hamper.";
      return "no clean shirt situation. Someone is doing an emergency wash tonight or Truman faces a hard morning.";
    },
    topupPatterns: [
      /\b(load|start|run|put in|switch|fold|folding|put away) (a load of )?(laundry|wash|the whites|the darks|clothes)\b/i,
      /\b(washer|dryer|laundromat|clothesline)\b.*\b(load|start|run|switch|hang)\b/i,
    ],
  },

  garbage: {
    label: "garbage / recycling to the curb",
    cadenceDays: 3,
    startingDaysSince: 1,
    stagesFn: (d) => {
      if (d < 2) return null;
      if (d < 4) return "garbage bag under the sink is full — starting to smell. Tomorrow's collection day.";
      if (d < 6) return "bag hasn't been taken out. Kitchen smells faintly. Collection day was missed and it's another two days.";
      return "the bag by the back step has been sitting too long. Something got into it overnight — a mess to clean before Meryl sees it.";
    },
    topupPatterns: [
      /\b(take|took|taking|drag|dragged) (the )?(bag|garbage|trash|recycling|bin)\b.*\b(out|to the curb|to the porch|down)\b/i,
      /\bcurb\b.*\b(garbage|trash|bag|bin|recycling)\b/i,
    ],
  },

  hallway_bulb: {
    label: "burnt-out hallway bulb",
    cadenceDays: 999,
    startingDaysSince: 4,
    stagesFn: (d) => {
      if (d < 3) return null;
      if (d < 6) return "the front hallway bulb has been out for days. Every trip through at night is by feel.";
      if (d < 10) return "still no bulb. Meryl nearly caught her stocking on the hallway table edge in the dark. It's become the thing that isn't getting done.";
      return "the bulb has been out over a week. Someone should just do it.";
    },
    topupPatterns: [
      /\b(change|changed|swap|swapped|replace|replaced|screw|screwed in) (the |a )?(bulb|light bulb|hallway light)\b/i,
    ],
  },

  mother_visit: {
    label: "Truman hasn't been to see his mother",
    cadenceDays: 999,
    startingDaysSince: 3,
    stagesFn: (d) => {
      if (d < 4) return null;
      if (d < 8) return "Truman hasn't been by his mother Angela's on Chester Street in a while. She hasn't said anything, but he knows.";
      if (d < 14) return "it's been over a week since he's seen his mother. She mentioned it once, lightly, the way she does when she means it.";
      return "Truman's mother has stopped mentioning it. That's worse than if she'd said something.";
    },
    topupPatterns: [
      /\b(visit|visited|see|saw|stopped by|dropped by)\b.*\b(his mother|angela|mom)\b/i,
      /\bangela\b.*\b(visit|came by|stopped by)\b/i,
    ],
    onlyOwnedBy: "truman",
  },

  electric_bill: {
    label: "the electric bill on the counter",
    cadenceDays: 999,
    startingDaysSince: 2,
    stagesFn: (d) => {
      if (d < 3) return null;
      if (d < 6) return "the paper electric bill has been sitting under the fruit bowl for days. Nobody's opened it.";
      if (d < 10) return "the bill is still there, still unopened. Truman checks around it every morning like it's radioactive.";
      return "the due date is tomorrow. If nobody's dealt with it by then, there's a late fee.";
    },
    topupPatterns: [
      /\b(open|opened|paid|pay|check|checked|look at|opens) (the |that )?(electric bill|the bill|utility bill)\b/i,
    ],
  },
};

function ensure(W) {
  if (!W.__chores) {
    W.__chores = {};
    for (const [id, def] of Object.entries(CHORES)) {
      W.__chores[id] = { lastDoneDay: W.day - def.startingDaysSince };
    }
  }
}

function daysSince(W, id) {
  ensure(W);
  return Math.max(0, W.day - (W.__chores[id]?.lastDoneDay ?? W.day));
}

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
        if (id === "groceries" && def.handledCost) {
          W.money.checking = Math.round((W.money.checking - def.handledCost) * 100) / 100;
        }
        break;
      }
    }
  }
  return handled;
}

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
  return "\nHOUSEHOLD BACKLOG (specific things this household is behind on — attend to one if the moment fits, or defer with awareness; not every turn needs to address these):\n" + lines.join("\n");
}

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
