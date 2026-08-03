// WORLD LEDGER — engine-agnostic butterfly-effect substrate.
//
// A persistent record of every significant world event: purchases, visits,
// invitations, promises, mail, phone calls, injuries, gifts, arguments.
// Every entry is dated and attributed. Agents read the ledger as context
// so their actions have consequences and preconditions.
//
// When an emerging action would violate world continuity — cooking dinner
// with no groceries logged, hosting a guest with no invitation — the ledger
// suggests a retroactive filler event ("Meryl stopped at Seahaven Grocers on
// her walk home") that the sim narrates into a character's dayLog. The world
// stays causally consistent.
//
// Portable across worlds: no Truman-specific entries. Ledger schema is
// generic (kind + actors + summary + day + hour).

const fs = require("fs");

const KINDS = [
  "purchase",       // someone bought something
  "visit",          // someone visited someone
  "invitation",     // someone invited someone
  "promise",        // someone promised something
  "mail",           // mail was sent / received
  "phone_call",     // a phone call happened
  "gift",           // someone gave something to someone
  "argument",       // conflict
  "meal",           // shared meal
  "haircut",        // grooming service
  "injury",         // physical event
  "task_complete",  // work task finished
  "encounter",      // brief public meeting
  "arrival",        // someone arrived at a place
  "departure",      // someone left a place
];

class WorldLedger {
  constructor(opts) {
    this.savePath = opts.savePath;
    this.olog = opts.olog || (() => {});
    this.state = {
      entries: [],       // { id, day, hour, kind, actors, summary, meta, weight }
      idCounter: 0,
    };
  }

  async load() {
    try {
      if (this.savePath && fs.existsSync(this.savePath)) {
        this.state = { ...this.state, ...JSON.parse(fs.readFileSync(this.savePath, "utf8")) };
        this.olog(`LEDGER: loaded ${this.state.entries.length} entries`);
      }
    } catch (e) {
      this.olog(`LEDGER: load failed (${e.message}) — starting fresh`);
    }
  }

  save() {
    try {
      if (this.savePath) fs.writeFileSync(this.savePath, JSON.stringify(this.state, null, 2));
    } catch (_) {}
  }

  // Add an entry. Returns the entry with assigned id.
  add({ day, hour, kind, actors, summary, meta, weight }) {
    if (!kind || !summary) return null;
    const id = `ledger_${++this.state.idCounter}`;
    const entry = {
      id,
      day: day || 0,
      hour: hour || 0,
      kind,
      actors: actors || [],
      summary,
      meta: meta || {},
      weight: weight || "normal",   // trivial | normal | important
      createdAt: Date.now(),
    };
    this.state.entries.push(entry);
    // Cap at 500 entries; drop oldest trivial first, then oldest normal
    if (this.state.entries.length > 500) {
      const trivial = this.state.entries.findIndex((e) => e.weight === "trivial");
      if (trivial >= 0) this.state.entries.splice(trivial, 1);
      else this.state.entries.shift();
    }
    this.save();
    return entry;
  }

  // Recent entries for an actor. Used to build agent-turn context.
  recentFor(actorId, limit = 8) {
    return this.state.entries
      .filter((e) => (e.actors || []).includes(actorId))
      .slice(-limit);
  }

  // All recent entries within N days. For general world context.
  recentAll(daysBack = 3, currentDay) {
    return this.state.entries.filter((e) =>
      (currentDay - e.day) <= daysBack
    );
  }

  // Precondition check. Given an intended action, does the ledger show the
  // necessary preconditions? Returns { ok, missing }.
  //
  // Examples:
  //   checkPrecondition("cook dinner with carrots", ["truman", "meryl"], W.day)
  //     → looks for a "purchase" of vegetables in the last 3 days.
  //   checkPrecondition("marlon visits for dinner", ["truman", "marlon"], W.day)
  //     → looks for an "invitation" between truman and marlon in the last 2 days.
  checkPrecondition({ actionText, actors, currentDay, currentHour }) {
    const text = String(actionText || "").toLowerCase();
    const missing = [];

    // Cooking a specific ingredient → need a recent purchase
    const cookMatch = text.match(/cook|prep|prepar|serving/);
    const ingredientMatch = text.match(/carrot|potato|chicken|beef|pork|fish|onion|tomato|lettuce|bread|cheese|milk|egg|pasta|rice/);
    if (cookMatch && ingredientMatch) {
      const ingredient = ingredientMatch[0];
      const purchased = this.state.entries.some((e) =>
        e.kind === "purchase" &&
        (currentDay - e.day) <= 3 &&
        String(e.summary).toLowerCase().includes(ingredient)
      );
      if (!purchased) {
        missing.push({
          kind: "purchase",
          summary: `${actors[0] || "someone"} bought ${ingredient} at the grocery`,
          actor: actors[0],
        });
      }
    }

    // Hosting a guest → need a recent invitation
    const guestMatch = text.match(/visit|come over|drop by|dinner with|hosting/);
    const nameMentioned = ["marlon", "angela", "larry", "doris", "cal", "hank"].filter((n) => text.includes(n));
    if (guestMatch && nameMentioned.length && actors.length) {
      const guest = nameMentioned[0];
      const invited = this.state.entries.some((e) =>
        e.kind === "invitation" &&
        (currentDay - e.day) <= 2 &&
        (e.actors || []).includes(guest)
      );
      if (!invited) {
        missing.push({
          kind: "invitation",
          summary: `${actors[0]} invited ${guest} to come over`,
          actor: actors[0],
        });
      }
    }

    // Haircut → previous appointment or noticed-hair-growing
    const haircutMatch = text.match(/haircut|barber shop|hair cut/);
    if (haircutMatch) {
      const recent = this.state.entries.some((e) =>
        e.kind === "haircut" && (currentDay - e.day) <= 21
      );
      // Not a hard requirement — haircuts happen. Just note it as trivia.
      if (!recent) {
        missing.push({
          kind: "trivia",
          summary: `${actors[0]} last got a haircut three weeks ago`,
          actor: actors[0],
        });
      }
    }

    return { ok: missing.length === 0, missing };
  }

  // Retroactively narrate a missing precondition. Adds a ledger entry for it
  // AND returns a short line that can be pushed into a character's dayLog so
  // it's in the world memory going forward.
  narrateBackward(missing, currentDay, currentHour) {
    if (!missing) return null;
    const actor = missing.actor || "someone";
    const summary = missing.summary;
    const day = currentDay;
    // Place it earlier today or yesterday so it feels like continuity
    const hour = Math.max(0, currentHour - Math.random() * 6);
    const entry = this.add({
      day, hour,
      kind: missing.kind === "purchase" ? "purchase"
          : missing.kind === "invitation" ? "invitation"
          : "encounter",
      actors: [actor],
      summary,
      meta: { retroactive: true },
      weight: "normal",
    });
    return {
      dayLogLine: {
        time: `${String(Math.floor(hour)).padStart(2, "0")}:${String(Math.floor((hour - Math.floor(hour)) * 60)).padStart(2, "0")}`,
        act: `[retroactive] ${summary}`,
        said: "",
        think: "",
      },
      entry,
    };
  }

  // Text block for injection into agent turn context. Recent significant
  // ledger entries this actor was involved in or that shape their world.
  contextFor(actorId, currentDay) {
    const mine = this.recentFor(actorId, 10);
    const world = this.recentAll(3, currentDay).filter((e) => !(e.actors || []).includes(actorId)).slice(-6);
    if (!mine.length && !world.length) return "";
    const lines = [];
    if (mine.length) {
      lines.push("YOUR RECENT WORLD-EVENTS (things that actually happened in your life; must be consistent with what you do next):");
      for (const e of mine) lines.push(`- day ${e.day} ${Math.floor(e.hour)}:00 — ${e.summary}`);
    }
    if (world.length) {
      lines.push("\nWHAT'S HAPPENED AROUND YOU RECENTLY:");
      for (const e of world) lines.push(`- day ${e.day} — ${e.summary}`);
    }
    return lines.join("\n");
  }

  // For debugging.
  entries() { return [...this.state.entries]; }
  count() { return this.state.entries.length; }
}

module.exports = { WorldLedger, KINDS };
