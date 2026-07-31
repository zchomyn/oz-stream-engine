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
    describe: "Camera concealed inside a decorative houseplant. A few blurred green leaves partially crop the frame edges as a soft vignette. Low angle, looking upward slightly toward the room's activity.",
    homeOnly: true,
  },
  // Object-hidden cameras — the Truman Show POV shots.
  // IMPORTANT: describes the CAMERA and its viewport only. Do NOT describe
  // what the camera happens to be seeing (coffee, ears, faces) because Nano
  // Banana treats that as scene content and paints it into every frame.
  {
    id: "coffee-mug",
    label: "MUG CAM",
    // Camera describe: aperture and vignette shape only. Model must not add
    // coffee to scenes where the subject isn't drinking.
    describe: "Camera lens fitted flush into the base of a ceramic drinking vessel on a table or counter. Restricted circular viewport looking upward from tabletop level. Frame edges show a soft dark ring where the vessel's inner rim vignettes the view.",
    homeOnly: false,
    objectCam: true,
    // Verb gate: subject's action must START with drink/sip/pour to activate.
    verbGate: ["drink", "sip", "pour", "raises", "lifts", "reaches for the mug"],
  },
  {
    id: "phone-receiver",
    label: "PHONE CAM",
    describe: "Camera embedded in a telephone handset. Restricted viewport with a curved plastic vignette on one side. Only activates when the receiver is picked up.",
    homeOnly: false,
    objectCam: true,
    verbGate: ["answers the phone", "picks up the phone", "phone rings", "on the phone", "calls", "dials"],
  },
  {
    id: "mirror-behind",
    label: "MIRROR CAM",
    describe: "Camera behind a two-way mirror. Faint doubled-image ghosting from the mirror surface visible in the frame. Wall-mounted, chest-to-head height, looking outward into the room from a mirror's position.",
    homeOnly: true,
  },
  {
    id: "wristwatch",
    label: "WATCH CAM",
    describe: "Camera embedded in the crown of a wristwatch. Very small circular vignette. Only activates when the wearer's wrist is raised toward their face or an object.",
    homeOnly: false,
    objectCam: true,
    verbGate: ["checks the time", "looks at his watch", "raises his wrist", "consults the watch"],
  },
  {
    id: "coat-button",
    label: "BUTTON CAM",
    describe: "Camera lens flush-mounted in the second button of a coat. Very small forward-facing viewport at chest height. Only activates while the coat is worn.",
    homeOnly: false,
    objectCam: true,
    verbGate: ["walking to work", "walking home", "walking down", "walking along", "walking through"],
  },
  {
    id: "newspaper-header",
    label: "NEWSPRINT CAM",
    describe: "Camera embedded in the masthead of a newspaper. Only activates when the paper is held open in reading position. Curved paper edges vignette the frame.",
    homeOnly: false,
    objectCam: true,
    verbGate: ["reads the paper", "reading the newspaper", "unfolds the chronicle", "opens the paper"],
  },
  {
    id: "picture-frame",
    label: "FRAME CAM",
    describe: "Camera hidden behind the glass of a framed photograph on a wall or mantel. Slight reflection ghosting on the frame. Angle looking outward into the room from a fixed spot.",
    homeOnly: true,
  },
  {
    id: "cereal-box",
    label: "CEREAL CAM",
    describe: "Camera lens fitted into the top of a cardboard cereal box. Only activates when the box is open. Extreme low-angle circular viewport looking upward when someone is pouring from above.",
    homeOnly: true,
    objectCam: true,
    verbGate: ["pours cereal", "opens the cornflakes", "shakes the box"],
  },
  {
    id: "car-radio",
    label: "DASHBOARD CAM",
    describe: "Camera hidden in an automobile dashboard, forward-angled toward the driver's seat. Steering wheel visible at bottom of frame, windshield visible top. Only activates when the driver is in the car.",
    homeOnly: false,
    outdoor: true,
    objectCam: true,
    verbGate: ["driving", "in the car", "at the wheel", "starts the engine"],
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
    describe: "Retail ceiling-corner security camera. Very wide angle. Aisles or counters partly visible.",
    homeOnly: false,
  },
  {
    id: "clock-face",
    label: "CLOCK CAM",
    describe: "Camera hidden behind the face of a wall clock. Looks out through a small hole in the clock face. Circular frame vignette. Center of view sharp, edges blurred.",
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

  // Score each camera. Base 1 for non-object cams. Object cams are strict:
  // they only fire when the subject's action contains one of their verb-gate
  // phrases as a substring. This prevents mug cam from firing because someone
  // mentioned coffee somewhere.
  const scored = CAM_POSITIONS.map((cam) => {
    let score = 1;
    if (isHome && cam.outdoor) score = 0;
    else if (isOutdoor && cam.homeOnly) score = 0;
    if (cam.objectCam) {
      // Verb gate: must match one of the exact phrases in ctx or score 0
      if (!cam.verbGate || !cam.verbGate.some((phrase) => ctx.includes(phrase))) {
        score = 0;
      } else {
        score = 8;   // when it does match, moderately boosted
      }
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
POST-PROCESSING PASS (apply these effects to the composed scene — do not let them change the scene itself):
- Very slight fisheye barrel distortion at the frame edges.
- Faint horizontal scan lines visible across the frame.
- Fine luminance grain in shadow areas.
- Mild chromatic aberration on high-contrast edges (very slight).
- Slight vignette darkening at the corners: ${cameraMeta.describe.match(/vignette/i) ? cameraMeta.describe : "gentle radial darkening at the four corners of the frame"}.
- Overall color is NEUTRAL — do NOT push warm, do NOT push cool. Whatever palette the room's lighting already has is what the camera captures.

TIMESTAMP OVERLAY (burn into the bottom-right corner):
- Small, blocky white monospaced text, faint drop-shadow.
- Text: "${cameraMeta.stampText}"

The frame is a natural, unposed hidden-camera capture. The subject does not know they are being observed. But the composition and the room and the people are DETERMINED BY THE REFERENCE IMAGES — this post pass only adds surveillance texture over what's already there.`;
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
