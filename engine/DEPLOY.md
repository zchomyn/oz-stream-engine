# Deploying the APE Engine — vendor-neutral

The engine is a Dockerfile in a GitHub repo you own. That combination is the
ownership story for infrastructure: any host that runs containers can run this,
and moving hosts is an afternoon, not a migration. The host is a commodity.

## Option A — Railway (recommended: browser-only, no Google, ~$5/mo)

1. railway.com → sign in with GitHub → **New Project** → **Deploy from GitHub repo**
   → select `zchomyn/project-oz-engine`. It detects the Dockerfile and builds.
2. In the service → **Settings → Networking → Generate Domain** to get your URL.
3. **Variables** tab → add:
   - `ACCESS_CODE` = your chosen code
   - `SAVE_PATH` = `/data/world-state.json`
4. **Settings → Volumes → Add volume**, mount path `/data`. This makes the world
   survive redeploys and restarts — better than ephemeral-disk setups.
5. Open `https://your-domain.up.railway.app/?code=YOURCODE` → press ▶ run.

Every push to `main` auto-redeploys. Hobby plan is $5/mo including usage; this
always-on zero-dependency process fits in roughly $5–10/mo, plus Gemini usage
(~$0.20–0.40/hr of text at normal speed, ~$0.16 per storyboard). Pause from the
page when idle and the model spend stops.

## Option B — Fly.io (~$5/mo, more control, needs a small CLI install)

`brew install flyctl && fly launch` from the engine folder; add a volume with
`fly volumes create data` and set `SAVE_PATH=/data/world-state.json`. Equivalent
result; better if you outgrow Railway.

## Option C — any $5 VPS (Hetzner, DigitalOcean)

Maximum independence, requires comfort with ssh. `docker run` the image, done.
Worth it later; overkill today.

## Cloud Run (kept for reference, not recommended for this project)

The flags would be `--min-instances 1 --max-instances 1 --no-cpu-throttling`,
but hosting on the reviewer's own cloud is the wrong shape for a project whose
independence you want legible. Skip.

## Notes

- One instance only, always. The world lives in one process's memory.
- The Gemini dependency is a *vendor* relationship (one function, `gemini()` in
  ape.js) — swappable to another model provider in an afternoon if it ever needs
  to be.
