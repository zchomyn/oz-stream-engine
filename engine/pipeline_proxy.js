// APE ENGINE — Pipeline proxy
//
// Serves the shapes overnight-pipeline-v7.html expects at a single endpoint.
// The HTML posts to us with either { service: 'imagen'|'veo'|'tts'|... } or
// with { system, messages } (Claude-shape text). We route each to the right
// Gemini call, charge the budget, and return the shape the HTML expects.
//
// This turns overnight-pipeline into a live ad-making studio pointed at the
// same world (and same key) the engine already runs against.

const CFG = require("./config");
const SAFETY = require("./safety");

// ---- Shared Gemini caller (mirrors ape.js's gemini() but self-contained here) ----
async function gemini(model, body) {
  const url = `${CFG.BASE_URL}/models/${model}:generateContent?key=${CFG.GEMINI_API_KEY}`;
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`[${r.status}] ${(await r.text()).slice(0, 300)}`);
  return r.json();
}

// ---- Text (Claude-shape → Gemini) ----
async function proxyText({ system, messages, maxTokens }) {
  const userText = (messages || []).map((m) => typeof m.content === "string" ? m.content : (m.content || []).map((c) => c.text || "").join("\n")).join("\n");
  const body = {
    contents: [{ role: "user", parts: [{ text: userText }] }],
    generationConfig: { maxOutputTokens: maxTokens || 2048, temperature: 0.9 },
  };
  if (system) body.systemInstruction = { parts: [{ text: system }] };
  const data = await gemini(CFG.TEXT_MODEL, body);
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
  // HTML expects a Claude-shaped `{ content: [{ type: 'text', text }] }`.
  return { content: [{ type: "text", text }] };
}

// ---- Imagen / Nano Banana Pro ----
async function proxyImage({ prompt, references = [] }) {
  const parts = [];
  for (const r of references || []) {
    if (!r) continue;
    // Reference may be a data URL, a bare base64, or an http URL.
    if (typeof r === "string") {
      if (r.startsWith("data:")) {
        const m = r.match(/^data:([^;]+);base64,(.*)$/s);
        if (m) parts.push({ inlineData: { mimeType: m[1], data: m[2] } });
      } else if (r.startsWith("http")) {
        try {
          const resp = await fetch(r);
          const buf = Buffer.from(await resp.arrayBuffer());
          parts.push({ inlineData: { mimeType: resp.headers.get("content-type") || "image/jpeg", data: buf.toString("base64") } });
        } catch (_) { /* skip a failed reference */ }
      }
    } else if (r.mimeType && r.data) {
      parts.push({ inlineData: r });
    }
  }
  // Every image the pipeline generates carries the same hard safety envelope
  // as the engine's own renderers. See safety.js.
  parts.push({ text: SAFETY.safePrompt(prompt) });
  const data = await gemini(CFG.IMAGE_MODEL, {
    contents: [{ parts }],
    ...SAFETY.safeImageConfig(),
  });
  const img = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!img) throw new Error("no image returned");
  const uri = `data:${img.inlineData.mimeType || "image/png"};base64,${img.inlineData.data}`;
  return { image_uri: uri };
}

// ---- Gemini Omni Flash / Video ----
// Real Interactions API shape from ai.google.dev/gemini-api/docs/omni (verified
// against Google's docs, not third-party reporting). Synchronous unary call.
// Image conditioning: inline base64 in an input part with {type, data, mime_type}.
// FIRST_FRAME tag in the prompt locks the still as the actual starting frame.
async function proxyVideo({ prompt, image_uri, aspectRatio = "16:9" }) {
  const model = process.env.GEMINI_VIDEO_MODEL || "gemini-omni-flash-preview";

  // Build input array: image part(s) first, then the text prompt
  const inputParts = [];
  if (image_uri && image_uri.startsWith("data:")) {
    const m = image_uri.match(/^data:([^;]+);base64,(.*)$/s);
    if (m) inputParts.push({ type: "image", data: m[2], mime_type: m[1] });
  }
  inputParts.push({ type: "text", text: SAFETY.safePrompt(prompt) });

  const body = {
    model,
    input: inputParts.length === 1 ? inputParts[0].text : inputParts,
    response_format: {
      type: "video",
      aspect_ratio: aspectRatio,   // "16:9" or "9:16"
    },
  };

  // Add task hint when we're doing image-to-video so the model doesn't guess wrong
  if (inputParts.length > 1) {
    body.generation_config = { video_config: { task: "image_to_video" } };
  }

  const url = `${CFG.BASE_URL}/interactions?key=${CFG.GEMINI_API_KEY}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`omni [${res.status}] ${(await res.text()).slice(0, 400)}`);

  const data = await res.json();

  // Video content is inside the model_output step. The SDK exposes it as
  // interaction.output_video.data for convenience, but the REST API only
  // guarantees the steps[] structure. Walk both possibilities.
  let videoB64 = data?.output_video?.data;
  if (!videoB64 && Array.isArray(data?.steps)) {
    for (const step of data.steps) {
      if (step.type !== "model_output" || !Array.isArray(step.content)) continue;
      for (const part of step.content) {
        if (part.type === "video" && part.data) { videoB64 = part.data; break; }
      }
      if (videoB64) break;
    }
  }
  if (!videoB64) throw new Error(`omni: no video in response (${JSON.stringify(data).slice(0, 300)})`);

  return { video_uri: `data:video/mp4;base64,${videoB64}`, model, interactionId: data.id };
}

// ---- TTS ----
// Try Gemini TTS; fall back to a synthetic tone if it fails so the HTML pipeline doesn't die.
async function proxyTTS({ text, gender }) {
  // Minimal Gemini TTS shape. If your project doesn't have this model enabled,
  // it errors; we return an empty audio content and the HTML falls back.
  try {
    const model = "gemini-2.5-flash-preview-tts";
    const body = {
      contents: [{ parts: [{ text }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: gender === "female" ? "Kore" : "Puck" } } },
      },
    };
    const data = await gemini(model, body);
    const audio = data.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
    if (audio?.inlineData?.data) return { audio_content: audio.inlineData.data };
  } catch (_) { /* fall through */ }
  return { audio_content: "" };
}

// ---- proxy_image (fetch remote URL, return as data URI for CORS-safe embedding) ----
async function proxyRemoteImage({ url }) {
  if (!url) return { error: "no url" };
  const r = await fetch(url);
  if (!r.ok) return { error: `fetch ${r.status}` };
  const buf = Buffer.from(await r.arrayBuffer());
  const ct = r.headers.get("content-type") || "image/jpeg";
  return { image_uri: `data:${ct};base64,${buf.toString("base64")}` };
}

// ---- search_images (fallback: return an empty results array, HTML tolerates it) ----
async function searchImages({ query }) {
  // Real Google image search needs a CSE key we don't have wired.
  // The HTML checks for a results array and gracefully proceeds without one.
  return { results: [] };
}

// ---- Router ----
async function handle(body) {
  // Claude-text shape (no service field)
  if (body && !body.service && (body.messages || body.system)) return proxyText(body);
  switch (body?.service) {
    case "imagen": return proxyImage(body);
    case "veo":    return proxyVideo(body);
    case "tts":    return proxyTTS(body);
    case "proxy_image":  return proxyRemoteImage(body);
    case "search_images": return searchImages(body);
    default: throw new Error(`unknown service: ${body?.service}`);
  }
}

module.exports = { handle };
