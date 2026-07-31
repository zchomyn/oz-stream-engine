// APE STREAM ENGINE — campaigns.js stub.
//
// In the parent engine campaigns are a first-class construct. In the stream
// engine there are no campaigns: it's a life being watched, not a research
// tool. Rather than surgically strip every campaign reference from ape.js,
// we stub the module here. Every function is a safe no-op that returns
// empty/false/null so ape.js code paths that check for campaigns fall
// through gracefully.
//
// If you ever want campaigns in the stream engine, replace this file with
// the real implementation from the parent engine.

module.exports = {
  load: () => {},
  create: () => null,
  start: () => null,
  end: () => null,
  get: () => null,
  list: () => [],
  running: () => [],   // <-- the important one; many code paths iterate this
  signalsFor: () => null,
  emit: () => {},
  fanout: () => {},
  summarize: () => null,
  setMediaPlan: () => null,
  setGeoLocations: () => null,
  setProductPlan: () => null,
  logTouch: () => {},
  logPurchase: () => {},
  persist: () => {},
  injectProduct: () => null,
  removeInjectedObjects: () => {},
  reconcilePlacements: () => {},
};
