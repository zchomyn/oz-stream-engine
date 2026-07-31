// APE STREAM ENGINE — brand_geo.js stub. No brands, no OSM, no pins.
module.exports = {
  geolocate: async () => ({ locations: [], source: "disabled" }),
  invalidate: () => {},
  HOME_LAT: 0,
  HOME_LNG: 0,
  distanceKm: () => 0,
};
