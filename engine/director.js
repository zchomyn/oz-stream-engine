// APE ENGINE — Director agent
//
// Watches the truthLog for emergent scenes. Every N slots, scans the last M
// slots of beats and identifies contiguous arcs that would make good short
// films if rendered. Scores each arc against four criteria; top-scoring
// candidates become scene entries the render pipeline (Chunks B–C) picks up.
//
// This module is purely analytical — no rendering, no spend. All it does is
// read state and write scene candidates to W.__scenes.candidates.
//
// Design principles from Zack's brief:
//   - "there should be an agent that finds the moments, connects them"
//   - "so people have access to pre-rendered videos if the simulation runs"
//   - "cinematically — feels like a real world moment, not just a sentence"
//
// The whole point is that the user never had to ask. The Director keeps
// working in the background while they do other things.

const HORIZON_SLOTS = 6;      // scan last ~90 sim-min for arcs
const ARC_MIN_BEATS = 2;
const ARC_MAX_BEATS = 6;
const ARC_MAX_SPAN_SLOTS = 4; // arc must happen within ~1 sim-hour
const SCORE_THRESHOLD = 55;   // candidates below this are ignored
const MAX_CANDIDATES_HELD = 12;

// Score an arc against the four criteria. Returns a total 0-100 and a
// breakdown so we can tune later.
function scoreArc(beats, worldContext) {
  if (beats.length < ARC_MIN_BEATS) return null;

  // (a) character overlap density — do the beats share protagonists?
  const actorFreq = {};
  let totalActors = 0;
  for (const b of beats) {
    for (const a of (b.actors || [])) {
      actorFreq[a] = (actorFreq[a] || 0) + 1;
      totalActors++;
    }
  }
  const uniqueActors = Object.keys(actorFreq).length;
  const dominantActor = Object.values(actorFreq).sort((x, y) => y - x)[0] || 0;
  // Score: high when 2-3 characters are involved, at least one repeatedly
  const overlapScore =
    uniqueActors === 1 ? 40 :
    uniqueActors === 2 ? 90 :
    uniqueActors === 3 ? 100 :
    60;
  // Boost if a protagonist appears in ≥50% of the beats (real through-line)
  const throughLine = dominantActor / beats.length >= 0.5 ? 15 : 0;

  // (b) presence of spoken dialogue vs pure ambient — arcs with real speech
  // score higher (they're what a viewer can actually hear)
  const spokenCount = beats.filter((b) => (b.text || "").match(/says?|asks?|replies|whispers|calls out/i) || (b.text || "").match(/"/)).length;
  const dialogueScore = Math.min(100, (spokenCount / beats.length) * 130);

  // (c) resolution — does something get RESOLVED in this arc? A chore
  // handled, a life event responded to, a want completed.
  //   Right now we detect this by looking for keywords in the tail beat that
  //   suggest closure ("hangs up", "puts it away", "sits back down").
  const closingKeywords = /\b(finally|hangs up|puts away|sits back|folds up|walks out|closes the|turns off|shuts|kisses|takes a breath|nods|smiles|laughs|sighs|says goodbye)\b/i;
  const tail = beats[beats.length - 1].text || "";
  const resolutionScore = closingKeywords.test(tail) ? 90 : 40;

  // (d) novelty — is this arc DIFFERENT from what was happening 30 min ago?
  //   Score is based on how different the vocabulary is between this arc and
  //   the preceding N beats. High vocabulary overlap = repetition = low novelty.
  const arcWords = new Set(beats.map((b) => b.text.toLowerCase().split(/\W+/).filter((w) => w.length > 4)).flat());
  const priorWords = new Set((worldContext.priorBeats || []).map((b) => b.text.toLowerCase().split(/\W+/).filter((w) => w.length > 4)).flat());
  let overlap = 0;
  arcWords.forEach((w) => { if (priorWords.has(w)) overlap++; });
  const noveltyScore = arcWords.size > 0 ? Math.max(20, 100 - Math.round((overlap / arcWords.size) * 100)) : 50;

  // (e) topic-diversity — an arc that traverses multiple topics is a REAL
  // scene shape (setup → complication → resolution). An arc where every beat
  // shares one topic (Lena mentioning dry mouth in 5 different ways) is just
  // dwelling. Reward diversity, penalize monoculture.
  const arcTopics = beats.map((b) => (b.topic || "").toLowerCase().trim()).filter(Boolean);
  const uniqueTopics = new Set(arcTopics);
  let topicDiversityScore;
  if (arcTopics.length === 0) {
    topicDiversityScore = 50;   // no topic data — neutral
  } else if (uniqueTopics.size === 1) {
    topicDiversityScore = 20;   // stuck on one topic — kill it
  } else if (uniqueTopics.size >= arcTopics.length * 0.75) {
    topicDiversityScore = 100;  // most beats are on different topics — real scene shape
  } else {
    topicDiversityScore = 60;   // partial diversity
  }

  // Weighted total. Weights re-balanced to include topic diversity, which
  // meaningfully separates real scenes from "character dwelling on one thing."
  const total = Math.round(
    overlapScore * 0.25 +
    throughLine +
    dialogueScore * 0.20 +
    resolutionScore * 0.15 +
    noveltyScore * 0.10 +
    topicDiversityScore * 0.20
  );

  return {
    total: Math.min(100, total),
    breakdown: { overlapScore, throughLine, dialogueScore, resolutionScore, noveltyScore, topicDiversityScore },
    dominantActors: Object.entries(actorFreq).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k]) => k),
  };
}

// Extract candidate arcs from the last HORIZON_SLOTS worth of truthLog.
// An "arc" is 2-6 contiguous beats within ≤4 slots that share ≥1 actor.
function findArcs(truthLog, currentSlot) {
  const recent = truthLog.filter((b) => b.slot >= currentSlot - HORIZON_SLOTS && b.actors?.length);
  if (recent.length < ARC_MIN_BEATS) return [];

  const arcs = [];
  // Sliding window: consider every start index and every valid end index
  for (let i = 0; i < recent.length; i++) {
    for (let j = i + ARC_MIN_BEATS - 1; j < Math.min(recent.length, i + ARC_MAX_BEATS); j++) {
      const beats = recent.slice(i, j + 1);
      const span = beats[beats.length - 1].slot - beats[0].slot;
      if (span > ARC_MAX_SPAN_SLOTS) break;

      // Every arc must have at least one actor appearing in ≥2 of its beats
      const actorCounts = {};
      for (const b of beats) for (const a of (b.actors || [])) actorCounts[a] = (actorCounts[a] || 0) + 1;
      const hasThroughLine = Object.values(actorCounts).some((c) => c >= 2);
      if (!hasThroughLine) continue;

      arcs.push({ startSlot: beats[0].slot, endSlot: beats[beats.length - 1].slot, beats });
    }
  }
  return arcs;
}

// Run the Director scan. Returns array of scored+ranked candidate arcs above threshold.
//
// Signature updated in Session 2b: caller may pre-fetch beats from the DB
// and pass them in. If beats is omitted, we fall back to W.truthLog (kept
// during migration; Session 3 removes the fallback).
function scan(W, beats) {
  const source = beats || W.truthLog || [];
  if (source.length < ARC_MIN_BEATS) return [];

  const currentSlot = W.slot;
  const arcs = findArcs(source, currentSlot);
  if (!arcs.length) return [];

  // Prior context for novelty scoring — filter within the same window we
  // received. Caller is expected to provide enough history for this to work
  // (roughly currentSlot - HORIZON_SLOTS * 2 backward).
  const priorBeats = source.filter((b) => b.slot < currentSlot - HORIZON_SLOTS && b.slot >= currentSlot - HORIZON_SLOTS * 2);

  const scored = [];
  for (const arc of arcs) {
    const score = scoreArc(arc.beats, { priorBeats });
    if (!score) continue;
    if (score.total < SCORE_THRESHOLD) continue;

    scored.push({
      id: `scene_d${W.day}_s${arc.startSlot}_${arc.endSlot}`,
      startSlot: arc.startSlot,
      endSlot: arc.endSlot,
      startTime: arc.beats[0].time,
      endTime: arc.beats[arc.beats.length - 1].time,
      day: W.day,
      score: score.total,
      breakdown: score.breakdown,
      actors: score.dominantActors,
      beats: arc.beats.map((b) => ({
        slot: b.slot, time: b.time, location: b.location, actors: b.actors, kind: b.kind, text: b.text,
      })),
      found: Date.now(),
      status: "candidate",   // candidate → planning → rendering → ready → played
    });
  }

  // Dedupe overlapping arcs: when multiple candidates cover overlapping slots,
  // prefer the LONGER arc (more beats = more scene shape); ties break to score.
  // Without this the render pipeline would spend $3.20+ rendering the same
  // scene at 4 different zoom levels (breakfast alone as 2 beats, as 3 beats,
  // as 6 beats, etc — all the same underlying story).
  const seenIds = new Set();
  const rankedByLenThenScore = scored.sort((a, b) => {
    const lenDiff = b.beats.length - a.beats.length;
    if (lenDiff !== 0) return lenDiff;
    return b.score - a.score;
  });
  const kept = [];
  for (const s of rankedByLenThenScore) {
    if (seenIds.has(s.id)) continue;
    // Reject if this arc overlaps in slot-range with any already-kept arc
    const overlaps = kept.some((k) =>
      s.startSlot <= k.endSlot && s.endSlot >= k.startSlot
    );
    if (overlaps) continue;
    seenIds.add(s.id);
    kept.push(s);
  }
  return kept.slice(0, 5); // top 5 non-overlapping candidates per scan
}

// Merge new candidates into W.__scenes.candidates without duplicating existing IDs.
function mergeCandidates(W, newCandidates) {
  if (!W.__scenes) W.__scenes = { candidates: [], rendered: [] };
  const existingIds = new Set([
    ...W.__scenes.candidates.map((c) => c.id),
    ...W.__scenes.rendered.map((c) => c.id),
  ]);
  let added = 0;
  for (const c of newCandidates) {
    if (existingIds.has(c.id)) continue;
    W.__scenes.candidates.push(c);
    added++;
  }
  // Cap the candidates queue so old low-score ones age out
  if (W.__scenes.candidates.length > MAX_CANDIDATES_HELD) {
    W.__scenes.candidates.sort((a, b) => b.score - a.score);
    W.__scenes.candidates = W.__scenes.candidates.slice(0, MAX_CANDIDATES_HELD);
  }
  return added;
}

// Compact snapshot for state API + cockpit display
function snapshot(W) {
  if (!W.__scenes) return { candidates: [], rendered: [] };
  return {
    candidates: W.__scenes.candidates.map((c) => ({
      id: c.id,
      day: c.day,
      startTime: c.startTime,
      endTime: c.endTime,
      score: c.score,
      actors: c.actors,
      status: c.status,
      beatCount: c.beats.length,
      preview: c.beats[0]?.text?.slice(0, 120) || "",
    })),
    rendered: W.__scenes.rendered.map((c) => ({
      id: c.id,
      day: c.day,
      startTime: c.startTime,
      endTime: c.endTime,
      score: c.score,
      actors: c.actors,
      title: c.title || null,
      logline: c.logline || null,
      poster: c.poster || null,
      videoUrl: c.videoUrl || null,
      videoStatus: c.videoStatus || null,
      status: c.status,
      shots: (c.shots || []).map((s, i) => ({
        grammar: s.grammar,
        subject: s.subject,
        moment: s.moment,
        status: s.status,
        imageUrl: s.status === "ready" || s.hasStill ? `/api/scene/${c.id}/shot/${i}` : null,
        videoUrl: s.hasVideo ? `/api/scene/${c.id}/video/${i}` : null,
      })),
    })),
  };
}

module.exports = { scan, mergeCandidates, snapshot, SCORE_THRESHOLD };
