// APE STREAM ENGINE — CCTV camera aesthetic system.
//
// Every scene rendered by the stream engine passes through this wrapper. It
// takes a base SCENE prompt and produces a variant that reads as a hidden
// camera capture: pinhole in a smoke detector, ceiling-corner security dome,
// dashcam, closet-height nanny cam, doorframe camera, plant cam.
//
// The wrapper defines:
//   - Camera position (where in the scene)
//   - Sensor characteristics (fisheye, chromatic aberration, noise, scan lines)
//   - Composition rules (off-center, obscured foreground, cropped)
//   - Color grade (warm, desaturated, low DR)
//   - Metadata overlay (CAM ID + timestamp burned into corner)
//
// The wrapper is called from ape.js render sites. It never touches the
// underlying SCENE content — only the visual framing.

const CAM_POSITIONS = [
  {
    id: "smoke-detector",
    label: "SMOKE DETECTOR",
    describe: "Camera hidden inside a ceiling-mounted smoke detector. Very high angle, looking down. Fisheye barrel distortion pronounced at edges. Everything appears slightly rounded outward.",
    homeOnly: true,
  },
  {
    id: "ceiling-corner",
    label: "CEILING-CORNER DOME",
    describe: "Ceiling-corner security dome camera, ~9 feet high. Wide angle, slight fisheye. View sweeps across the room from an upper corner.",
    homeOnly: false,
  },
  {
    id: "doorframe",
    label: "DOORFRAME CAM",
    describe: "Camera embedded in a doorframe at head height, looking across the room. Doorframe wood visible along one side of the frame as vignette.",
    homeOnly: false,
  },
  {
    id: "bookshelf",
    label: "SHELF CAM",
    describe: "Camera hidden between books on a shelf, ~4 feet high. Book spines partially crop the bottom edge. Angle nearly horizontal.",
    homeOnly: true,
  },
  {
    id: "mirror",
    label: "MIRROR CAM",
    describe: "Camera behind a two-way mirror, looking out into the room. Slight double-image ghost from mirror surface. Reflection of a lamp visible in the top corner.",
    homeOnly: true,
  },
  {
    id: "plant-cam",
    label: "PLANT CAM",
    describe: "Camera concealed inside a decorative houseplant. Leaves partially crop the frame edges as soft green vignette. Low angle, looking upward slightly.",
    homeOnly: true,
  },
  {
    id: "dashcam",
    label: "DASHCAM 04",
    describe: "Wide-angle dashcam mounted to a car windshield. Steering wheel and dashboard visible at the bottom of the frame. Front windshield visible. Slight sun glare when facing east.",
    homeOnly: false,
    outdoor: true,
  },
  {
    id: "streetlight",
    label: "STREET CAM",
    describe: "Camera mounted on a streetlight pole, ~12 feet high, angled downward. Wide angle. Occasional passing pedestrians blur through the frame edges. Weather affects visibility.",
    homeOnly: false,
    outdoor: true,
  },
  {
    id: "store-corner",
    label: "STORE CAM 02",
    describe: "Retail ceiling-corner security camera, black-and-white leaning toward warm cream in the highlights. Very wide angle. Aisles or counters partly visible.",
    homeOnly: false,
  },
  {
    id: "dashboard-clock",
    label: "CLOCK CAM",
    describe: "Camera hidden behind the face of a wall clock. Looks out through a small hole. Circular frame vignette. Center of view sharp, edges blurred.",
    homeOnly: true,
  },
];

// Pick a camera position based on location context. Home rooms get any of the
// home-installed cameras; outdoor scenes get street/dash cameras; interiors
// like the café or office get store-corner or bookshelf.
function pickCamera(location) {
  const homeRooms = ["master bedroom", "kitchen", "living room", "bathroom", "front hallway"];
  const outdoorSpots = ["front step", "lancaster square", "market street", "seahaven harbor", "seahaven park", "chester street"];
  const isHome = homeRooms.includes(location);
  const isOutdoor = outdoorSpots.includes(location);
  let candidates;
  if (isHome) candidates = CAM_POSITIONS.filter((c) => c.homeOnly !== false || !c.outdoor);
  else if (isOutdoor) candidates = CAM_POSITIONS.filter((c) => c.outdoor === true || (!c.homeOnly));
  else candidates = CAM_POSITIONS.filter((c) => !c.homeOnly && !c.outdoor);
  if (!candidates.length) candidates = CAM_POSITIONS;
  // Deterministic-ish based on a hash of location for stability across
  // renders of the same slot; randomized enough for variety across slots.
  const idx = Math.floor(Math.random() * candidates.length);
  return candidates[idx];
}

// Build a camera metadata block for use in the timestamp overlay.
function cameraMeta(location, day, timeStr) {
  const cam = pickCamera(location);
  const camNumber = String(Math.floor(Math.random() * 12) + 1).padStart(2, "0");
  return {
    id: cam.id,
    label: `${cam.label} ${camNumber}`,
    describe: cam.describe,
    stampText: `SEAHAVEN CAM ${camNumber} · DAY ${day} · ${timeStr}`,
  };
}

// The CCTV aesthetic block — appended to every render prompt in place of the
// usual cinematic framing. What this instructs the model to do:
function cctvAestheticBlock(cameraMeta) {
  return `
CAMERA FRAMING (this is a hidden-camera capture, not a cinematographer's shot):
- POSITION: ${cameraMeta.describe}
- Never a composed shot. Never eye-level. Never on-axis with any character. The character is unaware of being observed.
- Foreground may partially obscure the subject: a doorframe edge, a plant leaf, a book spine, a lamp shade, a rearview mirror. Embrace this — it makes the surveillance feel real.
- Subject may be off-center, cropped by the frame edge, or captured mid-motion. Not posed.

SENSOR CHARACTERISTICS:
- Slight fisheye barrel distortion (subtle at center, more pronounced at edges).
- Mild chromatic aberration at the frame edges (very slight cyan/red fringing where high-contrast lines meet).
- Sensor noise — a fine layer of luminance grain, more visible in shadows.
- Low dynamic range — highlights clip slightly (a window blows out to pure white; a bright light source glows). Shadows crush slightly to deep gray, not pure black.
- Very faint horizontal scan lines running the height of the frame, barely visible.
- Slight rolling-shutter jelly effect on fast motion (only if applicable).

COLOR GRADE:
- Warm cast — the cheap sensor runs slightly yellow-orange, especially in shadow tones.
- Desaturated overall. Not black-and-white — colors present but muted. Skin tones read natural but slightly waxy.
- No cinematic teal-and-orange. No color-graded darkroom feel. This is a bare sensor.

TIMESTAMP OVERLAY (burn into the bottom-right corner of the frame, as if the camera firmware wrote it there):
- Small, blocky white sans-serif or monospaced numeric text with a thin drop-shadow so it stays legible on any background.
- Exact text: "${cameraMeta.stampText}"
- Do not stylize the timestamp — it should look like it came from cheap 1998 CCTV firmware, not a designer.

OVERALL FEEL:
- Someone glancing at this frame should IMMEDIATELY read "security camera footage" — not "movie still," not "photograph," not "documentary." A hidden camera in a real room. The subject does not know they are on camera.`;
}

// Full wrapper — combines a base SCENE description with the CCTV aesthetic.
// The caller passes the base scene text; this returns the wrapped prompt.
function wrapAsCCTV(baseSceneText, location, day, timeStr) {
  const meta = cameraMeta(location, day, timeStr);
  return {
    prompt: `${baseSceneText}

${cctvAestheticBlock(meta)}`,
    meta,
  };
}

module.exports = {
  pickCamera,
  cameraMeta,
  cctvAestheticBlock,
  wrapAsCCTV,
  CAM_POSITIONS,
};
