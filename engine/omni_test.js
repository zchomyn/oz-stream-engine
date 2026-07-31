// APE ENGINE — Omni Flash standalone test harness
//
// Purpose: verify that gemini-omni-flash-preview responds to our request BEFORE
// wiring it back into the peek → animate → cockpit chain. Yesterday shipped
// four broken versions because I wired UI to an API I hadn't verified worked.
// This script exists so that never happens again.
//
// Two modes:
//   text_only:  smallest possible request, no image, no image_to_video. Confirms
//               the model responds to our key and the Interactions endpoint is
//               reachable at all.
//   image_to_video:  the real use case — send Marcus's portrait as the FIRST_FRAME
//                    with a short prompt, get a video back.
//
// Both dump the full response headers, status, and body to the log so we can
// see exactly what Google is returning. Errors are re-raised with the raw
// response text, not swallowed.

const fs = require("fs");
const path = require("path");
const CFG = require("./config");

const MODEL = process.env.GEMINI_VIDEO_MODEL || "gemini-omni-flash-preview";
const ENDPOINT = `${CFG.BASE_URL}/interactions?key=${CFG.GEMINI_API_KEY}`;

async function testTextOnly() {
  const body = {
    model: MODEL,
    input: "A quiet 2-second observational shot: a wooden kitchen counter with a blue ceramic mug and morning light on it. 35mm film aesthetic. No people. No dialogue. Subtle room tone.",
    response_format: { type: "video", aspect_ratio: "16:9" },
  };
  return runRequest("text_only", body);
}

async function testImageToVideo() {
  const anchor = path.join(__dirname, "anchors", "marcus.jpeg");
  if (!fs.existsSync(anchor)) throw new Error(`no anchor at ${anchor}`);
  const bytes = fs.readFileSync(anchor);
  const b64 = bytes.toString("base64");

  const body = {
    model: MODEL,
    input: [
      { type: "image", data: b64, mime_type: "image/jpeg" },
      { type: "text", text: "<FIRST_FRAME> The person in the reference photograph is standing in a Montréal kitchen at 6:15am. Continuous, unbroken handheld shot, ~3 seconds, 35mm film aesthetic, natural window light. He turns his head slightly toward the counter and says: \"Bedroom first. Got it.\" in a natural Montréal English accent. Audio: his voice speaking that line, with subtle radiator hum and light rain on window underneath. No music. No cuts. Same face, same clothing as the reference. Do not change the person." },
    ],
    generation_config: { video_config: { task: "image_to_video" } },
    response_format: { type: "video", aspect_ratio: "16:9" },
  };
  return runRequest("image_to_video", body);
}

async function runRequest(label, body) {
  const started = Date.now();
  const log = [];
  const push = (msg) => { log.push(msg); console.log(`[omni_test:${label}] ${msg}`); };

  push(`endpoint: ${CFG.BASE_URL}/interactions?key=<redacted>`);
  push(`model: ${MODEL}`);
  push(`body size: ${JSON.stringify(body).length} bytes`);
  push(`request sent at ${new Date().toISOString()}`);

  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (e) {
    push(`FETCH ERROR after ${Date.now() - started}ms: ${e.message}`);
    return { ok: false, label, log, error: e.message, elapsedMs: Date.now() - started };
  }

  const elapsedMs = Date.now() - started;
  push(`response received after ${elapsedMs}ms — status ${res.status}`);

  // Dump all headers so we can see if Google is redirecting, returning
  // async operation names, or complaining about model access
  const headers = {};
  res.headers.forEach((v, k) => { headers[k] = v; });
  push(`response headers: ${JSON.stringify(headers)}`);

  const rawText = await res.text();
  push(`response body length: ${rawText.length} bytes`);

  if (!res.ok) {
    push(`response body (first 800 chars): ${rawText.slice(0, 800)}`);
    return { ok: false, label, status: res.status, headers, rawText, log, elapsedMs };
  }

  let parsed = null;
  try { parsed = JSON.parse(rawText); }
  catch (e) {
    push(`response was not JSON: ${rawText.slice(0, 400)}`);
    return { ok: false, label, status: res.status, headers, rawText, log, elapsedMs, parseError: e.message };
  }

  // Walk the response for video content, log where we find it
  const summary = {
    id: parsed?.id,
    hasOutputVideo: !!parsed?.output_video,
    outputVideoDataLen: parsed?.output_video?.data?.length || 0,
    stepsCount: Array.isArray(parsed?.steps) ? parsed.steps.length : 0,
    stepTypes: Array.isArray(parsed?.steps) ? parsed.steps.map((s) => s.type) : [],
    topLevelKeys: Object.keys(parsed || {}),
  };
  push(`parsed summary: ${JSON.stringify(summary)}`);

  // Try to extract video bytes from either shape
  let videoB64 = parsed?.output_video?.data;
  if (!videoB64 && Array.isArray(parsed?.steps)) {
    for (const step of parsed.steps) {
      if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
      for (const part of step.content) {
        if (part.type === "video" && part.data) { videoB64 = part.data; break; }
      }
      if (videoB64) break;
    }
  }
  push(`video extracted: ${videoB64 ? `yes, ${videoB64.length} chars base64` : "no"}`);

  return { ok: !!videoB64, label, status: res.status, headers, summary, log, elapsedMs, videoLen: videoB64?.length || 0 };
}

module.exports = { testTextOnly, testImageToVideo };
