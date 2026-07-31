// APE STREAM ENGINE — media_plan.js stub. Ambient media pressure is a
// campaign concept; not applicable to the stream. All exports are no-ops.

const AUTOPLAN_SCHEMA = { type: "object", properties: {}, required: [] };
const INTENSITY_DEFAULTS = {};

function autoplanPrompt() { return ""; }
function pressureText() { return ""; }

module.exports = {
  AUTOPLAN_SCHEMA,
  INTENSITY_DEFAULTS,
  autoplanPrompt,
  pressureText,
};
