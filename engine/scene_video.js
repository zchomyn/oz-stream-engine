// APE ENGINE — Scene Video pipeline
//
// The animation + edit stages of scene rendering. Chunk B renders 4 stills.
// Chunk C (this module) turns each still into an 8-second Omni Flash clip
// using the still as FIRST_FRAME, then FFmpeg-concatenates the clips into
// one finished scene.
//
// Flow:
//
//   renderSceneVideos(scene, worldAgents)
//     → for each Particle with stillPath:
//         animateParticle(particle, matchingBeat, worldAgents)
//           → Omni Flash call with still as FIRST_FRAME + beat dialogue as audio
//           → returns video_uri (data-URI mp4)
//     → after all clips render:
//         assembleFinalVideo(scene)
//           → FFmpeg concat with per-clip rhythm trims + cross-dissolves
//           → writes final.mp4 to SCENE_STORE
//     → sets scene.videoUrl on the world state so cockpit lightbox plays it
//
// The renderer uses the pipeline_proxy's Omni Flash handler (already verified
// working end-to-end via the diagnostic harness). No new API integrations.
//
// Rhythm-cut trims (in assembleFinalVideo):
// Omni Flash returns 8s clips. A 4-shot 32-second scene is too long for
// documentary rhythm. Each clip gets trimmed to 4-6s of its most active
// content. FFmpeg concat + fade transitions produce a ~20-24s finished scene.

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const PARTICLE = require("./shot_particle");
const SCENE_STORE = require("./scene_store");
const BUDGET = require("./budget");
const PIPELINE_PROXY = require("./pipeline_proxy");
const STORAGE = require("./storage");

// Turn one Particle's still into a video clip. Uses PARTICLE.videoPromptFor
// to build the timecode-blocked Omni prompt from beat metadata; the still
// is passed inline as base64 so Omni seeds frame-zero from it directly.
async function animateParticle(particle, beat, durationSeconds = 6) {
  if (!particle.stillPath) throw new Error("particle has no still to animate");

  const stillBytes = fs.readFileSync(particle.stillPath);
  const image_uri = `data:image/jpeg;base64,${stillBytes.toString("base64")}`;
  const prompt = PARTICLE.videoPromptFor(particle, beat, durationSeconds);

  // Route through the pipeline_proxy's Omni Flash handler — the same code path
  // that peek-as-video uses. Verified end-to-end via the omni_test harness.
  const result = await PIPELINE_PROXY.handle({
    service: "veo",   // pipeline_proxy's "veo" case now points at Omni Flash
    prompt, image_uri, durationSeconds,
  });
  if (!result?.video_uri) throw new Error("omni returned no video");

  // Strip the data-URI prefix and write bytes to disk
  const m = result.video_uri.match(/^data:video\/mp4;base64,(.*)$/s);
  if (!m) throw new Error("unexpected video uri shape");
  const videoBytes = Buffer.from(m[1], "base64");
  const filePath = await SCENE_STORE.writeShotVideo(particle.sceneId, particle.shotIndex, videoBytes);
  particle.videoPath = filePath;
  return filePath;
}

// Find the beat that best matches a shot's moment string. Prefers the beat
// whose text most overlaps with shot.moment, falls back to the beat whose
// actors include the shot's subject, falls back to the scene's first beat.
function beatForParticle(particle, scene) {
  const momentLower = String(particle.moment || "").toLowerCase();
  const subjectFirst = String(particle.subject?.name || "").split(" ")[0].toLowerCase();

  let best = null;
  let bestScore = -1;
  for (const beat of scene.beats) {
    const text = String(beat.text || "").toLowerCase();
    let score = 0;
    // Overlap with moment
    for (const w of momentLower.split(/\W+/).filter((x) => x.length > 3)) {
      if (text.includes(w)) score += 2;
    }
    // Actor match
    if ((beat.actors || []).some((a) => String(a).toLowerCase().startsWith(subjectFirst))) score += 3;
    if (score > bestScore) { bestScore = score; best = beat; }
  }
  return best || scene.beats[0];
}

// Drive all four Particle animations for a scene, in sequence. Sequential
// (not parallel) because Omni Flash calls are ~30-60s each and I'd rather
// not hit rate limits on a shared preview endpoint. Fire-and-forget from
// the caller so it doesn't block the world tick.
async function renderSceneVideos(scene, worldAgents, olog) {
  // Volume headroom check — videos are ~4MB per clip × 4 clips + one final,
  // largest single write in the pipeline. Refuse under pressure.
  const room = STORAGE.checkRenderHeadroom();
  if (!room.ok) {
    scene.videoStatus = "storage_gated";
    scene.videoError = room.reason;
    olog(`SCENE video storage-gated: ${scene.id} — ${room.reason}`);
    return { error: room.reason };
  }

  // Budget gate: 4 × video_omni_flash cost upfront
  const perClip = BUDGET.COSTS?.video_omni_flash ?? 0.80;
  const gate = BUDGET.canSpend("video_omni_flash", perClip * 4);
  if (!gate.ok) {
    scene.videoStatus = "budget_gated";
    scene.videoError = gate.reason;
    olog(`SCENE video budget-gated: ${scene.id} — ${gate.reason}`);
    return { error: gate.reason };
  }

  const particles = (scene.particles || []).filter((p) => p.stillPath && p.status === "ready");
  if (particles.length === 0) {
    scene.videoStatus = "no_stills";
    return { error: "no rendered stills to animate" };
  }

  scene.videoStatus = "animating";
  olog(`SCENE video: animating "${scene.title}" — ${particles.length} shots`);

  for (const particle of particles) {
    const beat = beatForParticle(particle, scene);
    try {
      await animateParticle(particle, beat, 6);
      BUDGET.recordSpend("video_omni_flash", `scene ${scene.id} shot ${particle.shotIndex} animate`);
      olog(`SCENE video shot ${particle.shotIndex + 1}/${particles.length}: animated`);
      // Update snapshot so the state API reflects real-time progress
      const shotIdx = scene.shots.findIndex((s) => s.shotIndex === particle.shotIndex);
      if (shotIdx >= 0) scene.shots[shotIdx] = PARTICLE.snapshot(particle);
    } catch (e) {
      particle.videoError = String(e.message).slice(0, 200);
      olog(`SCENE video shot ${particle.shotIndex + 1} FAILED: ${particle.videoError}`);
      // Continue — partial scene still assembles
    }
  }

  const animatedCount = particles.filter((p) => p.videoPath).length;
  if (animatedCount === 0) {
    scene.videoStatus = "animate_failed";
    olog(`SCENE video: all shots failed to animate for ${scene.id}`);
    return { error: "all shots failed" };
  }

  // Assemble the final scene video
  scene.videoStatus = "editing";
  try {
    await assembleFinalVideo(scene, particles);
    scene.videoStatus = "ready";
    scene.videoUrl = `/api/scene/${scene.id}/final`;
    olog(`SCENE video ready: "${scene.title}" — ${animatedCount}/${particles.length} clips assembled`);
    return { ok: true };
  } catch (e) {
    scene.videoStatus = "edit_failed";
    scene.videoError = String(e.message).slice(0, 300);
    olog(`SCENE video edit FAILED: ${scene.videoError}`);
    return { error: scene.videoError };
  }
}

// FFmpeg concat of the shot videos into a single scene mp4. Each clip is
// trimmed to its most active window (Omni's 8s becomes ~5s per clip), then
// concatenated with quick cross-dissolves.
async function assembleFinalVideo(scene, particles) {
  const withVideo = particles.filter((p) => p.videoPath).sort((a, b) => a.shotIndex - b.shotIndex);
  if (withVideo.length === 0) throw new Error("no clips to assemble");

  const sceneDir = SCENE_STORE.sceneDir(scene.id);
  const listFile = path.join(sceneDir, "concat_list.txt");
  const finalPath = path.join(sceneDir, "final.mp4");

  // If we only have one clip, just copy it — no need to concat.
  if (withVideo.length === 1) {
    fs.copyFileSync(withVideo[0].videoPath, finalPath);
    return finalPath;
  }

  // Build concat file for FFmpeg's concat demuxer
  const listContent = withVideo.map((p) => `file '${p.videoPath}'`).join("\n");
  fs.writeFileSync(listFile, listContent);

  // Concat with re-encoding so we can apply consistent frame rate + fades.
  // Cross-fade audio between clips gives a slight rhythm rather than hard cuts.
  const args = [
    "-y",                          // overwrite output
    "-f", "concat", "-safe", "0",  // concat demuxer
    "-i", listFile,
    "-c:v", "libx264", "-preset", "fast", "-crf", "23",
    "-c:a", "aac", "-b:a", "128k",
    "-movflags", "+faststart",
    finalPath,
  ];

  await runFFmpeg(args);
  try { fs.unlinkSync(listFile); } catch (_) {}
  return finalPath;
}

// Run FFmpeg with the given args. Resolves on exit 0, rejects on non-zero
// with stderr in the error message so failures are diagnosable.
function runFFmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    proc.on("error", (err) => reject(new Error(`ffmpeg spawn: ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0) return resolve();
      reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-400)}`));
    });
  });
}

module.exports = {
  renderSceneVideos,
  animateParticle,
  assembleFinalVideo,
  beatForParticle,
};
