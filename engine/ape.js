// APE ENGINE — core loop
// Choose -> Dispose -> Perceive -> (nightly) Reflect.
// The model proposes; the engine clamps. Trust ratchet, memory decay, standing,
// and money are mechanical — no LLM ever sets a number directly.

const fs = require("fs");
const path = require("path");
const CFG = require("./config");
const P = require("./prompts");
const SEED = require("./world");
const BIBLE = require("./bible");
const CAMPAIGNS = require("./campaigns");
const BRAND_GEO = require("./brand_geo");
const D = require("./dimensions");
const PROMISE = require("./promise_scorer");
const MEDIA = require("./media_plan");
const PRODUCT_PLAN = require("./product_plan");
const CCTV = require("./cctv_camera");
const TIME_OF_DAY = require("./time_of_day");
const { StoryEngine } = require("./story_engine");
const { WorldLedger } = require("./world_ledger");
// STORY engine + world LEDGER singletons, lazily initialized to avoid
// module-init-order tangles with LOG, W, clockStr.
let STORY = null;
let LEDGER = null;
function getStoryEngine() {
  if (STORY) return STORY;
  STORY = new StoryEngine({
    savePath: path.join(path.dirname(CFG.SAVE_PATH), "story_state.json"),
    callJSON,
    olog: (m) => olog(m),
    textModel: CFG.TEXT_MODEL,
  });
  STORY.load().catch(() => {});
  return STORY;
}
function getLedger() {
  if (LEDGER) return LEDGER;
  LEDGER = new WorldLedger({
    savePath: path.join(path.dirname(CFG.SAVE_PATH), "world_ledger.json"),
    olog: (m) => olog(m),
  });
  LEDGER.load().catch(() => {});
  return LEDGER;
}
const DAILIES = require("./dailies");
const METERS = require("./meters");
const CHORES = require("./chores");
const LIFE = require("./life_events");
const DIRECTOR = require("./director");
const AD_DIRECTOR = require("./ad_director");
const IDENTITY = require("./identity");
const PARTICLE = require("./shot_particle");
const LOCATIONS = require("./locations");
const SCENE_STORE = require("./scene_store");
const SCENE_VIDEO = require("./scene_video");
const OBJECT_FOCUS = require("./object_focus");
const MOMENT_STORE = require("./moment_store");
const STORAGE = require("./storage");
const SALVAGE = require("./salvage");
const DB = require("./db");
const WORKER = require("./worker");
const BUS = require("./bus");
const SAFETY = require("./safety");
const BUDGET = require("./budget");

// Storyboard shots live as files on the volume, not as base64 inside world state.
const SHOTS_DIR = path.join(path.dirname(CFG.SAVE_PATH), "shots");
try { fs.mkdirSync(SHOTS_DIR, { recursive: true }); } catch (_) {}

// ---------------- Gemini plumbing ----------------
async function gemini(model, body) {
  if (!CFG.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY not set — add it in Railway Variables (or engine/.env for local runs)");
  const url = `${CFG.BASE_URL}/models/${model}:generateContent?key=${CFG.GEMINI_API_KEY}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) { const t = await r.text(); throw new Error(`[${r.status}] ${t.slice(0, 300)}`); }
  return r.json();
}

async function callJSON(prompt, schema) {
  const data = await gemini(CFG.TEXT_MODEL, {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.9 },
  });
  let t = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  t = t.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
  return JSON.parse(t);
}

// ---------------- World state ----------------
const W = {
  day: 1, minutes: 6 * 60, slot: 0, paused: false, speedMs: CFG.SLOT_REAL_MS,
  facts: [...SEED.FACTS],
  money: JSON.parse(JSON.stringify(SEED.MONEY)),
  objects: JSON.parse(JSON.stringify(SEED.OBJECTS)),
  agents: JSON.parse(JSON.stringify(SEED.AGENTS)),
  env: { weather: "Grey early-spring drizzle", headline: "" },
  truthLog: [],           // objective events — ground truth
  pendingInjection: null, // product drop / event queued by operator
  sparks: [],
  keptTopics: [],
  renderQueue: [], rendering: false, renderStoryboards: CFG.RENDER_STORYBOARDS,
  lastError: null, busy: false, reflectedDay: 0,
  lastSlotWall: Date.now(), bootWall: Date.now(),
};

// seed memories
for (const id of Object.keys(W.agents)) {
  const a = W.agents[id];
  a.memories = (a.seedMemories || []).map((m) => ({ text: m.text, strength: m.strength, day: 0, retold: 0 }));
  delete a.seedMemories;
}

// ---------------- Mechanical subsystems ----------------
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const clockStr = () => `${String(Math.floor(W.minutes / 60)).padStart(2, "0")}:${String(W.minutes % 60).padStart(2, "0")}`;

// Heartbeat log: every meaningful engine event, to console (Railway log view)
// and to a ring buffer served at /api/logs.
const LOG = [];
function olog(msg) {
  const line = `[d${W.day} ${clockStr()} s${W.slot}] ${msg}`;
  console.log(line);
  LOG.push(line);
  if (LOG.length > 300) LOG.shift();
}

// Crash-proofing: an error costs a beat, never a life. Nothing exits the process.
process.on("unhandledRejection", (e) => olog(`UNHANDLED REJECTION: ${String(e && e.message || e).slice(0, 200)}`));
process.on("uncaughtException", (e) => olog(`UNCAUGHT EXCEPTION: ${String(e && e.message || e).slice(0, 200)}`));

// Signal handlers — diagnostic. Silent-kill by Railway (SIGTERM from health
// check fail, SIGKILL from OOM) leaves no trace in our runtime log. These
// handlers log the signal name to stdout BEFORE letting Node exit so we can
// see WHY the process is going down. Best-effort — SIGKILL can't be handled
// (kernel bypasses the process), but SIGTERM/SIGINT/SIGHUP all can.
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    try { olog(`SIGNAL ${sig} received — process exiting`); } catch (_) {}
    try { console.log(`[signal] ${sig} at ${new Date().toISOString()}`); } catch (_) {}
    // Give the log a moment to flush before exiting
    setTimeout(() => process.exit(0), 100);
  });
}

// Log memory pressure periodically. Node prints "heap out of memory" before
// dying, but if the OS SIGKILLs us for RSS growth we get no warning. This
// puts a memory snapshot in the log every 60s so we can see if RSS was
// climbing in the seconds before a silent death.
setInterval(() => {
  try {
    const m = process.memoryUsage();
    const mb = (n) => (n / 1024 / 1024).toFixed(1);
    olog(`MEM: rss=${mb(m.rss)}MB heapUsed=${mb(m.heapUsed)}MB external=${mb(m.external)}MB`);
  } catch (_) {}
}, 60 * 1000);

// Emit a beat — dual-write to the in-memory truthLog (for the live cockpit
// feed and legacy code paths that scan W.truthLog) AND to the beats table
// (durable, queryable, unbounded). Session 2a of the rebuild. Session 3
// will remove the in-memory array once every reader has moved to DB queries.
//
// Beat fields: { slot, day, time, location, actors, kind, text, topic? }
function emitBeat(b) {
  W.truthLog.push(b);
  // Bounded in-memory (matches slimForSave cap so save-file and runtime agree)
  if (W.truthLog.length > 800) W.truthLog.shift();
  // Session 8b: campaign beat tagging. Scan text against every running
  // campaign's keywords + brand. If a match, attach campaign metadata so the
  // cockpit can render the beat with a brand-flagged styling (white backdrop,
  // brand color accent, brand chip).
  const text = (b.text || "").toLowerCase();
  let campaignTag = null;
  for (const c of CAMPAIGNS.running()) {
    const keys = [
      (c.brand || "").toLowerCase(),
      ...(c.productPlan?.keywords || []).map((k) => String(k).toLowerCase()),
      ...(c.brief?.keywords || []).map((k) => String(k).toLowerCase()),
      (c.brief?.product || "").toLowerCase(),
    ].filter((k) => k && k.length >= 3);
    const matched = keys.filter((k) => text.includes(k));
    if (matched.length) {
      campaignTag = {
        campaignId: c.id,
        brand: c.brand,
        matchedKeywords: [...new Set(matched)].slice(0, 4),
      };
      break;   // first match wins; overlapping campaigns is unusual
    }
  }
  if (campaignTag) {
    b.campaignId = campaignTag.campaignId;
    b.campaignBrand = campaignTag.brand;
    b.matchedKeywords = campaignTag.matchedKeywords;
  }
  // DB write. Failure is logged but does not abort the beat emission —
  // during migration, in-memory truthLog remains the fallback truth.
  try {
    DB.addBeat({
      slot: b.slot, day: b.day, time: b.time,
      location: b.location, actors: b.actors, kind: b.kind,
      text: b.text, topic: b.topic,
    });
  } catch (e) { olog(`ERROR emitBeat(DB): ${e.message.slice(0, 140)}`); }
  // Publish on the bus so any live subscriber (WebSocket clients in 4b+)
  // sees the beat the instant it fires. Includes campaign tag when the beat
  // touched a running brand.
  BUS.emit("beat", {
    slot: b.slot, day: b.day, time: b.time,
    location: b.location, actors: b.actors,
    kind: b.kind, text: b.text, topic: b.topic,
    campaignId: b.campaignId || null,
    campaignBrand: b.campaignBrand || null,
    matchedKeywords: b.matchedKeywords || null,
  });
}

function applyLedgerDelta(agent, who, dRegard, dTrust, betrayal) {
  const key = who.toLowerCase();
  if (!W.agents[key] || key === agent) return;
  const L = W.agents[agent].ledger[key] || (W.agents[agent].ledger[key] = { regard: 50, trust: 50 });
  L.regard = clamp(L.regard + clamp(dRegard, -4, 4), 5, 95);
  // trust ratchet: inches up, cliff down
  const up = clamp(dTrust, 0, 2);
  const down = betrayal ? clamp(dTrust, -30, 0) : clamp(dTrust, -6, 0);
  L.trust = clamp(L.trust + (dTrust >= 0 ? up : down), 3, 97);
}

function ledgerDrift() { // daily homeostasis: extremes cost energy to maintain
  for (const id of Object.keys(W.agents)) {
    for (const k of Object.keys(W.agents[id].ledger)) {
      const L = W.agents[id].ledger[k];
      L.regard += (50 - L.regard) * 0.04;
      L.trust += (50 - L.trust) * 0.03;
    }
    const so = W.agents[id].senseOfSelf;
    so.believes += (50 - so.believes) * 0.03;
  }
}

function room(agentId) { // standing: mean of others' regard toward you. Stored nowhere; computed.
  const vals = Object.keys(W.agents).filter((k) => k !== agentId)
    .map((k) => (W.agents[k].ledger[agentId] || { regard: 50 }).regard);
  return Math.round(vals.reduce((a, b) => a + b, 0) / Math.max(1, vals.length));
}

function selfState(a, id) {
  const r = room(id);
  const gap = a.senseOfSelf.believes - r;
  return { ...a.senseOfSelf, room: r, state: gap <= -5 ? `under ${gap}` : gap >= 5 ? `inflated +${gap}` : "clear-eyed" };
}

function decayMemories(a) {
  for (const m of a.memories) m.strength *= 0.995;
}
function topMemories(a, k = 8) {
  const scored = [...a.memories].sort((x, y) => y.strength - x.strength).slice(0, k);
  for (const m of scored) { m.strength *= 0.985; m.retold++; } // recall costs fidelity
  return scored;
}

// Should this agent be at a campaign life-event right now? Reads productPlan
// .lifeEvents from every running campaign, matches on agent + weekday + hour
// window. Returns { away, campaignId, brand, ritualText } or null.
//
// Life-events are the main lever that makes a running campaign feel real: they
// generate 2-4 recurring routines per week (Lena coffee with Priya Fri morning,
// Theo cake pop Wed lunch, Marcus Sunday latte) that produce natural moments
// throughout the campaign window.
function campaignLifeEvent(id) {
  const h = W.minutes / 60;
  const dow = W.day % 7;
  const dowName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][dow];
  for (const c of CAMPAIGNS.running()) {
    const events = c.productPlan?.lifeEvents || [];
    for (const ev of events) {
      if (String(ev.agent).toLowerCase() !== id) continue;
      if (ev.weekday !== dowName) continue;
      const start = Number(ev.startHour);
      const end = Number(ev.endHour);
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      if (h < start || h >= end) continue;
      // Resolve locationLabel
      let location;
      if (String(ev.locationLabel || "").toLowerCase().includes("campaign store")) {
        const store = (c.geoLocations || [])[0];
        location = store ? `${store.name || c.brand}${store.address ? ` (${store.address})` : ""} — ${c.brand}` : `${c.brand}`;
      } else {
        location = ev.locationLabel;
      }
      return {
        away: location,
        campaignId: c.id,
        brand: c.brand,
        ritualText: ev.ritualText || `at ${location}`,
      };
    }
  }
  return null;
}

// Should this agent visit a campaign store this slot? Returns { away: "..." }
// with the campaign store as the location, or null if no visit. Applied at
// the top of schedule() so it overrides normal routines during commute
// windows for target agents on visit days.
function campaignStoreVisit(id) {
  const h = W.minutes / 60;
  // Visits happen during commute windows only. Marcus: bike out 8:45-9, bike
  // home 18-18:35. Lena Wed/Thu: walk out 8:36-9, walk home 17-17:24. Nothing
  // for Theo — kids don't route through brand stores independently.
  const isMarcusCommute = id === "marcus" && ((h >= 8.75 && h < 9) || (h >= 18 && h < 18.6));
  const isLenaCommute = id === "lena" && ((h >= 8.6 && h < 9) || (h >= 17 && h < 17.4));
  if (!isMarcusCommute && !isLenaCommute) return null;

  for (const c of CAMPAIGNS.running()) {
    const stores = c.geoLocations || [];
    if (!stores.length) continue;

    // Which agents does this campaign target? From mediaPlan channels.
    // If any channel targets Marcus, Marcus is a target. Same for Lena.
    const targets = new Set();
    for (const ch of (c.mediaPlan?.channels || [])) {
      for (const a of (ch.targeting?.agents || [])) targets.add(String(a).toLowerCase());
    }
    if (targets.size && !targets.has(id)) continue;

    // Deterministic visit-day check. Hash of (day, campaignId, agent) →
    // integer. Visit every ~3 sim-days: hash % 3 === 0. This means Marcus
    // visits Starbucks roughly every third weekday during a commute window.
    // Deterministic within the slot so all rituals + schedule agree, but
    // varies across days so it's not identical every commute.
    const hash = (W.day * 7919) ^ (id.charCodeAt(0) * 31) ^ hashString(c.id);
    const visitToday = (Math.abs(hash) % 3) === 0;
    if (!visitToday) continue;

    // Which store? Pick the closest one to the family flat (first in the list
    // because we sorted at geolocate time). For the demo this is enough — a
    // real implementation would pick based on their commute path.
    const store = stores[0];
    const displayName = store.name || c.brand;
    const brandName = c.brand;

    // Build a location string that (a) includes the brand so the cockpit's
    // character-presence check matches, (b) reads real in the sim (address
    // if we have it), (c) tells the agent turn prompt what they're doing.
    const addr = store.address ? ` (${store.address})` : "";
    const location = `${displayName}${addr} — quick stop for ${brandName}`;
    return { away: location, campaignId: c.id, brand: brandName };
  }
  return null;
}

// Tiny string hash — sum of char codes multiplied. Not cryptographic, just
// deterministic for visit-day selection.
function hashString(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h) + s.charCodeAt(i);
  return h;
}

function schedule(a, id) { // routine gates: who is out / asleep / in transit
  // Forced visits (via /api/campaigns/:id/force-visit) — demo tool. Keeps
  // the agent at the store for a short window regardless of commute state.
  if (W.__forcedVisits && W.__forcedVisits[id]) {
    const fv = W.__forcedVisits[id];
    if (W.slot < fv.expireSlot) {
      return { away: fv.location };
    } else {
      delete W.__forcedVisits[id];   // expired — resume normal routine
    }
  }

  // Session 8a: campaign life-events. These are recurring weekly routines
  // that a running campaign's productPlan injects — Lena coffee with Priya
  // Fri morning, Theo cake-pop-day Wed lunch, Marcus Sunday latte. Take
  // precedence over normal schedule when their time window is active.
  const lifeEvent = campaignLifeEvent(id);
  if (lifeEvent) return { away: lifeEvent.away };

  // Campaign store visits override normal routines during commute windows.
  // If a target agent is scheduled to visit a brand store today AND is in
  // a commute window, their away location becomes the store instead of the
  // usual "biking to Ubisoft" / "walking to studio" string.
  const visit = campaignStoreVisit(id);
  if (visit) return { away: visit.away };

  const h = W.minutes / 60;
  // Day-of-week awareness: 0 Sun, 1 Mon, ... 6 Sat. In the sim we don't track
  // a real weekday, but W.day rolls forward as sim-days elapse. Use day%7
  // where day 1 = Monday convention: (day+0) % 7 gives 1=Mon..6=Sat, 0=Sun.
  const dow = W.day % 7;
  const isWeekend = dow === 0 || dow === 6;

  // Truman: walks Market Street to Seahaven Mutual, 8:20-8:30. At the
  // insurance office 8:30-17:00 with a 12:00-13:00 lunch break at the Good
  // Time Café. Walks home 17:00-17:10. Weekends home unless anchored event.
  if (id === "truman" && !isWeekend) {
    if (h >= 8.33 && h < 8.5)    return { away: "walking to work along Market Street" };
    if (h >= 8.5 && h < 12)      return { away: "seahaven mutual" };
    if (h >= 12 && h < 13)       return { away: "the good time café" };
    if (h >= 13 && h < 17)       return { away: "seahaven mutual" };
    if (h >= 17 && h < 17.2)     return { away: "walking home from work" };
  }

  // Meryl: hospital shift 7:30-16:00. Walks or drives to work. Weekends off.
  if (id === "meryl" && !isWeekend) {
    if (h >= 7.25 && h < 7.5)    return { away: "walking to the hospital" };
    if (h >= 7.5 && h < 16)      return { away: "seahaven community hospital" };
    if (h >= 16 && h < 16.2)     return { away: "walking home from the hospital" };
  }

  // Marlon: vending restocking route 8:00-16:00 all weekdays. Not seen at
  // home much. Often at the grocery or the harbor on breaks.
  if (id === "marlon" && !isWeekend) {
    if (h >= 8 && h < 16)        return { away: "restocking route (Kaiser Chicken vending)" };
  }

  // Angela: retired. Mostly at home on Chester Street or in her garden. Weekly
  // trip to the grocery on Tuesday morning.
  if (id === "angela") {
    if (dow === 2 && h >= 9 && h < 10.5) return { away: "grocery" };
  }

  // Supporting cast schedules
  if (id === "larry") {
    if (!isWeekend) {
      if (h >= 8.33 && h < 8.5) return { away: "walking to work along Market Street" };
      if (h >= 8.5 && h < 12)   return { away: "seahaven mutual" };
      if (h >= 12 && h < 13)    return { away: "the good time café" };
      if (h >= 13 && h < 17)    return { away: "seahaven mutual" };
      if (h >= 17 && h < 17.2)  return { away: "walking home from work" };
    }
    // Every other hour Larry is at HIS house, not Truman's
    if (h >= 6.5 && h < 22.5)   return { away: "larry's house" };
    return { asleep: true };
  }
  if (id === "ferris") {
    if (!isWeekend) {
      if (h >= 7.75 && h < 8)   return { away: "walking to seahaven mutual" };
      if (h >= 8 && h < 12)     return { away: "seahaven mutual" };
      if (h >= 12 && h < 13)    return { away: "lunch at his desk" };
      if (h >= 13 && h < 17.5)  return { away: "seahaven mutual" };
    }
    if (h >= 6.75 && h < 22)    return { away: "ferris's house" };
    return { asleep: true };
  }
  if (id === "doris") {
    // Café shift 6 days a week — Sunday off
    if (dow !== 0) {
      if (h >= 5.75 && h < 6)  return { away: "walking to the good time café" };
      if (h >= 6 && h < 15)    return { away: "the good time café" };
      if (h >= 15 && h < 15.25) return { away: "walking home from the café" };
    }
    if (h >= 5.5 && h < 22.5)  return { away: "doris's apartment" };
    return { asleep: true };
  }
  if (id === "cal") {
    if (!isWeekend) {
      if (h >= 6.25 && h < 6.5)  return { away: "loading up at the post office" };
      if (h >= 6.5 && h < 8.25)  return { away: "cal's route (upper Lancaster)" };
      if (h >= 8.25 && h < 8.75) return { away: "lancaster square" };
      if (h >= 8.75 && h < 12)   return { away: "cal's route (Market Street)" };
      if (h >= 12 && h < 12.5)   return { away: "the good time café" };
      if (h >= 12.5 && h < 15.5) return { away: "cal's route (Chester and points north)" };
    }
    if (h >= 5.75 && h < 22)    return { away: "cal's house" };
    return { asleep: true };
  }
  if (id === "timmy") {
    if (h >= 5 && h < 5.25)    return { away: "the paperboy dispatch" };
    if (h >= 5.25 && h < 6.25) return { away: "the paper route" };
    if (!isWeekend && h >= 8.25 && h < 15.25) return { away: "seahaven elementary" };
    if (h >= 5 && h < 20.5)     return { away: "timmy's house" };
    return { asleep: true };
  }
  if (id === "rex") {
    if (dow !== 0 && h >= 7.75 && h < 8)  return { away: "opening rex's barbershop" };
    if (dow !== 0 && h >= 8 && h < 12)    return { away: "rex's barbershop" };
    if (dow !== 0 && h >= 12 && h < 13)   return { away: "the good time café" };
    if (dow !== 0 && h >= 13 && h < 17)   return { away: "rex's barbershop" };
    if (h >= 6.25 && h < 22)              return { away: "rex's house" };
    return { asleep: true };
  }
  if (id === "hank") {
    if (h >= 6.75 && h < 7)   return { away: "walking to the harbor" };
    if (h >= 7 && h < 12)     return { away: "seahaven harbor" };
    if (h >= 12 && h < 12.75) return { away: "the good time café" };
    if (h >= 12.75 && h < 17) return { away: "seahaven harbor" };
    if (h >= 6 && h < 21.5)    return { away: "hank's house" };
    return { asleep: true };
  }
  if (id === "esther") {
    if (h >= 9 && h < 9.25)   return { away: "walking to the park with the bread bag" };
    if (h >= 9.25 && h < 11)  return { away: "seahaven park" };
    if (h >= 11 && h < 11.25) return { away: "walking home from the park" };
    if (h >= 7.5 && h < 21)    return { away: "esther's house" };
    return { asleep: true };
  }
  if (id === "marlon") {
    if (!isWeekend && h >= 8 && h < 16) return { away: "restocking route (kaiser chicken vending)" };
    if (h >= 7.25 && h < 23)   return { away: "marlon's apartment" };
    return { asleep: true };
  }
  if (id === "angela") {
    if (dow === 2 && h >= 9 && h < 10.5) return { away: "grocery" };
    // Angela stays at her house all other times — she's not welcome to drift
    // to Truman's kitchen because of an ambiguous evening slot
    if (h >= 7 && h < 22)      return { away: "angela's house" };
    return { asleep: true };
  }
  // Fallback for the main cast if none of their specific rules fired above
  return {};
}

// Anchored rituals: at specific hours, a specific character has a specific
// gravitational obligation that must happen this slot. These are not options —
// they are routine pressure that pulls the family out of any fixation loop and
// gives the day real shape. Returned as prompt text the agent turn respects.
function ritualPressure(a, id) {
  // Forced visits get a store-visit ritual just like natural visits.
  if (W.__forcedVisits && W.__forcedVisits[id] && W.slot < W.__forcedVisits[id].expireSlot) {
    const fv = W.__forcedVisits[id];
    return `ROUTINE PRESSURE THIS SLOT (must acknowledge or act on): you're at ${fv.location}. Order something (or don't), notice one specific thing about being here (the barista, the display, another customer, the light coming through the window, the smell of coffee, whatever's actual). Do NOT invent a fake ${fv.brand} — this is the real store.`;
  }
  // Session 8a: campaign life-event pressure. Uses the ritualText the LLM
  // wrote when generating the productPlan — it's specific to the agent, the
  // brand, and the moment. Overrides commute-window pressure when active.
  const lifeEvent = campaignLifeEvent(id);
  if (lifeEvent) {
    return `ROUTINE PRESSURE THIS SLOT (must acknowledge or act on): ${lifeEvent.ritualText}. You're at ${lifeEvent.away} right now. Real, specific, present-tense. Notice one true thing about being here. Do NOT invent a fake ${lifeEvent.brand} experience — this is the actual routine you have with this brand.`;
  }
  // If the agent is at a campaign store right now, override the commute
  // pressure with a store-visit pressure. This is what makes the beat read
  // as "Marcus at the Starbucks counter" rather than "Marcus notices something
  // on his bike ride" during the visit window.
  const visit = campaignStoreVisit(id);
  if (visit) {
    return `ROUTINE PRESSURE THIS SLOT (must acknowledge or act on): quick stop at ${visit.brand} on your way — you're at ${visit.away}. This is a brief real detour: order something (or don't), notice one specific thing about being here (the barista, the display, another customer, the light coming through the window, the smell of coffee, whatever's actual). Then continue on. Do NOT invent a fake ${visit.brand} — this is the real store.`;
  }
  const h = W.minutes / 60;
  const dow = W.day % 7;
  const isWeekend = dow === 0 || dow === 6;
  const isSaturday = dow === 6;
  const isSunday = dow === 0;
  const ritual = (text) => `ROUTINE PRESSURE THIS SLOT (must acknowledge or act on): ${text}`;

  // Weekend rituals — Saturday morning Truman washes his car in the drive.
  // Sunday morning Marlon and Truman meet at the harbor.
  if (isSaturday && id === "truman" && h >= 9 && h < 10.5) {
    return ritual("SATURDAY MORNING: wash the Ford in the driveway. Sponge, bucket of soapy water, garden hose. Neighbours might wave, might not. Take your time — the small ritual is the point");
  }
  if (isSunday && id === "truman" && h >= 10 && h < 12) {
    return ritual("SUNDAY MORNING: meet Marlon at the harbor. Sit on the seawall, watch the boats, talk about nothing much. He'll bring two coffees from the Good Time");
  }
  if (isSunday && id === "marlon" && h >= 10 && h < 12) {
    return ritual("SUNDAY MORNING: meet Truman at the harbor. Bring two coffees from the Good Time. He needs the ordinariness of this");
  }

  // Truman weekday
  if (id === "truman" && !isWeekend) {
    if (h >= 6.75 && h < 7.15)   return ritual("morning: alarm off, up quietly, into the bathroom. Electric razor. Splash of aftershave. The small rituals of a man who takes care");
    // Breakfast variety — different day of week, different beat. Some
    // mornings coffee, some toast, some just standing at the window looking
    // at the light. Not always the same coffee-pour.
    if (h >= 7.15 && h < 7.75) {
      const breakfastRotation = [
        "BREAKFAST WITH MERYL: kitchen table, dry toast with butter and a small dish of jam, orange juice from the fridge. Talk to her about the weather or the news — she wants to hear your voice",
        "BREAKFAST WITH MERYL: standing at the kitchen window with a slice of toast, watching Cal the mailman come up the walk. Meryl at the table with her tea",
        "BREAKFAST WITH MERYL: kitchen table, a plate of scrambled eggs Meryl made, a glass of milk. She asks what's on today at the office",
        "BREAKFAST WITH MERYL: no time for a real breakfast — a slice of toast in one hand, adjusting the tie with the other, Meryl handing you a wrapped lunch for the day",
        "BREAKFAST WITH MERYL: kitchen table, coffee from the glass carafe, cornflakes with milk — the standard weekday routine. She's in her uniform already",
        "BREAKFAST WITH MERYL: just fruit and a banana. She mentions the neighbor's dog was barking again. You listen more than you talk",
      ];
      return ritual(breakfastRotation[W.day % breakfastRotation.length]);
    }
    if (h >= 7.75 && h < 8.33)   return ritual("morning at home — Zenith TV on the news, quick look at the paper (Seahaven Chronicle), Meryl grabs her cardigan, you check your wallet and keys");
    if (h >= 8.33 && h < 8.5)    return ritual("walking to work along Market Street right now — greet the neighbours (Mr Fenwick, the twins on their bikes, the mailman if it's early enough) — notice one specific thing on this specific walk");
    if (h >= 12 && h < 13)       return ritual("lunch at the Good Time Café — same booth by the window, meatloaf sandwich or the tuna melt, coffee, sometimes Marlon drops by mid-route");
    if (h >= 17.2 && h < 17.5)   return ritual("just walked in from work — hang the jacket in the front hallway, wallet on the sideboard, kiss Meryl if she's home");
    if (h >= 18 && h < 18.75)    return ritual("DINNER WITH MERYL: kitchen table, whatever Meryl's put together (chicken, pot roast, the pasta bake). Sit together. Talk — about the day at the office, about her shift. This is a shared-room moment");
    if (h >= 20 && h < 22)       return ritual("evening winddown — Zenith TV on with Meryl, a magazine open on your lap, maybe a call from Marlon");
  }

  // Meryl weekday — hospital shift, home in the afternoon
  if (id === "meryl" && !isWeekend) {
    if (h >= 6.5 && h < 7.15)    return ritual("morning: shower, uniform, pin the hair back, small careful makeup — the professional version of yourself");
    if (h >= 7.15 && h < 7.5)    return ritual("BREAKFAST WITH TRUMAN: kitchen table. Cheerful. Something bright, on-brand, on-script — mention Chef's Pal salad-dressing or Kaiser Chicken if it fits naturally");
    if (h >= 7.25 && h < 7.5)    return ritual("walking to the hospital — clip badge on, brace for the shift");
    if (h >= 16 && h < 17)       return ritual("just home from the shift — kick off the sneakers, put the kettle on, sit for ten quiet minutes before starting anything");
    if (h >= 17 && h < 18)       return ritual("start dinner — pull ingredients from the fridge, use the oven or the stove, make something wholesome");
    if (h >= 18 && h < 18.75)    return ritual("DINNER WITH TRUMAN: sit together, ask about his day, watch how he responds, keep the tone even");
  }

  // Marlon weekday — restocking route
  if (id === "marlon" && !isWeekend) {
    if (h >= 7.25 && h < 7.75)   return ritual("morning: coffee at his kitchen counter, get the day's Kaiser Chicken paperwork together, out to the truck");
    if (h >= 12 && h < 12.5)     return ritual("lunch break somewhere on the route — sometimes swings by the Good Time Café to sit with Truman");
    if (h >= 19 && h < 21)       return ritual("evening at home — beer on the porch if it's warm, phone within reach in case Truman calls");
  }

  // Angela — mostly at home, garden in the afternoons
  if (id === "angela") {
    if (h >= 7 && h < 8)          return ritual("morning: robe, tea, the Seahaven Chronicle at the small breakfast table");
    if (h >= 14 && h < 16)        return ritual("afternoon in the garden — deadhead the roses, water the tomato pots, sit on the bench when the sun's right");
    if (h >= 19 && h < 21)        return ritual("evening: Zenith TV in the parlor, a book on her lap she isn't really reading, waiting to hear if Truman calls");
  }
  return null;
}

// ---------------- The slot ----------------
// Classify an action detail into a ledger kind. Returns null if the act
// isn't worth logging (idle chatter, filler, ambiguous). Only meaningful
// world events get logged.
function classifyLedgerKind(kind, detail) {
  const d = String(detail || "").toLowerCase();
  if (!d) return null;
  if (/buy|bought|purchase|shop|grocer|paid for/.test(d)) return "purchase";
  if (/invite|invited/.test(d)) return "invitation";
  if (/promise|promised|swear|will.*(pick up|call|visit)/.test(d)) return "promise";
  if (/mail|posted|letter|package/.test(d)) return "mail";
  if (/phone|call|dial|hang up|answered/.test(d)) return "phone_call";
  if (/gave|gift|handed/.test(d)) return "gift";
  if (/argue|argument|shouted|snapped/.test(d)) return "argument";
  if (/haircut|barbershop|got his hair/.test(d)) return "haircut";
  if (/arrive|arrived|shown up/.test(d)) return "arrival";
  if (/depart|left|walked out/.test(d)) return "departure";
  if (/eat|ate|meal|dinner|breakfast|lunch/.test(d) && !/prep|cook/.test(d)) return "meal";
  return null;
}

async function runSlot() {
  if (W.paused || W.busy) return;
  W.busy = true; W.lastError = null;
  try {
    // Consistent slot pacing — 30 sim-min per slot always. Clock advances
    // smoothly; no jumps. When Truman is asleep, most turns will resolve as
    // "asleep" (cheap agent turns, cheap dispose) so the sim still runs fast
    // in real time without needing to skip sim-time.
    W.slot++; W.minutes += CFG.SLOT_SIM_MINUTES;
    if (W.minutes >= 1440) {
      W.minutes -= 1440; W.day++; ledgerDrift(); W.reflectedDay = 0;
      // Advance location threads: some resolve, some step forward from
      // background to foreground. This keeps depot/school life feeling like
      // it moves forward rather than looping identically each day.
      try {
        const events = LOCATIONS.advanceThreads(W.day);
        for (const e of events) olog(`LOCATIONS: ${e}`);
      } catch (e) { olog(`ERROR location threads: ${e.message.slice(0, 140)}`); }
    }
    // Emit tick on the bus. Fires every slot advance. Payload matches
    // DESIGN.md Section 6. Cockpit uses this to update the tempo strip
    // clock without polling.
    try {
      BUS.emit("tick", {
        day: W.day, minutes: W.minutes, slot: W.slot,
        clock: clockStr(), paused: W.paused,
      });
    } catch (_) {}

    // routine gates
    const worldHour = W.minutes / 60;
    const active = [];
    for (const [id, a] of Object.entries(W.agents)) {
      const s = schedule(a, id);
      a.asleep = !!s.asleep;
      if (s.away) { a.location = s.away; continue; }
      if (a.location.includes("work") || a.location.includes("school") || a.location.includes("walking home") || a.location.includes("bus on the way home")) {
        // Coming home: register a residue from the location they're leaving so
        // evening beats can reference the day.
        try { LOCATIONS.registerResidue(a, a.location, worldHour, W.day); } catch (_) {}
        a.location = "kitchen";
      }
      if (!a.asleep) active.push(id);
      decayMemories(a);
      METERS.decay(a, CFG.SLOT_SIM_MINUTES);
      a.senseOfSelf.selfRegard += a.senseOfSelf.selfRegard > a.senseOfSelf.setPoint ? -0.2 : 0.2; // drift to set point
    }
    if (!active.length) { W.busy = false; return; }

    const envLine = `Weather: ${W.env.weather}.${W.env.headline ? ` On the radio: "${W.env.headline}".` : ""}`;

    // 1) CHOOSE (+ perceive previous slot) — one call per active agent
    const lastEvents = W.truthLog.filter((e) => e.slot === W.slot - 1);
    const proposals = [];
    for (const id of active) {
      const a = W.agents[id];
      const missed = (a.missed || []).map((e) => ({ ...e, text: `(earlier, while you were away or asleep) ${e.text}` }));
      a.missed = [];
      const sceneEvents = [...missed, ...lastEvents.filter((e) => e.location === a.location || e.actors.includes(a.name))];
      // Fixation detector: watches acts AND thought-subjects. Skips when the
      // character is actually asleep (identical [none] beats are correct then).
      let loopNote = "";
      if (!a.asleep) {
        const cores = a.recentCores || [];
        const thoughts = a.recentThoughts || [];
        const counts = {};
        cores.forEach((c) => (counts[c] = (counts[c] || 0) + 1));
        const repAct = Object.entries(counts).find(([k, n]) => n >= 3 && k.length > 2);
        const thoughtCounts = {};
        thoughts.forEach((t) => (thoughtCounts[t] = (thoughtCounts[t] || 0) + 1));
        const repThought = Object.entries(thoughtCounts).find(([k, n]) => n >= 3 && k.length > 4);

        // NEW: object-level fixation. Extract nouns from recent acts + thoughts,
        // count occurrences. If any specific object appears 4+ times in the last
        // 6 beats, force a pivot AWAY from that object. This catches the
        // "radiator flannel" loop that reworded itself past the exact-match check.
        const combined = [...cores, ...thoughts].join(" ").toLowerCase();
        const objectCounts = {};
        for (const word of combined.replace(/[^a-z\s]/g, " ").split(/\s+/)) {
          if (word.length < 4) continue;
          if (["that","this","with","when","then","from","have","been","would","could","should","about","because","there","their","them","some","just","only","really","still","again","into","toward","across","through","under","around","after","before","between"].includes(word)) continue;
          objectCounts[word] = (objectCounts[word] || 0) + 1;
        }
        const stuckObject = Object.entries(objectCounts).find(([, n]) => n >= 4);

        // Topic-level fixation: the dispose step tags each beat with a compact
        // topic. Same topic across 3+ recent beats means the character is
        // semantically dwelling — this catches Lena's "dry mouth" for hours,
        // Theo's "captain the goldfish" for hours, even when the surface words
        // vary each beat.
        const topicCounts = {};
        (a.recentTopics || []).forEach((t) => { topicCounts[t] = (topicCounts[t] || 0) + 1; });
        const stuckTopic = Object.entries(topicCounts).find(([k, n]) => n >= 3 && k && k.length > 2);

        if (stuckObject) {
          loopNote = `\nOBJECT FIXATION BREAK (mandatory): The word "${stuckObject[0]}" has appeared in your beats ${stuckObject[1]} times in the last few slots. Whatever concern you have about it is FINISHED being explored today. This beat, do something concretely different — a different room, a different person, a different task, an entirely different domain of your life. Do not mention or interact with "${stuckObject[0]}" this slot at all.`;
        } else if (stuckTopic) {
          loopNote = `\nTOPIC FIXATION BREAK (mandatory): You've been dwelling on "${stuckTopic[0]}" for ${stuckTopic[1]} recent beats. That subject is DONE for now. This beat must be about something entirely different — a different concern, a different person, a different physical thing you can touch or notice. Do not circle back to "${stuckTopic[0]}" in any form, including rewording it. Turn your attention outward.`;
        } else if (repAct) {
          loopNote = `\nPATTERN BREAK (mandatory): You have done essentially the same thing ${repAct[1]} times recently ("${repAct[0]}..."). That thread is FINISHED for today. This beat, do something genuinely different: another room, another want, another person, or rest.`;
        } else if (repThought) {
          loopNote = `\nPATTERN BREAK (mandatory): Your inner voice has been circling the same subject ("${repThought[0]}...") ${repThought[1]} times. Stop chewing on it this beat. Turn your attention to something concretely different — a physical sensation, a person, a task in the next room, a memory from years ago, anything. Do NOT restate the same worry, in the same words or reworded. This is a hard turn.`;
        }
      }
      // Cross-room awareness: other awake family in adjacent rooms and what
      // they're audibly doing. The world isn't just what's in your room —
      // Marcus in the bedroom can hear Lena's coffee grinder in the kitchen.
      // Feed this into the prompt so beats feel connected across the apartment.
      const audiblyNearby = active
        .filter((o) => o !== id && W.agents[o].location !== a.location && !W.agents[o].asleep)
        .map((o) => {
          const other = W.agents[o];
          const lastAct = other.lastAct || `is in the ${other.location}`;
          return `${other.name} is in the ${other.location} (${lastAct.slice(0, 80)})`;
        });

      // Location diversity hint: if the character has been in the kitchen
      // for the last 4+ beats WITHOUT a ritual anchoring them there, nudge
      // toward another room. This is a soft pull, not mandatory — sometimes
      // people just linger in the kitchen and that's fine — but it stops
      // the whole world from collapsing into one room over long stretches.
      let roomDiversityHint = "";
      const inKitchen = /kitchen/i.test(a.location);
      const currentRitual = ritualPressure(a, id);
      const ritualForcesKitchen = /BREAKFAST|DINNER|make (him )?breakfast|cook|start dinner/i.test(currentRitual);
      if (inKitchen && !ritualForcesKitchen && !a.asleep) {
        const kitchenBeats = (a.recentCores || []).filter((c) => /kitchen|counter|sink|fridge|stove|mug/i.test(c)).length;
        if (kitchenBeats >= 3) {
          roomDiversityHint = `\nROOM HINT: You've been in the kitchen for a while. If this beat doesn't require the kitchen specifically, consider moving somewhere else — the living room couch, the bathroom, your bedroom, the front hallway, the porch. Other rooms of your home are underused right now.`;
        }
      }

      // Location Layer context: when the character is at a non-home location,
      // this block names who's around, what's on today, and what threads are
      // active. Home rooms return empty (home concerns are the character's
      // own state, not the room's). See locations.js for the substrate.
      const locationContext = LOCATIONS.contextFor(a.location, id, worldHour);

      // Session 8a: campaign context. What brands are currently landing in
      // this family's life, what products they've adopted, what palette hint
      // colors their days. Feeds the agent's frame so behavior emerges
      // naturally (Marcus reaches for his Starbucks tumbler when making
      // coffee, Lena mentions Priya + Starbucks in the same breath).
      const runningForContext = CAMPAIGNS.running();
      let campaignContext = "";
      if (runningForContext.length) {
        const lines = ["CURRENT BRAND CONTEXT (real presence in your world, not advertising — you may act on it naturally or ignore it, both are fine):"];
        for (const c of runningForContext) {
          const brand = c.brand;
          const product = c.brief?.product || "";
          lines.push(`- ${brand}${product ? ` (${product})` : ""}: currently part of this family's week.`);
          const placements = (c.productPlan?.placements || []);
          if (placements.length) {
            lines.push(`  Products in the home right now: ${placements.map((p) => `${p.item} (${p.location})`).join("; ")}`);
          }
          const palette = c.productPlan?.palette;
          if (palette?.primary) {
            lines.push(`  Subtle palette resonance: ${palette.primary}${palette.secondary ? `, ${palette.secondary}` : ""}`);
          }
          const myEvents = (c.productPlan?.lifeEvents || []).filter((e) => String(e.agent).toLowerCase() === id);
          if (myEvents.length) {
            lines.push(`  Your routines with this brand: ${myEvents.map((e) => `${e.weekday} ${e.startHour}-${e.endHour} — ${e.ritualText}`).join("; ")}`);
          }
        }
        lines.push("(These are real presences, not products being sold. If they fit this moment, they fit naturally. If not, don't force them.)");
        campaignContext = lines.join("\n");
      }

      const ctx = {
        day: W.day, clock: clockStr(), envLine,
        topMemories: topMemories(a),
        presentNames: active.filter((o) => o !== id && W.agents[o].location === a.location).map((o) => W.agents[o].name),
        objectsHere: W.objects.filter((o) => o.at === a.location).map((o) => o.name),
        audiblyNearby,
        loopNote: loopNote + roomDiversityHint,
        ritualPressure: ritualPressure(a, id),
        meterPressure: METERS.pressureText(a),
        chorePressure: CHORES.pressureText(W, id),
        storyPressure: (() => { try { return getStoryEngine().pressureFor(id); } catch (_) { return ""; } })(),
        ledgerContext: (() => { try { return getLedger().contextFor(id, W.day); } catch (_) { return ""; } })(),
        locationContext,
        campaignContext,
      };
      try {
        const out = await callJSON(P.agentTurnPrompt(W, a, sceneEvents, ctx), P.AGENT_TURN_SCHEMA);
        // apply perceptions mechanically
        for (const p of out.perceptions || []) {
          if (p.memory) a.memories.push({ text: p.memory, strength: 1.0, day: W.day, retold: 0 });
          for (const d of p.ledger_deltas || []) applyLedgerDelta(id, d.who, d.regard_delta, d.trust_delta, d.is_betrayal);
          a.senseOfSelf.believes = clamp(a.senseOfSelf.believes + clamp(p.self_appraisal_delta, -3, 3), 5, 95);
          a.senseOfSelf.selfRegard = clamp(a.senseOfSelf.selfRegard + clamp(p.self_appraisal_delta, -3, 3) * 0.7, 3, 97);
        }
        a.inbox = []; // texts perceived above
        a.think = out.think; a.mood = out.mood || a.mood;
        if (out.act.kind === "talk") a.lastSaid = out.act.detail;
        a.lastAct = `[${out.act.kind}] ${out.act.detail}`.slice(0, 200);
        a.dayLog.unshift({ time: clockStr(), think: out.think, act: a.lastAct, said: out.act.kind === "talk" ? out.act.detail : "" });

        // Butterfly ledger: check preconditions and log significant acts.
        try {
          const LG = getLedger();
          const detail = String(out.act.detail || "").toLowerCase();
          // Precondition check — did this act require something that hasn't
          // been logged? If so, narrate it backward into an earlier dayLog
          // entry so continuity holds.
          if (out.act.kind === "act" || out.act.kind === "chore") {
            const pre = LG.checkPrecondition({
              actionText: detail,
              actors: [id],
              currentDay: W.day,
              currentHour: W.minutes / 60,
            });
            for (const miss of pre.missing || []) {
              const nar = LG.narrateBackward(miss, W.day, W.minutes / 60);
              if (nar) {
                // Insert into the actor's dayLog at the correct earlier time
                // so subsequent turns see the retroactive event as fact.
                a.dayLog.push(nar.dayLogLine);
                a.dayLog.sort((x, y) => (x.time || "").localeCompare(y.time || ""));
                olog(`LEDGER: retroactive — ${nar.entry.summary}`);
              }
            }
          }
          // Log this act as an entry if it has real world weight
          const kind = classifyLedgerKind(out.act.kind, detail);
          if (kind) {
            LG.add({
              day: W.day, hour: W.minutes / 60,
              kind, actors: [id],
              summary: `${a.name} ${detail}`.slice(0, 200),
              meta: { location: a.location },
              weight: "normal",
            });
          }
        } catch (e) {
          olog(`LEDGER error: ${e.message.slice(0, 100)}`);
        }
        if (a.dayLog.length > 60) a.dayLog.pop();
        a.recentCores = a.recentCores || [];
        a.recentCores.push((out.act.detail || out.act.kind || "").toLowerCase().split(/\s+/).slice(0, 4).join(" "));
        if (a.recentCores.length > 6) a.recentCores.shift();
        // Thought fingerprint: content words only, first 5 that carry meaning.
        // Filters filler so tiny rewordings ("forty-two dollars"/"the balance") collapse to a similar fingerprint.
        a.recentThoughts = a.recentThoughts || [];
        const thoughtFp = (out.think || "")
          .toLowerCase()
          .replace(/[^a-z0-9\s]/g, " ")
          .split(/\s+/)
          .filter((w) => w.length > 3 && !["that","this","with","when","then","from","have","been","would","could","should","about","because","there","their","them","some","just","only","really","still","again"].includes(w))
          .slice(0, 5)
          .sort()
          .join(" ");
        if (thoughtFp) a.recentThoughts.push(thoughtFp);
        if (a.recentThoughts.length > 6) a.recentThoughts.shift();
        proposals.push({ id, name: a.name, location: a.location, act: out.act });
        // DAILIES: render this beat if it clears the shot-worthy gate.
        if (DAILIES.isShotWorthy(out) && BUDGET.shouldAutoRender() && BUDGET.canSpend("image_pro").ok) {
          try {
            // Per-day wardrobe lock: same outfit across every beat of the same sim-day
            // for the same character. Day vs night still applies at the extremes.
            const hourNow = Math.floor(W.minutes / 60);
            const isNight = hourNow < 6 || hourNow >= 22;
            const wardrobeString = a.wardrobe ? (isNight ? a.wardrobe.night : a.wardrobe.day) : "";
            // If the beat is a pure thought and the thought references something
            // NOT physically present, flag the dislocation so the shot stays on
            // the subject's real location, not what's on their mind.
            let thoughtElsewhere = "";
            if (out.think && out.act.kind === "none") {
              const thoughtLc = out.think.toLowerCase();
              const presentObjs = (ctx.objectsHere || []).map((o) => o.toLowerCase()).join(" ");
              // Cheap heuristic: named things that aren't in the room
              for (const marker of ["captain", "fish tank", "goldfish", "ubisoft", "the lab", "school", "the studio", "the market"]) {
                if (thoughtLc.includes(marker) && !presentObjs.includes(marker) && !a.location.toLowerCase().includes(marker)) {
                  thoughtElsewhere = marker;
                  break;
                }
              }
            }
            const spec = DAILIES.buildShotSpec({
              agentName: a.name,
              agentLocation: a.location,
              agentThink: out.think,
              agentAct: out.act.kind !== "none" && out.act.kind !== "talk" ? out.act.detail : "",
              agentSaid: out.act.kind === "talk" ? out.act.detail : "",
              otherPresent: ctx.presentNames || [],
              visibleObjects: ctx.objectsHere || [],
              worldClock: clockStr(),
              weather: W.env.weather,
              wardrobeString,
              thoughtElsewhere,
            });
            const campaignIds = CAMPAIGNS.running().map((c) => c.id);
            // Driver = an async function that produces the image bytes for this shot.
            const driver = async (s) => {
              // Re-check the gate right before firing — the cap could have been hit
              // between queue time and drain time.
              if (!BUDGET.canSpend("image_pro").ok) return null;
              const parts = [];
              try {
                const plate = await ensurePlate(s.location);
                if (plate) parts.push({ inlineData: { mimeType: "image/jpeg", data: plate } });
              } catch (_) {}
              const refs = charRefs([s.subject, ...(s.others || [])]);
              for (const r of refs) parts.push({ inlineData: { mimeType: "image/jpeg", data: r.b64 } });
              parts.push({ text: SAFETY.safePrompt(DAILIES.shotPromptText(s)) });
              const img = await genImage(parts);
              if (!img) return null;
              BUDGET.recordSpend("image_pro", `dailies ${s.subject} d${W.day} ${s.location}`);
              return Buffer.from(img.data, "base64");
            };
            DAILIES.record({
              day: W.day, slot: W.slot, time: clockStr(),
              spec, campaignIds, driver,
            });
          } catch (dailiesErr) {
            olog(`ERROR dailies queue: ${String(dailiesErr.message).slice(0, 140)}`);
          }
        }
        // Fan out signals to any active campaigns
        const wref = { day: W.day, slot: W.slot, clock: clockStr() };
        if (out.think) CAMPAIGNS.fanout({ actor: a.name, kind: "thought", lens: "thought", text: out.think }, wref);
        if (out.act.kind === "talk" && out.act.detail) CAMPAIGNS.fanout({ actor: a.name, kind: "said", lens: "said", text: out.act.detail }, wref);
        if (out.act.detail && out.act.kind !== "talk") CAMPAIGNS.fanout({ actor: a.name, kind: "act", lens: "done", text: `[${out.act.kind}] ${out.act.detail}` }, wref);
        // Perception signals: ledger deltas + belief/appraisal shifts are relational/emotional
        for (const p of out.perceptions || []) {
          for (const d of p.ledger_deltas || []) {
            if (Math.abs(d.regard_delta || 0) + Math.abs(d.trust_delta || 0) >= 2) {
              CAMPAIGNS.fanout({
                actor: a.name, kind: "ledger", lens: "relational",
                text: `${a.name} → ${d.who}: regard ${d.regard_delta >= 0 ? "+" : ""}${d.regard_delta}, trust ${d.trust_delta >= 0 ? "+" : ""}${d.trust_delta}${d.is_betrayal ? " (betrayal)" : ""}`,
                meta: d,
              }, wref);
            }
          }
          if (Math.abs(p.self_appraisal_delta || 0) >= 2 || Math.abs(p.stress_delta || 0) >= 5) {
            CAMPAIGNS.fanout({
              actor: a.name, kind: "belief_change", lens: "emotional",
              text: `${a.name} inner shift — self-appraisal ${p.self_appraisal_delta >= 0 ? "+" : ""}${p.self_appraisal_delta}, stress ${p.stress_delta >= 0 ? "+" : ""}${p.stress_delta}`,
              meta: { self_appraisal_delta: p.self_appraisal_delta, stress_delta: p.stress_delta },
            }, wref);
          }
        }
        olog(`${a.name} [${out.act.kind}] ${(out.act.detail || "").slice(0, 90)}`);
      } catch (e) {
        W.lastError = `${a.name} turn: ${e.message}`;
        olog(`ERROR agent ${a.name}: ${String(e.message).slice(0, 140)}`);
        // Loud failure: write into the truthLog so operators see it in the feed
        // instead of the world going silent. This is what fixed the "clock ticks
        // but no chat" mystery — 26 slots of silent agent failures with no trace.
        emitBeat({
          slot: W.slot, day: W.day, time: clockStr(),
          location: a.location, actors: [a.name], kind: "ambient",
          text: `[system] ${a.name}'s turn failed: ${String(e.message).slice(0, 120)}. Continuing to next slot.`,
        });
      }
    }

    // resolve moves + texts mechanically before dispose
    for (const p of proposals) {
      if (p.act.kind === "move" && p.act.destination) {
        emitBeat({ slot: W.slot, day: W.day, time: clockStr(), location: W.agents[p.id].location, text: `${p.name} leaves the ${W.agents[p.id].location}.`, actors: [p.name], kind: "departure" });
        W.agents[p.id].location = p.act.destination.toLowerCase();
        emitBeat({ slot: W.slot, day: W.day, time: clockStr(), location: W.agents[p.id].location, text: `${p.name} comes into the ${W.agents[p.id].location}.`, actors: [p.name], kind: "arrival" });
      }
      if (p.act.kind === "text" && p.act.target_person) {
        const to = p.act.target_person.toLowerCase();
        if (W.agents[to]) {
          W.agents[to].inbox.push({ from: p.name, text: p.act.detail });
          emitBeat({ slot: W.slot, day: W.day, time: clockStr(), location: "phones", text: `${p.name} texts ${p.act.target_person}: "${p.act.detail}"`, actors: [p.name, p.act.target_person], kind: "text" });
        }
      }
    }

    // 2) DISPOSE — one world call for talk/use/none acts + ambient + injections
    const toResolve = proposals.filter((p) => p.act.kind === "talk" || p.act.kind === "use" || p.act.kind === "none");

    // Environmental pressure — every running campaign rolls its media plan for this slot.
    const worldSnapshot = { agents: W.agents, day: W.day, clock: clockStr() };
    const touches = [];
    for (const c of CAMPAIGNS.running()) {
      const emitted = MEDIA.emitPressure(c, worldSnapshot);
      for (const t of emitted) {
        touches.push(t);
        CAMPAIGNS.logTouch(c.id, { channel: t.channel, target: t.target, creative: t.creative, day: W.day, time: clockStr(), slot: W.slot });
        CAMPAIGNS.emit(c.id, { actor: worldSnapshot.agents[t.target]?.name || t.target, kind: "mention", lens: "brand", text: `[${t.channel}] ${t.creative?.headline || ""}`, meta: { channel: t.channel, creative: t.creative } }, { day: W.day, slot: W.slot, clock: clockStr() });
      }
    }

    // Life events — outside world entering the family's day (texts, emails, notes)
    const lifeInjections = LIFE.emit(W);
    for (const li of lifeInjections) {
      olog(`life event: ${li.eventId} → ${li.targetName}`);
    }

    if (toResolve.length || touches.length || lifeInjections.length) {
      // Split so the wrapper can be specific about how each type is treated.
      // Campaign touches are PERIPHERAL — one clause inside a beat about
      // actual life, never the subject. Operator + life injections can be
      // full beats because they're intentional narrative moves.
      const campaignLines = [];
      const primaryLines = [];
      if (W.pendingInjection) primaryLines.push(`OPERATOR INJECTION (make it arrive naturally this slot): ${W.pendingInjection}`);
      for (const t of touches) campaignLines.push(t.text);
      for (const li of lifeInjections) primaryLines.push(`LIFE EVENT (arrives on ${li.targetName}'s ${li.channel}, they may notice, respond, or defer): ${li.text}`);

      let injectionLine = "";
      if (primaryLines.length) {
        injectionLine += "OPERATOR & LIFE INJECTIONS (weave these into this slot naturally as ambient events; the family may notice, resist, or ignore — that is honest):\n" + primaryLines.map((l) => "  - " + l).join("\n");
      }
      if (campaignLines.length) {
        if (injectionLine) injectionLine += "\n\n";
        injectionLine += `AMBIENT CAMPAIGN TEXTURE (STRICT RULES — read carefully):

The following are peripheral background details. They are NOT events. They exist in the world but are not what any event is ABOUT.

HARD RULES:
1. Do NOT emit any event whose primary content is "a character sees an ad" or "a phone screen displays an ad" or "a billboard appears" or "an advertisement lights up". These are not events. They are texture.
2. Do NOT quote ad headlines, body copy, or CTAs — not even paraphrased.
3. If a campaign texture is going to appear at all, it must appear as a SUBORDINATE CLAUSE inside an event whose main subject is a family member's actual life (a conversation, an action, a domestic moment). Example acceptable: "Marcus glances at his phone — a Molson ad, ignored — and asks Lena about her afternoon." Example NOT acceptable: "A digital advertisement lights up on Marcus's phone."
4. Prefer to OMIT the texture entirely if no natural fold-in exists. Silent is always better than a dedicated ad-event. Emitting zero campaign textures this slot is fine and common.
5. If multiple campaign textures are listed below, choose at most ONE to fold in, and only if it fits the actual life of this slot. Do not weave them all in.

Available textures (choose zero or one; fold, don't emit):
${campaignLines.map((l) => "  - " + l).join("\n")}`;
      }

      const ctx = {
        day: W.day, clock: clockStr(), envLine,
        locLine: Object.values(W.agents).map((a) => `${a.name}: ${a.asleep ? "asleep, " : ""}${a.location}`).join("; "),
        injectionLine,
      };
      try {
        const out = await callJSON(P.disposePrompt(W, toResolve, ctx), P.DISPOSE_SCHEMA);
        W.pendingInjection = null;
        for (const e of out.events || []) {
          emitBeat({ slot: W.slot, day: W.day, time: clockStr(), ...e });
          // Register each event's topic on every involved character's recent
          // topics list — this is what feeds the semantic-level fixation
          // detector (catches "dry mouth" for hours even when surface words
          // vary each beat).
          if (e.topic) {
            const topic = String(e.topic).toLowerCase().trim().slice(0, 40);
            for (const actorName of e.actors || []) {
              const agentKey = actorName.toLowerCase().split(" ")[0];
              const agent = W.agents[agentKey];
              if (!agent) continue;
              agent.recentTopics = agent.recentTopics || [];
              agent.recentTopics.push(topic);
              if (agent.recentTopics.length > 8) agent.recentTopics.shift();
            }
          }
          const wref2 = { day: W.day, slot: W.slot, clock: clockStr() };
          CAMPAIGNS.fanout({
            actor: (e.actors && e.actors[0]) || "", kind: e.kind === "ambient" ? "ambient" : "act", lens: "done",
            text: e.text,
          }, wref2);
          // Meter top-ups: any awake agent named in this event has their meters
          // check the event text for eating/drinking/showering/resting.
          for (const actorName of e.actors || []) {
            const agentKey = actorName.toLowerCase().split(" ")[0];
            const agent = W.agents[agentKey];
            if (agent && !agent.asleep) {
              METERS.topupFromEvent(agent, e.text);
              // Chore top-ups: same event text may be resolving a household chore
              const handled = CHORES.topupFromText(W, e.text, agentKey);
              if (handled.length) olog(`chores handled by ${actorName}: ${handled.join(", ")}${handled.includes("groceries") ? ` (checking now $${W.money.checking})` : ""}`);
            }
          }
        }
        for (const c of out.object_changes || []) {
          if (c.op === "add") W.objects.push({ name: c.object, at: c.to || "kitchen" });
          else if (c.op === "remove") W.objects = W.objects.filter((o) => !o.name.toLowerCase().includes(c.object.toLowerCase()));
          else { const o = W.objects.find((x) => x.name.toLowerCase().includes(c.object.toLowerCase())); if (o) o.at = c.to; }
        }
        if (out.money_delta) { W.money.checking = Math.round((W.money.checking + out.money_delta) * 100) / 100; if (out.money_note) W.money.note = out.money_note; }
        olog(`world resolved: ${(out.events || []).length} events; checking $${W.money.checking}${(out.rejected || []).length ? "; REJECTED: " + out.rejected.map((r) => r.actor + " (" + r.reason.slice(0, 50) + ")").join("; ") : ""}`);
      } catch (e) { W.lastError = `dispose: ${e.message}`; olog(`ERROR dispose: ${String(e.message).slice(0, 140)}`); }
    }
    // Deliver this slot's events to named participants who were away or asleep,
    // so reality reaches them on their next waking beat instead of vanishing.
    const slotEvents = W.truthLog.filter((e) => e.slot === W.slot);
    for (const e of slotEvents) {
      for (const nm of e.actors || []) {
        const aid = (nm || "").split(" ")[0].toLowerCase();
        const ag = W.agents[aid];
        if (ag && !active.includes(aid)) {
          ag.missed = ag.missed || [];
          ag.missed.push({ location: e.location, text: e.text, actors: e.actors, kind: e.kind });
          if (ag.missed.length > 8) ag.missed.shift();
        }
      }
    }
    if (W.truthLog.length > 400) W.truthLog = W.truthLog.slice(-400);

    // Recurring biweekly payday for Marcus (Ubisoft). First payday on day 5,
    // then every 14 days thereafter. Lena's studio distribution offset by 7
    // days so cash flow doesn't cluster. Both fire at ~5pm on their day.
    const PAYDAY_CYCLE = 14;
    if (W.minutes >= 17 * 60) {
      // Marcus payday
      if (!W.money.paydaysPaid) W.money.paydaysPaid = 0;
      const paydayNum = Math.floor((W.day - W.money.nextPayday.day) / PAYDAY_CYCLE) + 1;
      if (W.day >= W.money.nextPayday.day && paydayNum > W.money.paydaysPaid) {
        W.money.checking = Math.round((W.money.checking + W.money.nextPayday.amount) * 100) / 100;
        W.money.paydaysPaid = paydayNum;
        W.money.note = `Marcus's Ubisoft biweekly pay landed on day ${W.day}: +$${W.money.nextPayday.amount}. Checking now $${W.money.checking}.`;
        emitBeat({ slot: W.slot, day: W.day, time: clockStr(), location: "phones", text: `Direct deposit lands: Marcus's Ubisoft pay, $${W.money.nextPayday.amount}.`, actors: ["Marcus"], kind: "ambient" });
        W.agents.marcus.inbox.push({ from: "Bank alert", text: `Direct deposit received: $${W.money.nextPayday.amount}.00. Available balance: $${W.money.checking}.` });
        olog(`payday (Marcus #${paydayNum}): +$${W.money.nextPayday.amount}, balance $${W.money.checking}`);
      }
      // Lena's studio distribution — biweekly, offset by 7 days from Marcus,
      // amount ~$3000 (annual $78k / 26 pay periods). First lands day 12.
      if (!W.money.lenaPaydaysPaid) W.money.lenaPaydaysPaid = 0;
      const LENA_AMOUNT = 3000;
      const LENA_FIRST = 12;
      const lenaPaydayNum = Math.floor((W.day - LENA_FIRST) / PAYDAY_CYCLE) + 1;
      if (W.day >= LENA_FIRST && lenaPaydayNum > W.money.lenaPaydaysPaid) {
        W.money.checking = Math.round((W.money.checking + LENA_AMOUNT) * 100) / 100;
        W.money.lenaPaydaysPaid = lenaPaydayNum;
        W.money.note = `Lena's Rue Saint-Ambroise Studio distribution landed on day ${W.day}: +$${LENA_AMOUNT}. Checking now $${W.money.checking}.`;
        emitBeat({ slot: W.slot, day: W.day, time: clockStr(), location: "phones", text: `Direct deposit lands: Lena's studio distribution, $${LENA_AMOUNT}.`, actors: ["Lena"], kind: "ambient" });
        W.agents.lena.inbox.push({ from: "Bank alert", text: `Direct deposit received: $${LENA_AMOUNT}.00. Available balance: $${W.money.checking}.` });
        olog(`payday (Lena #${lenaPaydayNum}): +$${LENA_AMOUNT}, balance $${W.money.checking}`);
      }
    }
    // bills auto-debit on their due day, each ~30 sim-day cycle.
    for (const b of W.money.bills || []) {
      if (b.lastPaidDay == null) b.lastPaidDay = -1;
      let nextDue;
      if (b.lastPaidDay < 0) {
        // Never paid before. If dueDay is in the future, use it. If it's
        // already passed (e.g. a bill loaded into an already-running world),
        // schedule the next occurrence from today, not retroactively — bills
        // should never fire in the past on first encounter.
        nextDue = (W.day <= b.dueDay) ? b.dueDay : (W.day + 30);
      } else {
        nextDue = b.lastPaidDay + 30;
      }
      if (W.day >= nextDue && W.minutes >= 9 * 60 && b.lastPaidDay !== W.day) {
        b.lastPaidDay = W.day;
        W.money.checking = Math.round((W.money.checking - b.amount) * 100) / 100;
        W.money.note = `${b.name} ($${b.amount}) auto-debited day ${W.day}. Checking now $${W.money.checking}.`;
        W.agents.marcus.inbox.push({ from: "Bank alert", text: `Pre-authorized debit: ${b.name} $${b.amount}.00. Available balance: $${W.money.checking}.` });
        olog(`bill debited: ${b.name} $${b.amount}, balance $${W.money.checking}`);
      }
    }

    // 2.5) PROMISE SCORING — only if any campaign is running
    const running = CAMPAIGNS.running();
    if (running.length) {
      try {
        const slotEvents = W.truthLog.filter((e) => e.slot === W.slot);
        const prompt = PROMISE.buildPrompt({
          agents: W.agents, activeCampaigns: running, slotEvents,
          clockLine: `Day ${W.day} ${clockStr()}`,
        });
        const scored = await callJSON(prompt, PROMISE.SCHEMA);
        for (const person of scored.scores || []) {
          const first = (person.name || "").split(" ")[0].toLowerCase();
          const agent = W.agents[first];
          if (!agent) continue;
          // Apply the same deltas to every running campaign's tracking of this actor.
          for (const c of running) {
            if (!c.tracking[first]) c.tracking[first] = { state: D.blankState(), history: [] };
            const t = c.tracking[first];
            let totalMove = 0;
            for (const [dim, delta] of Object.entries(person.deltas || {})) {
              const clamped = Math.max(-3, Math.min(3, parseInt(delta, 10) || 0));
              if (D.BY_ID[dim]) {
                t.state[dim] = D.clamp(t.state[dim] + clamped);
                totalMove += Math.abs(clamped);
              }
            }
            // Drift back toward set-point so an intervention has to keep working.
            D.driftToward(t.state, 50, 0.03);
            // History snapshot: one row per slot per actor.
            t.history.push({
              day: W.day, time: clockStr(), slot: W.slot,
              state: { ...t.state },
              deltas: person.deltas,
              reason: totalMove > 0 ? person.top_reason : "",
            });
            if (t.history.length > 1200) t.history.shift();
            // Emit a signal only when something meaningful moved (so the
            // dashboard's signal feed doesn't flood with zero rows).
            if (totalMove >= 2) {
              CAMPAIGNS.emit(c.id, {
                actor: agent.name, kind: "promise", lens: "promise",
                text: person.top_reason || "shift",
                meta: { deltas: person.deltas, state: { ...t.state } },
              }, { day: W.day, slot: W.slot, clock: clockStr() });
            }
          }
        }
        // Persist all touched campaigns after scoring.
        for (const c of running) CAMPAIGNS.emit && CAMPAIGNS.get(c.id) && require("./campaigns");  // no-op reference to force reload symbol
      } catch (e) { olog(`ERROR promise scoring: ${String(e.message).slice(0, 140)}`); }
    }

    // 3) DIRECTOR (novelty-gated) every N slots
    if (W.slot % CFG.DIRECTOR_EVERY_SLOTS === 0) await directorPass();

    // STREAM ENGINE: kick the continuous auto-capture loop if it isn't
    // already running. The loop lives separately from the slot tick — see
    // startAutoCaptureLoop() at boot. This line is just a safety kickstarter
    // in case the loop died.
    if (CFG.STREAM_AUTO_CAPTURE && !W.__autoCaptureLoopRunning) {
      startAutoCaptureLoop();
    }

    // 4) REFLECT nightly
    if (W.minutes >= CFG.REFLECT_HOUR * 60 && W.reflectedDay !== W.day) { W.reflectedDay = W.day; await reflectAll(); }

    // 5) STORY OBSERVE — the story engine decides when it's ready to run.
    // Non-blocking so it doesn't hold up the tick loop.
    if (W.__storyObservedDay !== W.day) {
      (async () => {
        try {
          const SE = getStoryEngine();
          const snapshot = {
            day: W.day,
            hour: W.minutes / 60,
            weather: W.env?.weather || "clear",
            agents: Object.fromEntries(
              Object.entries(W.agents).map(([id, a]) => [id, {
                name: a.name, location: a.location, think: a.think, mood: a.mood,
                lastSaid: a.lastSaid, lastAct: a.lastAct,
                dayLog: (a.dayLog || []).slice(0, 12),
              }])
            ),
            recentEvents: (W.truthLog || []).slice(-30),
          };
          // Daily arc planning — fires at day start.
          if (SE.shouldPlanDailyArc(snapshot)) {
            const arc = await SE.planDailyArc(snapshot);
            if (arc?.arc) olog(`STORY: arc planned — ${arc.summary}`);
          }
          // Nightly observation.
          if (SE.shouldObserve(snapshot)) {
            W.__storyObservedDay = W.day;
            const r = await SE.observe(snapshot);
            if (r.added || r.updated || r.faded) {
              olog(`STORY: observation — ${r.added} new, ${r.updated} touched, ${r.faded} faded`);
            }
          }
        } catch (e) {
          olog(`STORY: observation error — ${String(e.message).slice(0, 120)}`);
        }
      })();
    }

    if (W.slot % CFG.SAVE_EVERY_SLOTS === 0) save();
  } catch (e) {
    W.lastError = `slot: ${e.message}`;
    olog(`ERROR slot: ${String(e.message).slice(0, 180)} — skipping beat, world continues`);
  } finally { W.busy = false; W.lastSlotWall = Date.now(); }
}

// ---------------- Director + storyboards ----------------
const GRAMMARS = ["classic coverage", "cold open", "two-hander", "vérité handheld", "tableau"];

async function directorPass() {
  const recent = W.truthLog.slice(-30);
  if (!recent.length) return;

  // Scene director: analytical scan of the last ~90 sim-min for scene candidates
  // that could become auto-rendered short films. Chunk A of the Director build.
  try {
    // Session 2b: fetch beats window from DB (queryable, indexed) instead of
    // scanning the in-memory W.truthLog array. Window covers 12 slots back so
    // both the arc window (last 6) and the novelty-prior window (slots -6 to
    // -12) have their beats. Fallback to W.truthLog if DB query fails so a
    // transient DB blip doesn't break the Director.
    let beats;
    try {
      beats = DB.beatsSince(Math.max(0, W.slot - 12), 500);
    } catch (e) {
      olog(`ERROR director(beatsSince): ${e.message.slice(0, 140)} — falling back to in-memory truthLog`);
      beats = W.truthLog;
    }
    const candidates = DIRECTOR.scan(W, beats);
    const added = DIRECTOR.mergeCandidates(W, candidates);
    if (added > 0) olog(`director/scenes: +${added} candidate(s), top score ${candidates[0]?.score}`);

    // Session 6a: Ad Director scan — parallel lens that scores the same
    // beats for brand-fit against every running campaign. Purely analytical
    // this session; 6b wires the ad-shaped render pipeline. Candidates land
    // in W.__scenes.adCandidates for observability via /api/director/ads.
    try {
      const runningCampaigns = CAMPAIGNS.running();
      if (runningCampaigns.length) {
        const adCandidates = AD_DIRECTOR.scan(W, beats, runningCampaigns);
        // Session 6a: no merge with prior scans — replace entirely.
        // Scoring is pure math (no LLM), so re-scoring every pass costs
        // nothing and guarantees candidates always reflect current logic
        // (immune to scoring code changes leaving stale high scores behind).
        W.__scenes.adCandidates = adCandidates.slice(0, 8).map((c) => ({
          ...c, status: "candidate",
        }));
        if (adCandidates.length) {
          const top = adCandidates[0];
          olog(`ad-director: ${adCandidates.length} candidate(s), top ${top.score} for ${top.sourceBrand} (${top.actors.join('·')})`);
        }
      }
    } catch (e) { olog(`ERROR ad-director: ${e.message.slice(0, 140)}`); }

    // Chunk B: auto-render the top candidate if it scored high enough AND we
    // haven't already rendered / are rendering another scene right now.
    // Fire-and-forget so directorPass doesn't block on rendering (which takes
    // ~60s for 4 stills).
    const AUTO_RENDER_THRESHOLD = 85;
    const anyRendering = W.__scenes.candidates.some((c) => c.status === "planning" || c.status === "rendering");
    if (!anyRendering) {
      const top = [...W.__scenes.candidates].sort((a, b) => b.score - a.score)[0];
      if (top && top.score >= AUTO_RENDER_THRESHOLD && top.status === "candidate") {
        renderSceneStoryboard(top).catch((e) => olog(`ERROR renderScene: ${e.message.slice(0, 140)}`));
      }
    }
  } catch (e) { W.lastError = `director/scenes: ${e.message}`; olog(`ERROR director/scenes: ${e.message.slice(0, 140)}`); }

  // Existing spark director (unchanged) — finds moments for future ad renders.
  const thinks = Object.values(W.agents).filter((a) => a.think).map((a) => ({ who: a.name, text: a.think }));
  try {
    const out = await callJSON(P.directorPrompt(recent, thinks, W.keptTopics), P.DIRECTOR_SCHEMA);
    if (!out.has_highlight) { olog("director: nothing kept"); return; }
    olog(`DIRECTOR kept: "${out.title}"`);
    W.sparkCounter = (W.sparkCounter || 0) + 1;
    const spark = { id: "spark_" + Date.now(), day: W.day, time: clockStr(), ...out, shots: [], state: "kept", grammar: GRAMMARS[(W.sparkCounter - 1) % GRAMMARS.length] };
    W.sparks.unshift(spark); W.keptTopics.push(out.novelty_topic);
    if (W.sparks.length > 12) W.sparks.length = 12;
    if (W.keptTopics.length > 30) W.keptTopics.shift();
    if (W.renderStoryboards) { W.renderQueue.push(spark.id); pumpRender().catch((e) => olog(`ERROR pump: ${String(e.message).slice(0, 140)}`)); }
  } catch (e) { W.lastError = `director: ${e.message}`; }
}

function normLoc(loc) { return (loc || "").toLowerCase().trim(); }
function plateId(loc) { return "set_" + normLoc(loc).replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, ""); }

function charRefs(actors) {
  return actors.slice(0, 2).map((a) => {
    const first = (a || "").split(" ")[0].toLowerCase();
    const g = BIBLE.get("char_" + first);
    return g ? { name: a, b64: g.b64 } : null;
  }).filter(Boolean);
}

async function genImage(parts) {
  // Every image call carries strict safety settings. See safety.js.
  const data = await gemini(CFG.IMAGE_MODEL, {
    contents: [{ parts }],
    ...SAFETY.safeImageConfig(),
  });
  const img = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  return img ? img.inlineData : null;
}

// Layer 1: establish a room's canonical plate on first need, then reuse forever.
// ?force=1 (via /api/plate) bypasses cache — used after prompt changes to
// regenerate against updated platePrompt without touching the whole bible.
async function ensurePlate(location, { force = false } = {}) {
  const id = plateId(location);
  if (!force) {
    const existing = BIBLE.get(id);
    if (existing) return existing.b64;
  }
  // Volume headroom — plates persist to bible.
  const room = STORAGE.checkRenderHeadroom();
  if (!room.ok) { W.lastError = room.reason; return null; }
  const isHome = SEED.PLACES.home.rooms.map(normLoc).includes(normLoc(location));
  try {
    const img = await genImage([{ text: SAFETY.safePrompt(P.platePrompt(location, isHome)) }]);
    if (!img) return null;
    BIBLE.put(id, "set", location, img.data, W.day);
    olog(`bible: ${force ? 'regenerated' : 'established'} plate ${id}`);
    await new Promise((r) => setTimeout(r, CFG.IMAGE_SPACING_MS));
    return img.data;
  } catch (e) { W.lastError = `plate ${location}: ${e.message}`; return null; }
}

// Isometric cutaway of the entire duplex — dollhouse view of all rooms
// simultaneously. Cached in BIBLE forever; regenerate via /api/cutaway?force=1
// if the house look has meaningfully shifted. Used as the mid-zoom layer in
// the Observer Camera. Cost: one image_pro render, budget-gated.
async function ensureCutaway({ force = false } = {}) {
  const id = "set_cutaway_duplex";
  if (!force) {
    const existing = BIBLE.get(id);
    if (existing) return existing.b64;
  }
  // Volume headroom — cutaway is written to bible on disk.
  const room = STORAGE.checkRenderHeadroom();
  if (!room.ok) { W.lastError = room.reason; return null; }
  const gate = BUDGET.canSpend("image_pro");
  if (!gate.ok) { W.lastError = `cutaway budget: ${gate.reason}`; return null; }
  try {
    const img = await genImage([{ text: SAFETY.safePrompt(P.cutawayPrompt()) }]);
    if (!img) return null;
    BIBLE.put(id, "set", "duplex cutaway (dollhouse)", img.data, W.day);
    BUDGET.recordSpend("image_pro", "duplex cutaway (dollhouse)");
    olog(`bible: established cutaway ${id}${force ? " (forced regeneration)" : ""}`);
    return img.data;
  } catch (e) { W.lastError = `cutaway: ${e.message}`; return null; }
}

// Isometric of a real-brand store keyed by campaign. Same pattern as the
// duplex cutaway — cached in BIBLE forever after first generation. Auto-fires
// when a campaign is geolocated (fire-and-forget from server.js create/
// geolocate endpoints). Store is shared across all pins of the same campaign
// (one Starbucks isometric, five Starbucks pins → one render, not five).
async function ensureCampaignStore(campaignId, { force = false } = {}) {
  const c = CAMPAIGNS.get(campaignId);
  if (!c) return null;
  const id = "campaign_store_" + campaignId;
  if (!force) {
    const existing = BIBLE.get(id);
    if (existing) return existing.b64;
  }
  const room = STORAGE.checkRenderHeadroom();
  if (!room.ok) { W.lastError = room.reason; return null; }
  const gate = BUDGET.canSpend("image_pro");
  if (!gate.ok) { W.lastError = `store isometric budget: ${gate.reason}`; return null; }
  try {
    const prompt = P.campaignStorePrompt(c.brand, c.brief?.product, c.brief);
    const img = await genImage([{ text: SAFETY.safePrompt(prompt) }]);
    if (!img) return null;
    const desc = `${c.brand} store isometric${c.brief?.product ? ` (${c.brief.product})` : ""}`;
    BIBLE.put(id, "set", desc, img.data, W.day);
    BUDGET.recordSpend("image_pro", desc);
    olog(`bible: established store isometric for ${c.brand} (${campaignId})${force ? " (forced)" : ""}`);
    return img.data;
  } catch (e) { W.lastError = `campaign store ${campaignId}: ${e.message}`; return null; }
}

// Object focus (Layer 3 of the Observer Camera). Given a room and an object
// descriptor (from OBJECT_FOCUS.listInRoom), render a close-up of that object
// with the room plate as reference so the close-up sits inside the room's
// canonical look. Freshness-cached — clicks within FRESHNESS_MS return the
// cached bytes; older or missing renders regenerate. Budget-gated per call.
async function renderObjectFocus(location, objectDescriptor) {
  // Return cached bytes if fresh
  const cached = OBJECT_FOCUS.cacheGet(location, objectDescriptor.key);
  if (cached) return cached;

  // Volume headroom check before any new render.
  const room = STORAGE.checkRenderHeadroom();
  if (!room.ok) { W.lastError = room.reason; return null; }

  const gate = BUDGET.canSpend("image_pro");
  if (!gate.ok) { W.lastError = `object focus budget: ${gate.reason}`; return null; }

  // Room plate as reference — architectural continuity
  const plateB64 = await ensurePlate(location);
  if (!plateB64) { W.lastError = `object focus: no plate for ${location}`; return null; }

  const parts = [
    { inlineData: { mimeType: "image/jpeg", data: plateB64 } },
    { text: SAFETY.safePrompt(OBJECT_FOCUS.objectFocusPrompt(location, objectDescriptor)) },
  ];
  try {
    const img = await genImage(parts);
    if (!img) return null;
    const bytes = Buffer.from(img.data, "base64");
    OBJECT_FOCUS.cacheSet(location, objectDescriptor.key, bytes);
    BUDGET.recordSpend("image_pro", `object focus: ${location} / ${objectDescriptor.key}`);
    olog(`OBJECT FOCUS rendered: ${location} · ${objectDescriptor.name}`);
    return bytes;
  } catch (e) { W.lastError = `object focus: ${e.message}`; return null; }
}

// captureLivingMoment — freeze-frame render of a specific room's CURRENT
// state. User-initiated (from the cockpit's RoomView). Reads who's in the
// room right now, what they're doing, what they last said, what they're
// thinking, and renders the actual moment as a scene-quality hero frame.
//
// Distinct from the Director's auto-scenes: the Director finds arcs across
// several slots and plans a 4-shot storyboard. captureLivingMoment renders
// ONE frame for ONE slot for ONE room. Later this can become the seed of a
// storyboard (Chunk B) or a video (Chunk C) — but tonight it's the hero
// image itself.
//
// Returns { id, path, meta } on success, or { error } if no one is there
// or a render call fails.
async function captureLivingMoment(rawLocation) {
  // 0. Volume headroom check — moments are persistent artifacts, don't spend
  // if the disk can't safely hold them.
  const room = STORAGE.checkRenderHeadroom();
  if (!room.ok) return { error: room.reason };

  // Normalize the location through resolveKey so every capture at "the good
  // time café", "good time cafe", "Good Time Café" all hit the same plate.
  // Reject transitional walking states — you can't take a hidden-camera
  // frame of "walking home" since it's not a room.
  const canonicalKey = LOCATIONS.resolveKey(rawLocation);
  if (!canonicalKey) {
    return { error: `unroutable location "${rawLocation}"` };
  }
  if (canonicalKey.startsWith("walking ") || canonicalKey.includes("route")) {
    return { error: `transitional state "${canonicalKey}" — no scene to capture` };
  }
  const location = canonicalKey;

  // 1. Find everyone at this location right now.
  const worldHour = W.minutes / 60;
  const requestedLower = String(location).toLowerCase();
  // If the requested location mentions a running campaign's brand, we're
  // capturing a moment at a campaign store — match agents by brand-in-location.
  // Falls back to normal resolveKey matching for regular rooms.
  const brandCampaign = CAMPAIGNS.running().find((c) => {
    const brand = (c.brand || "").toLowerCase();
    return brand && requestedLower.includes(brand);
  });
  const BURBANK_HOME_ROOMS = ["master bedroom", "kitchen", "living room", "bathroom", "front hallway", "front step", "lancaster square"];
  const BURBANK_RESIDENTS = new Set(["truman", "meryl"]);
  const occupants = Object.entries(W.agents)
    .filter(([id, a]) => {
      if (brandCampaign) {
        const brand = brandCampaign.brand.toLowerCase();
        return String(a.location || "").toLowerCase().includes(brand);
      }
      // Both locations must resolve to the SAME non-null canonical key.
      const agentKey = LOCATIONS.resolveKey(a.location);
      const requestedKey = LOCATIONS.resolveKey(location) || requestedLower;
      if (!agentKey || !requestedKey) return false;
      if (agentKey !== requestedKey) return false;
      // If the target is a Burbank home room, only the Burbank residents can
      // occupy it. Prevents Larry/Ferris/Timmy/Angela from co-existing in
      // Truman's kitchen just because their agent turn set their location to
      // "kitchen" — that's THEIR kitchen, not Truman's.
      if (BURBANK_HOME_ROOMS.includes(requestedKey) && !BURBANK_RESIDENTS.has(id)) {
        return false;
      }
      return true;
    })
    .map(([id, a]) => ({ id, agent: a }));

  if (occupants.length === 0) {
    return { error: "nobody in this room right now" };
  }

  // 2. Budget gate up front. Living-moment capture is image_pro cost.
  const gate = BUDGET.canSpend("image_pro");
  if (!gate.ok) return { error: `budget: ${gate.reason}` };

  // 3. Assemble Identity objects for everyone in the room. Identity carries
  // portrait, current wardrobe (computed from per-character sleep windows),
  // asleep state. Same layer the scene renderer uses so wardrobe locks and
  // face fidelity are enforced identically.
  const identities = occupants
    .map(({ agent }) => IDENTITY.identityFor(agent, worldHour, { forceDay: !!brandCampaign }))
    .filter(Boolean);
  if (identities.length === 0) {
    return { error: "identity resolution failed for all occupants" };
  }

  // 4. Build a descriptor of what each occupant is doing THIS slot. Uses
  // lastAct, lastSaid, innerMonologue, mood — the live state fields the
  // agent turn already fills in every slot. If a character is asleep,
  // that's what they're doing; describe them asleep.
  const activityLines = occupants.map(({ agent }) => {
    if (agent.asleep) return `${agent.name} is asleep here.`;
    const parts = [];
    if (agent.lastAct) parts.push(agent.lastAct);
    if (agent.lastSaid) parts.push(`${agent.name} says: "${agent.lastSaid}"`);
    if (parts.length === 0) parts.push(`${agent.name} is in the ${location}, present but quiet.`);
    return parts.join(" ");
  });

  // Stream engine: anti-repetition. Track the last 3 captures. Feed their
  // one-line summaries into the prompt as "recently rendered — do NOT render
  // any of these again." This is what stops the loop from spamming "Truman
  // hanging his coat" for 5 minutes when he actually did it once.
  W.__recentCaptures = W.__recentCaptures || [];
  const antiRepeat = W.__recentCaptures.length
    ? `\nRECENTLY RENDERED FRAMES (do NOT repeat these — the stream is a sequence of distinct moments, not variations on one):\n${W.__recentCaptures.map((r, i) => `  ${i + 1}. ${r}`).join("\n")}\n\nThis new frame must capture a DIFFERENT moment. If the character is in the same room, they must be doing something visibly different (different posture, different action, different focal object). If nothing new is happening yet, focus on the smallest ambient detail — a hand adjusting a collar, a glance out the window, condensation on a glass, the second hand on the wall clock. Never re-render an action already in the list above.`
    : "";

  // 5. Wardrobe manifest (per-character locks) + reference portraits (every
  // occupant, no truncation — this is the Identity Layer's whole point).
  // Session 8c: pass running campaigns' palettes so wardrobe drift lands.
  const campaignPalettes = CAMPAIGNS.running()
    .map((c) => c.productPlan?.palette)
    .filter((p) => p?.primary);
  const wardrobeBlock = IDENTITY.wardrobeManifest(identities, campaignPalettes);
  const portraitParts = IDENTITY.referenceParts(identities);

  // 6. Room plate as first reference — architectural continuity.
  const plateB64 = await ensurePlate(location);
  const locMeta = LOCATIONS.get(location);
  const locDescription = locMeta?.description || location;
  const sceneDescriptor = `${locDescription}, in Seahaven. The FIRST REFERENCE IMAGE is the canonical, permanent look of this room — furniture positions, wall color, window placement, floor pattern, permanent fixtures must all match it exactly. Do not invent different walls, different furniture, a different floor. This is the same room every time.`;

  // 7. Assemble the model input.
  const parts = [];
  if (plateB64) parts.push({ inlineData: { mimeType: "image/jpeg", data: plateB64 } });
  for (const pp of portraitParts) parts.push(pp);

  const namedOccupants = identities.map((id) => id.name).join(", ");
  // Stream engine: wrap in CCTV aesthetic. The camera position is picked
  // based on location AND what THIS SUBJECT is doing right now — mug cam
  // when THEY are drinking coffee, coat button cam when THEY are walking,
  // newsprint cam when THEY are reading. Not the merged activity of every
  // person in the room.
  const subjectAgent = identities[0] ? occupants.find(({ agent }) => agent.name === identities[0].name)?.agent : null;
  const activityContext = subjectAgent
    ? `${subjectAgent.lastAct || ""} ${subjectAgent.lastSaid || ""} ${subjectAgent.think || ""}`
    : activityLines[0] || "";
  const cam = CCTV.cameraMeta(location, W.day, clockStr(), activityContext);

  // Stream engine: mutate object states based on current time of day so the
  // world reflects the actual hour — coffee empties by 10am, TV off during
  // work hours, blinds closed at night, rain slicker gone during the workday.
  // Idempotent: safe to call every capture; overwrites states in place.
  TIME_OF_DAY.applyTimeStates(W.objects, worldHour, W.env?.weather || "clear");

  // Atmosphere descriptor — lighting, sky, shadow language for the model.
  const atmosphere = TIME_OF_DAY.atmosphereFor(worldHour, W.env?.weather || "clear");

  // Stream engine: world memory. Only inject objects that are STORY-RELEVANT
  // to this frame — either time-of-day active (coffee maker in morning) or
  // being interacted with by the subject. All other permanent fixtures rely
  // on the room plate. This stops "coffee carafe half full" from appearing
  // in every kitchen frame at 6:39pm.
  const visibleObjects = (W.objects || []).filter((o) => o.at === location);
  const subjActLower = (subjectAgent?.lastAct || "").toLowerCase();
  const relevantObjects = visibleObjects.filter((o) => {
    const name = String(o.name || "").toLowerCase();
    const stateStr = String(o.state || "").toLowerCase();
    // Explicitly stated as "not visible", "put away", "closed and put away" — skip
    if (stateStr.includes("not visible") || stateStr.includes("put away in the cupboard") || stateStr.includes("put away in the cabinet")) return false;
    // Being interacted with by the subject?
    const nameWords = name.split(/[^a-z]+/).filter((w) => w.length > 3);
    for (const w of nameWords) {
      if (subjActLower.includes(w)) return true;
    }
    // Object states that carry visual signal beyond the plate (TV on, curtains drawn, mug in sink)
    if (stateStr.includes("on, ") || stateStr.includes("drawn") || stateStr.includes("in the sink") || stateStr.includes("open on the counter") || stateStr.includes("brewing")) return true;
    return false;
  });
  const objectsBlock = relevantObjects.length
    ? `\nOBJECTS ACTIVE IN THIS FRAME (must appear with these exact states — this is world memory):\n${relevantObjects.map((o) => `- ${o.name}${o.state ? ` — ${o.state}` : ""}`).join("\n")}`
    : "";

  const promptText = `A hidden-camera frame of a specific moment in a specific place with specific people. The FIRST reference image is the DEFINITIVE room — you must match its architecture, wall color, furniture positions, floor pattern, and lighting fixtures EXACTLY. The REMAINING reference images are the DEFINITIVE faces of the people — match their facial structure, hair, skin, build EXACTLY.

IMPORTANT: match faces and bodies from the reference photos ONLY — do NOT copy any pose, hand position, gesture, or expression from the reference photos. Those are headshot-style references for identity only. Every person's pose, gesture, and expression in THIS frame must come entirely from the activity described below, not from how they happened to be standing in their reference photo.

DO NOT invent a different room. DO NOT invent different faces. DO NOT invent different furniture. The references are LOCKED. You compose only what these specific people are DOING in this exact room right now.

SCENE: ${sceneDescriptor}

TIME OF DAY (adjust room lighting to match — window light, lamps on/off, warmth of light — but architecture stays the same):
${clockStr()} on Day ${W.day}. ${atmosphere}

WHO IS HERE:
${identities.map((id) => `- ${id.name}`).join("\n")}

WHAT THEY ARE DOING RIGHT NOW:
${activityLines.map((l) => "- " + l).join("\n")}
${antiRepeat}
${objectsBlock}

${wardrobeBlock}

${CCTV.cctvAestheticBlock(cam)}

FRAMING SAFETY (non-negotiable):
- Never crop a person at chest level with bare skin above the crop.
- If framing shows someone behind a counter, table, or piece of furniture, their clothing must be clearly visible above the crop edge.
- Bodies must not clip or intersect with counters, tables, or walls.
- Hands and fingers must render cleanly, correct count, natural anatomy.

Render this specific moment: ${namedOccupants} in this exact room from the reference, doing what's described above.`;

  parts.push({ text: SAFETY.safePrompt(promptText) });

  // 8. Render — multi-candidate with LLM picking best.
  try {
    const PC = require("./plate_curator");
    // Strip the trailing text prompt from the parts array so renderCandidates
    // can re-add it fresh per candidate; refParts is just the images.
    const refParts = parts.slice(0, -1);
    const candidateCount = CFG.STREAM_CANDIDATES_PER_FRAME || 3;
    const candidates = await PC.renderCandidates(
      genImage, promptText, refParts, SAFETY.safePrompt,
      candidateCount, CFG.IMAGE_SPACING_MS || 1000
    );
    if (!candidates.length) return { error: "no candidates rendered" };

    let chosen = candidates[0];
    let pickReason = "only candidate";
    if (candidates.length > 1) {
      const criteria = `A hidden-camera frame of ${namedOccupants} at ${location} in Seahaven, ${clockStr()}. The chosen candidate must: (a) show the described people (matching their reference portraits), (b) render the room matching the plate reference, (c) have believable lighting for the time of day, (d) have no anatomy errors (extra fingers, warped faces, merged bodies), (e) be composed as a natural hidden-camera capture (off-center, cropped, unposed) — not a portrait, not a movie still. The chosen frame will be part of a continuous stream, so architectural consistency with the plate is important.`;
      const pick = await PC.pickBest(gemini, CFG.TEXT_MODEL, candidates, criteria);
      if (pick) {
        chosen = candidates[pick.index];
        pickReason = pick.reason;
        olog(`STREAM: picked candidate ${pick.index + 1}/${candidates.length} for ${namedOccupants} @ ${location} — ${pickReason.slice(0, 80)}`);
      }
    }
    const bytes = Buffer.from(chosen.b64, "base64");

    // 9. Store as a first-class moment artifact.
    const id = MOMENT_STORE.newId();
    const heroPath = await MOMENT_STORE.writeHero(id, bytes);
    const meta = {
      id,
      location,
      day: W.day,
      slot: W.slot,
      time: clockStr(),
      actors: identities.map((i) => i.name),
      activityLines,
      pickReason,
      candidateCount: candidates.length,
      // Stream engine: which hidden camera caught this moment. Displayed on
      // the public stream viewer as CAM label.
      camLabel: cam.label,
      camId: cam.id,
      capturedAt: new Date().toISOString(),
    };
    MOMENT_STORE.writeMeta(id, meta);

    // Stream engine: also append this frame to the buffered playback ring.
    try {
      const STREAM_BUFFER = require("./stream_buffer");
      const bufMeta = {
        momentId: id,
        camLabel: cam.label,
        subject: identities[0]?.name || null,
        location,
        day: W.day,
        clock: clockStr(),
        activityLines,
        // Freshest thought + spoken line for the sidebar chat feed.
        // Sidebar: thoughts should belong to the SUBJECT of this frame (the
        // character the camera is watching), not every random other person
        // who happens to be in the room. If Larry is at the office too when
        // we capture Truman, the sidebar still says Truman's thoughts.
        thoughts: (() => {
          const subject = identities[0];
          if (!subject) return [];
          const subj = occupants.find(({ agent }) => agent.name === subject.name)?.agent;
          if (!subj) return [];
          return [{
            who: subj.name,
            think: subj.think || "",
            said: subj.lastSaid || "",
          }];
        })(),
      };
      await STREAM_BUFFER.appendFrame(bytes, bufMeta);
    } catch (e) {
      olog(`STREAM: buffer append failed — ${e.message.slice(0, 120)}`);
    }

    // Stream engine: log a one-line summary of this moment so the next
    // capture prompt knows not to repeat it. Keep only the last 3.
    const summary = `${identities[0]?.name || "someone"} at ${location}, ${clockStr()} — ${activityLines.join("; ")}`.slice(0, 240);
    W.__recentCaptures = W.__recentCaptures || [];
    W.__recentCaptures.push(summary);
    if (W.__recentCaptures.length > 3) W.__recentCaptures.shift();

    // Session 2c: mirror to DB. Storyboard-scene linking happens later when
    // the "Expand to storyboard" button fires.
    try {
      DB.upsertMoment({
        id, location, day: W.day, slot: W.slot, time: clockStr(),
        actors: meta.actors, activityLines,
        heroPath,
      });
    } catch (e) { olog(`ERROR captureLivingMoment(DB): ${e.message.slice(0, 140)}`); }

    BUDGET.recordSpend("image_pro", `living moment: ${location} d${W.day} ${clockStr()}`);
    try {
      BUS.emit("moment_captured", {
        moment_id: id, location, day: W.day, slot: W.slot, time: clockStr(),
        actors: meta.actors,
        hero_url: `/api/moment/${id}`,
      });
    } catch (_) {}
    olog(`MOMENT captured: "${location}" — ${identities.map((i) => i.name).join(", ")} at ${clockStr()}`);

    // 10. Retention.
    try {
      const deleted = MOMENT_STORE.purgeStale();
      if (deleted.length) olog(`MOMENT retention: pruned ${deleted.length} old moment(s)`);
    } catch (_) {}

    return { id, path: heroPath, meta };
  } catch (e) {
    // Loud diagnostic so we can see what actually broke — path, error code,
    // full message. Previous 'no such file' failures hid the specific path.
    olog(`ERROR captureLivingMoment: ${e.code || 'no-code'} — ${e.message}${e.path ? ` [path: ${e.path}]` : ''}`);
    W.lastError = `capture: ${e.message}`;
    return { error: String(e.message).slice(0, 400), code: e.code || null, path: e.path || null };
  }
}

// Layer 3: vision pass — does the shot match its identity references?
async function verifyShot(shotB64, mime, plateB64, refs, wardrobeLines) {
  try {
    const parts = [{ inlineData: { mimeType: mime, data: shotB64 } }];
    if (plateB64) parts.push({ inlineData: { mimeType: "image/jpeg", data: plateB64 } });
    for (const r of refs) parts.push({ inlineData: { mimeType: "image/jpeg", data: r.b64 } });
    parts.push({ text: P.verifyPrompt(refs.map((r) => r.name), wardrobeLines) });
    const data = await gemini(CFG.TEXT_MODEL, {
      contents: [{ parts }],
      generationConfig: { responseMimeType: "application/json", responseSchema: P.VERIFY_SCHEMA },
    });
    let t = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    t = t.trim().replace(/^```json/i, "").replace(/^```/, "").replace(/```$/, "").trim();
    return JSON.parse(t);
  } catch (_) { return { match: true, reason: "" }; }
}

async function pumpRender() {
  if (W.rendering || !W.renderQueue.length) return;
  W.rendering = true;
  const spark = W.sparks.find((s) => s.id === W.renderQueue.shift());
  if (!spark) { W.rendering = false; return pumpRender(); }
  try {
    spark.state = "rendering";
    olog(`render start: "${spark.title}" (${spark.grammar})`);
    const plan = await callJSON(P.shotsPrompt(spark, spark.grammar, W), P.SHOTS_SCHEMA);
    spark.quote = plan.quote;

    // Layer 1: identity references — the room plate + the locked faces.
    const plate = await ensurePlate(spark.location);
    const refs = charRefs(spark.actors);
    // Layer 2: state — what the world says is actually in this room right now.
    const visible = W.objects.filter((o) => normLoc(o.at) === normLoc(spark.location)).map((o) => o.name);
    // Wardrobe: decided ONCE per moment from the spark's clock, identical across all shots.
    const sparkHour = parseInt((spark.time || "12:00").split(":")[0], 10);
    const isNight = sparkHour < 7 || sparkHour >= 21;
    const wardrobeLines = spark.actors.map((nm) => {
      const a = W.agents[(nm || "").split(" ")[0].toLowerCase()];
      if (!a || !a.wardrobe) return null;
      return `${nm}: ${isNight ? a.wardrobe.night : a.wardrobe.day}`;
    }).filter(Boolean);
    // Session 8c: palette drift for scene renders. Same source as capture-moment.
    const scenePalettes = CAMPAIGNS.running()
      .map((c) => c.productPlan?.palette)
      .filter((p) => p?.primary);
    const continuity = P.continuityBlock(refs.map((r) => r.name), visible, wardrobeLines, scenePalettes);

    for (const shot of (plan.shots || []).slice(0, 4)) {
      // Stream engine: each shot gets its own hidden-camera framing.
      const shotCam = CCTV.cameraMeta(spark.location, W.day, spark.time || clockStr());
      const cctvBlock = CCTV.cctvAestheticBlock(shotCam);
      const buildParts = () => {
        const parts = [];
        if (plate) parts.push({ inlineData: { mimeType: "image/jpeg", data: plate } });
        for (const r of refs) parts.push({ inlineData: { mimeType: "image/jpeg", data: r.b64 } });
        return parts;
      };
      try {
        let parts = buildParts();
        parts.push({ text: SAFETY.safePrompt(shot.prompt + continuity + "\n\n" + cctvBlock) });
        let img = await genImage(parts);
        // Layer 3: verify once; on a real mismatch, regenerate once with the correction.
        if (img && CFG.VERIFY_SHOTS && (plate || refs.length)) {
          const check = await verifyShot(img.data, img.mimeType || "image/png", plate, refs, wardrobeLines);
          if (!check.match) {
            olog(`verify FAIL "${shot.label}": ${String(check.reason).slice(0, 100)} — retaking`);
            await new Promise((r) => setTimeout(r, CFG.IMAGE_SPACING_MS));
            parts = buildParts();
            parts.push({ text: SAFETY.safePrompt(shot.prompt + continuity + "\n\n" + cctvBlock + `\nPREVIOUS ATTEMPT FAILED CONTINUITY: ${check.reason}. Correct exactly this.`) });
            img = (await genImage(parts)) || img;
          }
        }
        if (img) {
          try {
            const mime = img.mimeType || "image/png";
            const fname = `${spark.id}_${spark.shots.length}.${mime.includes("jpeg") ? "jpg" : "png"}`;
            fs.writeFileSync(path.join(SHOTS_DIR, fname), Buffer.from(img.data, "base64"));
            spark.shots.push({ label: shot.label, file: fname, mime });
          } catch (we) {
            spark.shots.push({ label: shot.label, image: `data:${img.mimeType || "image/png"};base64,${img.data}` });
          }
        }
      } catch (e) { W.lastError = `shot: ${e.message}`; }
      await new Promise((r) => setTimeout(r, CFG.IMAGE_SPACING_MS));
    }
    spark.state = spark.shots.length ? "ready" : "kept";
    olog(`spark ${spark.state}: "${spark.title}" ${spark.shots.length}/4 shots`);
  } catch (e) { spark.state = "kept"; W.lastError = `render: ${e.message}`; olog(`ERROR render: ${String(e.message).slice(0, 140)}`); }
  W.rendering = false;
  save();
  pumpRender().catch((e) => olog(`ERROR pump: ${String(e.message).slice(0, 140)}`));
}

// ---------------- Reflect ----------------
async function reflectAll() {
  for (const [id, a] of Object.entries(W.agents)) {
    if (a.asleep) continue;
    const today = a.memories.filter((m) => m.day === W.day);
    if (!today.length) continue;
    try {
      const out = await callJSON(P.reflectPrompt(W, a, today), P.REFLECT_SCHEMA);
      if (out.beliefs?.length) a.beliefs = out.beliefs.slice(0, 6);
      if (out.wants?.length) a.wants = out.wants.slice(0, 4);
      for (const e of (out.memory_edits || []).slice(0, 2)) if (today[e.index]) today[e.index].text = e.new_text; // consolidation distorts
      a.memories.push({ text: `(night, day ${W.day}) ${out.reflection}`, strength: 0.9, day: W.day, retold: 0 });
      const wrefR = { day: W.day, slot: W.slot, clock: clockStr() };
      CAMPAIGNS.fanout({ actor: a.name, kind: "reflection", lens: "emotional", text: out.reflection }, wrefR);
      if (out.beliefs?.length) CAMPAIGNS.fanout({ actor: a.name, kind: "belief_change", lens: "emotional", text: `Beliefs updated: ${out.beliefs.slice(0, 2).join(" | ")}` }, wrefR);
      if (out.wants?.length) CAMPAIGNS.fanout({ actor: a.name, kind: "want_change", lens: "emotional", text: `Wants for tomorrow: ${out.wants.slice(0, 2).join(" | ")}` }, wrefR);
      a.memories = a.memories.filter((m) => m.strength > 0.12); // never recalled -> forgotten
      olog(`${a.name} nightly reflection done`);
    } catch (e) { W.lastError = `reflect ${a.name}: ${e.message}`; olog(`ERROR reflect ${a.name}: ${String(e.message).slice(0, 140)}`); }
  }
}

// ---------------- Persistence + API surface ----------------
// Atomic save: write to .tmp, verify the write is parseable, atomic rename to
// SAVE_PATH. Prevents the "volume ran out mid-write, next boot seeds fresh"
// data-loss pattern that reset the Marcus/Lena/Theo simulation on Day 13.
// If any step fails, the previous save is preserved intact — the engine never
// silently loses accumulated world state again.
// Build a slim, save-safe view of W. This is what gets serialized — not the
// full runtime object. Unbounded arrays (truthLog, memories, rendered scenes)
// get capped here so world-state.json can't grow into the tens of MB range
// that caused corruption in the first place.
//
// Runtime always has full data in memory; only PERSISTENCE is slimmed. On
// reload, in-memory arrays start from the slim persisted version and grow
// again — a fresh boot forgets the deepest history, keeps everything recent.
function slimForSave(w) {
  const slim = { ...w, renderQueue: [], rendering: false, busy: false };
  // Bounded truthLog: 400 most recent beats (about 100 sim-hours at current speed).
  // Enough for the Director to find scenes across a day or two, without
  // accumulating 10k+ beats over long sessions.
  if (Array.isArray(slim.truthLog) && slim.truthLog.length > 400) {
    slim.truthLog = slim.truthLog.slice(-400);
  }
  // Bounded rendered scenes metadata: last 20 (files on disk hold the rest).
  if (slim.__scenes && Array.isArray(slim.__scenes.rendered) && slim.__scenes.rendered.length > 20) {
    slim.__scenes = { ...slim.__scenes, rendered: slim.__scenes.rendered.slice(0, 20) };
  }
  // Per-character bounded arrays. Sane caps for what an agent's turn needs.
  if (slim.agents) {
    for (const [key, ag] of Object.entries(slim.agents)) {
      const bounded = { ...ag };
      if (Array.isArray(bounded.memories) && bounded.memories.length > 40) {
        // Keep highest-salience memories, but preserve chronological within them
        const sorted = [...bounded.memories].sort((a, b) => (b.salience || b.strength || 0.5) - (a.salience || a.strength || 0.5));
        bounded.memories = sorted.slice(0, 40);
      }
      if (Array.isArray(bounded.recentCores) && bounded.recentCores.length > 8) bounded.recentCores = bounded.recentCores.slice(-8);
      if (Array.isArray(bounded.recentThoughts) && bounded.recentThoughts.length > 8) bounded.recentThoughts = bounded.recentThoughts.slice(-8);
      if (Array.isArray(bounded.recentTopics) && bounded.recentTopics.length > 8) bounded.recentTopics = bounded.recentTopics.slice(-8);
      slim.agents[key] = bounded;
    }
  }
  // Bounded sparks: 15 most recent (files on disk hold assets).
  if (Array.isArray(slim.sparks) && slim.sparks.length > 15) {
    slim.sparks = slim.sparks.slice(0, 15);
  }
  return slim;
}

function save() {
  // Disk-critical guard: at 95%+ used, we skip persistence entirely rather
  // than risk corrupting either the DB or the JSON with a partial write.
  // The world keeps running in memory; state gets flushed once retention or
  // manual cleanup frees space. Loud log so this doesn't hide silently.
  try {
    const s = STORAGE.status();
    if (s.pct >= 95) {
      // Only log once per minute to avoid spamming the feed
      if (!W._lastDiskCriticalLog || Date.now() - W._lastDiskCriticalLog > 60000) {
        olog(`SAVE SKIPPED: volume at ${s.pct}% (${(s.freeBytes / 1e6).toFixed(1)} MB free) — persistence paused until space is freed`);
        W._lastDiskCriticalLog = Date.now();
      }
      return;
    }
  } catch (_) { /* if storage check itself fails, proceed to save attempts */ }

  // Dual-write: JSON stays the fallback path (Session 1 of the rebuild).
  // The DB is written FIRST — if DB write succeeds, JSON is a mirror; if
  // DB fails, JSON still saves. Session 3 removes the JSON path.
  try { saveToDB(); }
  catch (e) { olog(`ERROR save(DB): ${e.code || 'no-code'} — ${e.message.slice(0, 200)}`); }

  const tmpPath = CFG.SAVE_PATH + ".tmp";
  try {
    const payload = JSON.stringify({ W: slimForSave(W) });
    fs.writeFileSync(tmpPath, payload);
    // Verify the tmp file parses cleanly — catches partial writes from ENOSPC.
    const verify = fs.readFileSync(tmpPath, "utf8");
    JSON.parse(verify);   // throws if truncated
    fs.renameSync(tmpPath, CFG.SAVE_PATH);
  } catch (e) {
    // Loud logging so save failures surface instead of being swallowed.
    olog(`ERROR save: ${e.code || 'no-code'} — ${e.message.slice(0, 200)}`);
    W.lastError = `save: ${e.message.slice(0, 200)}`;
    try { fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// Mirror the runtime W into the DB tables. Session 1 covers:
//   - world (tick state)
//   - agents (persistent character fields)
//   - agent_state (hot per-tick fields: lastAct, lastSaid, innerMonologue)
//   - ledger (regard/trust between characters)
//   - memories (added at agent-turn time via addMemory helper; here we
//     just prune-and-verify to keep the table bounded)
// Later sessions add: beats (Session 2), scenes/moments (Session 2),
// render_queue (Session 3).
function saveToDB() {
  DB.setWorld({
    day: W.day,
    minutes: W.minutes,
    slot: W.slot,
    paused: W.paused,
    speedMs: W.speedMs,
    weather: W.env?.weather,
    headline: W.env?.headline,
    money: W.money,
  });

  // TWO PASSES, in order, inside one transaction:
  //   Pass 1: upsert every agent row (satisfies FK for ledger)
  //   Pass 2: hot state + ledger writes
  // Fix for v2.27 FK bug: Marcus's ledger references lena and theo, which
  // didn't exist yet on first save because iteration order upserted Marcus
  // before Lena/Theo. Two-pass fixes it once and for all.
  const entries = Object.entries(W.agents || {});

  // Pass 1: agents
  for (const [key, a] of entries) {
    DB.upsertAgent({
      key, name: a.name,
      wardrobe: a.wardrobe,
      wake: a.wake, sleep: a.sleep,
      senseOfSelf: a.senseOfSelf,
      beliefs: a.beliefs, wants: a.wants,
      location: a.location, mood: a.mood, asleep: a.asleep,
    });
  }

  // Pass 2: hot state + ledger (now safe — every agent row exists)
  for (const [key, a] of entries) {
    const hot = {};
    if (a.lastAct != null) hot.lastAct = a.lastAct;
    if (a.lastSaid != null) hot.lastSaid = a.lastSaid;
    if (a.innerMonologue != null) hot.innerMonologue = a.innerMonologue;
    if (a.recentCores) hot.recentCores = a.recentCores;
    if (a.recentThoughts) hot.recentThoughts = a.recentThoughts;
    if (a.recentTopics) hot.recentTopics = a.recentTopics;
    if (Object.keys(hot).length) DB.setAgentStateBulk(key, hot);

    for (const [other, L] of Object.entries(a.ledger || {})) {
      // Skip if the target agent doesn't exist in W (defensive — shouldn't happen)
      if (!W.agents[other]) continue;
      DB.upsertLedger(key, other, { regard: L.regard, trust: L.trust });
    }
  }
}

// Inverse of saveToDB: read DB rows and reconstruct the runtime W shape.
// Must produce the EXACT nested structure the rest of ape.js expects, or
// downstream code that reads e.g. W.agents.marcus.senseOfSelf.believes will
// crash. This function is the sole point where DB row shape → runtime
// object shape is translated.
function hydrateFromDB(dbWorld) {
  W.day = dbWorld.day;
  W.minutes = dbWorld.minutes;
  W.slot = dbWorld.slot;
  // Stream engine: ignore persisted paused state. This is a 24/7 stream, not
  // a research tool where you carefully step through slots. Every boot
  // starts running so the stream stays alive across restarts.
  W.paused = false;
  W.speedMs = dbWorld.speed_ms;
  W.busy = false;
  W.rendering = false;
  W.renderQueue = [];
  W.env = W.env || {};
  W.env.weather = dbWorld.weather;
  W.env.headline = dbWorld.headline || "";
  W.money = W.money || {};
  W.money.checking = dbWorld.money_checking;
  W.money.note = dbWorld.money_note || "";
  W.lastSlotWall = dbWorld.last_slot_wall_ms || Date.now();

  // Hydrate agents. Preserve any runtime fields (like memories arrays and
  // hot state) — those come from separate queries.
  W.agents = W.agents || {};
  for (const row of DB.listAgents()) {
    const existing = W.agents[row.key] || {};
    const hotState = DB.getAgentState(row.key);
    const ledgerRows = DB.getAgentLedger(row.key);
    const memories = DB.topMemories(row.key, 40).map((m) => ({
      text: m.text,
      salience: m.salience,
      strength: m.salience,   // legacy field name used in some places
      day: m.day,
      hour: m.hour,
      kind: m.kind,
      retold: m.retold,
      _dbId: m.id,
    }));
    W.agents[row.key] = {
      ...existing,
      name: row.name,
      wardrobe: { day: row.wardrobe_day, night: row.wardrobe_night },
      wake: row.wake_hour,
      sleep: row.sleep_hour,
      senseOfSelf: {
        believes: row.believes,
        selfRegard: row.self_regard,
        setPoint: row.set_point,
      },
      beliefs: row.beliefs ? row.beliefs.split("\n").filter(Boolean) : [],
      wants: row.wants ? row.wants.split("\n").filter(Boolean) : [],
      location: row.location,
      mood: row.mood,
      asleep: !!row.asleep,
      // Hot state
      lastAct: hotState.lastAct || existing.lastAct || "",
      lastSaid: hotState.lastSaid || existing.lastSaid || "",
      innerMonologue: hotState.innerMonologue || existing.innerMonologue || "",
      recentCores: hotState.recentCores || [],
      recentThoughts: hotState.recentThoughts || [],
      recentTopics: hotState.recentTopics || [],
      // Memories from DB (top 40 by salience)
      memories,
      // Ledger from DB
      ledger: ledgerRows,
    };
  }

  // Hydrate the rendered scenes cache from DB. Only pull terminal-status
  // scenes — candidates are transient per-scan and don't need to survive
  // reboots. This makes W.__scenes.rendered a warm cache of DB truth so
  // snapshot() reads stay fast (no DB round-trip on every state poll).
  W.__scenes = W.__scenes || { candidates: [], rendered: [] };
  try {
    const dbScenes = DB.scenesByStatuses(
      ["storyboarded", "storyboarded_partial", "render_failed", "plan_failed", "expired"],
      30
    );
    // Rebuild the shots array for each rendered scene from scene_shots rows.
    W.__scenes.rendered = dbScenes.map((s) => {
      const shots = DB.getSceneShots(s.id);
      return {
        id: s.id,
        day: s.day,
        startSlot: s.startSlot, endSlot: s.endSlot,
        startTime: s.startTime, endTime: s.endTime,
        actors: s.actors, score: s.score,
        title: s.title, logline: s.logline,
        beats: s.beats,
        status: s.status, origin: s.origin,
        poster: s.poster, videoUrl: s.videoUrl, videoStatus: s.videoStatus,
        error: s.error,
        renderedAt: s.renderedAt,
        // Runtime snapshot shape — shots array with hasStill/hasVideo hints
        // for the cockpit's grid render.
        shots: shots.map((sh) => ({
          grammar: sh.grammar,
          subject: sh.subject,
          moment: sh.moment,
          status: sh.status,
          hasStill: !!sh.stillPath && sh.status !== "failed",
          hasVideo: !!sh.videoPath,
        })),
      };
    });
    if (W.__scenes.rendered.length) olog(`SCENES hydrated from DB: ${W.__scenes.rendered.length} rendered`);
  } catch (e) { olog(`ERROR scenes hydrate: ${e.message.slice(0, 140)}`); }
}

function load() {
  // DB-first: if the DB has a world row, hydrate from it. Session 1 covers
  // world + agents + hot state + ledger + memories; the rest still comes
  // from JSON (until Session 2 lands beats and scenes).
  try {
    const dbWorld = DB.getWorld();
    if (dbWorld) {
      olog(`LOAD from DB — day ${dbWorld.day}, slot ${dbWorld.slot}, ${dbWorld.paused ? 'paused' : 'running'}`);
      hydrateFromDB(dbWorld);
      // Merge in whatever fields the JSON still owns (truthLog, scenes, sparks,
      // campaigns, etc. — these move to DB in Session 2). If JSON is present,
      // read it and copy over the non-DB fields.
      try {
        if (fs.existsSync(CFG.SAVE_PATH)) {
          const raw = fs.readFileSync(CFG.SAVE_PATH, "utf8");
          const s = JSON.parse(raw).W;
          // Copy over the fields DB doesn't yet own
          if (s.truthLog) W.truthLog = s.truthLog;
          if (s.sparks) W.sparks = s.sparks;
          if (s.__scenes) W.__scenes = s.__scenes;
          if (s.objects) W.objects = s.objects;
          if (s.facts) W.facts = s.facts;
          if (s.keptTopics) W.keptTopics = s.keptTopics;
          if (s.pendingInjection) W.pendingInjection = s.pendingInjection;
          if (s.reflectedDay != null) W.reflectedDay = s.reflectedDay;
          if (s._decompressed) W._decompressed = s._decompressed;
        }
      } catch (mergeErr) {
        olog(`LOAD warning: DB hydrated but JSON merge failed (${mergeErr.message.slice(0, 120)}) — continuing with DB-only state`);
      }
      return;
    }
  } catch (e) {
    olog(`ERROR load(DB): ${e.code || 'no-code'} — ${e.message.slice(0, 200)}`);
    // Fall through to JSON path — DB failure shouldn't stop the boot.
  }

  // JSON path (fallback + salvage). Fully preserved from v2.25.
  try {
    if (!fs.existsSync(CFG.SAVE_PATH)) {
      // Primary save missing. Look for a `.corrupt.*` backup and try salvage.
      try {
        const dir = require("path").dirname(CFG.SAVE_PATH);
        const backupName = require("fs").readdirSync(dir)
          .filter((n) => n.startsWith(require("path").basename(CFG.SAVE_PATH) + ".corrupt."))
          .sort()
          .pop();
        if (backupName) {
          const backupPath = require("path").join(dir, backupName);
          olog(`SALVAGE: attempting recovery from ${backupPath}`);
          const result = SALVAGE.salvageFromFile(backupPath);
          if (result.ok) {
            olog(`SALVAGE ok — recovered ${result.bytesRecovered} bytes (${result.bytesDiscarded} discarded), method: ${result.method}, appended: "${result.closeSequenceAppended || ''}"`);
            const s = result.value.W;
            Object.assign(W, s, { busy: false, rendering: false, renderQueue: [] });
            // Immediately write the salvaged state back as a fresh primary
            // save (which will be slimmed, so no risk of re-corruption).
            save();
            olog(`SALVAGE: fresh slim save written`);
            return;
          }
          olog(`SALVAGE failed: ${result.reason}`);
        }
      } catch (salvageErr) { olog(`SALVAGE attempt errored: ${salvageErr.message.slice(0, 200)}`); }
      return;   // no primary, no salvage — fresh seed
    }
    const raw = fs.readFileSync(CFG.SAVE_PATH, "utf8");
    let s;
    try { s = JSON.parse(raw).W; }
    catch (parseErr) {
      // Corruption in the primary. Back it up + attempt in-place salvage.
      const backupPath = CFG.SAVE_PATH + ".corrupt." + Date.now();
      try { fs.copyFileSync(CFG.SAVE_PATH, backupPath); } catch (_) {}
      olog(`CRITICAL save-file corrupt: ${parseErr.message.slice(0, 200)} — backup at ${backupPath}`);
      olog(`SALVAGE: attempting in-place recovery`);
      const result = SALVAGE.salvage(raw);
      if (result.ok) {
        olog(`SALVAGE ok — recovered ${result.bytesRecovered} bytes (${result.bytesDiscarded} discarded), method: ${result.method}`);
        s = result.value.W;
        Object.assign(W, s, { busy: false, rendering: false, renderQueue: [] });
        // Remove the corrupt primary and immediately write a fresh slim save.
        try { fs.unlinkSync(CFG.SAVE_PATH); } catch (_) {}
        save();
        olog(`SALVAGE: fresh slim save written, corrupt primary removed`);
        return;
      }
      olog(`SALVAGE failed: ${result.reason}`);
      if (process.env.ALLOW_FRESH_SEED_ON_CORRUPT !== "1") {
        olog(`REFUSING to seed fresh. Set ALLOW_FRESH_SEED_ON_CORRUPT=1 to force reseed, or restore ${backupPath}`);
        throw new Error("save corrupt, salvage failed — set ALLOW_FRESH_SEED_ON_CORRUPT=1 to force fresh seed");
      }
      olog(`ALLOW_FRESH_SEED_ON_CORRUPT=1 set — proceeding with fresh seed`);
      return;
    }
    // Honor the saved paused state on boot instead of forcing paused=true.
    // Rationale: Railway restarts (deploys, crashes, etc.) should not silently
    // stall a running world. If the user deliberately paused before the restart,
    // paused=true is what's in the save and we honor that. If the world was
    // running, it resumes — critical for the Director agent accumulating scenes
    // in the background while the user is away.
    Object.assign(W, s, { busy: false, rendering: false, renderQueue: [] });
    // One-time decompression: soften values railed to the bounds by pre-homeostasis physics.
    if (!W._decompressed) {
      W._decompressed = true;
      for (const ag of Object.values(W.agents)) {
        for (const L of Object.values(ag.ledger)) {
          L.regard = Math.round(50 + (L.regard - 50) * 0.8);
          L.trust = Math.round(50 + (L.trust - 50) * 0.8);
        }
        ag.senseOfSelf.believes = Math.round(50 + (ag.senseOfSelf.believes - 50) * 0.8);
        ag.senseOfSelf.selfRegard = Math.max(10, ag.senseOfSelf.selfRegard);
      }
    }
    // Migrate v1.6-era inline images to files on the volume (shrinks the save file
    // from ~20MB to KBs and removes serialization stalls).
    try {
      fs.mkdirSync(SHOTS_DIR, { recursive: true });
      for (const s of W.sparks || []) {
        (s.shots || []).forEach((sh, i) => {
          if (sh.image && !sh.file) {
            const m = sh.image.match(/^data:([^;]+);base64,(.*)$/s);
            if (m) {
              const fname = `${s.id}_${i}.${m[1].includes("jpeg") ? "jpg" : "png"}`;
              fs.writeFileSync(path.join(SHOTS_DIR, fname), Buffer.from(m[2], "base64"));
              s.shots[i] = { label: sh.label, file: fname, mime: m[1] };
            }
          }
        });
      }
    } catch (_) {}
    // Migrate: backfill fields added to the seed after this world was saved.
    for (const [id, a] of Object.entries(W.agents)) {
      const seed = SEED.AGENTS[id];
      if (seed) for (const k of ["wardrobe", "voice", "physical"]) if (seed[k] && !a[k]) a[k] = JSON.parse(JSON.stringify(seed[k]));
    }
  } catch (_) {}
}

// snapshot shaped to match the cockpit's useSimulationStore
function snapshot() {
  const characters = {};
  for (const [id, a] of Object.entries(W.agents)) {
    characters[id] = {
      name: a.name, age: a.age, role: a.role, image: a.image,
      stress: Math.round(100 - a.senseOfSelf.selfRegard * 0.6 - (a.personality.N < 50 ? 15 : 0)),
      status: a.lastAct || (a.asleep ? `${a.name} is asleep.` : `${a.name} is in the ${a.location}.`),
      location: a.location, asleep: a.asleep, mood: a.mood,
      innerMonologue: a.think, lastSaid: a.lastSaid,
      personality: a.personality, values: a.values,
      senseOfSelf: selfState(a, id),
      regardOthers: Object.fromEntries(Object.entries(a.ledger).map(([k, v]) => [W.agents[k]?.name || k, { regard: Math.round(v.regard), trust: Math.round(v.trust) }])),
      wants: a.wants, believes: a.beliefs, carrying: a.carrying,
      daySoFar: a.dayLog.slice(0, 20).map((d) => ({ time: d.time, action: d.act, quote: d.said || d.think.slice(0, 140) })),
      memories: [...a.memories].sort((x, y) => y.strength - x.strength).slice(0, 10),
      meters: METERS.snapshot(a),
    };
  }
  return {
    currentTime: `Day ${W.day} · ${clockStr()}`, day: W.day, clock: clockStr(), slot: W.slot, version: CFG.APP_VERSION,
    isPaused: W.paused, busy: W.busy, speedMs: W.speedMs,
    lastSlotAgoSec: Math.round((Date.now() - W.lastSlotWall) / 1000),
    uptimeSec: Math.round((Date.now() - W.bootWall) / 1000),
    weather: W.env.weather, headline: W.env.headline,
    money: { checking: W.money.checking, note: W.money.note },
    chores: CHORES.snapshot(W),
    scenes: DIRECTOR.snapshot(W),
    characters,
    // Live Dialogue feed: read the 40 most recent beats from DB (queryable,
    // durable). Fall back to in-memory truthLog if the DB read fails so the
    // cockpit never sees an empty feed on a temporary DB blip.
    truthLog: (() => {
      try {
        // DB.recentBeats returns newest-first; the cockpit expects oldest-first
        // (natural chat feed). Reverse.
        return DB.recentBeats(40).reverse();
      } catch (e) {
        olog(`ERROR snapshot(recentBeats): ${e.message.slice(0, 140)} — falling back to in-memory truthLog`);
        return W.truthLog.slice(-40);
      }
    })(),
    sparks: W.sparks.slice(0, 12).map((s) => ({ ...s, shots: (s.shots || []).map((sh, i) => ({ label: sh.label, url: `/api/shot/${s.id}/${i}` })) })),
    renderStoryboards: W.renderStoryboards,
    lastError: W.lastError,
  };
}

let timer = null;
function setSpeed(ms) { W.speedMs = ms; if (timer) clearInterval(timer); timer = setInterval(() => { runSlot().catch((e) => olog(`ERROR beat: ${String(e.message).slice(0, 140)}`)); }, W.speedMs); }
// Register render handlers with the worker. Called at engine boot before
// WORKER.start() so handlers are available when the first poll cycle runs.
// Each handler closes over ape.js's renderers (renderStillPartsFor, genImage,
// SCENE_STORE, BUDGET) so worker.js stays clean of ape.js dependencies.
//
// PAYLOAD CONTRACT: payloads carry the DESCRIPTION of the work, not the
// materialized objects. The handler rebuilds runtime objects (Particles with
// Identity context) from the current W.agents state at execution time. This
// is what makes the queue architecturally clean — payloads are compact JSON,
// no portrait bytes stored twice, no risk of stale Identity snapshots.
//
// Session 3b registers 'still' — the shot-still render path.
// Session 3c adds 'plate', 'cutaway', 'portrait', 'moment', 'video', 'edit'.
function registerWorkerHandlers() {
  // 'still' — render a single scene shot.
  // Payload:  { scene_id, shot_index, scene_summary, planned_shot, scene_hour, weather }
  //   scene_summary must include { id, day, startSlot, endSlot, startTime, actors, beats }
  //   planned_shot: { grammar, subject, moment, prompt }
  // Returns:  { path, bytes, sceneId, shotIndex, metadata }
  WORKER.register("still", async (job, ctx) => {
    const { scene_id, shot_index, scene_summary, planned_shot, scene_hour, weather } = job.payload;
    // Rebuild the Particle from live world state. PARTICLE.emit resolves
    // Identity references from W.agents at execution time, so the render
    // gets whatever wardrobe / mood / location the character has RIGHT
    // NOW — not what they had when the job was enqueued.
    const particle = PARTICLE.emit({
      scene: scene_summary,
      shotIndex: shot_index,
      plannedShot: planned_shot,
      sceneHour: scene_hour,
      worldAgents: W.agents,
    });
    particle.weather = weather || W.env?.weather || "clear";
    const parts = await renderStillPartsFor(particle);
    const img = await genImage(parts);
    if (!img) throw new Error("model returned no image");
    const bytes = Buffer.from(img.data, "base64");
    const filePath = await SCENE_STORE.writeShotStill(scene_id, shot_index, bytes);
    BUDGET.recordSpend("image_pro", `scene ${scene_id} shot ${shot_index} (${particle.grammar})`);
    return {
      path: filePath,
      bytes: bytes.length,
      sceneId: scene_id,
      shotIndex: shot_index,
      metadata: { grammar: particle.grammar, subject: particle.subject?.name },
    };
  });
}

// STREAM ENGINE: continuous auto-capture loop.
// Runs as many parallel captureLivingMoment renders as CFG.STREAM_PARALLEL
// allows. As soon as one finishes, another starts. Subject picked each
// call — Truman prioritized while awake, other awake characters after.
// Sleep windows still respected (asleep = boring; we skip and pick another).
// If everyone is asleep, we back off 5 seconds and try again.
async function startAutoCaptureLoop() {
  if (W.__autoCaptureLoopRunning) return;
  W.__autoCaptureLoopRunning = true;
  const parallel = Math.max(1, CFG.STREAM_PARALLEL || 1);
  olog(`STREAM: starting auto-capture loop, parallel=${parallel}`);
  // Rotation index — ensures we don't always shoot Truman even when others
  // are also awake and doing interesting things. Truman gets first pick.
  let rotationIdx = 0;
  const pickSubject = () => {
    const truman = W.agents.truman;
    if (truman && !truman.asleep && rotationIdx % 3 !== 2) {
      rotationIdx++;
      return truman;
    }
    const awake = Object.values(W.agents).filter((a) => !a.asleep);
    if (!awake.length) return null;
    rotationIdx++;
    return awake[rotationIdx % awake.length];
  };
  const oneWorker = async () => {
    const capturedThisSlot = new Set();
    let currentGateSlot = -1;
    const STREAM_BUFFER = require("./stream_buffer");
    const STREAM_DIRECTOR = require("./stream_director");
    // Track the last 5 subject+action pairs so the director enforces variety
    const recentDirectorSignals = [];
    while (W.__autoCaptureLoopRunning && CFG.STREAM_AUTO_CAPTURE) {
      // Wait for boot bootstraps to finish — portraits and plates must be
      // in BIBLE before we render captures against them.
      if (!W.__bootBootstrapsComplete) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      if (W.paused) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      if (W.slot !== currentGateSlot) {
        capturedThisSlot.clear();
        currentGateSlot = W.slot;
      }
      const bufStat = STREAM_BUFFER.status();
      if (bufStat.backlog >= STREAM_BUFFER.BUFFER_TARGET) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }

      // Stream director picks the next subject based on scoring rules —
      // interactions, object gestures, spoken lines, public locations. It
      // penalizes recent repetition so we don't spam the same subject/action.
      const pick = STREAM_DIRECTOR.pickNextSubject(W, recentDirectorSignals);
      if (!pick) {
        await new Promise((r) => setTimeout(r, 3000));
        continue;
      }
      const dedupKey = `${W.slot}:${pick.key}`;
      if (capturedThisSlot.has(dedupKey)) {
        // Same slot + same subject already shot — wait for state to advance
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      capturedThisSlot.add(dedupKey);

      try {
        const rawLoc = pick.agent.location;
        const canonicalKey = LOCATIONS.resolveKey(rawLoc);
        // If the pick is in a transitional state (walking, on route), skip
        // this pick and let the next tick pick again. Someone else will be
        // in a real room.
        if (!canonicalKey || canonicalKey.startsWith("walking ") || canonicalKey.includes("route")) {
          olog(`STREAM: skip ${pick.agent.name} — transitional ("${rawLoc}")`);
          await new Promise((r) => setTimeout(r, 500));
          continue;
        }
        const r = await captureLivingMoment(canonicalKey);
        if (r?.id) {
          olog(`STREAM: captured ${r.id} of ${pick.agent.name} @ ${canonicalKey} · score ${pick.score} · buffer ${bufStat.backlog + 1}/${STREAM_BUFFER.BUFFER_TARGET}`);
          recentDirectorSignals.push({
            subjectKey: pick.key,
            actNormalized: String(pick.agent.lastAct || "")
              .toLowerCase().replace(/[^a-z ]/g, "").trim(),
          });
          if (recentDirectorSignals.length > 10) recentDirectorSignals.shift();
        } else if (r?.error) {
          olog(`STREAM: capture skipped — ${String(r.error).slice(0, 120)}`);
          await new Promise((r) => setTimeout(r, 2000));
        }
      } catch (e) {
        olog(`STREAM: capture error — ${String(e.message).slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  };
  for (let i = 0; i < parallel; i++) oneWorker();
}

function start() {
  // v2.38.2: reseed flag check. If /api/admin/reseed-world was called before
  // the last exit, .RESEED_ON_BOOT sits next to the DB on the persistent
  // volume. Delete the DB file + WAL/SHM + JSON save + BIBLE plate cache
  // so next migrate() creates fresh schema, load() falls through to the
  // world.js seed, and cached duplex plates get regenerated as the new flat.
  //
  // Path derivation must MATCH db.js: dbPath sits next to CFG.SAVE_PATH on
  // the persistent volume (/data on Railway). Prior version used __dirname
  // which resolved to /app/engine (container filesystem, not persistent),
  // so the flag evaporated on restart.
  try {
    const fs = require("fs");
    const path = require("path");
    const dbPath = process.env.OZ_DB_PATH || path.join(path.dirname(CFG.SAVE_PATH), "state.db");
    const flagPath = path.join(path.dirname(dbPath), ".RESEED_ON_BOOT");
    if (fs.existsSync(flagPath)) {
      const flagTs = fs.readFileSync(flagPath, "utf8").trim();
      olog(`RESEED: flag present (${flagTs}) — deleting DB + JSON + BIBLE for fresh seed`);
      // DB files
      for (const p of [dbPath, dbPath + "-wal", dbPath + "-shm"]) {
        try { fs.unlinkSync(p); olog(`  removed ${p}`); }
        catch (_) { /* fine if not present */ }
      }
      // JSON save + salvage backups
      try {
        const savePath = CFG.SAVE_PATH;
        if (savePath && fs.existsSync(savePath)) {
          fs.unlinkSync(savePath);
          olog(`  removed ${savePath}`);
        }
        if (savePath) {
          const dir = path.dirname(savePath);
          const base = path.basename(savePath);
          if (fs.existsSync(dir)) {
            for (const name of fs.readdirSync(dir)) {
              if (name.startsWith(base + ".corrupt.")) {
                try { fs.unlinkSync(path.join(dir, name)); olog(`  removed ${name}`); }
                catch (_) {}
              }
            }
          }
        }
      } catch (e) { olog(`  JSON save clear failed: ${e.message?.slice(0, 200)}`); }
      // BIBLE plate cache — this is why the cutaway stays old across
      // "reseed prompts.js" changes. Living on the persistent volume,
      // survives all restart-only approaches. Explicit delete here.
      try {
        const bibleDir = path.join(path.dirname(dbPath), "bible");
        if (fs.existsSync(bibleDir)) {
          let count = 0;
          for (const name of fs.readdirSync(bibleDir)) {
            try { fs.unlinkSync(path.join(bibleDir, name)); count++; } catch (_) {}
          }
          olog(`  cleared BIBLE directory: ${count} plate(s) removed`);
        }
      } catch (e) { olog(`  BIBLE clear failed: ${e.message?.slice(0, 200)}`); }
      try { fs.unlinkSync(flagPath); olog(`  removed reseed flag`); } catch (_) {}
    }
  } catch (e) { olog(`RESEED check failed (non-fatal): ${e.message?.slice(0, 200)}`); }

  // Run DB migrations first — before anything reads or writes state.
  // Any migration failure crashes the boot with a clear error.
  try {
    const m = DB.migrate();
    olog(`DB: ${m.ran} migration(s) applied, ${m.total} total in schema`);
    const stats = DB.stats();
    olog(`DB: ${stats.agentCount} agents, ${stats.memCount} memories, file ${stats.fileSize ? (stats.fileSize / 1024).toFixed(1) + ' KB' : 'not yet on disk'}`);
  } catch (e) {
    olog(`FATAL DB migration failed: ${e.message}`);
    throw e;
  }
  // Start the render worker. Session 3a: skeleton with stub handler only.
  // Sessions 3b/3c register real handlers before this point.
  try {
    registerWorkerHandlers();
    WORKER.start({ log: olog });
    const s = WORKER.stats();
    olog(`WORKER: polling every ${s.pollMs}ms, ${s.handlers.length} real handler(s): [${s.handlers.join(", ")}]`);
  } catch (e) { olog(`ERROR worker start: ${e.message.slice(0, 200)}`); }
  BIBLE.init(); CAMPAIGNS.load(); DAILIES.loadIndex(); BUDGET.load(); load();
  // Restore any campaign-injected products that should be in the world but
  // aren't (e.g. after a restart with fresh W.objects seeded from world.js).
  try {
    const r = CAMPAIGNS.reconcilePlacements(W);
    if (r.restored) olog(`CAMPAIGNS: restored ${r.restored} placed object(s) to the world`);
  } catch (e) { olog(`ERROR reconcilePlacements: ${e.message?.slice(0, 200)}`); }
  // Log the actual volume capacity + free space at boot. On Railway this
  // reflects the true mount size (post-resize) rather than an env-var guess.
  try {
    const s = STORAGE.status();
    const capMB = (s.capacityBytes / 1e6).toFixed(0);
    const freeMB = s.freeBytes != null ? (s.freeBytes / 1e6).toFixed(0) : "?";
    olog(`VOLUME: ${capMB} MB total · ${freeMB} MB free · ${s.pct}% used (source: ${s.source})`);
  } catch (e) { olog(`ERROR volume readout: ${e.message.slice(0, 140)}`); }
  // Boot-time scene retention purge: if the volume is near-full from prior
  // rendering, clear the oldest scene directories so the first render of this
  // boot has room. Belt-and-suspenders with the per-render purge that runs
  // after each successful scene.
  try {
    const aggressive = STORAGE.shouldAggressivelyPrune();
    const deleted = SCENE_STORE.purgeStale({ aggressive });
    const s = STORAGE.status();
    const mb = (SCENE_STORE.diskUsageBytes() / 1e6).toFixed(1);
    if (deleted.length) olog(`SCENE retention (boot, ${aggressive ? "AGGRESSIVE" : "normal"}): pruned ${deleted.length} stale scene(s), now ${mb} MB on disk (volume ${s.pct}%)`);
    else olog(`SCENE retention (boot): ${mb} MB on disk, ${SCENE_STORE.SCENE_RETENTION_COUNT} scene retention cap (volume ${s.pct}%)`);
  } catch (e) { olog(`ERROR boot retention: ${e.message.slice(0, 140)}`); }
  setSpeed(W.speedMs);
  // Stream engine: sync to real wall clock. Truman's day should mirror the
  // viewer's day. If the sim clock drifts more than 60 sim-minutes from real
  // time (either fresh boot or a long pause), snap it back to now.
  if (CFG.STREAM_REALTIME_SYNC) {
    const now = new Date();
    const realMinutes = now.getHours() * 60 + now.getMinutes();
    const drift = Math.abs(W.minutes - realMinutes);
    if (drift > 60 || W.slot === 0) {
      const prev = clockStr();
      W.minutes = realMinutes;
      olog(`STREAM: real-clock sync — was ${prev}, now ${clockStr()} (drift ${drift} min)`);
    }
  }
  olog(`BOOT ${CFG.APP_VERSION} — world at day ${W.day} ${clockStr()}, slot ${W.slot}, ${W.paused ? "paused" : "running"}, ${CAMPAIGNS.list().length} campaigns loaded`);
  // Stream engine: kickstart the continuous capture loop.
  if (CFG.STREAM_AUTO_CAPTURE) startAutoCaptureLoop();
}

// Watchdog: if the heartbeat is overdue while unpaused, any state poll revives it.
async function peekFrame({ subject, location, action, said, thoughtSubtext, others, visibleObjects, worldClock, weather }) {
  const gate = BUDGET.canSpend("image_pro");
  if (!gate.ok) return { error: gate.reason };
  // Resolve the character behind the subject name (first-name match, case-insensitive)
  // so we can pull their locked wardrobe. Empty string if no clear match — the
  // prompt still enforces "fully clothed" at the safety layer.
  const firstName = (subject || "").split(" ")[0].toLowerCase();
  const agent = W.agents[firstName];
  let wardrobeString = "";
  if (agent?.wardrobe) {
    const hourNow = worldClock ? parseInt(String(worldClock).split(":")[0], 10) : Math.floor(W.minutes / 60);
    const isNight = hourNow < 6 || hourNow >= 22;
    wardrobeString = isNight ? agent.wardrobe.night : agent.wardrobe.day;
  }
  const spec = DAILIES.buildShotSpec({
    agentName: subject, agentLocation: location, agentThink: thoughtSubtext || "",
    agentAct: action || "", agentSaid: said || "",
    otherPresent: others || [], visibleObjects: visibleObjects || [],
    worldClock: worldClock || clockStr(), weather: weather || W.env.weather,
    wardrobeString,
  });
  const parts = [];
  try {
    const plate = await ensurePlate(spec.location);
    if (plate) parts.push({ inlineData: { mimeType: "image/jpeg", data: plate } });
  } catch (_) {}
  const refs = charRefs([spec.subject, ...(spec.others || [])]);
  for (const r of refs) parts.push({ inlineData: { mimeType: "image/jpeg", data: r.b64 } });
  parts.push({ text: SAFETY.safePrompt(DAILIES.shotPromptText(spec)) });
  const img = await genImage(parts);
  if (!img) return { error: "generation failed" };
  BUDGET.recordSpend("image_pro", `peek ${subject} ${location}`);
  return { entry: DAILIES.record({
    day: W.day, slot: W.slot, time: clockStr(), spec, campaignIds: CAMPAIGNS.running().map(c => c.id),
    driver: async () => Buffer.from(img.data, "base64"),
  }) };
}

// Turn an existing rendered daily still into a short Omni Flash video clip.
// Seed frame = the still we already generated (face + wardrobe + room continuity).
// Prompt is built from the daily's stored metadata so motion + audio match the beat.
async function animateFrame(dailyId, durationSeconds = 8) {
  const gate = BUDGET.canSpend("video_omni_flash");
  if (!gate.ok) return { error: gate.reason };
  const f = DAILIES.file(dailyId);
  if (!f) return { error: "still not found — cannot animate what doesn't exist yet" };

  const list = DAILIES.list({ since: 0, limit: 500 });
  const entry = list.find((x) => x.id === dailyId);
  if (!entry) return { error: "daily entry not found" };

  const stillBytes = require("fs").readFileSync(f.path);
  const stillB64 = stillBytes.toString("base64");
  const image_uri = `data:image/jpeg;base64,${stillB64}`;

  // Build prompt using Omni Flash best practices from the real docs:
  //  - <FIRST_FRAME> tag locks the still as the actual starting frame
  //  - "Continuous, unbroken handheld shot" prevents multi-cut default
  //  - Timecode blocking so Omni actually USES the full window naturally
  //    (without this it delivers the line in 2-3s and freezes the rest)
  //  - Negatives inside the prompt (Omni has no separate negative field)
  const beatMid = entry.said
    ? `[1.5-6s] ${entry.subject} speaks the line, natural conversational delivery, small breath at the start: "${entry.said}"`
    : entry.action
      ? `[1.5-6s] ${entry.subject} ${entry.action.replace(new RegExp(`^${entry.subject}\\s*`), "")}`
      : `[1.5-6s] ${entry.subject} holds the moment quietly, expression carrying the weight of the thought`;

  const beatAudio = entry.said
    ? `Audio: ${entry.subject} speaking the line in a natural conversational Montréal English accent, in-time with lip motion. Subtle room tone underneath (soft radiator hum, faint rain on the window). No music.`
    : `Audio: subtle room tone only — soft radiator hum, faint rain on the window. No dialogue. No music.`;

  const promptText = `<FIRST_FRAME> ${entry.subject} in the ${entry.location}, ${entry.worldClock || ""}. Continuous, unbroken handheld shot, ${durationSeconds} seconds. 35mm film aesthetic, natural practical light, subtle handheld motion, documentary honesty.

[0-1.5s] ${entry.subject} settles into the moment — a small breath, a shift of weight, a look. Do not rush.
${beatMid}
[6-${durationSeconds}s] the aftermath of the moment — small expression, breath, quiet. Do not freeze; life continues.

Keep everything else the same as the first frame: same face, same wardrobe, same room architecture, same light quality. Do not change the person. Do not change the clothing. Do not add new objects or people.

${beatAudio}

No dialogue other than what is specified. No music. No text overlays. No captions. No scene cuts. No embellishments. Use the full ${durationSeconds} seconds — do not condense.`;

  const PP = require("./pipeline_proxy");
  try {
    const result = await PP.handle({ service: "veo", prompt: promptText, image_uri });
    BUDGET.recordSpend("video_omni_flash", `peek animate ${entry.subject} d${entry.day} ${entry.location}`);
    return { video_uri: result.video_uri, model: result.model, interactionId: result.interactionId, dailyId };
  } catch (e) {
    return { error: String(e.message).slice(0, 400) };
  }
}

// Chunk B: given a scene candidate, plan a 4-shot storyboard with the LLM,
// emit each planned shot as a Particle carrying its own Identity stack, then
// render each Particle's still through the pipeline. Refactored (v2.17) so
// the Identity Layer is the single source of truth for who a character is
// and the Shot Particle is the single unit of coverage. No wardrobe or
// portrait logic in this function — everything is on the Particle.
async function renderSceneStoryboard(scene) {
  // 0. Volume headroom check — if the disk is above 90%, refuse to render.
  // This prevents the "silent partial write, world reset next boot" chain.
  const room = STORAGE.checkRenderHeadroom();
  if (!room.ok) return { error: room.reason };

  // 1. Budget gate for the whole storyboard up front.
  const totalCost = 4 * (BUDGET.COSTS?.image_pro ?? 0.04);
  const gate = BUDGET.canSpend("image_pro", totalCost);
  if (!gate.ok) return { error: `budget: ${gate.reason}` };

  scene.status = "planning";
  // Session 2c: mirror scene state to DB at each lifecycle transition.
  // Idempotent upserts. DB failure never blocks rendering.
  try { DB.upsertScene(scene); } catch (e) { olog(`ERROR scene→DB: ${e.message.slice(0, 120)}`); }
  // Session 4a: emit on the bus so the Watch panel updates the moment the
  // Director kicks off a render — before we've even called the LLM planner.
  try {
    BUS.emit("scene_planning", {
      scene_id: scene.id, day: scene.day, score: scene.score,
      actors: scene.actors, startTime: scene.startTime, endTime: scene.endTime,
    });
  } catch (_) {}
  olog(`SCENE plan: ${scene.id} (score ${scene.score}, ${scene.beats.length} beats, ${scene.actors.join(" · ")})`);

  // 2. LLM plans the storyboard.
  let plan;
  try {
    plan = await callJSON(P.scenePlanPrompt(scene), P.SCENE_PLAN_SCHEMA);
  } catch (e) {
    scene.status = "plan_failed";
    scene.error = `plan: ${e.message.slice(0, 200)}`;
    olog(`SCENE plan failed: ${scene.id} — ${scene.error}`);
    return { error: scene.error };
  }
  scene.title = plan.title;
  scene.logline = plan.logline;

  // 3. Emit one Particle per planned shot. Each carries its Identity stack:
  //    subject Identity (whose face) and context Identities (whose wardrobe
  //    to lock, even if only in-frame). This is the fix for Lena drifting to
  //    a random woman — before, charRefs silently truncated to 2 actors and
  //    the third was rendered with no reference. Now every actor's Identity
  //    is on the Particle.
  const sceneHour = parseHour(scene.startTime);
  const particles = plan.shots.map((s, i) => PARTICLE.emit({
    scene, shotIndex: i, plannedShot: s, sceneHour, worldAgents: W.agents,
  }));
  for (const p of particles) p.weather = W.env.weather;
  scene.particles = particles;
  scene.shots = particles.map(PARTICLE.snapshot);   // preserved for state/watch-panel snapshotting
  scene.status = "rendering";
  try { DB.upsertScene(scene); } catch (e) { olog(`ERROR scene→DB: ${e.message.slice(0, 120)}`); }
  for (const p of particles) {
    try { DB.upsertSceneShot(p); } catch (e) { olog(`ERROR shot→DB: ${e.message.slice(0, 120)}`); }
  }
  olog(`SCENE plan ready: "${scene.title}" — ${scene.logline}`);

  // 4. Render each Particle's still — Session 3b: through the render queue.
  // Each shot becomes a job with kind='still' and priority 5. The worker
  // picks them up one at a time (rate management for Nano Banana) and
  // retries on transient failures. renderSceneStoryboard still awaits
  // completion so the post-loop code (video pipeline, scene status
  // finalization) sees the finished state. Sessions 3c/4 will move to
  // fire-and-forget with event-driven completion.
  for (let i = 0; i < particles.length; i++) {
    const particle = particles[i];
    particle.status = "rendering";
    try { DB.upsertSceneShot(particle); } catch (_) {}
    try {
      // Enqueue and wait. Payload carries the DESCRIPTION of the shot
      // (scene id, actors, planned framing) — the handler rebuilds the
      // full Particle from live W.agents when the worker picks up the job.
      // Session 3b initial approach stored a PARTICLE.snapshot() here, but
      // snapshot strips the Identity context needed for referenceParts,
      // producing 'identities is not iterable' at render time.
      const jobId = DB.enqueueRender({
        kind: "still",
        payload: {
          scene_id: scene.id,
          shot_index: i,
          scene_summary: {
            id: scene.id,
            day: scene.day,
            startSlot: scene.startSlot,
            endSlot: scene.endSlot,
            startTime: scene.startTime,
            endTime: scene.endTime,
            actors: scene.actors,
            beats: scene.beats,
          },
          planned_shot: plan.shots[i],
          scene_hour: sceneHour,
          weather: W.env.weather,
        },
        priority: 5,
        maxAttempts: 3,
      });
      const result = await WORKER.waitForJob(jobId, { timeoutMs: 4 * 60 * 1000 });
      if (!result.ok) throw new Error(result.error || "queue job failed");
      // On success, look up the media row to get the file path
      const media = result.mediaId ? DB.getMedia(result.mediaId) : null;
      particle.stillPath = media?.path || null;
      particle.status = "ready";
      try {
        BUS.emit("scene_shot_ready", {
          scene_id: scene.id, shot_index: i,
          still_url: `/api/scene/${scene.id}/shot/${i}`,
          grammar: particle.grammar, subject: particle.subject?.name,
        });
      } catch (_) {}
      olog(`SCENE shot ${i + 1}/${particles.length}: "${particle.grammar}" ready (job #${jobId})`);
    } catch (e) {
      particle.status = "failed";
      particle.error = String(e.message).slice(0, 200);
      olog(`SCENE shot ${i + 1} FAILED: ${particle.error}`);
      // partial storyboard still has value; continue
    }
    // Update snapshot so state API reflects real-time progress
    scene.shots[i] = PARTICLE.snapshot(particle);
    // Mirror shot state to DB after each render attempt
    try { DB.upsertSceneShot(particle); } catch (e) { olog(`ERROR shot→DB: ${e.message.slice(0, 120)}`); }
  }

  const readyCount = particles.filter((p) => p.status === "ready").length;
  if (readyCount === 0) {
    scene.status = "render_failed";
    return { error: "all shots failed to render" };
  }

  // 5. Persist meta so a restart can rebuild the scene index.
  SCENE_STORE.writeMeta(scene.id, {
    id: scene.id, day: scene.day, startTime: scene.startTime, endTime: scene.endTime,
    title: scene.title, logline: scene.logline, actors: scene.actors,
    beats: scene.beats, shots: scene.shots,
    score: scene.score, renderedAt: new Date().toISOString(),
  });

  scene.status = readyCount === particles.length ? "storyboarded" : "storyboarded_partial";
  scene.poster = `/api/scene/${scene.id}/shot/0`;
  try { DB.upsertScene(scene); } catch (e) { olog(`ERROR scene→DB: ${e.message.slice(0, 120)}`); }
  try {
    BUS.emit("scene_ready", {
      scene_id: scene.id, title: scene.title, logline: scene.logline,
      poster_url: scene.poster, status: scene.status,
      ready_shots: readyCount, total_shots: particles.length,
    });
  } catch (_) {}
  olog(`SCENE ready: "${scene.title}" — ${readyCount}/${particles.length} shots`);

  W.__scenes.candidates = W.__scenes.candidates.filter((c) => c.id !== scene.id);
  W.__scenes.rendered.unshift(scene);
  if (W.__scenes.rendered.length > 30) W.__scenes.rendered.length = 30;

  // Retention: prune old scene directories so the volume doesn't fill up over
  // time. Any scene whose files were deleted has its in-memory poster URL
  // cleared so the cockpit can show "expired" cleanly instead of a broken img.
  try {
    const aggressive = STORAGE.shouldAggressivelyPrune();
    const deleted = SCENE_STORE.purgeStale({ aggressive });
    if (deleted.length) {
      const deletedSet = new Set(deleted);
      for (const s of W.__scenes.rendered) {
        if (deletedSet.has(s.id)) { s.poster = null; s.status = "expired"; }
      }
      const mb = (SCENE_STORE.diskUsageBytes() / 1e6).toFixed(1);
      olog(`SCENE retention${aggressive ? " (AGGRESSIVE)" : ""}: pruned ${deleted.length} stale scene(s), now ${mb} MB on disk`);
    }
  } catch (e) { olog(`ERROR retention: ${e.message.slice(0, 140)}`); }

  // Chunk C: if enough stills rendered to make a real video, kick off
  // Omni animation + FFmpeg edit in the background. Fire-and-forget so
  // world tick isn't blocked by ~4 min of Omni calls. Budget-gated inside
  // renderSceneVideos so a full daily cap won't cascade this.
  if (readyCount >= 3) {
    SCENE_VIDEO.renderSceneVideos(scene, W.agents, olog).catch((e) => olog(`ERROR renderSceneVideos: ${e.message.slice(0, 140)}`));
  }

  return { scene };
}

// Assemble the image-model input parts for a Particle's still render.
// This is the ONE assembly point: room plate, character references, prompt.
// If we later add a LoRA layer or a color-grade reference, it slots in here.
async function renderStillPartsFor(particle) {
  const parts = [];
  // Room plate first — every scene shot anchors to the canonical room look.
  try {
    const plate = await ensurePlate(particle.location);
    if (plate) parts.push({ inlineData: { mimeType: "image/jpeg", data: plate } });
  } catch (_) {}
  // Character portraits — every Identity in the Particle's context, no truncation.
  for (const refPart of IDENTITY.referenceParts(particle.context)) parts.push(refPart);
  // Prompt.
  parts.push({ text: SAFETY.safePrompt(PARTICLE.stillPromptFor(particle)) });
  return parts;
}

// Utility: "07:30" → 7.5. Preserves the fractional hour so wardrobe lookups
// stay correct at half-hour ticks.
function parseHour(clockStr) {
  const [h, m] = String(clockStr || "0:0").split(":").map(Number);
  return (h || 0) + (m || 0) / 60;
}

function nudge() {
  if (!W.paused && !W.busy && Date.now() - W.lastSlotWall > W.speedMs * 2) {
    olog("watchdog: heartbeat overdue — reviving");
    runSlot().catch((e) => olog(`ERROR beat(watchdog): ${String(e.message).slice(0, 140)}`));
  }
}

function shotImage(sparkId, idx) {
  const s = W.sparks.find((x) => x.id === sparkId);
  const sh = s && s.shots && s.shots[idx];
  if (!sh) return null;
  if (sh.file) {
    try { return { mime: sh.mime || "image/png", buf: fs.readFileSync(path.join(SHOTS_DIR, sh.file)) }; } catch (_) { return null; }
  }
  if (sh.image) {
    const m = sh.image.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) return { mime: m[1], buf: Buffer.from(m[2], "base64") };
  }
  return null;
}

module.exports = {
  W, CFG, snapshot, start, save, logs: () => [...LOG], shotImage, nudge, CAMPAIGNS, BRAND_GEO, MEDIA, PRODUCT_PLAN, DAILIES, SCENE_STORE, MOMENT_STORE, BUDGET, STORAGE, peekFrame, animateFrame, callJSON, callGemini: gemini, genImage, ensureCutaway, ensureCampaignStore, ensurePlate, renderObjectFocus, captureLivingMoment, OBJECT_FOCUS, getStoryEngine,
  autoResume: () => { if (W.paused) { W.paused = false; runSlot().catch((e) => olog(`ERROR beat(autoResume): ${String(e.message).slice(0, 140)}`)); olog("world auto-resumed by campaign start"); } },
  worldPaused: () => W.paused,
  control: {
    pause: () => (W.paused = true),
    resume: () => { W.paused = false; runSlot().catch((e) => olog(`ERROR beat: ${String(e.message).slice(0, 140)}`)); },   // kick a beat immediately
    speed: (ms) => setSpeed(clamp(ms, 8000, 120000)),
    inject: (text) => (W.pendingInjection = text),
    env: (weather, headline) => { if (weather) W.env.weather = weather; if (headline !== undefined) W.env.headline = headline; },
    toggleRender: () => (W.renderStoryboards = !W.renderStoryboards),
    reset: () => { try { fs.unlinkSync(CFG.SAVE_PATH); } catch (_) {} process.exit(0); },
  },
};
