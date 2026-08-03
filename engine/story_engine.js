// STORY ENGINE — engine-agnostic narrative substrate.
//
// A story engine that observes a simulation and detects emergent narrative
// pressure. It never dictates beats. It only sees what happened, notes what
// feels story-shaped, and feeds that noticing back to the sim as pressure
// on future agent turns.
//
// The discipline: if a novelist reading a transcript of the last day would
// underline a passage as "this is going to come back later," we make a
// thread. If they'd underline nothing, we make no threads. Bottom-up.
//
// Interface (kept stable so this module can move to any engine):
//   const SE = new StoryEngine({ savePath, callJSON, olog, textModel });
//   await SE.load();                        // hydrate from disk if present
//   await SE.observe(worldSnapshot);        // called ~once per sim-day
//   SE.pressureFor(agentId) → string        // injected into agent turn prompt
//   SE.curateFor(candidates) → sortedList   // director boost for story-touching
//   SE.threads() → array                     // active threads for debugging
//   SE.viewerBrief() → string                // safe vague summary
//
// worldSnapshot shape (any engine can produce this):
//   {
//     day, hour, weather,
//     agents: { [id]: { name, location, think, lastSaid, lastAct, dayLog: [...] } },
//     recentEvents: [{ ts, actor, act, location, said, note }],
//     objects: [{ name, at, state }],
//   }

const fs = require("fs");

class StoryEngine {
  constructor(opts) {
    this.savePath = opts.savePath;
    this.callJSON = opts.callJSON;
    this.olog = opts.olog || (() => {});
    this.textModel = opts.textModel;
    this.state = {
      threads: [],      // active threads
      lastObservedDay: 0,
      lastObservedHour: 0,
      idCounter: 0,
    };
  }

  // Load persisted state from disk. Safe on first boot (no file).
  async load() {
    try {
      if (this.savePath && fs.existsSync(this.savePath)) {
        const raw = fs.readFileSync(this.savePath, "utf8");
        const loaded = JSON.parse(raw);
        this.state = { ...this.state, ...loaded };
        this.olog(`STORY: loaded ${this.state.threads.length} threads from disk`);
      }
    } catch (e) {
      this.olog(`STORY: load failed (${e.message}) — starting fresh`);
    }
  }

  // Persist state to disk. Called after every observe pass.
  save() {
    try {
      if (this.savePath) {
        fs.writeFileSync(this.savePath, JSON.stringify(this.state, null, 2));
      }
    } catch (e) {
      this.olog(`STORY: save failed (${e.message})`);
    }
  }

  // Should we run an observation pass now? Two triggers:
  //  - First observation: after some day 1 activity has accumulated (hour >= 4)
  //  - Subsequent observations: end of each sim-day (hour >= 22 after day roll)
  shouldObserve(worldSnapshot) {
    const day = worldSnapshot.day;
    const hour = worldSnapshot.hour;
    // Bootstrap: we've never observed yet AND some day has some activity
    if (this.state.lastObservedDay === 0 && day >= 1 && hour >= 4) return true;
    // Nightly: crossed into a new day at end-of-day hour
    if (day > this.state.lastObservedDay && hour >= 22) return true;
    return false;
  }

  // Should we plan a daily arc now? Fires at the start of each new day.
  shouldPlanDailyArc(worldSnapshot) {
    const day = worldSnapshot.day;
    const hour = worldSnapshot.hour;
    if (day > (this.state.lastArcPlannedDay || 0) && hour >= 5 && hour <= 9) return true;
    return false;
  }

  // Plan one daily arc — a small emergent beat that should happen today.
  // Fed back into agent pressure so their turns organically make room for it.
  async planDailyArc(worldSnapshot) {
    if (!this.shouldPlanDailyArc(worldSnapshot)) return null;
    const day = worldSnapshot.day;
    const activeThreads = this.state.threads.slice(0, 10)
      .map((t) => `- [${t.weight}] ${t.summary}`).join("\n");
    const agentBrief = Object.entries(worldSnapshot.agents || {}).slice(0, 12)
      .map(([id, a]) => `- ${a.name}: ${a.mood || "steady"}, recently ${a.lastAct || "quiet"}`).join("\n");
    const prompt = `You are helping shape ONE small emergent beat for today. Not a script — a possibility, a nudge.

RULES:
- ONE beat. One small moment or thread. Not a plot.
- Must feel organic, not manufactured. Something a real day would produce.
- Draw from active threads if they'd naturally deepen today. Otherwise a fresh small beat.
- Not big or dramatic. A small human moment: a hesitation, an odd remark, a gift, a rediscovery, an object noticed, a chance encounter, a decision withheld.
- Written in one sentence.
- Must involve 1-3 specific agents by id.

ACTIVE THREADS:
${activeThreads || "  (none)"}

CAST TODAY:
${agentBrief}

Return JSON:
- beat_summary: one sentence describing what small thing could happen today
- involves: array of agent ids
- pressure: second-person text (one paragraph) for the involved agents — how this shapes their day, without dictating any specific action
- keywords: 3-5 short strings for later matching

If today feels quieter and shouldn't have a beat: return {"beat_summary": "", "involves": [], "pressure": "", "keywords": []}`;

    let out;
    try {
      out = await this.callJSON(prompt, DAILY_ARC_SCHEMA);
    } catch (e) {
      this.olog(`STORY: arc planning failed — ${e.message}`);
      return null;
    }
    this.state.lastArcPlannedDay = day;
    if (!out.beat_summary || !out.involves || !out.involves.length) {
      this.save();
      return { skipped: true };
    }
    // Register as a small thread that will get touched over the day
    const id = `arc_${++this.state.idCounter}`;
    this.state.threads.push({
      id,
      summary: out.beat_summary,
      involves: out.involves,
      weight: "small",       // daily arcs start small; observe() may promote later
      pressure: out.pressure,
      firstNoticedAt: `day ${day} hour ${worldSnapshot.hour} (planned)`,
      createdDay: day,
      lastTouchedDay: day,
      touches: 1,
      keywords: out.keywords || [],
      isArc: true,
    });
    this.save();
    this.olog(`STORY: daily arc for day ${day} — ${out.beat_summary}`);
    return { arc: id, summary: out.beat_summary };
  }

  // The heart of the engine. Read the last sim-day of turns and events. Ask
  // the model: what narrative pressure is emerging? Return an array of
  // thread deltas — new threads to add, or updates to existing threads.
  async observe(worldSnapshot) {
    if (!this.shouldObserve(worldSnapshot)) return { added: 0, updated: 0, faded: 0 };

    // First: age existing threads. Threads that haven't been touched by an
    // event in W days should fade. Heaviness of thread determines fade rate.
    const day = worldSnapshot.day;
    const beforeCount = this.state.threads.length;
    this.state.threads = this.state.threads
      .map((t) => ({ ...t, ageDays: day - (t.lastTouchedDay || t.createdDay) }))
      .filter((t) => {
        // Small threads fade after 3 days of no touch, medium after 7, big after 30
        if (t.weight === "small" && t.ageDays > 3) return false;
        if (t.weight === "medium" && t.ageDays > 7) return false;
        if (t.weight === "big" && t.ageDays > 30) return false;
        return true;
      });
    const faded = beforeCount - this.state.threads.length;

    // Now: ask the model what's emerging.
    const prompt = this._buildObservationPrompt(worldSnapshot);
    let observation;
    try {
      observation = await this.callJSON(prompt, OBSERVATION_SCHEMA);
    } catch (e) {
      this.olog(`STORY: observation failed — ${e.message}`);
      this.state.lastObservedDay = day;
      this.state.lastObservedHour = worldSnapshot.hour;
      this.save();
      return { added: 0, updated: 0, faded };
    }

    let added = 0;
    let updated = 0;

    // Process new threads
    for (const nt of observation.new_threads || []) {
      if (!nt.summary || !nt.involves) continue;
      const id = `thread_${++this.state.idCounter}`;
      this.state.threads.push({
        id,
        summary: nt.summary,
        involves: nt.involves,          // array of agent ids
        weight: nt.weight || "small",   // small | medium | big
        pressure: nt.pressure || "",    // text to inject into agent turns
        firstNoticedAt: `day ${day} hour ${worldSnapshot.hour}`,
        createdDay: day,
        lastTouchedDay: day,
        touches: 1,
        keywords: nt.keywords || [],     // for capture curation matching
      });
      added++;
      this.olog(`STORY: new ${nt.weight || "small"} thread — ${nt.summary.slice(0, 100)}`);
    }

    // Process updates to existing threads
    for (const upd of observation.thread_updates || []) {
      const t = this.state.threads.find((x) => x.id === upd.thread_id);
      if (!t) continue;
      if (upd.new_pressure) t.pressure = upd.new_pressure;
      if (upd.new_summary) t.summary = upd.new_summary;
      if (upd.weight_change) t.weight = upd.weight_change;
      t.lastTouchedDay = day;
      t.touches = (t.touches || 0) + 1;
      updated++;
      this.olog(`STORY: touched thread ${t.id} (${t.summary.slice(0, 60)})`);
    }

    this.state.lastObservedDay = day;
    this.state.lastObservedHour = worldSnapshot.hour;
    this.save();
    return { added, updated, faded };
  }

  // Build the observation prompt. This is what the model sees.
  _buildObservationPrompt(w) {
    const activeThreadsBlock = this.state.threads.length
      ? this.state.threads.slice(0, 20).map((t, i) =>
          `[${t.id}] (${t.weight}, age ${t.ageDays || 0}d, involves ${(t.involves || []).join(", ")}): ${t.summary}`
        ).join("\n")
      : "  (none yet)";

    // Sample the recent agent behavior
    const agentSummaries = Object.entries(w.agents || {}).map(([id, a]) => {
      const recentLog = (a.dayLog || []).slice(0, 8).map((l) =>
        `  ${l.time}: [${l.act}]${l.said ? ` "${l.said}"` : ""}`
      ).join("\n");
      return `${a.name} (${id}):
  current: ${a.lastAct || "quiet"}${a.lastSaid ? ` — "${a.lastSaid}"` : ""}
  recent thinking: ${(a.think || "").slice(0, 200)}
  today so far:
${recentLog || "  (nothing yet)"}`;
    }).join("\n\n");

    return `You are a story observer, not a story writer. You watch a simulated world and note what a careful novelist would circle as story-shaped — moments where behavior implies something unspoken, patterns that could pay off later, tensions building beneath ordinary life.

RULES:
- Do NOT invent plot. Do NOT suggest what should happen next. Only note what has ALREADY emerged from what these characters have already done and said.
- If nothing story-shaped emerged this cycle, return empty arrays. That is a valid answer. Do not manufacture threads.
- Weight threads honestly: "small" is a hesitation, a glance, a word out of place. "medium" is a pattern across multiple turns. "big" is a rupture, a lie, a lasting emotional shift.
- Pressure text is what THIS THREAD makes the involved characters carry going forward. Written in second person to the character: "You have been carrying this since Tuesday..."

ACTIVE THREADS (already noted, may deepen with today's behavior):
${activeThreadsBlock}

TODAY'S WORLD:
Day ${w.day}, hour ${w.hour}. Weather: ${w.weather || "clear"}.

CHARACTERS AND THEIR DAY:
${agentSummaries}

Return JSON matching the schema:
- new_threads: array of new story-shaped observations that emerged today. Each has summary (one sentence), involves (array of agent ids), weight (small/medium/big), pressure (second-person text for the involved agents), keywords (3-5 short strings for matching future scenes).
- thread_updates: array of updates to existing threads. Each has thread_id, optional new_summary, optional new_pressure, optional weight_change.

If nothing story-shaped happened today, return {"new_threads": [], "thread_updates": []}.`;
  }

  // Text to inject into an agent's turn prompt. All active threads involving
  // this agent, joined. If none, empty string.
  pressureFor(agentId) {
    const mine = this.state.threads.filter((t) => (t.involves || []).includes(agentId) && t.pressure);
    if (!mine.length) return "";
    // Bigger threads earlier
    mine.sort((a, b) => {
      const rank = { big: 3, medium: 2, small: 1 };
      return (rank[b.weight] || 0) - (rank[a.weight] || 0);
    });
    const lines = mine.slice(0, 4).map((t) => `- ${t.pressure}`);
    return `CARRYING WITH YOU (things you have been carrying from earlier days, without necessarily thinking about them consciously right now):\n${lines.join("\n")}`;
  }

  // Score a set of candidate captures against active threads. Frames that
  // intersect with a thread (by keyword match against activityLines, location,
  // or subject involvement) get a boost.
  curateFor(candidates) {
    if (!this.state.threads.length) return candidates;
    return candidates.map((c) => {
      let bonus = 0;
      const ctx = `${c.subjectKey || ""} ${c.actNormalized || ""} ${(c.location || "").toLowerCase()}`;
      for (const t of this.state.threads) {
        // Subject involvement
        if (c.subjectKey && (t.involves || []).includes(c.subjectKey)) {
          bonus += t.weight === "big" ? 25 : t.weight === "medium" ? 15 : 6;
        }
        // Keyword match
        for (const kw of t.keywords || []) {
          if (kw && ctx.includes(String(kw).toLowerCase())) {
            bonus += t.weight === "big" ? 12 : t.weight === "medium" ? 8 : 3;
            break;
          }
        }
      }
      return { ...c, storyBonus: bonus };
    });
  }

  threads() {
    return [...this.state.threads];
  }

  // Safe vague brief for UI / debugging endpoint. Never spoils.
  viewerBrief() {
    return {
      activeCount: this.state.threads.length,
      byWeight: {
        big: this.state.threads.filter((t) => t.weight === "big").length,
        medium: this.state.threads.filter((t) => t.weight === "medium").length,
        small: this.state.threads.filter((t) => t.weight === "small").length,
      },
      lastObservedDay: this.state.lastObservedDay,
    };
  }
}

const OBSERVATION_SCHEMA = {
  type: "object",
  properties: {
    new_threads: {
      type: "array",
      items: {
        type: "object",
        properties: {
          summary: { type: "string" },
          involves: { type: "array", items: { type: "string" } },
          weight: { type: "string", enum: ["small", "medium", "big"] },
          pressure: { type: "string" },
          keywords: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "involves", "weight"],
      },
    },
    thread_updates: {
      type: "array",
      items: {
        type: "object",
        properties: {
          thread_id: { type: "string" },
          new_summary: { type: "string" },
          new_pressure: { type: "string" },
          weight_change: { type: "string", enum: ["small", "medium", "big"] },
        },
        required: ["thread_id"],
      },
    },
  },
  required: ["new_threads", "thread_updates"],
};

const DAILY_ARC_SCHEMA = {
  type: "object",
  properties: {
    beat_summary: { type: "string" },
    involves: { type: "array", items: { type: "string" } },
    pressure: { type: "string" },
    keywords: { type: "array", items: { type: "string" } },
  },
  required: ["beat_summary", "involves"],
};

module.exports = { StoryEngine, OBSERVATION_SCHEMA };
