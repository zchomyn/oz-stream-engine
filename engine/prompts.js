// APE ENGINE — prompts & schemas
// All model-facing text lives here so tuning never touches engine mechanics.

// ---- Writing rules (adapted from petergyang/no-ai-slop, MIT) ----
// Applied to inner voice, dialogue, memories, and copy. Character voice is allowed
// to be messy; it is not allowed to be slop.
const STYLE_RULES = `WRITING RULES (hard requirements):
- Concrete over abstract. Objects, names, numbers, sensations. "The rent line on the spreadsheet" not "financial pressures."
- Banned words: delve, foster, leverage, utilize, empower, streamline, robust, tapestry, realm, beacon, multifaceted, meticulous, paramount, transformative, elevate, embark, journey, testament, vibrant, bustling.
- No binary contrasts ("It's not X, it's Y"). No importance puffery ("a pivotal moment"). No colon reveals. No "little did he know."
- No trailing -ing analysis clauses ("...highlighting his commitment").
- People think in fragments and specifics, not in essays. Vary sentence length. One thought can trail off.
- Dialogue: people interrupt, understate, deflect, answer a different question than the one asked. A 9-year-old sounds nine, not like a wise screenwriter's device.
- Never narrate emotions by name when behaviour can carry them ("he rinsed the same plate twice" beats "he felt anxious").`;

const FACT_RULES = (facts) => `IMMUTABLE FACTS (violating any of these is an error):
${facts.map((f) => "- " + f).join("\n")}`;

// ---- Schemas (Gemini structured output) ----
const S = { OBJ: "OBJECT", ARR: "ARRAY", STR: "STRING", INT: "INTEGER", NUM: "NUMBER", BOOL: "BOOLEAN" };

const AGENT_TURN_SCHEMA = {
  type: S.OBJ,
  properties: {
    perceptions: {
      type: S.ARR,
      items: {
        type: S.OBJ,
        properties: {
          event_index: { type: S.INT },
          memory: { type: S.STR, description: "How THIS person will remember it — their emphasis, their distortion. First person." },
          ledger_deltas: {
            type: S.ARR,
            items: {
              type: S.OBJ,
              properties: {
                who: { type: S.STR },
                regard_delta: { type: S.INT, description: "-10..10" },
                trust_delta: { type: S.INT, description: "-30..3. Trust climbs by inches, falls off a cliff." },
                is_betrayal: { type: S.BOOL },
              },
              required: ["who", "regard_delta", "trust_delta", "is_betrayal"],
            },
          },
          self_appraisal_delta: { type: S.INT, description: "-3..3 shift in how they think the family sees them" },
          stress_delta: { type: S.INT, description: "-15..15" },
        },
        required: ["event_index", "memory", "ledger_deltas", "self_appraisal_delta", "stress_delta"],
      },
    },
    think: { type: S.STR, description: "Inner voice, reaches no one. Runs before the act. Length matches personality: impulsive=short, anxious=looping." },
    act: {
      type: S.OBJ,
      properties: {
        kind: { type: S.STR, description: "one of: talk | move | use | text | none" },
        detail: { type: S.STR, description: "talk: the exact words said aloud. use: what they physically do with what object. move: why. text: exact message text. none: what stillness looks like." },
        target_person: { type: S.STR, description: "for talk (addressee) or text (recipient), else empty" },
        destination: { type: S.STR, description: "for move: a real room or place, else empty" },
        object: { type: S.STR, description: "for use: an object actually present, else empty" },
        spend: { type: S.NUM, description: "dollars spent this act, 0 if none" },
      },
      required: ["kind", "detail", "target_person", "destination", "object", "spend"],
    },
    advanced_want_index: { type: S.INT, description: "index of the want this act advances, or -1" },
    mood: { type: S.STR, description: "two or three plain words" },
  },
  required: ["perceptions", "think", "act", "advanced_want_index", "mood"],
};

const DISPOSE_SCHEMA = {
  type: S.OBJ,
  properties: {
    events: {
      type: S.ARR,
      items: {
        type: S.OBJ,
        properties: {
          location: { type: S.STR },
          text: { type: S.STR, description: "Objective, camera-neutral description. No interiority — the ground truth log." },
          actors: { type: S.ARR, items: { type: S.STR } },
          kind: { type: S.STR, description: "action | talk | ambient | arrival | departure" },
          topic: { type: S.STR, description: "2-4 word compact subject tag for the fixation detector, e.g. 'coffee maker leak', 'captain the goldfish', 'ankylosaurus poster', 'bakery mark deadline', 'controller grip'. Same topic across multiple beats = character is dwelling; different topics = the beat moves." },
        },
        required: ["location", "text", "actors", "kind", "topic"],
      },
    },
    object_changes: {
      type: S.ARR,
      items: {
        type: S.OBJ,
        properties: { op: { type: S.STR, description: "move|add|remove" }, object: { type: S.STR }, to: { type: S.STR } },
        required: ["op", "object", "to"],
      },
    },
    money_delta: { type: S.NUM },
    money_note: { type: S.STR },
    rejected: {
      type: S.ARR,
      items: { type: S.OBJ, properties: { actor: { type: S.STR }, reason: { type: S.STR } }, required: ["actor", "reason"] },
    },
  },
  required: ["events", "object_changes", "money_delta", "money_note", "rejected"],
};

const REFLECT_SCHEMA = {
  type: S.OBJ,
  properties: {
    reflection: { type: S.STR },
    beliefs: { type: S.ARR, items: { type: S.STR }, description: "2-6 belief statements, updated. Beliefs harden from repeated memories." },
    wants: { type: S.ARR, items: { type: S.STR }, description: "2-4 wants for tomorrow, ranked, most pressing first" },
    memory_edits: {
      type: S.ARR,
      items: { type: S.OBJ, properties: { index: { type: S.INT }, new_text: { type: S.STR } }, required: ["index", "new_text"] },
      description: "Up to 2 memories that consolidation quietly rewrites — sharpen the feeling, blur the fact.",
    },
  },
  required: ["reflection", "beliefs", "wants", "memory_edits"],
};

const DIRECTOR_SCHEMA = {
  type: S.OBJ,
  properties: {
    has_highlight: { type: S.BOOL },
    title: { type: S.STR },
    why: { type: S.STR, description: "one line: why a documentary crew keeps this" },
    actors: { type: S.ARR, items: { type: S.STR } },
    location: { type: S.STR },
    verbatim_lines: { type: S.ARR, items: { type: S.STR }, description: "the actual words from the log, unchanged" },
    interior_line: { type: S.STR, description: "one think-channel line that gives the gap between mind and mouth" },
    novelty_topic: { type: S.STR, description: "3-5 word signature: actors+theme, for the novelty gate" },
  },
  required: ["has_highlight", "title", "why", "actors", "location", "verbatim_lines", "interior_line", "novelty_topic"],
};

const SHOTS_SCHEMA = {
  type: S.OBJ,
  properties: {
    shots: {
      type: S.ARR,
      items: {
        type: S.OBJ,
        properties: { label: { type: S.STR }, prompt: { type: S.STR } },
        required: ["label", "prompt"],
      },
    },
    quote: { type: S.STR, description: "the single verbatim line that should sit under the storyboard" },
  },
  required: ["shots", "quote"],
};

// ---- Prompt builders ----

function oceanLine(p) {
  const d = (v, lo, hi) => (v >= 66 ? hi : v <= 33 ? lo : null);
  const bits = [
    d(p.O, "concrete-minded", "imaginative"), d(p.C, "scattered", "disciplined"),
    d(p.E, "inward", "outgoing"), d(p.A, "guarded", "warm"), d(p.N, "steady", "anxiety runs the engine"),
  ].filter(Boolean);
  return bits.join(", ") || "even-keeled";
}

function agentTurnPrompt(w, agent, sceneEvents, ctx) {
  const mems = ctx.topMemories.map((m, i) => `  ${i}. ${m.text}`).join("\n");
  const ledger = Object.entries(agent.ledger)
    .map(([k, v]) => `  ${w.agents[k] ? w.agents[k].name : k}: regard ${v.regard}, trust ${v.trust}`).join("\n");
  const here = ctx.presentNames.length ? ctx.presentNames.join(", ") : "no one else";
  const nearby = (ctx.audiblyNearby || []).length ? "\nAudibly nearby (you can hear them, might call to them, might join them): " + ctx.audiblyNearby.join("; ") : "";
  const objs = ctx.objectsHere.length ? ctx.objectsHere.join("; ") : "nothing notable";
  const inbox = agent.inbox.length
    ? `TEXTS JUST DELIVERED (no tone, no face — read them through your own lens):\n${agent.inbox.map((t) => `  from ${t.from}: "${t.text}"`).join("\n")}`
    : "";
  const events = sceneEvents.length
    ? `WHAT JUST HAPPENED WHERE YOU ARE (perceive each through your personality — your memory of it will not be neutral):\n${sceneEvents.map((e, i) => `  [${i}] ${e.text}`).join("\n")}`
    : "WHAT JUST HAPPENED: a quiet stretch. Nothing external. (Empty perceptions array is correct; the mind still runs.)";

  return `${STYLE_RULES}

${FACT_RULES(w.facts)}

YOU ARE ${agent.name.toUpperCase()}, ${agent.age}. ${agent.role}.
Personality lens: ${oceanLine(agent.personality)} (O${agent.personality.O} C${agent.personality.C} E${agent.personality.E} A${agent.personality.A} N${agent.personality.N})
Voice: ${agent.voice}
Values, ranked: ${agent.values.join(" > ")}
Mood: ${agent.mood}. ${agent.asleep ? "You are asleep." : ""}
Sense of self: you privately rate yourself ${agent.senseOfSelf.selfRegard}/100. You believe the family sees you at about ${agent.senseOfSelf.believes}/100. (You cannot see their real numbers.)

YOUR PRIVATE LEDGER (one-way; theirs may be nothing like yours):
${ledger}

BELIEFS (the lens hardens):
${agent.beliefs.map((b) => "  - " + b).join("\n")}

MEMORIES SURFACING NOW (recalling them is re-perceiving them):
${mems}

WANTS, ranked:
${agent.wants.map((g, i) => `  ${i}. ${g}`).join("\n")}

NOW: Day ${ctx.day}, ${ctx.clock}. You are in the ${agent.location}. Present: ${here}. Objects here: ${objs}.${nearby}
${ctx.envLine}${ctx.loopNote || ""}
${ctx.storyPressure ? "\n" + ctx.storyPressure + "\n" : ""}${ctx.ritualPressure ? "\n" + ctx.ritualPressure + "\n" : ""}${ctx.meterPressure || ""}${ctx.chorePressure || ""}
${ctx.locationContext ? "\n" + ctx.locationContext + "\n" : ""}${ctx.campaignContext ? "\n" + ctx.campaignContext + "\n" : ""}
${inbox}
${events}

Do this in order:
1. PERCEIVE each indexed event above (and each delivered text) as ${agent.name} would — memory in your words, ledger deltas for people involved, a self-appraisal shift, a stress shift. The same dinner becomes three different evenings; write yours.
2. THINK — the inner voice. It reaches no one. Your worry loops on what you VALUE most, not on what is loudest.
3. ACT — one act: talk (exact words, someone present), move (a real room), use (an object actually here), text (exact words to one person anywhere; it arrives on their next turn, toneless), or none. Small and true beats dramatic. You cannot spend money you don't believe you have.`;
}

function disposePrompt(w, proposals, ctx) {
  return `You are the WORLD of a domestic simulation. Not a narrator — a physics engine with a notebook.

${FACT_RULES(w.facts)}

GROUND TRUTH RIGHT NOW: Day ${ctx.day}, ${ctx.clock}. ${ctx.envLine}
Checking account: $${w.money.checking}. ${w.money.note}
Objects: ${w.objects.map((o) => `${o.name} (${o.at})`).join("; ")}
Locations of people: ${ctx.locLine}

PROPOSED ACTS THIS SLOT:
${proposals.map((p) => `  - ${p.name} (in ${p.location}): [${p.act.kind}] ${p.act.detail}${p.act.spend ? ` (wants to spend $${p.act.spend})` : ""}`).join("\n")}

Resolve the slot:
- Decide what actually happens. Acts can FAIL for physical reasons (object missing, person absent, not enough money). Reject anything referencing people or facts that don't exist.
- Emit objective events per location: camera-neutral prose, exact spoken words preserved in quotes, no interiority. People in the same room witness each other's acts. Arrivals and departures are visible; paths are private.
- Move/add/remove objects as acts require. Track money precisely.
- When an act inspects something the world tracks (the bank balance, a bill, a due date), the resulting event MUST state the true figure from GROUND TRUTH above, verbatim (e.g. "The banking app shows a balance of $1,356."). People learn real numbers only this way — never let an invented figure stand in an event.
- Roughly every few slots, one small ambient event is welcome (radiator clank, phone buzz from an unknown number, rain against the canal-side windows) — Montréal, early spring, thoughtfully-designed Saint-Henri flat. Never demanding twice in a row.
${ctx.injectionLine}`;
}

function reflectPrompt(w, agent, dayMemories) {
  return `${STYLE_RULES}

You are ${agent.name}, ${agent.age}. ${agent.voice}
Personality: ${oceanLine(agent.personality)}. Values: ${agent.values.join(" > ")}.
It is night. The day settles. This is consolidation, not conversation.

CURRENT BELIEFS:
${agent.beliefs.map((b) => "  - " + b).join("\n")}
TODAY, AS YOU REMEMBER IT:
${dayMemories.map((m, i) => `  ${i}. ${m.text}`).join("\n")}
CURRENT WANTS:
${agent.wants.map((g) => "  - " + g).join("\n")}

Nightly reflection: one honest paragraph in your inner voice. Then updated beliefs (repeated experience hardens into belief; contradicted belief cracks slowly, not instantly). Then tomorrow's wants, re-ranked by what today actually did to you. Optionally rewrite up to 2 of today's memories the way sleep does — the feeling sharpens, the detail blurs.`;
}

function directorPrompt(recentEvents, thinks, previousTopics) {
  return `You are the DIRECTOR pass of a documentary about one family. You watch the raw log and keep almost nothing.

RAW OBJECTIVE LOG (recent):
${recentEvents.map((e) => `  [${e.location}] ${e.text}`).join("\n")}

INTERIOR CHANNEL (what they thought, which the camera can't see):
${thinks.map((t) => `  ${t.who}: ${t.text}`).join("\n")}

ALREADY-KEPT TOPICS (novelty gate — a repeat must clearly ESCALATE to earn a slot):
${previousTopics.length ? previousTopics.map((t) => "  - " + t).join("\n") : "  (none yet)"}

Keep at most ONE moment, only if a documentary editor would fight for it: a gap between what was said and what was meant, a small act that costs someone something, a child's question landing where it shouldn't. Routine is not a highlight. If nothing earns it, has_highlight=false — that is the common, correct answer.`;
}

function shotsPrompt(spark, grammar, w) {
  return `Storyboard a captured documentary moment as 4 stills. Shot grammar this time: ${grammar}.

THE MOMENT: "${spark.title}" — ${spark.why}
Location: ${spark.location} of a cluttered 90s-trim rental duplex in Saint-Henri, Montréal. Practical lamps, worn textures.
Actors: ${spark.actors.join(", ")}.
What was said (verbatim, may appear as the moment's caption, never as rendered text): ${spark.verbatim_lines.join(" / ")}
Interior note (informs expression only): ${spark.interior_line}

For each of 4 shots give a label and a dense photographic prompt: 35mm documentary still, natural practical light, film grain, no text, no logos, faces consistent with the reference image. Do NOT describe anyone's clothing — wardrobe is fixed separately and identical across all four shots. Choose the quote — the single verbatim line under the storyboard.`;
}

// ---- Visual Bible prompts ----

function platePrompt(location, isHomeRoom) {
  const locKey = String(location || "").toLowerCase();
  // Seahaven descriptors for each canonical location. Fall back to a
  // generic "small ocean-town" fixture when a location isn't in the map.
  const descriptors = {
    "master bedroom": "the master bedroom of a modest 1950s clapboard two-story house at 34 Lancaster Square, Seahaven. Twin south-facing windows with lace curtains. A wooden queen bed with a floral quilt. A wooden dresser with an oval mirror. A framed wedding photograph above the bed. Small braided rug on the pine floor",
    "kitchen": "the kitchen of a modest 1950s clapboard house in Seahaven. Yellow tile counter with chrome edge. White wooden cabinets. A pale yellow Frigidaire. A gas stove with a chrome kettle on the back burner. Small pine table for two with matching chairs. Checkerboard linoleum floor. Sunny window above the sink with white gingham curtains",
    "living room": "the living room of a modest 1950s clapboard house in Seahaven. Zenith TV in a walnut console. Faded floral sofa with two matching armchairs. A brick fireplace with a framed photograph of a father and small boy on a sailboat on the mantel. Braided oval rug. Table lamps with cream shades. Wood-paneled walls halfway up",
    "bathroom": "the downstairs bathroom of a modest 1950s clapboard house in Seahaven. Pale pink tile walls to shoulder height, cream above. Small white pedestal sink. Medicine cabinet with a mirrored door. An electric razor on the shelf. A pale pink towel on a chrome bar. A single lightbulb in a frosted globe fixture",
    "front hallway": "the front hallway of a modest 1950s clapboard house in Seahaven. Yellow rain slicker on a hook by the door. A small oval mirror. A wooden coat tree. A blue runner rug down the hardwood floor. The screen door visible at the end of the hall",
    "front step": "the front step and small porch of 34 Lancaster Square, Seahaven — a modest 1950s clapboard house, white with sky-blue trim. Two potted red geraniums on the step. White picket fence at the sidewalk. A trimmed lawn. The porch light is off. It's a warm spring morning",
    "lancaster square": "Lancaster Square, Seahaven — a picture-perfect residential cul-de-sac. Trimmed lawns. White picket fences. Identical clapboard houses in muted pastels. A single blooming dogwood in the middle of the green. Late spring, warm and clear",
    "market street": "Market Street, Seahaven's main commercial artery. Brick-fronted storefronts with striped awnings. A barber shop with a striped pole, a bakery with pies in the window, a small drugstore, the Seahaven Chronicle office. Wide sidewalks. Occasional parked Fords and Chevrolets. Late 1990s but frozen in a warmer decade",
    "seahaven mutual": "Seahaven Mutual — a small insurance office on Market Street. Wooden clerks' desks in a row. Green banker's lamps. A fern by the window. An old black rotary phone at the reception desk. Wood-paneled walls. A framed portrait of the founder. Frosted glass door with lettering",
    "the good time café": "The Good Time Café on Market Street — a diner with red vinyl booths along the windows, a chrome counter with stools, a pie case with three or four slices, a jukebox in the corner. Checkerboard linoleum floor. Pendant lamps in warm cream. Morning light through the front window",
    "seahaven harbor": "Seahaven Harbor — a small crescent bay. A weathered wooden pier extending out. Fishing boats moored. A stone seawall. Coiled rope, small crates. Seagulls. A striped harbormaster shed with a small window. The bay is calm; the sky is warm and clear",
    "seahaven park": "Seahaven Park — a wide town green with a white bandstand at the center, ringed by old oaks. A small duck pond with wooden benches. Wooden benches donated with brass plaques. A gravel path meandering. Late spring, warm, dappled light",
    "grocery": "Seahaven Grocers — a mid-century supermarket. Checkerboard floor. Aisles of canned goods and cereal boxes. A Kaiser Chicken vending machine near the entrance. A fresh-produce section along one wall with tomatoes, lettuce, apples. Warm fluorescent light. A cashier's chrome register at the front",
    "chester street": "Chester Street, a quieter residential street in Seahaven. Older homes, larger lots. A magnolia tree in bloom in one front yard. Big shade trees along the sidewalks. Warm spring afternoon",
  };
  const setting = descriptors[locKey]
    || (isHomeRoom
      ? `${location}, part of a modest 1950s clapboard two-story house at 34 Lancaster Square, Seahaven`
      : `${location}, Seahaven — a small ocean town, warm and picturesque, late spring 1998`);
  return `Establishing reference plate: ${setting}.
Empty of people and animals. Only permanent fixtures and furniture — no loose props that come and go.
Warm natural light, no dramatic lens choices. Slight vintage feel — Seahaven exists frozen just before you were paying attention.
No text, no logos, no branded product visible.
This image becomes the PERMANENT canonical look of this place: choose one coherent layout, one palette, one light logic, and commit to it.`;
}

// Isometric cutaway "dollhouse" render of the entire duplex — all rooms
// visible simultaneously from a top-down 3/4 angle with the roof and outer
// walls implicitly cut away. Used as the mid-zoom layer in the Observer
// Camera: neighborhood map → house cutaway → single-room panorama.
function cutawayPrompt() {
  return `Warm mid-afternoon aerial establishing shot of Seahaven — a small, picturesque 1998 American ocean town. Modest 1950s clapboard houses in muted pastels, white picket fences, trimmed lawns, a small harbor with fishing boats, Market Street running down the center with brick storefronts and striped awnings, a green town park with a bandstand. Warm honest light, no cinematic color grading, no text, no logos.`;
}

// Stream engine: campaigns don't exist. Preserved as a stub so any legacy
// import doesn't crash. Returns a bare Seahaven placeholder.
function campaignStorePrompt() {
  return "Seahaven storefront — a small ocean-town shop, warm late spring 1998.";
}

function continuityBlock(actorNames, visibleObjects, wardrobeLines, campaignPalettes = []) {
  let paletteLine = "";
  if (campaignPalettes.length) {
    const tones = campaignPalettes
      .map((p) => [p.primary, p.secondary].filter(Boolean).join(" and "))
      .filter(Boolean)
      .join("; ");
    if (tones) {
      paletteLine = `\n- SUBTLE PALETTE DRIFT (for wardrobe rendering only — do NOT add branded items or logos): the family's current aesthetic naturally tilts toward ${tones}. Where wardrobe allows range (a sweater, a scarf, a jacket), lean toward these tones. Realistic, not costume-y.`;
    }
  }
  return `
SCENE CONTINUITY (hard requirements):
- The FIRST reference image is the room itself. Match its architecture, furniture, palette, and light logic exactly. Do not redesign the space.
- The following reference image(s): ${actorNames.join(", ")}. Match face, hair, build, and skin exactly.
- WARDROBE, identical in ALL FOUR shots of this moment (this is one continuous scene, minutes apart at most):
${(wardrobeLines || []).map((l) => "    " + l).join("\n") || "    as the portraits show"}
  Never change, add, or remove clothing between shots.${paletteLine}
- Objects visible in this room right now: ${visibleObjects.length ? visibleObjects.join("; ") : "only what the room plate already shows"}. Do NOT add objects, pets, brands, or people not listed.`;
}

const VERIFY_SCHEMA = {
  type: S.OBJ,
  properties: {
    match: { type: S.BOOL },
    reason: { type: S.STR, description: "if no match: the specific mismatch — wrong face, redesigned room, extra person/object, anatomy glitch" },
  },
  required: ["match", "reason"],
};

function verifyPrompt(actorNames, wardrobeLines) {
  return `Continuity check. The FIRST image is a generated documentary shot. The following image(s) are canonical references: the room plate, then ${actorNames.join(", ")}.
Fail the shot for real breaks: a clearly different person (face/hair/build), a redesigned room, extra people or animals, anatomy or rendering glitches, or WRONG CLOTHING. Required wardrobe for this scene:
${(wardrobeLines || []).map((l) => "  " + l).join("\n") || "  as the portraits show"}
Lighting and angle variation are fine. Return match=true unless something is genuinely wrong.`;
}

// ---------- Scene planner (Director Chunk B) ----------
// Takes a Director scene candidate's beats and produces a 4-shot cinematic
// storyboard. Not one-beat = one-shot — a cinematographer would cover a scene
// with a wide establishing, a medium 2-shot, a close-up on the key line, and
// a reaction shot. Sometimes multiple beats fit under one shot; that's fine.

const SCENE_PLAN_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "Short evocative title (3-6 words) for the finished scene" },
    logline: { type: "string", description: "One sentence, present tense, describing what this scene is emotionally about" },
    shots: {
      type: "array",
      minItems: 4,
      maxItems: 4,
      items: {
        type: "object",
        properties: {
          grammar: { type: "string", enum: ["wide", "medium", "close_up", "reaction", "detail"], description: "Shot grammar" },
          subject: { type: "string", description: "Named character who is the primary subject of this shot" },
          moment: { type: "string", description: "Which beat's moment this shot captures — quote or paraphrase the specific action or line" },
          prompt: { type: "string", description: "The specific image prompt for this shot — 2-3 sentences describing framing, subject action, and mood" },
        },
        required: ["grammar", "subject", "moment", "prompt"],
      },
    },
  },
  required: ["title", "logline", "shots"],
};

function scenePlanPrompt(scene) {
  const beatLines = scene.beats.map((b, i) => `${i + 1}. [${b.time} · ${b.location}] ${b.text}`).join("\n");
  const actors = [...new Set(scene.beats.flatMap((b) => b.actors || []))].join(", ");
  return `You are a documentary film cinematographer breaking down a small domestic scene into a 4-shot cinematic sequence. The world is Saint-Henri, Montréal, working-class duplex, 35mm film aesthetic, natural practical light. Documentary honesty, not staged drama.

SCENE (Day ${scene.day}, ${scene.startTime} → ${scene.endTime}):
Beats in order:
${beatLines}

Characters present: ${actors}

Plan exactly 4 shots that cover this scene cinematically. Rules:
- Shot 1 should usually establish the space and situation — wide or medium wide.
- Shot 2-3 should carry the dramatic beats — usually medium two-shots for dialogue, close-ups on the key line, or detail shots of the specific objects mentioned (the lightbulb box, the math sheet, the mug).
- Shot 4 is usually a reaction or a resolution — a face registering, an aftermath, a small look.
- Each shot's "moment" field must reference a specific beat number or quote a specific line/action.

CRITICAL PROMPT SCOPE RULES for the "prompt" field:
- The "prompt" field describes ONLY framing (over-shoulder, mid-wide, tight, low-angle), what's visible in the frame (which objects/furniture), and emotional mood/expression.
- The "prompt" field must NEVER describe what any character is wearing, their face, their hair, their skin, their ethnicity, or their body type. Wardrobe and face fidelity are locked by separate reference photos — do not touch them.
- The "prompt" field must NEVER add characters not present in the beats' actors. Do not invent people.
- The "prompt" field must NEVER describe framing that crops a person at chest-level with bare skin above the crop.

Wardrobe and face fidelity are handled by the renderer's own rules — don't repeat them in your prompt.
Do NOT stage or dramatize. Documentary honesty. Real people doing everyday things.

Return the storyboard as JSON matching the schema.`;
}

module.exports = {
  STYLE_RULES, AGENT_TURN_SCHEMA, DISPOSE_SCHEMA, REFLECT_SCHEMA, DIRECTOR_SCHEMA, SHOTS_SCHEMA, VERIFY_SCHEMA, SCENE_PLAN_SCHEMA,
  agentTurnPrompt, disposePrompt, reflectPrompt, directorPrompt, shotsPrompt, platePrompt, cutawayPrompt, campaignStorePrompt, continuityBlock, verifyPrompt, scenePlanPrompt,
};
