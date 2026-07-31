// APE STREAM ENGINE — world.js.
// This module preserves the parent engine's require path (require('./world'))
// while sourcing content from world_truman.js. If you want to swap worlds
// (say, back to the Montréal family for testing), swap the require here.
module.exports = require("./world_truman");
