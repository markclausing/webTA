/**
 * Where on the map a place on Earth lands.
 *
 * Lambert azimuthal equal-area, centred on 15°E 52°N, which is what most atlases
 * use for Europe: Scandinavia does not balloon the way it does in Mercator, and
 * a square kilometre of Poland is a square kilometre of Portugal, which matters
 * in a game that charges you by the square kilometre.
 *
 * Map units are kilometres. +x is east, +y is north. The renderer turns y into
 * -z; nothing in the simulation knows that.
 */

const R = 6371;
const RAD = Math.PI / 180;
export const LON0 = 15;
export const LAT0 = 52;
const sin0 = Math.sin(LAT0 * RAD);
const cos0 = Math.cos(LAT0 * RAD);

export function project(lon, lat) {
  const l = (lon - LON0) * RAD;
  const p = lat * RAD;
  const k = Math.sqrt(2 / (1 + sin0 * Math.sin(p) + cos0 * Math.cos(p) * Math.cos(l)));
  return [
    R * k * Math.cos(p) * Math.sin(l),
    R * k * (cos0 * Math.sin(p) - sin0 * Math.cos(p) * Math.cos(l)),
  ];
}

export function unproject(x, y) {
  const rho = Math.hypot(x, y);
  if (rho < 1e-9) return [LON0, LAT0];
  const c = 2 * Math.asin(Math.min(1, rho / (2 * R)));
  const sc = Math.sin(c);
  const cc = Math.cos(c);
  const lat = Math.asin(cc * sin0 + (y * sc * cos0) / rho);
  const lon = LON0 * RAD + Math.atan2(x * sc, rho * cos0 * cc - y * sin0 * sc);
  return [lon / RAD, lat / RAD];
}

/** The playing field, in map kilometres: Lisbon to Moscow, Crete to the North Cape. */
export const BOUNDS = { x0: -2350, x1: 2150, y0: -2000, y1: 2250 };
