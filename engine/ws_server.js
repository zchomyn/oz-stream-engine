// APE ENGINE — WebSocket Transport
//
// Session 4b of the rebuild (see DESIGN.md Section 6). Attaches a WebSocket
// server to the same HTTP server that serves /api/*, sharing the port. Every
// connected client becomes a BUS subscriber; every emitted event fans out as
// a JSON frame.
//
// Protocol:
//   Client connects to:  ws(s)://engine/events?code=<ACCESS_CODE>&since=<lastId>
//     - code: required if ACCESS_CODE is set
//     - since: optional; if present, server replays events with id > since
//              before subscribing to live stream
//   Server sends immediately on accept:
//     { type: "hello", server_time, last_event_id, protocol_version }
//   Server then sends every event as:
//     { id, type, payload, ts }   (same shape as BUS.emit produces)
//   Client can send:
//     { type: "ping" }   → server responds { type: "pong", ts }
//   (Future: commands like pause/resume/whisper come via WS as well; 4c
//   scope. For now, control still goes over HTTP POST.)
//
// Backpressure: if a socket's buffered amount exceeds MAX_BUFFERED bytes,
// we drop the socket. This protects the server from a slow client stalling
// event emission for all other clients.

const url = require("url");
const { WebSocketServer } = require("ws");
const BUS = require("./bus");

const PROTOCOL_VERSION = 1;
const MAX_BUFFERED = 1024 * 1024;    // 1 MB per client
const PING_INTERVAL_MS = 30 * 1000;  // heartbeat every 30s

function attach(httpServer, { log, accessCode = null }) {
  const wss = new WebSocketServer({ noServer: true });
  let _connectionCount = 0;
  let _totalDropped = 0;

  // Handle HTTP upgrade requests. The 'upgrade' event fires when a client
  // sends the WebSocket handshake. We check the path + auth here BEFORE
  // completing the upgrade so unauthorized clients never establish a socket.
  httpServer.on("upgrade", (req, socket, head) => {
    let parsed;
    try { parsed = new URL(req.url, "http://x"); }
    catch (_) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    if (parsed.pathname !== "/events") {
      socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
      socket.destroy();
      return;
    }

    if (accessCode) {
      const code = parsed.searchParams.get("code") || req.headers["x-oz-code"];
      if (code !== accessCode) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      _handleConnection(ws, parsed);
    });
  });

  function _handleConnection(ws, parsed) {
    _connectionCount++;
    const connId = _connectionCount;
    const sinceId = parsed.searchParams.get("since") ? parseInt(parsed.searchParams.get("since"), 10) : null;
    log(`WS connect #${connId} (since=${sinceId ?? "none"}) — ${BUS.subscriberCount() + 1} client(s) now`);

    // Send hello immediately so the client knows the current server state
    const helloEvent = {
      type: "hello",
      server_time: Date.now(),
      last_event_id: BUS.stats().lastEventId,
      protocol_version: PROTOCOL_VERSION,
    };
    _send(ws, helloEvent);

    // If client asked for replay, send everything since their last-seen id
    if (sinceId != null && !Number.isNaN(sinceId)) {
      const replay = BUS.since(sinceId);
      for (const e of replay) _send(ws, e);
      log(`WS #${connId} replayed ${replay.length} event(s) since #${sinceId}`);
    }

    // Subscribe to the bus. Every emit fans out here.
    const unsubscribe = BUS.subscribe((event) => {
      if (ws.readyState !== ws.OPEN) return;
      _send(ws, event);
    });

    // Heartbeat: ping the client every 30s. If it doesn't respond to two
    // pings in a row, the connection is dead and we clean up.
    let _pongDue = false;
    const heartbeat = setInterval(() => {
      if (ws.readyState !== ws.OPEN) return;
      if (_pongDue) {
        // No pong since last ping — the socket is dead
        log(`WS #${connId} heartbeat timeout, closing`);
        try { ws.terminate(); } catch (_) {}
        return;
      }
      _pongDue = true;
      try { ws.ping(); } catch (_) {}
    }, PING_INTERVAL_MS);

    ws.on("pong", () => { _pongDue = false; });

    // Client messages: ping/pong game, and future control commands
    ws.on("message", (data) => {
      let msg;
      try { msg = JSON.parse(data.toString()); }
      catch (_) { return; }
      if (msg.type === "ping") {
        _send(ws, { type: "pong", ts: Date.now() });
      }
      // Future: pause/resume/capture/whisper commands come here
    });

    ws.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
      log(`WS close #${connId} — ${BUS.subscriberCount()} client(s) now`);
    });

    ws.on("error", (e) => {
      log(`WS error #${connId}: ${e.message?.slice(0, 140)}`);
    });
  }

  // Safe send with backpressure check. Drops the socket if its outgoing
  // buffer grows past MAX_BUFFERED bytes.
  function _send(ws, event) {
    if (ws.readyState !== ws.OPEN) return;
    if (ws.bufferedAmount > MAX_BUFFERED) {
      _totalDropped++;
      log(`WS backpressure: bufferedAmount=${ws.bufferedAmount}, dropping socket`);
      try { ws.terminate(); } catch (_) {}
      return;
    }
    try { ws.send(JSON.stringify(event)); }
    catch (e) {
      log(`WS send error: ${e.message?.slice(0, 140)}`);
      try { ws.terminate(); } catch (_) {}
    }
  }

  function stats() {
    return {
      totalConnections: _connectionCount,
      totalDropped: _totalDropped,
      currentSubscribers: BUS.subscriberCount(),
      protocolVersion: PROTOCOL_VERSION,
    };
  }

  return { stats };
}

module.exports = { attach };
