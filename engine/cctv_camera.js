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
  // Traditional hidden cameras
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
    id: "plant-cam",
    label: "PLANT CAM",
    describe: "Camera concealed inside a decorative houseplant. Leaves partially crop the frame edges as soft green vignette. Low angle, looking upward slightly.",
    homeOnly: true,
  },
  // Object-hidden cameras — the Truman Show POV shots
  {
    id: "coffee-mug",
    label: "MUG CAM",
    describe: "Camera hidden inside a coffee mug or cup, lens looking UP through the coffee toward the drinker's face. Warm brown liquid ripples visible around the edges of the frame. Extreme close-up of a mouth, chin, tip of the nose from below. Only visible when someone is drinking.",
    homeOnly: false,
    objectCam: true,
    triggerWords: ["coffee", "mug", "drink", "sip", "carafe"],
  },
  {
    id: "phone-receiver",
    label: "PHONE CAM",
    describe: "Extreme close-up camera hidden in a phone receiver. When the phone is picked up, we see an ear, side of a face, hair, a jawline. Warm plastic curvature crops the frame. Only shows when someone is on the phone.",
    homeOnly: false,
    objectCam: true,
    triggerWords: ["phone", "call", "receiver"],
  },
  {
    id: "mirror-behind",
    label: "MIRROR CAM",
    describe: "Two-way mirror camera in the bathroom or bedroom. Subject looks directly at the camera without knowing — grooming, checking their teeth, adjusting their hair. Slight ghost double-image from mirror surface. Sink or dresser visible below the frame edge.",
    homeOnly: true,
  },
  {
    id: "wristwatch",
    label: "WATCH CAM",
    describe: "Camera hidden in the face of a wristwatch. The frame is a small circle vignette. What we see is whatever the wrist is pointing at — the surface of a desk, a newspaper, a plate of food, someone's shoulder. Watch hands may be faintly visible as translucent overlays.",
    homeOnly: false,
    objectCam: true,
  },
  {
    id: "coat-button",
    label: "BUTTON CAM",
    describe: "Camera hidden inside a coat button, chest-height on the wearer, looking forward. Whatever the wearer is looking at, we see. Slight round vignette. Very low resolution feel — this is the cheapest camera in the network.",
    homeOnly: false,
    objectCam: true,
    triggerWords: ["coat", "jacket", "walking", "office", "outside"],
  },
  {
    id: "newspaper-header",
    label: "NEWSPRINT CAM",
    describe: "Camera embedded in the masthead of the Seahaven Chronicle newspaper. When someone reads the paper, we see their face from below the page — eyes moving across the columns, sometimes their mouth. Grainy newsprint texture around the frame edges.",
    homeOnly: false,
    objectCam: true,
    triggerWords: ["newspaper", "chronicle", "read", "paper"],
  },
  {
    id: "picture-frame",
    label: "FRAME CAM",
    describe: "Camera hidden behind the glass of a framed photograph (the sailboat photo, the wedding photo). Slight reflection ghost on the frame. Angle looking out into the room from a fixed spot on the mantel or wall.",
    homeOnly: true,
  },
  {
    id: "cereal-box",
    label: "CEREAL CAM",
    describe: "Camera hidden inside a cornflakes or cereal box, looking UP through the top when the box is opened. Extreme low angle of someone pouring cereal from above — box top edges vignette the frame.",
    homeOnly: true,
    objectCam: true,
    triggerWords: ["cornflakes", "cereal", "breakfast"],
  },
  {
    id: "car-radio",
    label: "DASHBOARD CAM",
    describe: "Camera hidden in a car radio or dashboard. Wide angle capturing the driver from a low front-angle. Steering wheel visible at bottom of frame. Windshield visible top. Sun glare on the interior.",
    homeOnly: false,
    outdoor: true,
    objectCam: true,
  },
  {
    id: "streetlight",
    label: "STREET CAM",
    describe: "Camera mounted on a streetlight pole, ~12 feet high, angled downward. Wide angle. Occasional passing pedestrians blur through the frame edges.",
    homeOnly: false,
    outdoor: true,
  },
  {
    id: "store-corner",
    label: "STORE CAM",
    describe: "Retail ceiling-corner security camera, black-and-white leaning toward warm cream in the highlights. Very wide angle. Aisles or counters partly visible.",
    homeOnly: false,
  },
  {
    id: "clock-face",
    label: "CLOCK CAM",
    describe: "Camera hidden behind the face of a wall clock. Looks out through a small hole. Circular frame vignette. Center of view sharp, edges blurred.",
    homeOnly: true,
  },
];

// Pick a camera position based on location context. Home rooms get any of the
// home-installed cameras; outdoor scenes get street/dash cameras; interiors
// like the café or office get store-corner or bookshelf.
function pickCamera(location, activityContext = "") {
  const homeRooms = ["master bedroom", "kitchen", "living room", "bathroom", "front hallway"];
  const outdoorSpots = ["front step", "lancaster square", "market street", "seahaven harbor", "seahaven park", "chester street"];
  const isHome = homeRooms.includes(location);
  const isOutdoor = outdoorSpots.includes(location);
  const ctx = (activityContext || "").toLowerCase();

  // Score each camera: location gate + trigger-word boost for object cams
  const scored = CAM_POSITIONS.map((cam) => {
    let score = 1;
    if (isHome && cam.outdoor) score = 0;
    else if (isOutdoor && cam.homeOnly) score = 0;
    if (cam.triggerWords && score > 0) {
      const hits = cam.triggerWords.filter((w) => ctx.includes(w)).length;
      if (hits > 0) score += hits * 10;
    }
    return { cam, score };
  }).filter((s) => s.score > 0);

  if (!scored.length) return CAM_POSITIONS[0];
  const total = scored.reduce((s, x) => s + x.score, 0);
  let r = Math.random() * total;
  for (const s of scored) {
    r -= s.score;
    if (r <= 0) return s.cam;
  }
  return scored[scored.length - 1].cam;
}

// Build a camera metadata block for use in the timestamp overlay.
function cameraMeta(location, day, timeStr, activityContext = "") {
  const cam = pickCamera(location, activityContext);
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
