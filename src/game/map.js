/**
 * The ground the war is fought over: a 25 km grid laid on Europe.
 *
 * Every cell is sea, lake or land, and land belongs to a country. Countries are
 * on one of three sides: hostile (Russia and Belarus), defended (NATO and the
 * rest of Europe, Ukraine and Moldova included), or outside - the Caucasus,
 * North Africa and the Middle East, which are on the map because they are next
 * to it and which nobody's tanks drive into.
 *
 * Nothing here changes during a game. Who holds a cell right now is the
 * simulation's business; this file only knows who it belonged to at the start.
 */

import data from './data/europe.js';
import { project } from './proj.js';

export const CELL = data.cell;
export const COLS = data.cols;
export const ROWS = data.rows;
export const X0 = data.x0;
export const Y0 = data.y0;
export const X1 = X0 + COLS * CELL;
export const Y1 = Y0 + ROWS * CELL;
export const N = COLS * ROWS;

export const COUNTRIES = data.countries;
export const SHAPES = data.shapes;
export const LAKES = data.lakes;

function bytes(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

export const SEA = 0;
export const LAKE = 1;
export const LAND = 2;

/** Which side a cell started the game on. */
export const NONE = 0;     // water, or a country nobody is fighting over
export const FRIEND = 1;   // defended: lose it and it costs you
export const HOSTILE = 2;  // Russia, Belarus and occupied Ukraine

const rawGrid = bytes(data.grid);
const rawOccupied = bytes(data.occupied);
const rawElev = new Int16Array(bytes(data.elev).buffer);

export const terrain = new Uint8Array(N);
export const country = new Int16Array(N).fill(-1);
export const origin = new Uint8Array(N);
export const elev = new Int16Array(N);

for (let i = 0; i < N; i++) {
  const g = rawGrid[i];
  elev[i] = rawElev[i];
  if (g === 0) terrain[i] = SEA;
  else if (g === 1) terrain[i] = LAKE;
  else {
    terrain[i] = LAND;
    country[i] = g - 2;
    const role = COUNTRIES[g - 2].role;
    if (rawOccupied[i] || role === 'hostile') origin[i] = HOSTILE;
    else if (role === 'nato' || role === 'europe') origin[i] = FRIEND;
  }
}

export const col = (i) => i % COLS;
export const row = (i) => (i / COLS) | 0;

export function cellAt(x, y) {
  const c = Math.floor((x - X0) / CELL);
  const r = Math.floor((y - Y0) / CELL);
  if (c < 0 || r < 0 || c >= COLS || r >= ROWS) return -1;
  return r * COLS + c;
}

export const cx = (i) => X0 + ((i % COLS) + 0.5) * CELL;
export const cy = (i) => Y0 + (((i / COLS) | 0) + 0.5) * CELL;

export const isSea = (i) => i >= 0 && terrain[i] === SEA;
export const isLand = (i) => i >= 0 && terrain[i] === LAND;

/** Eight neighbours, as index offsets, with their step lengths. */
export const NEIGHBOURS = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

/** Calls fn(j) for every cell within `radius` cells of i, i included. */
export function around(i, radius, fn) {
  const c0 = i % COLS, r0 = (i / COLS) | 0;
  const r2 = radius * radius + 0.5;
  for (let dr = -radius; dr <= radius; dr++) {
    const r = r0 + dr;
    if (r < 0 || r >= ROWS) continue;
    for (let dc = -radius; dc <= radius; dc++) {
      const c = c0 + dc;
      if (c < 0 || c >= COLS || dc * dc + dr * dr > r2) continue;
      fn(r * COLS + c);
    }
  }
}

/** The nearest cell to i that passes test, searching out to maxRadius cells. */
export function nearest(i, maxRadius, test) {
  if (test(i)) return i;
  const c0 = i % COLS, r0 = (i / COLS) | 0;
  for (let rad = 1; rad <= maxRadius; rad++) {
    let best = -1, bd = Infinity;
    for (let dr = -rad; dr <= rad; dr++) {
      for (let dc = -rad; dc <= rad; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== rad) continue;
        const r = r0 + dr, c = c0 + dc;
        if (r < 0 || c < 0 || r >= ROWS || c >= COLS) continue;
        const j = r * COLS + c;
        const d = dr * dr + dc * dc;
        if (d < bd && test(j)) { bd = d; best = j; }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

/** Cells of the main sea, as opposed to a landlocked puddle the grid left behind. */
export const openSea = (() => {
  const seen = new Uint8Array(N);
  const comps = [];
  for (let s = 0; s < N; s++) {
    if (terrain[s] !== SEA || seen[s]) continue;
    const list = [s];
    seen[s] = 1;
    for (let k = 0; k < list.length; k++) {
      const i = list[k];
      for (const [dc, dr] of NEIGHBOURS) {
        const c = (i % COLS) + dc, r = ((i / COLS) | 0) + dr;
        if (c < 0 || r < 0 || c >= COLS || r >= ROWS) continue;
        const j = r * COLS + c;
        if (terrain[j] === SEA && !seen[j]) { seen[j] = 1; list.push(j); }
      }
    }
    comps.push(list);
  }
  const out = new Uint8Array(N);
  for (const list of comps) if (list.length > 12) for (const i of list) out[i] = 1;
  return out;
})();

// --- places -------------------------------------------------------------------

/**
 * Cities you defend. A capital costs more to lose. Coastal cities get a port,
 * which is where hostile ships aim and where your own can be launched from.
 */
const FRIENDLY_CITIES = [
  ['Tallinn', 24.75, 59.44, 1], ['Tartu', 26.72, 58.38], ['Narva', 28.19, 59.38],
  ['Riga', 24.1, 56.95, 1], ['Daugavpils', 26.53, 55.87], ['Liepāja', 21.01, 56.51],
  ['Vilnius', 25.28, 54.69, 1], ['Kaunas', 23.9, 54.9], ['Klaipėda', 21.13, 55.7],
  ['Warsaw', 21.01, 52.23, 1], ['Białystok', 23.16, 53.13], ['Gdańsk', 18.65, 54.35],
  ['Lublin', 22.57, 51.25], ['Kraków', 19.94, 50.06], ['Poznań', 16.93, 52.41],
  ['Helsinki', 24.94, 60.17, 1], ['Lappeenranta', 28.19, 61.06], ['Oulu', 25.47, 65.01],
  ['Rovaniemi', 25.73, 66.5], ['Stockholm', 18.07, 59.33, 1], ['Gothenburg', 11.97, 57.71],
  ['Luleå', 22.15, 65.58], ['Oslo', 10.75, 59.91, 1], ['Tromsø', 18.96, 69.65],
  ['Kirkenes', 30.05, 69.73], ['Copenhagen', 12.57, 55.68, 1], ['Berlin', 13.4, 52.52, 1],
  ['Hamburg', 9.99, 53.55], ['Munich', 11.58, 48.14], ['Frankfurt', 8.68, 50.11],
  ['Prague', 14.42, 50.08, 1], ['Vienna', 16.37, 48.21, 1], ['Bratislava', 17.11, 48.15, 1],
  ['Budapest', 19.04, 47.5, 1], ['Bucharest', 26.1, 44.43, 1], ['Constanța', 28.63, 44.17],
  ['Iași', 27.6, 47.16], ['Chișinău', 28.86, 47.01, 1], ['Kyiv', 30.52, 50.45, 1],
  ['Kharkiv', 36.23, 49.99], ['Odesa', 30.72, 46.48], ['Lviv', 24.03, 49.84],
  ['Dnipro', 35.05, 48.46], ['Sofia', 23.32, 42.7, 1], ['Varna', 27.91, 43.21],
  ['Athens', 23.73, 37.98, 1], ['Thessaloniki', 22.94, 40.64], ['Istanbul', 28.97, 41.01],
  ['Ankara', 32.85, 39.93, 1], ['Belgrade', 20.46, 44.79, 1], ['Zagreb', 15.98, 45.81, 1],
  ['Ljubljana', 14.5, 46.05, 1], ['Rome', 12.5, 41.9, 1], ['Milan', 9.19, 45.46],
  ['Paris', 2.35, 48.86, 1], ['Brussels', 4.35, 50.85, 1], ['Amsterdam', 4.9, 52.37, 1],
  ['Rotterdam', 4.48, 51.92], ['London', -0.13, 51.5, 1], ['Edinburgh', -3.19, 55.95],
  ['Madrid', -3.7, 40.42, 1], ['Lisbon', -9.14, 38.72, 1], ['Dublin', -6.26, 53.35, 1],
  ['Bern', 7.45, 46.95, 1],
];

/** Where the other side comes from. Some are ports, and ships sail from those. */
const HOSTILE_PLACES = [
  ['Moscow', 37.62, 55.75, 1], ['St Petersburg', 30.32, 59.94], ['Pskov', 28.33, 57.82],
  ['Murmansk', 33.08, 68.97], ['Petrozavodsk', 34.35, 61.79], ['Kaliningrad', 20.51, 54.71],
  ['Minsk', 27.56, 53.9, 1], ['Grodno', 23.83, 53.68], ['Brest', 23.69, 52.1],
  ['Vitebsk', 30.2, 55.19], ['Gomel', 30.98, 52.44], ['Smolensk', 32.05, 54.78],
  ['Bryansk', 34.36, 53.24], ['Kursk', 36.19, 51.73], ['Belgorod', 36.59, 50.6],
  ['Rostov', 39.7, 47.23], ['Sevastopol', 33.52, 44.6], ['Donetsk', 37.8, 48.0],
  ['Novorossiysk', 37.77, 44.72], ['Mariupol', 37.55, 47.1],
];

/** The sea next to a city, if it has any within reach, from the open sea only. */
function portOf(cell) {
  return nearest(cell, 4, (j) => openSea[j] === 1);
}

function place([name, lon, lat, capital], side, id) {
  const [x, y] = project(lon, lat);
  let cell = cellAt(x, y);
  // A coastal city can fall on a sea cell at 25 km; walk it ashore.
  if (!isLand(cell)) cell = nearest(cell, 3, isLand);
  const port = portOf(cell);
  return {
    id,
    key: name.toLowerCase().replace(/ø/g, 'o').replace(/ł/g, 'l').normalize('NFD').replace(/[^a-z]/g, ''),
    name,
    x,
    y,
    cell,
    capital: Boolean(capital),
    side,
    port,
    country: country[cell],
  };
}

export const CITIES = [
  ...FRIENDLY_CITIES.map((c) => place(c, FRIEND, 0)),
  ...HOSTILE_PLACES.map((c) => place(c, HOSTILE, 0)),
].map((c, id) => ({ ...c, id }));

export const CITY = Object.fromEntries(CITIES.map((c) => [c.key, c]));

/** Friendly land cells: the denominator of "how much did you keep". */
export const FRIENDLY_CELLS = origin.reduce((n, o) => n + (o === FRIEND), 0);

/** How far apart two cells are, in cells. */
export function cellDist(a, b) {
  return Math.hypot((a % COLS) - (b % COLS), ((a / COLS) | 0) - ((b / COLS) | 0));
}
