# APE Stream Engine — SEAHAVEN

A live-streamed hidden-camera study of one character's life.

## What this is

A fork of the APE engine (Project Oz) that runs a second, public-facing world: **Truman Burbank**, an insurance clerk in a picture-perfect 1998 ocean town called Seahaven. He lives, works, sleeps, walks to the office, has lunch at the same diner every day, sees the same faces. The stream is continuous.

Every frame is rendered as if captured by a hidden camera — a smoke detector, a doorframe cam, a dashcam, a plant. Subtle fisheye, sensor noise, a burned-in timestamp in the corner. The subject does not know he is being watched.

## Public endpoints (no auth)

- `GET /stream` — the viewer HTML page. Big frame, LIVE indicator, cam label, sim time. Frame updates every 15s.
- `GET /stream/latest.jpg` — the latest hero frame as JPEG.
- `GET /stream/status` — `{ live, day, clock, subject, subjectLocation, camLabel, latestMomentId }`.

## Operator endpoints (auth via `?code=...`)

Same as the parent APE engine. Everything else, including `/api/state`, `/api/control`, `/events` WebSocket, etc. Not part of the public viewing experience.

## What's different from the parent engine

- **World**: Seahaven, not Saint-Henri. Truman, Meryl, Marlon, Angela — not Marcus/Lena/Theo.
- **CCTV aesthetic**: every render goes through `cctv_camera.js` which wraps prompts in hidden-camera visual language.
- **Campaign infrastructure stubbed**: no `campaigns`, no `brand_geo`, no `product_plan`, no `ad_director`, no `media_plan`. All modules preserved as no-op stubs so ape.js code paths that check for campaigns fall through gracefully.
- **Public stream routes**: `/stream`, `/stream/latest.jpg`, `/stream/status` — no auth, meant for public viewing.

## Phase 1 (this build)

- Truman world seed
- Seahaven locations + plates
- CCTV aesthetic on every render
- Public stream page + endpoints
- No viewer interventions yet
- No render-ahead buffer yet (stream plays what the sim currently produces)

## Phase 2 (later)

- 24-hour render-ahead buffer with playback delay
- Viewer interventions: send gifts, letters, packages that arrive on future sim days
- Moderation queue for viewer inputs

## Phase 3 (later still)

- Camera-switching viewer voting
- Milestone events (Truman's birthday, seasons)
- Multi-episode narrative accumulation
