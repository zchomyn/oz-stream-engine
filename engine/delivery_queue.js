// APE STREAM ENGINE — delivery queue.
//
// A public, calendar-based "send Truman something" feature. One delivery
// slot per real-world calendar day. Viewers claim an open day and name an
// item; the next morning in the sim, a package arrives and Truman reacts to
// it in a way that fits the object — wears clothing, displays a curio,
// eats something, uses a gadget, whatever makes sense.
//
// Design constraints:
//   - ONE item per day. Scarcity is the whole point — it gives people a
//     reason to check back and see if "their" day is still open.
//   - Delivery resolves once, at a fixed morning hour, via the SAME
//     pendingInjection mechanism already proven tonight (brand drop, send
//     Marcus to Starbucks). No new sim machinery — just a scheduled trigger.
//   - Basic content moderation on submitted item text — this is public
//     and unauthenticated, so a lightweight denylist + length cap guards
//     against the obvious abuse cases. Not a full safety pipeline; a
//     reasonable first line of defense for a fun feature.

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

const QUEUE_PATH = path.join(path.dirname(CFG.SAVE_PATH), "delivery_queue.json");

let QUEUE = {};   // { "2026-08-08": { item, submittedAt, delivered, revealedResult } }

function load() {
  try {
    if (fs.existsSync(QUEUE_PATH)) {
      QUEUE = JSON.parse(fs.readFileSync(QUEUE_PATH, "utf8"));
    }
  } catch (_) { QUEUE = {}; }
}
load();

function persist() {
  try { fs.writeFileSync(QUEUE_PATH, JSON.stringify(QUEUE, null, 2)); } catch (_) {}
}

// Today's date in the operator's server timezone, as YYYY-MM-DD. Deliveries
// are keyed by real calendar date, not sim date — the whole point is "check
// back tomorrow," which only makes sense against real time.
function todayKey() {
  return new Date().toISOString().slice(0, 10);
}
function dateKeyPlus(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

// Very lightweight content moderation. Not exhaustive — a reasonable first
// line of defense for a public, unauthenticated text field on a fun feature.
// Blocks obvious abuse categories and unreasonable length. Does not attempt
// to catch everything; if this feature gets real traffic, upgrade to an
// LLM-based moderation pass.
const DENYLIST = [
  "fuck", "shit", "cunt", "nigger", "faggot", "retard",
  "kill yourself", "kys", "rape",
];
function moderate(text) {
  const t = String(text || "").trim();
  if (!t) return { ok: false, reason: "empty" };
  if (t.length > 80) return { ok: false, reason: "too long (keep it under 80 characters)" };
  const lower = t.toLowerCase();
  for (const bad of DENYLIST) {
    if (lower.includes(bad)) return { ok: false, reason: "not allowed" };
  }
  return { ok: true, text: t };
}

// List upcoming slots (today through +N days). Each entry: { date, claimed,
// item (only if claimed), delivered }. Item text IS shown once claimed —
// visible scarcity is the mechanic; people should see "Aug 9 — a rubber
// duck (claimed)" and want to grab Aug 10 for themselves.
function listSlots(daysAhead = 10) {
  const out = [];
  const today = todayKey();
  for (let i = 0; i <= daysAhead; i++) {
    const key = dateKeyPlus(i);
    const entry = QUEUE[key];
    out.push({
      date: key,
      isToday: key === today,
      claimed: !!entry,
      item: entry?.item || null,
      delivered: !!entry?.delivered,
    });
  }
  return out;
}

// Claim an open slot. Returns { ok, error? }.
function claimSlot(date, itemText) {
  const today = todayKey();
  if (!date || date < today) return { ok: false, error: "that date has already passed" };
  const maxDate = dateKeyPlus(30);
  if (date > maxDate) return { ok: false, error: "too far in the future — pick a date within 30 days" };
  if (QUEUE[date]) return { ok: false, error: "that day is already claimed — pick another" };
  const mod = moderate(itemText);
  if (!mod.ok) return { ok: false, error: mod.reason };
  QUEUE[date] = { item: mod.text, submittedAt: Date.now(), delivered: false };
  persist();
  return { ok: true, date, item: mod.text };
}

// Peek at today's claimed-but-undelivered item without marking it delivered.
// Caller should check conditions (e.g. is the subject awake) before calling
// confirmDelivered().
function peekTodayDelivery() {
  const today = todayKey();
  const entry = QUEUE[today];
  if (!entry || entry.delivered) return null;
  return entry.item;
}

// Mark today's delivery as actually delivered. Call only after actually
// injecting it.
function confirmDelivered() {
  const today = todayKey();
  const entry = QUEUE[today];
  if (!entry) return;
  entry.delivered = true;
  entry.deliveredAt = Date.now();
  persist();
}

// Convenience wrapper kept for compatibility — peeks and immediately
// confirms. Prefer peekTodayDelivery()/confirmDelivered() when the caller
// needs to gate on conditions (like the subject being awake) before
// committing to "delivered."
function resolveTodayDelivery() {
  const item = peekTodayDelivery();
  if (item) confirmDelivered();
  return item;
}

// Build the injection instruction for a claimed item. The instruction stays
// item-agnostic in HOW it's handled — that judgment is left to the agent
// turn LLM, which is exactly the "he puts on the sweater / displays the duck
// on the mantel / eats the cookie" behavior the feature wants. We just
// establish that a labeled package with this specific item inside arrives
// and Truman brings it in.
function deliveryInjectionText(item) {
  return `There's a knock at the door — a delivery driver has dropped off a small parcel, plainly labeled, containing: ${item}. Truman answers, brings it inside, and opens it right there. He reacts to it and decides what to actually do with it in a way that makes sense for what it is — wear it if it's something wearable, eat it if it's food, display it somewhere in the house if it's an object, use it if it's a gadget, bring it to the office if that's where it belongs. Play this out naturally over the next couple of turns — his reaction, his choice of what to do with it, and where it ends up.`;
}

module.exports = {
  listSlots,
  claimSlot,
  resolveTodayDelivery,
  peekTodayDelivery,
  confirmDelivered,
  deliveryInjectionText,
  todayKey,
  moderate,   // exported for testing
};
