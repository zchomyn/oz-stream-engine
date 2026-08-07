// APE STREAM ENGINE — Google Cloud Storage adapter.
//
// Persists fat binary files (rendered JPEGs) to a GCS bucket so we don't
// blow past Railway's volume quota. Small stateful JSON (world state, story
// threads, world ledger) stays on the Railway volume — that's kilobytes.
// Only images go to GCS.
//
// Credentials pulled from env:
//   GCS_CREDENTIALS_JSON — full service account JSON as a string
//   GCS_BUCKET           — bucket name
//   GCS_PROJECT_ID       — optional; inferred from creds if omitted
//
// If any of those are missing, this module falls back to local-disk mode
// (writes to /data/gcs_fallback/...) so dev/local runs still work.

const fs = require("fs");
const path = require("path");

let _bucket = null;
let _mode = "unconfigured";  // "gcs" | "local" | "unconfigured"
let _localRoot = null;

function init() {
  if (_mode !== "unconfigured") return _mode;
  const credsRaw = process.env.GCS_CREDENTIALS_JSON;
  const bucketName = process.env.GCS_BUCKET;
  const projectId = process.env.GCS_PROJECT_ID;

  if (!credsRaw || !bucketName) {
    // Fall back to local disk
    const CFG = require("./config");
    _localRoot = path.join(path.dirname(CFG.SAVE_PATH), "gcs_fallback");
    try { fs.mkdirSync(_localRoot, { recursive: true }); } catch (_) {}
    _mode = "local";
    console.log(`[gcs] no credentials — falling back to local disk at ${_localRoot}`);
    return _mode;
  }

  try {
    const { Storage } = require("@google-cloud/storage");
    const credentials = JSON.parse(credsRaw);
    const storage = new Storage({
      projectId: projectId || credentials.project_id,
      credentials,
    });
    _bucket = storage.bucket(bucketName);
    _mode = "gcs";
    console.log(`[gcs] configured — bucket=${bucketName}, project=${projectId || credentials.project_id}`);
    return _mode;
  } catch (e) {
    console.error(`[gcs] init failed — ${e.message}. Falling back to local disk.`);
    const CFG = require("./config");
    _localRoot = path.join(path.dirname(CFG.SAVE_PATH), "gcs_fallback");
    try { fs.mkdirSync(_localRoot, { recursive: true }); } catch (_) {}
    _mode = "local";
    return _mode;
  }
}

// Upload bytes to a path in the bucket (or local fallback). Path uses slashes
// as delimiters. Content-Type defaults to image/jpeg.
async function upload(objectPath, bytes, contentType = "image/jpeg") {
  init();
  if (_mode === "gcs") {
    const file = _bucket.file(objectPath);
    await file.save(bytes, {
      contentType,
      resumable: false,   // small objects (JPEGs) — one-shot upload is faster
      metadata: { cacheControl: "public, max-age=3600" },
    });
    return objectPath;
  }
  // Local fallback
  const full = path.join(_localRoot, objectPath);
  try { fs.mkdirSync(path.dirname(full), { recursive: true }); } catch (_) {}
  fs.writeFileSync(full, bytes);
  return full;
}

// Download bytes from a path. Returns Buffer or null if not found.
async function download(objectPath) {
  init();
  if (_mode === "gcs") {
    try {
      const file = _bucket.file(objectPath);
      const [bytes] = await file.download();
      return bytes;
    } catch (e) {
      if (e.code === 404) return null;
      throw e;
    }
  }
  const full = path.join(_localRoot, objectPath);
  if (!fs.existsSync(full)) return null;
  return fs.readFileSync(full);
}

// Check existence without downloading.
async function exists(objectPath) {
  init();
  if (_mode === "gcs") {
    try {
      const file = _bucket.file(objectPath);
      const [ex] = await file.exists();
      return ex;
    } catch (_) { return false; }
  }
  return fs.existsSync(path.join(_localRoot, objectPath));
}

// Delete an object.
async function del(objectPath) {
  init();
  if (_mode === "gcs") {
    try { await _bucket.file(objectPath).delete(); return true; }
    catch (e) { if (e.code === 404) return false; throw e; }
  }
  const full = path.join(_localRoot, objectPath);
  if (fs.existsSync(full)) { fs.unlinkSync(full); return true; }
  return false;
}

// List objects with a given prefix (up to N). Returns array of { name, size, updated }.
async function list(prefix = "", maxResults = 500) {
  init();
  if (_mode === "gcs") {
    const [files] = await _bucket.getFiles({ prefix, maxResults });
    return files.map((f) => ({
      name: f.name,
      size: parseInt(f.metadata?.size || "0", 10),
      updated: f.metadata?.updated,
    }));
  }
  // Local fallback — walk the directory
  const root = path.join(_localRoot, prefix);
  const out = [];
  const walk = (dir, base) => {
    if (!fs.existsSync(dir)) return;
    for (const name of fs.readdirSync(dir)) {
      if (out.length >= maxResults) return;
      const p = path.join(dir, name);
      const rel = path.posix.join(base, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p, rel);
      else out.push({ name: rel, size: st.size, updated: st.mtime.toISOString() });
    }
  };
  walk(root, prefix);
  return out;
}

// Public URL for a bucket path. For GCS, uses the public-viewer URL (works
// even for uniform-access buckets when we sign, but for now returns the
// standard object URL). For local mode, returns the local file path.
function publicUrl(objectPath) {
  init();
  if (_mode === "gcs") {
    return `https://storage.googleapis.com/${process.env.GCS_BUCKET}/${objectPath}`;
  }
  return path.join(_localRoot, objectPath);
}

// Signed URL for temporary read access (used by /stream/latest.jpg to serve
// GCS content without making the bucket public). Falls back to public URL
// in local mode. Returns null on error.
async function signedUrl(objectPath, ttlSeconds = 300) {
  init();
  if (_mode === "gcs") {
    try {
      const [url] = await _bucket.file(objectPath).getSignedUrl({
        action: "read",
        expires: Date.now() + ttlSeconds * 1000,
        version: "v4",
      });
      return url;
    } catch (e) {
      console.error(`[gcs] signedUrl failed for ${objectPath}: ${e.message}`);
      return null;
    }
  }
  return publicUrl(objectPath);
}

function mode() { init(); return _mode; }

module.exports = { init, upload, download, exists, del, list, publicUrl, signedUrl, mode };
