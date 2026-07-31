# APE Engine — Phase 1 (engine first)

The Agent Particle Engine from the explainer, running for real. Choose → Dispose →
Perceive → Reflect, with the psychology that the cockpit's canned data promised:
OCEAN lenses, ranked values, one-way regard/trust ledgers, a computed standing the
agents can't see, memories that distort on recall and consolidate at night, texts
that arrive toneless on the next turn, and a ground-truth log kept separate from
what anyone remembers — so the gap is measurable.

Marcus, Lena, and Theo are seeded from the exact numbers in `useSimulationStore.js`.
The world Scott met continues. It does not reset.

## Run

```bash
cd engine
node server.js        # Node 18+ (built-in fetch). Zero npm installs.
# open http://localhost:8090  →  press ▶ run
```

The key is hardcoded in `config.js` per your call — env vars override when you're
ready. `world-state.json` persists the world across restarts; the reset button
wipes it.

## What to watch in the first hour

1. **The lie under load.** Ground truth: the gas bill is paid and checking sits at
   $236, which Lena doesn't know. Marcus's memories say he's hiding it until
   Friday. Watch the truth-vs-memory panel drift apart, and watch whether Lena's
   "small itch" memory grows into a belief at nightly reflection.
2. **The ledger moving.** Trust climbs in +1s and +2s. If the model flags a
   betrayal (say, Lena checks the account), the ratchet lets it fall 30 points in
   one slot. That asymmetry is engine math, not prompt vibes.
3. **The director staying quiet.** The reel will mostly say "nothing kept yet —
   the gate is strict, that is the point." When it keeps something, it's because
   the mouth and the mind diverged on camera. Repeats must escalate to re-enter.
4. **Theo at school, Marcus at the depot.** Routine gates skip them; arrivals are
   visible events, paths private.
5. **Storyboards with the locked faces.** Sparks render 4 shots (rotating grammar:
   classic, cold open, two-hander, vérité, tableau) anchored to the same three
   profile jpegs the cockpit uses.

## The mechanical / model boundary (the part Scott will ask about)

The model never sets a number. It proposes; the engine clamps:
regard ±6 per slot, trust +2 max up / −30 on flagged betrayal, self-appraisal ±3,
daily drift toward neutral, self-regard drifting to its set point, memory strength
decaying 0.5%/slot and paying a fidelity cost on every recall, unrecalled memories
deleted at reflection. Standing ("the room") is computed as the mean of others'
regard and stored nowhere. Money only moves through dispose(). The immutable FACTS
block plus dispose-side rejection is the fix for the invented-daughter bug.

Cost: ~4 text calls per slot (one per awake agent + one world call), a director
pass every 6 slots, reflections nightly. At "normal" speed that's roughly $0.20–
0.40/hour of text on flash, plus ~$0.16 per rendered storyboard. Toggle 🎬 off to
run psychology-only.

## API (phase 2 hooks — the cockpit)

`GET /api/state` returns characters keyed `marcus|lena|theo` with `personality`,
`senseOfSelf` (incl. computed `room` and `state`), `regardOthers`, `values`,
`wants`, `believes`, `carrying`, `daySoFar`, `innerMonologue` — the same shape as
`useSimulationStore`. Phase 2 is replacing the store's canned object with a 3-second
poll of this endpoint. `POST /api/inject`, `/api/env`, `/api/control` cover the
InjectionEngine and world controls.

Phase 3 is the pipeline bridge: a kept spark enters `overnight-pipeline-v7` at the
casting/keyframe stages with anchors + verbatim lines, replacing brand→brief→
director→storyline. The ad is captured, then produced — never authored.

## Slide 14 replacement copy ("what agents believe")

> **What Agents Believe** — *belief systems are part of a persona, not part of the
> physics.* Some agents in Oz read horoscopes. Some knock on wood. One budgets by
> vibes. The engine gives every agent a belief system and takes none of them as
> true: beliefs bend `perceive()`, never `dispose()`. A superstitious agent sees
> omens in a burnt dinner; the world just sees a burnt dinner. That gap — between
> what a person believes and what actually happened — is the most human thing we
> simulate, and we can measure it.

Attribution to carry forward when the campaign report ships: the report's
light-mirror/dark-mirror structure incorporates the Light/Dark Ethical Framework
by Nick Porcino and Dimitri Diakopoulos (CC BY 4.0).
