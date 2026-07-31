// APE ENGINE — Life events stream
//
// The outside world entering the family's day. Small stochastic injections
// that fire per-slot based on realistic frequencies and time-of-day windows.
// Each event becomes an ambient event dispose weaves into the beat, tagged to
// a specific target character. They may notice, respond, or defer — deferring
// accumulates specific consequence (unanswered texts pile up, unread client
// emails escalate).
//
// Design principle from Zack: life isn't just self-generated. Marcus's sister
// Christine texts. Lena's freelance client emails a revision at 4:47pm. The
// school calls about a snow day. The world works whether the family engages
// or not — the point is what the family chooses to attend to.
//
// This is deliberately parallel to the media_plan pressure emitter — brand
// campaigns and life events are both "pressure emitters" that hand dispose
// shaped ambient content. Same architectural pattern.

const EVENTS = [
  // --- Text messages ---
  {
    id: "christine_text",
    label: "Marcus's sister Christine texts",
    channel: "sms",
    target: "marcus",
    perDay: 0.35,   // ~1 every 3 days
    hours: [8, 22],
    variants: [
      `Marcus's phone buzzes with a text from his sister Christine: "hey. mom asked if you're coming for easter this year. no pressure just let me know when you can."`,
      `Christine texts Marcus: "found the photo of dad on the bike. sending it later. call me back when you can."`,
      `Marcus's phone lights up with a text from Christine: "did you ever hear back from that guy about the shift at the port? just checking in."`,
      `Christine texts: "mom's fine btw. i know you worry. just tired. love you"`,
      `Text from Christine to Marcus: "hey are you okay? haven't heard from you in like a week"`,
    ],
    // If Marcus doesn't respond within 24hr, this text piles onto the existing chore pressure.
    deferralKey: "sister_text",
  },

  {
    id: "kari_client_email",
    label: "freelance client emails Lena a revision",
    channel: "email",
    target: "lena",
    perDay: 1.6,   // multiple per workday during active jobs
    hours: [8, 20],
    variants: [
      `Lena's laptop chimes with an email from the bakery client: "hey — quick note, can the wheat stalk be a little more organic? the current one feels stiff. thanks!"`,
      `Email lands in Lena's inbox from the bakery client: "one more thing — can we see it on a dark background too? proof deadline still Wednesday."`,
      `Lena's client emails: "just showed my partner and she says the amber's a little too orange. thoughts? no rush but if you can adjust today that'd be great."`,
      `Email from another client, marked URGENT: "Lena, the deck for tomorrow — we're missing the exec bio pages. Can you push those tonight?"`,
      `Lena's inbox pings: her print vendor confirming the file uploaded successfully. No action needed.`,
      `Email from the bakery client: "actually, let's go with your original direction. sorry for the flip-flop. proof still on for wed."`,
    ],
  },

  {
    id: "teacher_note",
    label: "note home from Theo's teacher",
    channel: "school_note",
    target: "lena",   // arrives in Theo's backpack, Lena finds it
    perDay: 0.2,   // ~1 per week
    hours: [15, 19],  // discovered after school
    variants: [
      `Lena finds a note tucked in Theo's backpack: "Reminder — spring concert on Thursday, 6pm. Kids should wear something red or yellow. Signed permission slip due Monday."`,
      `A folded note from Theo's teacher, handed to him at dismissal: "Theo did such a beautiful drawing today about goldfish. I've displayed it in the hallway. — Mme Bélanger"`,
      `Note from Theo's teacher in his agenda: "Theo has been distracted this week. Would appreciate a quick check-in call when convenient."`,
      `A permission slip from école Saint-Zotique: "Class field trip to Biodôme, $12, please return by Friday."`,
    ],
  },

  {
    id: "school_snow_day",
    label: "school bulletin about weather",
    channel: "school_alert",
    target: "lena",  // arrives at Lena's phone in the morning
    perDay: 0.06,   // rare
    hours: [6, 8],
    variants: [
      `Lena's phone buzzes with an alert from école Saint-Zotique: "École fermée aujourd'hui en raison de la tempête. School closed today due to the storm."`,
      `Text from the school's parent line: "Delayed opening — first bell now 9:30am due to weather. Buses will run 30 minutes late."`,
    ],
    // Cascading world-state change: if snow day fires, Theo's schedule
    // needs to skip school. This is handled inline in ape.js by checking a flag.
    worldEffect: (W) => { W.__schoolClosed = { day: W.day }; },
  },

  {
    id: "spam_call",
    label: "spam call",
    channel: "phone_call",
    target: "any",
    perDay: 0.8,
    hours: [9, 20],
    variants: [
      `An unknown number calls — Marcus lets it ring out. Voicemail: "This is Rogers reminding you about your loyalty upgrade..."`,
      `Lena's phone rings from a 438 number she doesn't recognize. She ignores it. It stops after four rings.`,
      `A number Marcus recognizes as spam calls twice in a row, then stops.`,
    ],
  },

  {
    id: "neighbor_knock",
    label: "neighbor at the door",
    channel: "in_person",
    target: "any",
    perDay: 0.12,   // ~1 every 8 days
    hours: [10, 19],
    variants: [
      `A knock at the door — it's Mme Tremblay from the upstairs duplex asking if their recycling was mixed up with hers on the porch. Kind, quick conversation.`,
      `Someone knocks — a delivery person leaves a package on the step. Nothing addressed to the Jenkins family, wrong duplex number.`,
      `Knock at the door — a young man asking about window replacement quotes. Marcus (or whoever opens) is polite but declines.`,
    ],
  },

  {
    id: "friend_text",
    label: "friend texts Marcus about the game",
    channel: "sms",
    target: "marcus",
    perDay: 0.25,
    hours: [17, 22],
    variants: [
      `Marcus's phone buzzes — text from Danny at the depot: "you watching the game tonight or what"`,
      `Danny texts: "hey remember that guy from the loading dock? his kid just made the AAA team. told you."`,
      `Marcus gets a text from his old friend Sean: "in town next weekend, quick coffee?"`,
    ],
  },

  {
    id: "theo_friend_ping",
    label: "Theo's friend messages via family tablet",
    channel: "kid_chat",
    target: "theo",
    perDay: 0.3,
    hours: [15, 20],
    variants: [
      `Theo's tablet dings — his friend Milo has sent him three consecutive fish emojis and "CAPTAIN". No context.`,
      `A message on Theo's tablet from a classmate: "did u finish the math? whats question 7"`,
      `Theo's friend Milo sends: "my dad said i can have you over on saturday if your mom says yes"`,
    ],
  },
];

const SLOTS_PER_DAY = 96;

// Roll each event for this slot. Returns array of injection texts.
function emit(W) {
  const injections = [];
  const clock = W.clock || "00:00";
  const hour = parseInt(clock.split(":")[0], 10) || 0;

  // Sundays are quieter for work channels
  const isSunday = false;   // TODO: real day-of-week from W.day if we track it

  for (const ev of EVENTS) {
    // Time-window gate
    if (hour < ev.hours[0] || hour >= ev.hours[1]) continue;

    // Skip client emails on weekends (if we ever track day-of-week)
    if (ev.channel === "email" && isSunday) continue;

    // Per-slot probability = perDay / slots-per-active-hour-window
    const windowHours = ev.hours[1] - ev.hours[0];
    const activeSlots = Math.max(1, Math.round((windowHours / 24) * SLOTS_PER_DAY));
    const pPerSlot = ev.perDay / activeSlots;

    if (Math.random() > pPerSlot) continue;

    // Pick a target
    let targetKey = ev.target;
    if (targetKey === "any") {
      const awake = Object.entries(W.agents || {}).filter(([, a]) => !a.asleep).map(([k]) => k);
      if (!awake.length) continue;
      targetKey = awake[Math.floor(Math.random() * awake.length)];
    }
    const target = W.agents[targetKey];
    if (!target || target.asleep) continue;

    // Pick a variant
    const variant = ev.variants[Math.floor(Math.random() * ev.variants.length)];

    injections.push({
      eventId: ev.id,
      channel: ev.channel,
      target: targetKey,
      targetName: target.name,
      text: variant,
    });

    // Apply world effects
    if (ev.worldEffect) ev.worldEffect(W);

    // Only fire one life event per slot at most, to keep density realistic
    break;
  }
  return injections;
}

module.exports = { emit, EVENTS };
