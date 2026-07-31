// APE ENGINE — Promise scoring
// After each slot, if any campaign is active, score each character's beat
// against the ten dimensions. Movement is small per slot (±3), and can be
// negative — a product that fails delivers real dips, not zeros.
//
// The scorer is a single structured Gemini call per slot. Cheap: one call
// covers all three characters across all ten dimensions. Cost: roughly one
// dispose call per slot, so ~1.3x the existing per-slot text spend while
// campaigns are running. When no campaigns are active, scoring is skipped.

const D = require("./dimensions");

function buildPrompt({ agents, activeCampaigns, slotEvents, clockLine }) {
  const dimBlock = D.DIMENSIONS.map((d) => `  ${d.id}: ${d.prompt}`).join("\n");
  const activeAgents = Object.entries(agents).filter(([, a]) => !a.asleep && !a.withdrawn);
  const beats = activeAgents.map(([id, a]) => {
    const evts = (slotEvents || []).filter((e) => (e.actors || []).some((n) => (n || "").toLowerCase().startsWith(a.name.toLowerCase().split(" ")[0])));
    return `— ${a.name}:
    think: ${a.think ? '"' + a.think.slice(0, 300) + '"' : "(nothing this slot)"}
    said: ${a.lastSaid ? '"' + a.lastSaid + '"' : "(nothing this slot)"}
    acted: ${a.lastAct ? a.lastAct.slice(0, 200) : "(nothing this slot)"}
    events they were in: ${evts.length ? evts.map((e) => "* " + e.text).join(" ") : "(none)"}
    mood: ${a.mood || ""}`;
  }).join("\n\n");
  const briefs = activeCampaigns.map((c) => {
    const promise = c.promise?.dimensions?.length
      ? c.promise.dimensions.map((p) => `${D.BY_ID[p.id]?.label || p.id}: brand claims to lift by +${p.targetLift}`).join(" | ")
      : "(no explicit promise)";
    return `— ${c.brand}${c.brief.product ? " (" + c.brief.product + ")" : ""}: ${promise}`;
  }).join("\n");

  return `You are an EXPERIMENTAL PSYCHOLOGIST measuring how a single slot of life shifted each person on ten well-defined dimensions.

TIME: ${clockLine}

ACTIVE BRAND CAMPAIGNS (context — do not force alignment, score honestly):
${briefs || "(none)"}

THE TEN DIMENSIONS (each on a 0-100 scale, current baseline sits near 50 unless otherwise noted below):
${dimBlock}

THIS SLOT, FOR EACH ACTIVE PERSON:
${beats}

RULES:
- Movement is small: for each person, each dimension shifts by -3 to +3 based on evidence in THIS slot.
- Nothing in the beat = no movement (0). Do not invent movement to please a brand.
- A brand campaign is present but not necessarily helpful: if the product frustrated them, drained energy, or triggered shame, the relevant dimensions go DOWN. Honest scoring beats optimistic scoring.
- Be specific: cite the phrase or action from the beat in your reason. If you can't cite, the score should be 0.

Return JSON with a "scores" array; one entry per active person named above.`;
}

const SCHEMA = {
  type: "OBJECT",
  properties: {
    scores: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          name: { type: "STRING" },
          deltas: {
            type: "OBJECT",
            properties: Object.fromEntries(D.IDS.map((id) => [id, { type: "INTEGER" }])),
            required: D.IDS,
          },
          top_reason: { type: "STRING", description: "One sentence citing the beat that drove the largest movement." },
        },
        required: ["name", "deltas", "top_reason"],
      },
    },
  },
  required: ["scores"],
};

module.exports = { buildPrompt, SCHEMA };
