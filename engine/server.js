// APE ENGINE — server + debug viewer
// Zero dependencies. `node server.js` then open http://localhost:8090
// GET  /api/state   — full snapshot (shape matches the cockpit's useSimulationStore)
// POST /api/control — {action: pause|resume|reset|toggleRender, speedMs?}
// POST /api/inject  — {text} product drop or event, arrives naturally next slot
// POST /api/env     — {weather?, headline?}

const http = require("http");
const CFG = require("./config");
const APE = require("./ape");
const DB = require("./db");
let wsHandle = null;   // populated after WS attach at bottom of file
const OMNI_TEST = require("./omni_test");

// Optional gate for public URLs: set ACCESS_CODE env and every request needs
// ?code=... (or x-oz-code header). Empty = open, for local use.
const ACCESS_CODE = process.env.ACCESS_CODE || "";

function json(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(obj));
}
function body(req) { return new Promise((r) => { let d = ""; req.on("data", (c) => (d += c)); req.on("end", () => { try { r(JSON.parse(d || "{}")); } catch (_) { r({}); } }); }); }

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "Content-Type,x-oz-code", "Access-Control-Allow-Methods": "GET,POST" }); return res.end(); }

  // ============ PUBLIC STREAM ROUTES ============
  // No auth. This is what the public sees.
  //   GET /stream           → the viewer HTML page
  //   GET /stream/latest.jpg → the latest hero frame from any capture-moment
  //   GET /stream/status    → { sim time, LIVE flag, cam label, subject location }
  //
  // The stream serves the most recent moment from MOMENT_STORE. When the
  // sim advances and produces a new hero frame, /stream/latest.jpg updates.
  const streamUrl = req.url.split("?")[0];
  if (streamUrl === "/stream" || streamUrl === "/stream/") {
    const html = renderStreamHtml();
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store, must-revalidate", "Access-Control-Allow-Origin": "*" });
    return res.end(html);
  }
  if (streamUrl === "/stream/latest.jpg") {
    try {
      const latest = APE.MOMENT_STORE.latest();
      if (!latest || !latest.b64) {
        // Serve a 1x1 transparent placeholder if no frames yet.
        const placeholder = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");
        res.writeHead(200, { "Content-Type": "image/gif", "Cache-Control": "no-store" });
        return res.end(placeholder);
      }
      const buf = Buffer.from(latest.b64, "base64");
      res.writeHead(200, {
        "Content-Type": "image/jpeg",
        "Cache-Control": "no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      });
      return res.end(buf);
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }
  if (streamUrl === "/stream/status") {
    try {
      const latest = APE.MOMENT_STORE.latest();
      const snap = APE.snapshot();
      const trumanLoc = snap.characters?.truman?.location || "unknown";
      return json(res, 200, {
        live: !snap.isPaused,
        day: snap.day,
        clock: snap.clock,
        subject: "Truman Burbank",
        subjectLocation: trumanLoc,
        latestMomentId: latest?.id || null,
        camLabel: latest?.meta?.camLabel || null,
      });
    } catch (e) {
      return json(res, 500, { error: e.message });
    }
  }

  // ============ AUTHED OPERATOR ROUTES ============
  if (ACCESS_CODE) {
    const q = new URL(req.url, "http://x").searchParams.get("code");
    if (q !== ACCESS_CODE && req.headers["x-oz-code"] !== ACCESS_CODE)
      return json(res, 401, { error: "access code required — append ?code=YOURCODE" });
  }
  const u = req.url.split("?")[0];

  if (u === "/api/state") { APE.nudge(); return json(res, 200, APE.snapshot()); }
  if (u === "/api/budget" && req.method === "GET") return json(res, 200, APE.BUDGET.snapshot());
  if (u === "/api/budget" && req.method === "POST") {
    const b = await body(req);
    if (typeof b.dailyCapUsd === "number") APE.BUDGET.setDailyCap(b.dailyCapUsd);
    if (typeof b.autoRender === "boolean") APE.BUDGET.setAutoRender(b.autoRender);
    if (typeof b.runLiveMinutes === "number") APE.BUDGET.setRunLiveMinutes(b.runLiveMinutes);
    return json(res, 200, APE.BUDGET.snapshot());
  }
  if (u === "/api/generate" && req.method === "POST") {
    const b = await body(req);
    const service = b?.service;
    const budgetKind = service === "imagen" ? "image_pro" : service === "veo" ? "video_omni" : "text";
    if (budgetKind !== "text") {
      const gate = APE.BUDGET.canSpend(budgetKind);
      if (!gate.ok) return json(res, 402, { error: gate.reason });
    }
    try {
      const PP = require("./pipeline_proxy");
      const out = await PP.handle(b);
      if (budgetKind !== "text" && out && !out.error) APE.BUDGET.recordSpend(budgetKind, `pipeline ${service}`);
      return json(res, 200, out);
    } catch (e) {
      return json(res, 500, { error: String(e.message).slice(0, 300) });
    }
  }

  // Campaign context for the pipeline HTML — the brand's brief, the family's
  // most recent signals, so a "make ad from campaign" flow has the real world
  // to work with instead of blank inputs.
  if (u.startsWith("/api/campaigns/") && u.endsWith("/pipelineContext") && req.method === "GET") {
    const id = u.split("/")[3];
    const c = APE.CAMPAIGNS.get(id);
    if (!c) return json(res, 404, { error: "campaign not found" });
    const sigs = APE.CAMPAIGNS.signalsFor(id).slice(-40);
    const highlights = sigs.filter(s => ["said","thought","act","reflection"].includes(s.kind)).slice(-20);
    return json(res, 200, {
      brand: c.brand,
      product: c.brief?.product,
      audience: c.brief?.audience,
      promise: c.promise,
      tone: c.brief?.tone,
      keywords: c.brief?.keywords,
      recentBeats: highlights.map(s => ({ who: s.actor, kind: s.kind, text: s.text, time: s.time, day: s.day })),
      recentTouches: (c.touches || []).slice(-8),
    });
  }

  // Diagnostic endpoint for Omni Flash. GET /api/diag/omni?mode=text_only|image_to_video
  // Runs the standalone Interactions request in isolation and returns everything —
  // status, headers, response summary, video byte count. Purpose: verify the API
  // responds before we wire it back into peek. Yesterday shipped four broken
  // versions because I built UI on top of an untested API request. This is the
  // step-zero verification that comes first now.
  if (u.startsWith("/api/diag/omni") && req.method === "GET") {
    // req.url includes query string; u has had it stripped for path matching.
    const mode = new URL("http://x" + req.url).searchParams.get("mode") || "text_only";
    try {
      const result = mode === "image_to_video"
        ? await OMNI_TEST.testImageToVideo()
        : await OMNI_TEST.testTextOnly();
      return json(res, 200, result);
    } catch (e) {
      return json(res, 500, { error: String(e.message), stack: (e.stack || "").split("\n").slice(0, 5) });
    }
  }
  if (u === "/api/peek" && req.method === "POST") {
    const b = await body(req);
    const r = await APE.peekFrame(b || {});
    return json(res, r.error ? 402 : 200, r);
  }
  // Turn an existing rendered daily into a short Omni Flash video (~$0.30).
  // POST /api/peek/:dailyId/animate  { durationSeconds?: 8 }  (Omni max is 10)
  const animMatch = u.match(/^\/api\/peek\/([^\/]+)\/animate$/);
  if (animMatch && req.method === "POST") {
    const dailyId = animMatch[1];
    const b = await body(req);
    const r = await APE.animateFrame(dailyId, b?.durationSeconds || 8);
    return json(res, r.error ? 402 : 200, r);
  }

  // ---- Campaigns ----
  if (u === "/api/dimensions" && req.method === "GET")
    return json(res, 200, { dimensions: require("./dimensions").DIMENSIONS });

  // ---- Dailies ----
  if (u === "/api/dailies" && req.method === "GET") {
    const url = new URL(req.url, "http://x");
    const since = parseInt(url.searchParams.get("since") || "0", 10);
    const limit = parseInt(url.searchParams.get("limit") || "60", 10);
    const campaignId = url.searchParams.get("campaignId") || "";
    return json(res, 200, { dailies: APE.DAILIES.list({ since, limit, campaignId }), pending: APE.DAILIES.pending() });
  }
  if (u.startsWith("/api/dailies/")) {
    const id = u.split("/")[3];
    const f = APE.DAILIES.file(id);
    if (!f) return json(res, 404, { error: "not found" });
    const buf = require("fs").readFileSync(f.path);
    res.writeHead(200, { "Content-Type": f.mime, "Cache-Control": "public, max-age=86400, immutable", "Access-Control-Allow-Origin": "*" });
    return res.end(buf);
  }

  // Character portrait — served for the Observer Camera's room-view compositor
  // and any UI that needs a small face crop. Portraits are the canonical
  // reference photos generated at world seed; served from BIBLE.
  const portraitMatch = u.match(/^\/api\/portrait\/([a-z]+)$/);
  if (portraitMatch && req.method === "GET") {
    const key = portraitMatch[1];
    const entry = require("./bible").get("char_" + key);
    if (!entry) return json(res, 404, { error: `no portrait for "${key}"` });
    const buf = Buffer.from(entry.b64, "base64");
    res.writeHead(200, { "Content-Type": entry.mime || "image/jpeg", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" });
    return res.end(buf);
  }

  // Observer Camera Layer 1: isometric cutaway of the whole duplex.
  // Cached in BIBLE forever after first render; ?force=1 regenerates.
  // Returns JPEG bytes; ETag stable so browsers can cache aggressively.
  if (u.startsWith("/api/cutaway") && req.method === "GET") {
    const force = new URL("http://x" + req.url).searchParams.get("force") === "1";
    const b64 = await APE.ensureCutaway({ force });
    if (!b64) return json(res, 500, { error: APE.W.lastError || "cutaway unavailable" });
    const buf = Buffer.from(b64, "base64");
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": force ? "no-cache" : "public, max-age=3600", "Access-Control-Allow-Origin": "*" });
    return res.end(buf);
  }

  // Observer Camera Layer 2: canonical plate for any location.
  // /api/plate/:locationKey — matches the plateId() normalization.
  // ?force=1 bypasses cache and re-renders against the current platePrompt.
  // Response ETag tracks BIBLE version so browsers auto-revalidate when
  // the plate is regenerated even without ?force in the client URL.
  const plateMatch = u.match(/^\/api\/plate\/([^\/]+)$/);
  if (plateMatch && req.method === "GET") {
    const raw = decodeURIComponent(plateMatch[1]);
    const params = new URL("http://x" + req.url).searchParams;
    const force = params.get("force") === "1";
    const b64 = await APE.ensurePlate(raw, { force });
    if (!b64) return json(res, 404, { error: `no plate for "${raw}"` });
    const buf = Buffer.from(b64, "base64");
    // Read version from BIBLE for ETag. The put() version bump means
    // regenerated plates get a new ETag → browser re-fetches automatically.
    let version = 1;
    try {
      const plateId = require("./ape");
      const BIBLE = require("./bible");
      const bibleId = "plate_" + raw.toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const entry = BIBLE.list().find((e) => e.id === bibleId);
      if (entry) version = entry.version;
    } catch (_) {}
    const etag = `W/"plate-${raw}-v${version}"`;
    // If the client sent this exact ETag, we could 304 — but for simplicity
    // (and because 5-second freshness matters at demo time) just serve fresh
    // bytes with the versioned ETag. Cache-Control short.
    const cacheControl = force ? "no-cache, no-store, must-revalidate" : "public, max-age=60, must-revalidate";
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": cacheControl, "ETag": etag, "Access-Control-Allow-Origin": "*" });
    return res.end(buf);
  }

  // Observer Camera Layer 3: list of clickable objects in a room.
  // GET /api/room-objects/:location → { fixtures: [...], runtime: [...] }
  const roomObjMatch = u.match(/^\/api\/room-objects\/([^\/]+)$/);
  if (roomObjMatch && req.method === "GET") {
    const raw = decodeURIComponent(roomObjMatch[1]);
    const result = APE.OBJECT_FOCUS.listInRoom(raw, APE.W.objects || []);
    return json(res, 200, { location: raw, ...result });
  }

  // Observer Camera Layer 3: render/serve a specific object close-up.
  // GET /api/object/:location/:objectKey — renders (or returns cached) close-up.
  const objectMatch = u.match(/^\/api\/object\/([^\/]+)\/([^\/]+)$/);
  if (objectMatch && req.method === "GET") {
    const location = decodeURIComponent(objectMatch[1]);
    const objectKey = decodeURIComponent(objectMatch[2]);
    // Look up the descriptor (fixture or runtime)
    const list = APE.OBJECT_FOCUS.listInRoom(location, APE.W.objects || []);
    const descriptor = [...list.fixtures, ...list.runtime].find((o) => o.key === objectKey);
    if (!descriptor) return json(res, 404, { error: `no object "${objectKey}" in "${location}"` });
    const bytes = await APE.renderObjectFocus(location, descriptor);
    if (!bytes) return json(res, 500, { error: APE.W.lastError || "render failed" });
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*" });
    return res.end(bytes);
  }

  // ADMIN: aggressive live storage cleanup. Prunes scenes, moments, dailies
  // down to their keep-latest bounds. Non-destructive to DB or campaigns.
  // Body: { confirm: 'clean up storage', sceneKeep?: 20, momentKeep?: 10 }
  if (u === "/api/admin/cleanup" && req.method === "POST") {
    const b = await body(req);
    if (b?.confirm !== "clean up storage") {
      return json(res, 400, { error: "confirmation required", expected: { confirm: "clean up storage" } });
    }
    try {
      const fs = require("fs");
      const path = require("path");
      const dataDir = path.dirname(CFG.SAVE_PATH);
      const before = { pct: null, freeBytes: null };
      try { const s = STORAGE.status(); before.pct = s.pct; before.freeBytes = s.freeBytes; } catch (_) {}

      const SCENE_STORE = require("./scene_store");
      const MOMENT_STORE = require("./moment_store");
      const sceneKeep = Number.isFinite(b?.sceneKeep) ? b.sceneKeep : 20;
      const momentKeep = Number.isFinite(b?.momentKeep) ? b.momentKeep : 10;
      const scenesBefore = SCENE_STORE.diskUsageBytes();
      const deletedScenes = SCENE_STORE.purgeStale({ keepCount: sceneKeep });
      const scenesAfter = SCENE_STORE.diskUsageBytes();

      // Moments: prune to keepCount most recent
      const momentsDir = path.join(dataDir, "moments");
      let deletedMoments = 0;
      let momentBytes = 0;
      try {
        if (fs.existsSync(momentsDir)) {
          const entries = fs.readdirSync(momentsDir)
            .map((name) => {
              const p = path.join(momentsDir, name);
              try {
                const st = fs.statSync(p);
                if (!st.isDirectory()) return null;
                return { id: name, path: p, mtime: st.mtimeMs };
              } catch (_) { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);
          for (let i = momentKeep; i < entries.length; i++) {
            try {
              const walk = (p) => {
                const st = fs.statSync(p);
                if (st.isDirectory()) {
                  for (const n of fs.readdirSync(p)) walk(path.join(p, n));
                  fs.rmdirSync(p);
                } else { momentBytes += st.size; fs.unlinkSync(p); }
              };
              walk(entries[i].path);
              deletedMoments++;
            } catch (_) {}
          }
        }
      } catch (_) {}

      // Dailies: keep only the most recent 20 stills
      const dailiesDir = path.join(dataDir, "dailies");
      let deletedDailies = 0;
      let dailyBytes = 0;
      try {
        if (fs.existsSync(dailiesDir)) {
          const entries = fs.readdirSync(dailiesDir)
            .filter((n) => n.endsWith(".jpg") || n.endsWith(".jpeg") || n.endsWith(".png") || n.endsWith(".mp4"))
            .map((n) => {
              const p = path.join(dailiesDir, n);
              try { const st = fs.statSync(p); return { name: n, path: p, mtime: st.mtimeMs, size: st.size }; }
              catch (_) { return null; }
            })
            .filter(Boolean)
            .sort((a, b) => b.mtime - a.mtime);
          for (let i = 20; i < entries.length; i++) {
            try { fs.unlinkSync(entries[i].path); dailyBytes += entries[i].size; deletedDailies++; } catch (_) {}
          }
        }
      } catch (_) {}

      // Sparks: fully clear — they're regenerable
      const sparksDir = path.join(dataDir, "sparks");
      let deletedSparks = 0;
      let sparkBytes = 0;
      try {
        if (fs.existsSync(sparksDir)) {
          for (const n of fs.readdirSync(sparksDir)) {
            const p = path.join(sparksDir, n);
            try { const st = fs.statSync(p); if (!st.isFile()) continue; sparkBytes += st.size; fs.unlinkSync(p); deletedSparks++; } catch (_) {}
          }
        }
      } catch (_) {}

      const after = { pct: null, freeBytes: null };
      try { const s = STORAGE.status(); after.pct = s.pct; after.freeBytes = s.freeBytes; } catch (_) {}
      const totalBytesFreed = (scenesBefore - scenesAfter) + momentBytes + dailyBytes + sparkBytes;

      return json(res, 200, {
        ok: true,
        scenes: { deleted: deletedScenes.length, kept: sceneKeep, bytesFreed: scenesBefore - scenesAfter },
        moments: { deleted: deletedMoments, kept: momentKeep, bytesFreed: momentBytes },
        dailies: { deleted: deletedDailies, bytesFreed: dailyBytes },
        sparks: { deleted: deletedSparks, bytesFreed: sparkBytes },
        totalMBFreed: +(totalBytesFreed / 1e6).toFixed(1),
        volumeBefore: before,
        volumeAfter: after,
      });
    } catch (e) {
      return json(res, 500, { error: e.message?.slice(0, 400) });
    }
  }

  // ADMIN: nuke the whole /data volume so v2.41 seeds the world with the
  // new schedule + payday model from world.js. Re-added temporarily; removed
  // in the next commit after use. Same pattern as v2.38.3.
  if (u === "/api/admin/nuke-volume-and-reseed" && req.method === "POST") {
    const b = await body(req);
    if (b?.confirm !== "wipe /data and let the world be born again") {
      return json(res, 400, {
        error: "confirmation required",
        expected: { confirm: "wipe /data and let the world be born again" },
      });
    }
    try {
      const fs = require("fs");
      const path = require("path");
      const dataDir = path.dirname(CFG.SAVE_PATH);
      const before = { pct: null, freeBytes: null };
      try {
        const s = STORAGE.status();
        before.pct = s.pct;
        before.freeBytes = s.freeBytes;
      } catch (_) {}
      const dbStats = (() => { try { return DB.stats(); } catch (_) { return {}; } })();
      const preSummary = {
        agents: dbStats.agentCount || 0,
        memories: dbStats.memCount || 0,
        beats: dbStats.beatCount || 0,
        scenes: dbStats.sceneCount || 0,
        moments: dbStats.momentCount || 0,
        campaigns: dbStats.campaignCount || 0,
        volumePct: before.pct,
        volumeMBFree: before.freeBytes ? +(before.freeBytes / 1e6).toFixed(1) : null,
      };
      const removed = [];
      const failed = [];
      let bytesFreed = 0;
      const walk = (p) => {
        let st;
        try { st = fs.statSync(p); }
        catch (e) { failed.push({ path: p, error: e.message }); return; }
        if (st.isDirectory()) {
          let children;
          try { children = fs.readdirSync(p); }
          catch (e) { failed.push({ path: p, error: e.message }); return; }
          for (const name of children) walk(path.join(p, name));
          try { fs.rmdirSync(p); removed.push(p + "/"); }
          catch (e) { failed.push({ path: p, error: e.message }); }
        } else {
          bytesFreed += st.size;
          try { fs.unlinkSync(p); removed.push(p); }
          catch (e) { failed.push({ path: p, error: e.message }); }
        }
      };
      let topLevel;
      try { topLevel = fs.readdirSync(dataDir); }
      catch (e) {
        return json(res, 500, { error: `cannot read ${dataDir}: ${e.message}` });
      }
      for (const name of topLevel) walk(path.join(dataDir, name));
      setTimeout(() => process.exit(0), 300);
      return json(res, 200, {
        ok: true,
        preSummary,
        removedCount: removed.length,
        failedCount: failed.length,
        mbFreed: +(bytesFreed / 1e6).toFixed(1),
        removedSample: removed.slice(0, 30),
        failed: failed.slice(0, 20),
        note: "Volume wiped. Process exiting in 300ms. Railway restarts; ape.js seeds fresh from world.js. Reconnect after ~30s.",
      });
    } catch (e) {
      return json(res, 500, { error: e.message?.slice(0, 400), stack: e.stack?.slice(0, 800) });
    }
  }

  // Living Moments — user-initiated freeze-frame of a room's current state.
  // POST /api/capture-moment { location } → { id, meta } on success.
  if (u === "/api/capture-moment" && req.method === "POST") {
    const b = await body(req);
    if (!b?.location) return json(res, 400, { error: "location required" });
    const result = await APE.captureLivingMoment(b.location);
    if (result.error) return json(res, result.error.includes("nobody") ? 404 : 500, result);
    return json(res, 200, { id: result.id, meta: result.meta });
  }


  // GET /api/bus — event bus observability. Returns stats + recent events.
  // Session 4a inspection endpoint — lets us verify emitters are landing
  // events in history before wiring WebSocket clients in 4b.
  //   ?limit=N   — recent event count (default 50)
  //   ?since=ID  — return only events after this id (for polling replays)
  //   ?type=X    — filter by event type
  if (u.startsWith("/api/bus") && req.method === "GET") {
    const params = new URL("http://x" + req.url).searchParams;
    const limit = parseInt(params.get("limit") || "50", 10);
    const sinceId = params.get("since") ? parseInt(params.get("since"), 10) : null;
    const type = params.get("type");
    try {
      const BUS = require("./bus");
      let events = sinceId != null ? BUS.since(sinceId) : BUS.recent(limit);
      if (type) events = events.filter((e) => e.type === type);
      return json(res, 200, {
        stats: BUS.stats(),
        events,
      });
    } catch (e) {
      return json(res, 500, { error: e.message.slice(0, 200) });
    }
  }

  // GET /api/ws — WebSocket transport observability. Reports connection
  // counts, drops, current subscribers. Session 4b.
  if (u === "/api/ws" && req.method === "GET") {
    try {
      const stats = wsHandle ? wsHandle.stats() : { note: "ws not attached yet" };
      return json(res, 200, stats);
    } catch (e) {
      return json(res, 500, { error: e.message.slice(0, 200) });
    }
  }

  // GET /events-debug — plain HTML page that opens a WebSocket to /events
  // and streams live events. No dependencies, no build step, just a browser
  // tab to prove the transport works. Session 4b verification tool.
  if (u === "/events-debug" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(EVENTS_DEBUG_HTML);
  }

  // GET /api/director/ads — Ad Director inspection endpoint. Returns the
  // current ad candidates that the Ad Director has scored above threshold.
  // Session 6a: read-only, lets us verify the scoring is picking up on
  // beats that actually mention/use campaign products before we wire the
  // ad-shaped render pipeline in 6b.
  if (u === "/api/director/ads" && req.method === "GET") {
    try {
      const candidates = APE.W.__scenes?.adCandidates || [];
      const runningCampaigns = APE.CAMPAIGNS.running().map((c) => ({
        id: c.id, brand: c.brand, product: c.brief?.product,
        injectedObjects: c.injectedObjects || [],
        touches: c.touches?.length || 0,
      }));
      return json(res, 200, {
        candidates,
        candidateCount: candidates.length,
        runningCampaigns,
        threshold: 55,
        note: "Session 6a — read-only. Ad-shaped render pipeline lands in 6b.",
      });
    } catch (e) {
      return json(res, 500, { error: e.message?.slice(0, 200) });
    }
  }

  // GET /api/render/queue — inspection endpoint. Read-only, ?limit=N for
  // recent jobs, ?status=queued|running|success|failed to filter.
  // Session 3a: gives operator visibility into the queue's health.
  if (u.startsWith("/api/render/queue") && req.method === "GET") {
    const params = new URL("http://x" + req.url).searchParams;
    const limit = parseInt(params.get("limit") || "30", 10);
    const status = params.get("status") || undefined;
    try {
      return json(res, 200, {
        stats: DB.renderQueueStats(),
        media: DB.mediaStats(),
        jobs: DB.listRenderJobs({ status, limit }),
      });
    } catch (e) {
      return json(res, 500, { error: e.message.slice(0, 200) });
    }
  }

  // GET /api/moments — list recent moments (metadata only, newest first).
  // Session 2c·2: reads from DB (queryable, ordered by captured_at DESC).
  // Falls back to walking disk via MOMENT_STORE if DB read fails.
  if (u === "/api/moments" && req.method === "GET") {
    const limit = parseInt(new URL("http://x" + req.url).searchParams.get("limit") || "40", 10);
    try {
      const rows = DB.listMoments({ limit });
      // Response shape matches the old MOMENT_STORE.list return: { id, ...meta }
      const moments = rows.map((m) => ({
        id: m.id,
        location: m.location,
        day: m.day,
        slot: m.slot,
        time: m.time,
        actors: m.actors,
        activityLines: m.activityLines,
        capturedAt: m.capturedAt,
        storyboardSceneId: m.storyboardSceneId,
      }));
      return json(res, 200, { moments });
    } catch (e) {
      // Fallback: walk the moment_store directory
      const items = APE.MOMENT_STORE.list({ limit });
      return json(res, 200, { moments: items.map((m) => ({ id: m.id, ...m.meta })), fallback: `DB read failed: ${e.message.slice(0, 120)}` });
    }
  }

  // GET /api/moment/:id — serve a captured moment's hero image.
  const momentMatch = u.match(/^\/api\/moment\/([^\/]+)$/);
  if (momentMatch && req.method === "GET") {
    const id = momentMatch[1];
    const p = APE.MOMENT_STORE.heroPath(id);
    if (!APE.MOMENT_STORE.exists(p)) return json(res, 404, { error: "moment not found or expired" });
    const buf = require("fs").readFileSync(p);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400", "Access-Control-Allow-Origin": "*" });
    return res.end(buf);
  }

  // Serve a scene's shot still: /api/scene/:id/shot/:idx
  const sceneShotMatch = u.match(/^\/api\/scene\/([^\/]+)\/shot\/(\d+)$/);
  if (sceneShotMatch) {
    const sceneId = sceneShotMatch[1];
    const idx = parseInt(sceneShotMatch[2], 10);
    const p = APE.SCENE_STORE.shotStillPath(sceneId, idx);
    if (!APE.SCENE_STORE.exists(p)) return json(res, 404, { error: "shot not found" });
    const buf = require("fs").readFileSync(p);
    res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "public, max-age=86400, immutable", "Access-Control-Allow-Origin": "*" });
    return res.end(buf);
  }
  // Serve a scene's animated shot: /api/scene/:id/video/:idx  (Chunk C output)
  const sceneVideoMatch = u.match(/^\/api\/scene\/([^\/]+)\/video\/(\d+)$/);
  if (sceneVideoMatch) {
    const sceneId = sceneVideoMatch[1];
    const idx = parseInt(sceneVideoMatch[2], 10);
    const p = APE.SCENE_STORE.shotVideoPath(sceneId, idx);
    if (!APE.SCENE_STORE.exists(p)) return json(res, 404, { error: "video not found" });
    const buf = require("fs").readFileSync(p);
    res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=86400, immutable", "Access-Control-Allow-Origin": "*" });
    return res.end(buf);
  }
  // Serve the final edited scene video: /api/scene/:id/final  (Chunk C output)
  const sceneFinalMatch = u.match(/^\/api\/scene\/([^\/]+)\/final$/);
  if (sceneFinalMatch) {
    const sceneId = sceneFinalMatch[1];
    const p = APE.SCENE_STORE.finalVideoPath(sceneId);
    if (!APE.SCENE_STORE.exists(p)) return json(res, 404, { error: "final not found" });
    const buf = require("fs").readFileSync(p);
    res.writeHead(200, { "Content-Type": "video/mp4", "Cache-Control": "public, max-age=86400, immutable", "Access-Control-Allow-Origin": "*" });
    return res.end(buf);
  }
  if (u === "/api/campaigns" && req.method === "GET")
    return json(res, 200, { campaigns: APE.CAMPAIGNS.list() });
  // GET /api/campaigns/map-pins — aggregated pin list for the cockpit map layer.
  // Returns pins from every RUNNING campaign so the cockpit only needs one call
  // to render the whole layer. Each pin includes campaign context so click
  // handlers can route into the right campaign.
  if (u === "/api/campaigns/map-pins" && req.method === "GET") {
    const pins = [];
    for (const c of APE.CAMPAIGNS.running()) {
      for (const loc of (c.geoLocations || [])) {
        pins.push({
          campaignId: c.id,
          brand: c.brand,
          product: c.brief?.product || null,
          osm_id: loc.osm_id,
          lat: loc.lat,
          lng: loc.lng,
          name: loc.name,
          address: loc.address,
          shop: loc.shop,
          distance_km: loc.distance_km,
        });
      }
    }
    return json(res, 200, { pins, count: pins.length });
  }
  if (u === "/api/campaigns" && req.method === "POST") {
    const b = await body(req);
    const c = APE.CAMPAIGNS.create(b || {}, APE.W);
    // Auto-resume: a running campaign on a paused world produces no data.
    if (c._justBecameFirstRunning) APE.autoResume();
    // Auto-plan by default.
    if (b?.autoplan !== false && !c.mediaPlan) {
      (async () => {
        try {
          const prompt = APE.MEDIA.autoplanPrompt(c, { agents: APE.W.agents });
          const plan = await APE.callJSON(prompt, APE.MEDIA.AUTOPLAN_SCHEMA);
          APE.CAMPAIGNS.setMediaPlan(c.id, plan);
        } catch (e) {
          // Record the failure on the campaign AND log it so we can see it.
          const cur = APE.CAMPAIGNS.get(c.id);
          if (cur) {
            cur.mediaPlanError = String(e.message || e).slice(0, 300);
            APE.CAMPAIGNS.persist(c.id);
          }
          console.error("[autoplan] failed for", c.brand, ":", String(e.message || e).slice(0, 300));
        }
      })();
    }
    // Auto-geolocate: query Overpass for real store locations of this brand
    // near the family flat. Fire-and-forget — pins land on the map layer
    // within ~10s of campaign creation without any operator step. Chains
    // into store isometric render so the isometric is ready when the
    // operator first clicks a pin.
    if (b?.autogeolocate !== false && c.brand) {
      (async () => {
        try {
          const result = await APE.BRAND_GEO.geolocate(c.brand, { limit: 5 });
          if (result.locations.length) {
            APE.CAMPAIGNS.setGeoLocations(c.id, result.locations);
            // Chain: render the store isometric now that we know real
            // locations exist. Fire-and-forget so subsequent operations
            // don't wait on Nano Banana's ~20-30s render.
            try { await APE.ensureCampaignStore(c.id); }
            catch (e) { console.error("[store-isometric] chained failed for", c.brand, ":", String(e.message || e).slice(0, 200)); }
          }
        } catch (e) {
          console.error("[geolocate] failed for", c.brand, ":", String(e.message || e).slice(0, 300));
        }
      })();
    }
    // Session 8a: auto-reshape. Product placements into W.objects, weekly
    // life-events onto the schedule, palette hints, keywords for beat-tagging.
    // Fire-and-forget — ready within ~15-20s of campaign creation.
    if (b?.autoreshape !== false && c.brand) {
      (async () => {
        try {
          const P = require("./product_plan");
          const prompt = P.productPlanPrompt(c, { agents: APE.W.agents });
          const plan = await APE.callJSON(prompt, P.PRODUCT_PLAN_SCHEMA);
          APE.CAMPAIGNS.setProductPlan(c.id, plan);
          for (const p of (plan.placements || [])) {
            if (!p.location || !p.item) continue;
            APE.CAMPAIGNS.injectProduct(c.id, { name: p.item, at: p.location }, APE.W);
          }
          console.log(`[reshape] ${c.brand}: ${plan.placements?.length || 0} products placed, ${plan.lifeEvents?.length || 0} life-events registered`);
        } catch (e) {
          console.error("[reshape] failed for", c.brand, ":", String(e.message || e).slice(0, 300));
        }
      })();
    }
    delete c._justBecameFirstRunning;
    return json(res, 200, { campaign: c, worldResumed: !APE.worldPaused() });
  }
  if (u.startsWith("/api/campaigns/")) {
    const seg = u.split("/");
    const id = seg[3];
    const tail = seg[4];
    if (!APE.CAMPAIGNS.get(id)) return json(res, 404, { error: "campaign not found" });
    if (!tail && req.method === "GET") return json(res, 200, { campaign: APE.CAMPAIGNS.get(id) });
    if (tail === "start" && req.method === "POST") {
      const c2 = APE.CAMPAIGNS.start(id, APE.W);
      if (c2?._justBecameFirstRunning) APE.autoResume();
      if (c2) delete c2._justBecameFirstRunning;
      return json(res, 200, { campaign: c2, worldResumed: !APE.worldPaused() });
    }
    if (tail === "end" && req.method === "POST") return json(res, 200, { campaign: APE.CAMPAIGNS.end(id, APE.W) });
    if (tail === "signals" && req.method === "GET") {
      const url = new URL(req.url, "http://x");
      const since = parseInt(url.searchParams.get("since") || "0", 10);
      const lens = url.searchParams.get("lens") || "";
      let sigs = APE.CAMPAIGNS.signalsFor(id);
      if (since) sigs = sigs.filter((x) => x.ts > since);
      if (lens) sigs = sigs.filter((x) => x.lens === lens);
      return json(res, 200, { signals: sigs });
    }
    if (tail === "summary" && req.method === "GET") return json(res, 200, { summary: APE.CAMPAIGNS.summarize(id) });
    if (tail === "mediaPlan" && req.method === "GET") {
      const c = APE.CAMPAIGNS.get(id);
      return json(res, 200, { mediaPlan: c.mediaPlan || null });
    }
    if (tail === "mediaPlan" && req.method === "POST") {
      const b = await body(req);
      const c = APE.CAMPAIGNS.setMediaPlan(id, b?.mediaPlan || null);
      return json(res, 200, { campaign: c });
    }
    if (tail === "touches" && req.method === "GET") {
      const c = APE.CAMPAIGNS.get(id);
      return json(res, 200, { touches: c.touches || [] });
    }
    // POST /api/campaigns/:id/inject { name, at }
    // Drops a physical product into W.objects at the specified location.
    // Instantly visible to the agent turn prompt at that location, and to
    // moment renders. Removal happens automatically when the campaign ends.
    // This is the mechanism that makes "capture the family using it" work.
    if (tail === "inject" && req.method === "POST") {
      const b = await body(req);
      if (!b?.name || !b?.at) return json(res, 400, { error: "name and at required" });
      const c = APE.CAMPAIGNS.injectProduct(id, { name: b.name, at: b.at }, APE.W);
      if (!c) return json(res, 500, { error: "injection failed" });
      return json(res, 200, {
        campaign: c,
        injectedObjects: c.injectedObjects || [],
        worldObjects: APE.W.objects.filter((o) => o.at === b.at),
      });
    }
    // GET /api/campaigns/:id/injected — list what this campaign has placed
    if (tail === "injected" && req.method === "GET") {
      const c = APE.CAMPAIGNS.get(id);
      return json(res, 200, { injectedObjects: c.injectedObjects || [] });
    }
    // POST /api/campaigns/:id/reshape
    // Runs the productPlan LLM pass. Result: physical products injected into
    // W.objects at specific rooms, recurring lifeEvents saved to the campaign
    // so schedule() can honor them, palette hints for wardrobe drift (8c),
    // keywords for beat-tagging (8b). Idempotent-ish: re-running clears the
    // previous placements and generates a fresh plan.
    if (tail === "reshape" && req.method === "POST") {
      const c = APE.CAMPAIGNS.get(id);
      if (!c) return json(res, 404, { error: "campaign not found" });
      try {
        // Clear previous placements from the world so re-reshaping isn't additive
        APE.CAMPAIGNS.removeInjectedObjects(id, APE.W);
        // Generate the plan
        const P = require("./product_plan");
        const prompt = P.productPlanPrompt(c, { agents: APE.W.agents });
        const plan = await APE.callJSON(prompt, P.PRODUCT_PLAN_SCHEMA);
        APE.CAMPAIGNS.setProductPlan(id, plan);
        // Inject each placement into W.objects
        let injected = 0;
        for (const p of (plan.placements || [])) {
          if (!p.location || !p.item) continue;
          APE.CAMPAIGNS.injectProduct(id, { name: p.item, at: p.location }, APE.W);
          injected++;
        }
        return json(res, 200, {
          campaignId: id,
          brand: c.brand,
          placements: plan.placements || [],
          lifeEvents: plan.lifeEvents || [],
          palette: plan.palette || null,
          keywords: plan.keywords || [],
          injected,
          note: `${injected} products placed in the flat. ${plan.lifeEvents?.length || 0} recurring life-events registered. Beats from this campaign will be tagged with keywords for cockpit highlighting.`,
        });
      } catch (e) {
        return json(res, 500, { error: e.message?.slice(0, 400) });
      }
    }
    // Instantly places the named agent at the campaign store. Demo tool —
    // bypasses commute-window RNG so the operator can see the whole loop
    // (pin click → store isometric → capture-moment) without waiting for
    // sim days to align. Overrides schedule() for 4 slots (~1 sim-hour)
    // then the agent returns to their normal routine.
    if (tail === "force-visit" && req.method === "POST") {
      const b = await body(req);
      const c = APE.CAMPAIGNS.get(id);
      if (!c) return json(res, 404, { error: "campaign not found" });
      const stores = c.geoLocations || [];
      if (!stores.length) return json(res, 400, { error: "campaign has no geolocated stores yet" });
      const agentKey = (b?.agent || "marcus").toLowerCase();
      const agent = APE.W.agents[agentKey];
      if (!agent) return json(res, 404, { error: `unknown agent: ${agentKey}` });
      const store = stores[0];
      const location = `${store.name || c.brand}${store.address ? ` (${store.address})` : ""} — quick stop for ${c.brand}`;
      // Direct mutation. The next slot's dispose will see the character
      // there. The character-presence check in CampaignStoreView will match
      // on the brand substring immediately.
      agent.location = location;
      // Also set a soft forcedVisit flag with an expiry so the schedule
      // function can honor it for a few slots instead of yanking them back
      // to their commute state.
      APE.W.__forcedVisits = APE.W.__forcedVisits || {};
      APE.W.__forcedVisits[agentKey] = {
        location, brand: c.brand, campaignId: c.id,
        expireSlot: APE.W.slot + 4,   // ~1 sim-hour
      };
      return json(res, 200, {
        ok: true,
        agent: agentKey,
        location,
        brand: c.brand,
        expireSlot: APE.W.__forcedVisits[agentKey].expireSlot,
        note: "Character placed at campaign store for ~1 sim-hour. CampaignStoreView will show them under 'Currently here' within the next state poll (10s or WebSocket tick).",
      });
    }
    // Queries Overpass/OSM for real-world stores of this campaign's brand
    // near the family flat. Stores results on campaign.geoLocations. Cockpit
    // map pins layer reads from here. Async: Overpass calls take 2-10s
    // depending on rate limit and query complexity. Idempotent: subsequent
    // calls within 30 min return cached results without re-hitting Overpass.
    if (tail === "geolocate" && req.method === "POST") {
      const b = await body(req);
      const c = APE.CAMPAIGNS.get(id);
      if (!c) return json(res, 404, { error: "campaign not found" });
      const brand = (b?.brand || c.brand || "").trim();
      if (!brand) return json(res, 400, { error: "brand required (on campaign or in body)" });
      try {
        const result = await APE.BRAND_GEO.geolocate(brand, { limit: b?.limit || 5 });
        APE.CAMPAIGNS.setGeoLocations(id, result.locations);
        // Fire-and-forget: pre-render the store isometric so the first pin
        // click has an image ready. Cached in BIBLE forever after.
        if (result.locations.length && b?.skipStoreIsometric !== true) {
          (async () => {
            try { await APE.ensureCampaignStore(id); }
            catch (e) { console.error("[store-isometric] failed for", brand, ":", String(e.message || e).slice(0, 200)); }
          })();
        }
        return json(res, 200, {
          campaignId: id,
          brand,
          locations: result.locations,
          count: result.locations.length,
          source: result.source,
          error: result.error || null,
          storeIsometricStatus: result.locations.length ? "rendering (check /store-isometric in ~30s)" : "skipped (no locations)",
          note: result.locations.length === 0 && result.source !== "error"
            ? `No ${brand} found within 4km of the family flat. Try a broader brand or a specific location.`
            : null,
        });
      } catch (e) {
        return json(res, 500, { error: e.message?.slice(0, 300) });
      }
    }
    // GET /api/campaigns/:id/store-isometric[?force=1]
    // Returns the JPEG bytes of the store's isometric cutaway. First call
    // triggers render (~20-30s); cached in BIBLE forever after. force=1
    // regenerates (e.g. if the brand's brief changed and you want a new render).
    if (tail === "store-isometric" && req.method === "GET") {
      const params = new URL("http://x" + req.url).searchParams;
      const force = params.get("force") === "1";
      const c = APE.CAMPAIGNS.get(id);
      if (!c) return json(res, 404, { error: "campaign not found" });
      try {
        const b64 = await APE.ensureCampaignStore(id, { force });
        if (!b64) return json(res, 500, { error: APE.W.lastError || "store render failed" });
        const buf = Buffer.from(b64, "base64");
        const cacheControl = force ? "no-cache, no-store, must-revalidate" : "public, max-age=3600, must-revalidate";
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": cacheControl, "Access-Control-Allow-Origin": "*" });
        return res.end(buf);
      } catch (e) {
        return json(res, 500, { error: e.message?.slice(0, 300) });
      }
    }
    // GET /api/campaigns/:id/locations — read cached geo results
    if (tail === "locations" && req.method === "GET") {
      const c = APE.CAMPAIGNS.get(id);
      if (!c) return json(res, 404, { error: "campaign not found" });
      return json(res, 200, {
        campaignId: id,
        brand: c.brand,
        locations: c.geoLocations || [],
      });
    }
    // POST /api/campaigns/:id/rescale { intensity }
    // Rescales the existing mediaPlan channels to a named intensity tier
    // (low|medium|high) without regenerating creative. Fast operator lever
    // to push visible frequency up mid-campaign without waiting for autoplan.
    if (tail === "rescale" && req.method === "POST") {
      const b = await body(req);
      const tier = (b?.intensity || "").toLowerCase();
      if (!["low", "medium", "high"].includes(tier)) {
        return json(res, 400, { error: "intensity must be low, medium, or high" });
      }
      const c = APE.CAMPAIGNS.get(id);
      if (!c?.mediaPlan?.channels) return json(res, 400, { error: "campaign has no mediaPlan to rescale" });
      const defaults = APE.MEDIA.INTENSITY_DEFAULTS[tier];
      // Apply new per-channel frequency where the channel exists in the plan.
      // Keeps existing creative and targeting.
      const updated = {
        ...c.mediaPlan,
        intensity: tier,
        channels: c.mediaPlan.channels.map((cp) => ({
          ...cp,
          enabled: true,
          frequencyPerDay: defaults[cp.id] ?? cp.frequencyPerDay,
        })),
      };
      APE.CAMPAIGNS.setMediaPlan(id, updated);
      return json(res, 200, { campaign: APE.CAMPAIGNS.get(id), tier, mediaPlan: updated });
    }
    if (tail === "channels" && req.method === "GET") {
      return json(res, 200, { channels: APE.MEDIA.CHANNELS });
    }
    if (tail === "promise" && req.method === "GET") {
      const c = APE.CAMPAIGNS.get(id);
      const url = new URL(req.url, "http://x");
      const sinceSlot = parseInt(url.searchParams.get("since") || "0", 10);
      const curves = {};
      for (const [actor, t] of Object.entries(c.tracking || {})) {
        curves[actor] = {
          state: t.state,
          history: (t.history || []).filter((h) => h.slot > sinceSlot),
        };
      }
      return json(res, 200, { promise: c.promise, tracking: curves });
    }
  }
  if (u === "/api/logs") return json(res, 200, { lines: APE.logs() });
  if (u === "/api/storage") return json(res, 200, APE.STORAGE.status());
  if (u === "/api/models") {
    try {
      const r = await fetch(`${CFG.BASE_URL}/models?key=${CFG.GEMINI_API_KEY}&pageSize=200`);
      const d = await r.json();
      const models = (d.models || []).map((m) => ({ name: m.name, methods: m.supportedGenerationMethods }));
      return json(res, r.ok ? 200 : 502, { models, error: d.error?.message });
    } catch (e) { return json(res, 502, { error: e.message }); }
  }
  if (u.startsWith("/api/shot/")) {
    const seg = u.split("/");
    const img = APE.shotImage(seg[3], parseInt(seg[4] || "0", 10));
    if (!img) return json(res, 404, { error: "no shot" });
    res.writeHead(200, { "Content-Type": img.mime, "Cache-Control": "public, max-age=86400, immutable", "Access-Control-Allow-Origin": "*" });
    return res.end(img.buf);
  }
  if (u === "/api/control" && req.method === "POST") {
    const b = await body(req);
    if (b.action === "pause") APE.control.pause();
    if (b.action === "resume") APE.control.resume();
    if (b.action === "toggleRender") APE.control.toggleRender();
    if (b.action === "reset") { json(res, 200, { ok: true, note: "state cleared, process exiting — restart node" }); return APE.control.reset(); }
    if (b.speedMs) APE.control.speed(b.speedMs);
    return json(res, 200, { ok: true });
  }
  if (u === "/api/inject" && req.method === "POST") { const b = await body(req); APE.control.inject(b.text || ""); return json(res, 200, { ok: true }); }
  if (u === "/api/env" && req.method === "POST") { const b = await body(req); APE.control.env(b.weather, b.headline); return json(res, 200, { ok: true }); }
  if (u === "/") { res.writeHead(200, { "Content-Type": "text/html" }); return res.end(PAGE); }
  json(res, 404, { error: "not found" });
});

const PAGE = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>APE — Engine Room</title><style>
:root{--bg:#070708;--panel:#0E0E0F;--line:#222224;--txt:#E4E4E6;--dim:#88888A;--faint:#555558;--acc:#CDBBA7;--warn:#b8893b;--bad:#c05b5b;--good:#5b9c7a}
*{box-sizing:border-box;margin:0}body{background:var(--bg);color:var(--txt);font:13px/1.5 ui-monospace,Menlo,monospace;padding:18px}
h1{font-size:13px;letter-spacing:.25em;text-transform:uppercase;color:var(--acc)}
.top{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-bottom:14px}
button,input,select{background:#161617;border:1px solid var(--line);color:var(--txt);padding:6px 10px;border-radius:6px;font:inherit}
button{cursor:pointer}button:hover{border-color:var(--acc)}
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.nm{font-size:15px;color:var(--acc)}.dim{color:var(--dim)}.faint{color:var(--faint);font-size:11px}
.think{border-left:2px solid var(--warn);padding-left:8px;margin:8px 0;font-style:italic;color:#cbb}
.said{border-left:2px solid var(--good);padding-left:8px;margin:8px 0}
.row2{display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-top:12px}
.log div{padding:3px 0;border-bottom:1px dashed #1a1a1c}
.bar{height:5px;background:#1c1c1e;border-radius:3px;overflow:hidden;margin:2px 0 6px}.fill{height:100%;background:var(--acc)}
.spark{border:1px solid var(--line);border-radius:8px;padding:10px;margin-bottom:8px;background:#0a0a0b}
.shots{display:grid;grid-template-columns:repeat(4,1fr);gap:4px;margin-top:6px}.shots img{width:100%;aspect-ratio:1;object-fit:cover;border-radius:4px}
.pill{display:inline-block;padding:1px 8px;border:1px solid var(--line);border-radius:99px;font-size:10px;color:var(--dim)}
.gap{color:var(--bad)} .clear{color:var(--good)} .err{color:var(--bad);font-size:11px}
.tvm{display:grid;grid-template-columns:1fr 1fr;gap:8px;font-size:11px}.tvm div{background:#0a0a0b;border:1px solid var(--line);border-radius:6px;padding:8px}
</style></head><body>
<div class="top"><h1>APE // Engine Room</h1><span id="ver" class="pill" style="color:var(--acc)"></span><span id="clock" class="pill"></span><span id="money" class="pill"></span>
<button onclick="ctl('resume')">▶ run</button><button onclick="ctl('pause')">⏸ pause</button>
<select id="spd" onchange="setSpd(this.value)">
<option value="45000">slow</option><option value="30000" selected>normal</option><option value="15000">fast</option></select>
<input id="inj" placeholder="drop into the world (e.g. a Nespresso Vertuo Pop, $249, appears at the dépanneur window)" style="width:340px">
<button onclick="inject()">inject</button>
<select id="wx"><option>Grey early-spring drizzle</option><option>Sudden thunderstorm</option><option>First warm day of the year</option><option>Heavy wet snow</option></select>
<button onclick="env()">set weather</button>
<input id="hl" placeholder="radio headline" style="width:220px"><button onclick="env()">broadcast</button>
<button onclick="ctl('toggleRender')" id="rbtn">🎬</button>
<button onclick="if(confirm('wipe world?'))ctl('reset')" style="border-color:#553">reset</button>
<span id="err" class="err"></span></div>
<div class="grid" id="chars"></div>
<div class="row2"><div class="card"><div class="faint" style="margin-bottom:6px">GROUND TRUTH LOG (what actually happened)</div><div class="log" id="log"></div>
<div class="faint" style="margin:12px 0 6px">TRUTH vs MEMORY (the measurable gap)</div><div class="tvm" id="tvm"></div></div>
<div class="card"><div class="faint" style="margin-bottom:6px">DIRECTOR'S REEL (novelty-gated)</div><div id="sparks"></div></div></div>
<script>
const Q=new URLSearchParams(location.search).get('code')||'';
function api(p){return Q?p+'?code='+encodeURIComponent(Q):p}
function setSpd(v){fetch(api('/api/control'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({speedMs:+v})})}
function ctl(a){fetch(api('/api/control'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:a})})}
function inject(){const t=document.getElementById('inj').value.trim();if(t)fetch(api('/api/inject'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({text:t})}).then(()=>document.getElementById('inj').value='')}
function env(){fetch(api('/api/env'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({weather:document.getElementById('wx').value,headline:document.getElementById('hl').value.trim()})})}
function esc(s){return (s||'').replace(/</g,'&lt;')}
async function tick(){try{const s=await(await fetch(api('/api/state'))).json();
document.getElementById('ver').textContent='v'+(s.version||'?');document.getElementById('clock').textContent=s.currentTime+(s.busy?' · thinking…':s.isPaused?' · paused':' · live');
document.getElementById('money').textContent='checking $'+s.money.checking;
document.getElementById('err').textContent=s.lastError?('⚠ '+s.lastError):'';
document.getElementById('rbtn').textContent=s.renderStoryboards?'🎬 render: on':'🎬 render: off';
document.getElementById('chars').innerHTML=Object.values(s.characters).map(c=>{
const so=c.senseOfSelf;const gapCls=so.state.startsWith('under')||so.state.startsWith('inflated')?'gap':'clear';
const led=Object.entries(c.regardOthers).map(([k,v])=>k+': regard '+v.regard+' · trust '+v.trust).join('<br>');
return '<div class="card"><div class="nm">'+c.name+' <span class="faint">'+esc(c.mood)+' · '+esc(c.location)+(c.asleep?' · asleep':'')+'</span></div>'
+'<div class="faint" style="margin:6px 0 2px">self '+Math.round(so.selfRegard)+' · room '+so.room+' · believes '+Math.round(so.believes)+' · <span class="'+gapCls+'">'+so.state+'</span></div>'
+'<div class="faint">'+led+'</div>'
+(c.innerMonologue?'<div class="think">💭 '+esc(c.innerMonologue)+'</div>':'')
+(c.lastSaid?'<div class="said">🗣 "'+esc(c.lastSaid)+'"</div>':'')
+'<div class="faint">'+esc(c.status)+'</div>'
+'<div class="faint" style="margin-top:8px">wants</div>'+c.wants.map(w=>'<div class="dim">· '+esc(w)+'</div>').join('')
+'</div>'}).join('');
document.getElementById('log').innerHTML=s.truthLog.slice().reverse().slice(0,18).map(e=>'<div><span class="faint">d'+e.day+' '+e.time+' · '+esc(e.location)+'</span> '+esc(e.text)+'</div>').join('');
const m=s.characters.marcus;document.getElementById('tvm').innerHTML='<div><b class="faint">WORLD</b><br>'+esc(s.money.note)+'</div><div><b class="faint">MARCUS REMEMBERS</b><br>'+(m.memories||[]).slice(0,3).map(x=>esc(x.text)).join('<br>')+'</div>';
document.getElementById('sparks').innerHTML=(s.sparks||[]).map(sp=>'<div class="spark"><b>'+esc(sp.title)+'</b> <span class="pill">'+sp.state+'</span><div class="faint">'+esc(sp.why)+'</div>'
+(sp.verbatim_lines||[]).map(l=>'<div class="said">"'+esc(l)+'"</div>').join('')
+(sp.shots&&sp.shots.length?'<div class="shots">'+sp.shots.map(x=>'<img src="'+api(x.url)+'">').join('')+'</div>':'')
+(sp.quote?'<div style="margin-top:6px;color:var(--acc);font-style:italic">— "'+esc(sp.quote)+'"</div>':'')+'</div>').join('')||'<span class="faint">nothing kept yet — the gate is strict, that is the point</span>';
}catch(e){}}
setInterval(tick,2500);tick();
</script></body></html>`;

// Live WebSocket event stream viewer. Opens a WS to /events?since=... and
// prints every incoming event with type + payload. Session 4b verification
// tool — a browser tab pointed at this proves the transport works end-to-end.
const EVENTS_DEBUG_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>APE / events</title>
<style>
  body { background: #0a0a0b; color: #d8d8d8; font: 13px/1.5 -apple-system, ui-sans-serif, system-ui, monospace; padding: 20px; max-width: 900px; margin: 0 auto; }
  h1 { font-size: 15px; font-weight: 500; margin: 0 0 12px; color: #888; letter-spacing: 0.5px; text-transform: uppercase; }
  #status { padding: 8px 12px; border-radius: 6px; background: #1a1a1c; margin-bottom: 16px; font-size: 12px; }
  #status.connected { background: #0f2419; color: #6be09b; }
  #status.disconnected { background: #2d1518; color: #ff8a95; }
  .event { padding: 8px 12px; margin: 4px 0; background: #131315; border-radius: 4px; border-left: 3px solid #2a2a2c; }
  .event .head { display: flex; gap: 12px; align-items: baseline; }
  .event .id { color: #555; font-size: 11px; }
  .event .type { color: #6be09b; font-weight: 500; font-size: 12px; text-transform: uppercase; letter-spacing: 0.3px; }
  .event .time { color: #666; font-size: 11px; margin-left: auto; }
  .event .payload { color: #b8b8b8; font-size: 12px; margin-top: 4px; word-break: break-word; }
  .event.tick { border-left-color: #4a90d9; }
  .event.beat { border-left-color: #d94a90; }
  .event.scene_planning, .event.scene_shot_ready, .event.scene_ready { border-left-color: #d9a44a; }
  .event.moment_captured { border-left-color: #b06be0; }
  .event.render_progress { border-left-color: #6be0d9; }
  .event.hello { border-left-color: #f0c674; }
  input, button { background: #1a1a1c; color: #d8d8d8; border: 1px solid #2a2a2c; padding: 6px 10px; border-radius: 4px; font-family: inherit; font-size: 12px; }
  button { cursor: pointer; }
  button:hover { background: #232326; }
  .controls { display: flex; gap: 8px; margin-bottom: 16px; align-items: center; }
  #events { max-height: calc(100vh - 200px); overflow-y: auto; }
</style></head><body>
<h1>APE / event stream</h1>
<div class="controls">
  Access code: <input id="code" placeholder="code" style="width: 120px" />
  Since id: <input id="since" placeholder="optional" style="width: 100px" type="number" />
  <button onclick="connect()">Connect</button>
  <button onclick="disconnect()">Disconnect</button>
  <button onclick="document.getElementById('events').innerHTML=''">Clear</button>
</div>
<div id="status">Disconnected</div>
<div id="events"></div>
<script>
let ws = null;
const setStatus = (t, cls) => { const s = document.getElementById('status'); s.textContent = t; s.className = cls || ''; };
const addEvent = (e) => {
  const el = document.createElement('div');
  el.className = 'event ' + (e.type || 'other');
  const ts = e.ts ? new Date(e.ts).toLocaleTimeString('en-US', { hour12: false }) : '';
  el.innerHTML = '<div class="head"><span class="id">#' + (e.id || '?') + '</span><span class="type">' + (e.type || 'unknown') + '</span><span class="time">' + ts + '</span></div>' +
    '<div class="payload">' + JSON.stringify(e.payload || e, null, 0).slice(0, 500) + '</div>';
  const feed = document.getElementById('events');
  feed.insertBefore(el, feed.firstChild);
  while (feed.children.length > 200) feed.removeChild(feed.lastChild);
};
function connect() {
  disconnect();
  const code = document.getElementById('code').value || 'baloo';
  const since = document.getElementById('since').value;
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = scheme + '//' + location.host + '/events?code=' + encodeURIComponent(code) + (since ? '&since=' + since : '');
  setStatus('Connecting to ' + url + '...');
  ws = new WebSocket(url);
  ws.onopen = () => setStatus('Connected — waiting for events', 'connected');
  ws.onclose = (e) => setStatus('Disconnected (code ' + e.code + ')', 'disconnected');
  ws.onerror = () => setStatus('Error — see browser console', 'disconnected');
  ws.onmessage = (m) => { try { addEvent(JSON.parse(m.data)); } catch (e) { addEvent({ type: 'parse_error', payload: m.data }); } };
}
function disconnect() { if (ws) { try { ws.close(); } catch (e) {} ws = null; } }
</script></body></html>`;

// The public stream viewer — a single-page HTML document. Big frame filling
// the viewport, LIVE indicator, sim time overlay, cam label. Polls
// /stream/latest.jpg every 15 seconds. Zero UI chrome beyond what serves the
// aesthetic. The frame updates when the sim produces a new hero moment.
function renderStreamHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <title>SEAHAVEN — LIVE</title>
  <style>
    :root { color-scheme: dark; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body { width: 100%; height: 100%; background: #000; color: #d4d4d4; font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; overflow: hidden; }
    #stage { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: #000; }
    #frame {
      max-width: 100vw;
      max-height: 100vh;
      object-fit: contain;
      display: block;
      /* Slight signal-degradation feel — very subtle */
      filter: contrast(1.02) saturate(0.94);
    }
    /* HUD overlays */
    #hud-top-left { position: fixed; top: 24px; left: 24px; display: flex; align-items: center; gap: 12px; z-index: 10; }
    #live { display: inline-flex; align-items: center; gap: 8px; padding: 6px 10px; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.14); border-radius: 3px; font-size: 11px; letter-spacing: 0.25em; text-transform: uppercase; color: #f4f4f4; }
    #live::before {
      content: ""; width: 8px; height: 8px; border-radius: 50%; background: #e93b3b;
      animation: pulse 1.8s ease-in-out infinite;
      box-shadow: 0 0 6px rgba(233,59,59,0.6);
    }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
    #cam-label { padding: 6px 10px; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.14); border-radius: 3px; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; color: #d4d4d4; }
    #hud-top-right { position: fixed; top: 24px; right: 24px; z-index: 10; }
    #timestamp { padding: 6px 10px; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.14); border-radius: 3px; font-size: 11px; letter-spacing: 0.15em; color: #f4f4f4; font-variant-numeric: tabular-nums; }
    #hud-bottom { position: fixed; bottom: 24px; left: 24px; right: 24px; z-index: 10; display: flex; align-items: center; justify-content: space-between; }
    #subject { padding: 6px 10px; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.14); border-radius: 3px; font-size: 10.5px; letter-spacing: 0.15em; color: #d4d4d4; }
    #station { padding: 6px 10px; background: rgba(0,0,0,0.55); border: 1px solid rgba(255,255,255,0.14); border-radius: 3px; font-size: 10.5px; letter-spacing: 0.2em; text-transform: uppercase; color: #d4d4d4; }
    /* Very subtle scan-line vignette overlay for the "surveillance monitor" feel */
    #vignette { position: fixed; inset: 0; pointer-events: none; z-index: 5;
      background:
        radial-gradient(ellipse at center, rgba(0,0,0,0) 55%, rgba(0,0,0,0.35) 100%),
        repeating-linear-gradient(0deg, rgba(255,255,255,0.02) 0px, rgba(255,255,255,0.02) 1px, transparent 1px, transparent 3px);
    }
    #placeholder { color: #666; font-size: 12px; letter-spacing: 0.2em; text-transform: uppercase; text-align: center; padding: 20px; }
  </style>
</head>
<body>
  <div id="stage">
    <img id="frame" alt="Seahaven live feed" src="/stream/latest.jpg" onerror="onFrameError()" />
    <div id="placeholder" style="display:none">Waiting for signal…</div>
  </div>
  <div id="vignette"></div>
  <div id="hud-top-left">
    <div id="live">LIVE</div>
    <div id="cam-label">SEAHAVEN CAM 07</div>
  </div>
  <div id="hud-top-right">
    <div id="timestamp">DAY 1 · 06:45</div>
  </div>
  <div id="hud-bottom">
    <div id="subject">SUBJECT: TRUMAN BURBANK</div>
    <div id="station">SEAHAVEN OBSERVATION NETWORK</div>
  </div>
<script>
(async function () {
  const frameEl = document.getElementById('frame');
  const placeholderEl = document.getElementById('placeholder');
  const camEl = document.getElementById('cam-label');
  const timeEl = document.getElementById('timestamp');
  const subjectEl = document.getElementById('subject');
  const liveEl = document.getElementById('live');

  function refreshFrame() {
    // Cache-bust so the browser refetches even if URL is the same
    frameEl.src = '/stream/latest.jpg?t=' + Date.now();
  }
  window.onFrameError = () => {
    frameEl.style.display = 'none';
    placeholderEl.style.display = 'block';
  };
  frameEl.addEventListener('load', () => {
    frameEl.style.display = 'block';
    placeholderEl.style.display = 'none';
  });

  async function refreshStatus() {
    try {
      const r = await fetch('/stream/status');
      const d = await r.json();
      if (d.camLabel) camEl.textContent = d.camLabel;
      timeEl.textContent = 'DAY ' + d.day + ' · ' + d.clock;
      if (d.subjectLocation) subjectEl.textContent = 'SUBJECT: TRUMAN · ' + d.subjectLocation.toUpperCase();
      liveEl.textContent = d.live ? 'LIVE' : 'PAUSED';
      liveEl.style.opacity = d.live ? 1 : 0.5;
    } catch (e) { /* transient network — try again next tick */ }
  }

  // Initial + periodic refresh. Frame updates every 15s, status every 5s.
  refreshFrame();
  refreshStatus();
  setInterval(refreshFrame, 15000);
  setInterval(refreshStatus, 5000);
})();
</script>
</body>
</html>`;
}

APE.start();

// Attach WebSocket transport on the same port. Handles /events upgrade.
// Every BUS emit fans out to connected clients. Session 4b of the rebuild.
const WS = require("./ws_server");
wsHandle = WS.attach(server, {
  log: (m) => console.log(`[ws] ${m}`),
  accessCode: ACCESS_CODE,
});

server.listen(CFG.PORT, () => {
  console.log("\n=== APE ENGINE ===");
  console.log("Engine room: http://localhost:" + CFG.PORT);
  console.log("State API:   http://localhost:" + CFG.PORT + "/api/state");
  console.log("Events (WS): ws://localhost:" + CFG.PORT + "/events");
  console.log("Debug WS:    http://localhost:" + CFG.PORT + "/events-debug");
  console.log("Gemini key: " + (CFG.GEMINI_API_KEY ? "loaded from environment" : "MISSING — set GEMINI_API_KEY in Railway Variables or engine/.env"));
  console.log("Paused on boot — press ▶ run in the page.\n");
});
