// APE STREAM ENGINE — time-of-day awareness.
//
// Two responsibilities:
//   1. Convert the sim clock into lighting/atmosphere language for the SCENE
//      prompt so Nano Banana renders morning as morning, dusk as dusk.
//   2. Mutate W.objects based on time of day so the coffee cup empties by
//      10am, the cereal box gets put away after breakfast, the TV turns
//      itself on when Truman is home, blinds close at night.
//
// This is the difference between "the model interpreted the clock string
// abstractly" and "the frame actually looks like 6:39pm."

// Given a clock hour (0-24 float), return atmosphere descriptor for the prompt.
function atmosphereFor(hour, weather = "clear") {
  const h = hour;
  const overcast = weather === "overcast" || weather === "rain";
  if (h < 5) {
    return "deep night. Rooms dark except for whatever electric light is on (bedside lamp, hallway nightlight, refrigerator light through a door left ajar). Streetlights outside cast pale yellow rectangles through windows. Sky outside black. Blinds and curtains drawn.";
  }
  if (h < 6.5) {
    return "pre-dawn. Sky outside a deep gunmetal blue turning slate. First hint of horizon light. Interior lamps still on. Every color inside slightly cool and gray.";
  }
  if (h < 8) {
    return "early morning. Warm gold sun raking low through east windows, long soft shadows across floors. Kitchen bright with morning light. Air feels crisp and fresh.";
  }
  if (h < 11) {
    return "mid-morning. Bright natural daylight. Cool clean light. Windows open. Every surface reads its actual color.";
  }
  if (h < 14) {
    return "midday. Overhead sunlight. Neutral warm-white cast. Shadows short and hard-edged. Bright.";
  }
  if (h < 17) {
    return "afternoon. Warm sunlight from the west. Long soft shadows. Light picks up warm tones — honey wood, cream walls glow.";
  }
  if (h < 18.5) {
    return "early evening. Golden hour. Very warm sunset light through west windows, deep amber slanting across walls, dust motes visible. Rooms feel amber-lit.";
  }
  if (h < 20) {
    return "dusk. Sun just set. Sky outside deep peach fading to violet. Interior lamps starting to come on. Air feels tender and blue. Lamps warm; shadow areas cool.";
  }
  if (h < 22) {
    return "evening. Dark outside. Warm interior lamp light — table lamps, floor lamps, a reading light. Rest of the room falls into warm shadow. Windows show only reflection.";
  }
  return "late evening. Most lights off. One or two lamps still on. Blinds and curtains drawn. Room feels quiet, dark, warm-shadowed.";
}

// Given time of day + activity, mutate the W.objects list in place. Called
// from ape.js right before the SCENE prompt is assembled, so the model sees
// each object's CURRENT state at this clock time.
//
// Rules:
//   coffee carafe:
//     06:00-08:30 → full and brewing (red brew light on)
//     08:30-10:00 → carafe emptying
//     10:00-16:00 → empty, rinsed, upside down in the drying rack
//     16:00-19:00 → clean and put away
//     19:00-22:00 → clean, unused
//   cereal box:
//     06:00-08:00 → open on the counter
//     08:00-onward → closed, back in the cupboard
//   Zenith TV:
//     06:30-08:30 → on, morning news
//     08:30-17:00 → off (nobody home)
//     17:30-22:30 → on, evening programming
//     otherwise off
//   yellow rain slicker (front hallway):
//     08:30-17:00 → not on the hook (Truman took it if raining)
//     otherwise → on the middle hook
//   morning newspaper:
//     05:30 → on the front step
//     06:45-08:30 → picked up, on kitchen table folded to sports
//     08:30-onward → in the paper bin by the door
//   curtains/blinds:
//     22:30-06:30 → drawn
//     otherwise → open
function applyTimeStates(objects, hour, weather = "clear", day = 0) {
  if (!Array.isArray(objects)) return objects;
  const h = hour;

  const setState = (nameMatch, state) => {
    for (const o of objects) {
      if (String(o.name || "").toLowerCase().includes(nameMatch)) {
        o.state = state;
      }
    }
  };

  // Coffee carafe
  if (h >= 6 && h < 8.5) setState("coffee maker", "carafe full and brewing, red brew light on, faint steam rising from the top vent");
  else if (h >= 8.5 && h < 10) setState("coffee maker", "carafe about a quarter full, brew light off but still warm on the plate");
  else if (h >= 10 && h < 16) setState("coffee maker", "carafe empty, rinsed, upside down in the drying rack next to the sink");
  else setState("coffee maker", "clean and put away, carafe seated on the machine, brew light off");

  // Cereal box
  if (h >= 6 && h < 8) setState("cornflakes", "open on the counter, top flaps folded back, a used cereal bowl beside it");
  else setState("cornflakes", "closed, top folded twice, put away in the cupboard (not visible on the counter)");

  // Yellow mug in sink
  if (h >= 6 && h < 8.5) setState("yellow ceramic mug", "clean, on the counter beside the coffee maker");
  else if (h >= 8.5 && h < 20) setState("yellow ceramic mug", "in the sink with a small ring of coffee stain inside");
  else setState("yellow ceramic mug", "clean, put away in the cabinet");

  // Zenith TV
  if (h >= 6.5 && h < 8.5) setState("Zenith TV", "on, tuned to Seahaven Morning News, low volume, showing a weather map");
  else if (h >= 17.5 && h < 22.5) setState("Zenith TV", "on, showing evening programming (a game show or the nightly news), warm CRT glow");
  else setState("Zenith TV", "off, dark screen, faint gray reflection of the room");

  // Rain slicker on hook
  if (h >= 8.5 && h < 17.5) setState("yellow rain slicker", "not currently on the hook — Truman took it or it's hanging elsewhere. The hook is empty.");
  else setState("yellow rain slicker", "hanging on the middle hook, damp collar if it rained today");

  // Master bedroom curtains
  if (h < 6.5 || h >= 22) setState("wedding photograph", "hung straight on the wall above the bed. Curtains at the windows drawn closed, room dim.");

  // House keys — a real, occasional small drama. Matches the SAME day-cycle
  // index used in Truman's morning ritual rotation (readyRotation in ape.js,
  // 7-entry cycle, index 3 is the "keys aren't on the hook" beat) so the
  // object state and the narrative text always agree — this is what makes
  // "looking for keys" a genuine world-memory beat instead of flavor text
  // that never shows up visually. Only affects the morning window; by the
  // time he's left for work (h >= 8.15) they're back with him.
  const isKeysMissingDay = (day % 7) === 3;
  if (isKeysMissingDay && h >= 7.6 && h < 8.15) {
    setState("house keys", "not on the hook — misplaced somewhere in the house, needs finding");
  } else if (h >= 8.15) {
    setState("house keys", "with Truman, out the door");
  } else {
    setState("house keys", "hanging on the hook where they always go");
  }

  // Weather influences
  if (weather === "rain" || weather === "overcast") {
    for (const o of objects) {
      if (o.state && !o.state.includes("gray light")) {
        // annotate weather but don't overwrite time-of-day state
      }
    }
  }

  return objects;
}

// Which time-of-day rituals feel right for this hour? Returns a short beat
// suggestion for the SCENE prompt. Not used yet, reserved for the smarter
// director in a later phase.
function beatSuggestionFor(hour, dow) {
  const h = hour;
  const isWeekend = dow === 0 || dow === 6;
  if (h < 6) return "asleep";
  if (h < 8) return "morning routine — shave, breakfast, coffee";
  if (h < 12) return isWeekend ? "leisurely morning" : "at work";
  if (h < 13) return "lunch";
  if (h < 17) return isWeekend ? "afternoon" : "at work";
  if (h < 18.5) return "commute home";
  if (h < 20) return "early evening at home";
  if (h < 22.5) return "evening — TV, quiet";
  return "winding down for sleep";
}

module.exports = { atmosphereFor, applyTimeStates, beatSuggestionFor };
