// Builds the map of Europe the game is played on.
//
//   node tools/build-map.js
//
// Two things come out of it:
//
//   src/game/data/europe.js   countries as simplified outlines, and the grid the
//                             simulation walks on: what every 25 km square is
//                             (sea, lake, which country) and how high it is.
//   assets/relief.png         a 1024² height map for the renderer, sea floor and
//                             all, in the same projection.
//
// The sources are Natural Earth (1:50m countries and lakes, public domain) and
// the Terrarium elevation tiles on AWS Open Data (SRTM, GMTED and ETOPO1 under
// the hood). Both are fetched once into tools/.cache and never at play time, so
// the game itself still loads nothing from anywhere.

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { project, unproject, BOUNDS } from '../src/game/proj.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CACHE = path.join(ROOT, 'tools', '.cache');
mkdirSync(CACHE, { recursive: true });

const NE = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';
const TILES = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

export const CELL = 25; // km
const RELIEF = 1024;    // px, square, over BOUNDS
const SIMPLIFY = 2.2;   // km
const RELIEF_TOP = 4800;  // m, white in the red channel
const RELIEF_DEEP = 5500; // m, white in the green channel

// Who is who. Everything European that is not Russia or Belarus is defended;
// anything else on the map (the Caucasus, North Africa, the Middle East) is
// scenery that nobody marches through.
const HOSTILE = ['RUS', 'BLR'];
const NATO = ['ALB', 'BEL', 'BGR', 'HRV', 'CZE', 'DNK', 'EST', 'FIN', 'FRA', 'DEU', 'GRC', 'HUN',
  'ISL', 'ITA', 'LVA', 'LTU', 'LUX', 'MNE', 'NLD', 'MKD', 'NOR', 'POL', 'PRT', 'ROU', 'SVK', 'SVN',
  'ESP', 'SWE', 'TUR', 'GBR'];
const EUROPE = ['AUT', 'IRL', 'CHE', 'MLT', 'CYP', 'SRB', 'BIH', 'KOS', 'AND', 'LIE', 'MCO', 'SMR',
  'VAT', 'UKR', 'MDA'];

// Occupied Ukraine as of the game's start, roughly: Crimea, the land bridge south
// of the Zaporizhzhia front, and most of the Donbas. Applied only to cells that are
// Ukrainian or Russian already, so its edges can wander into Russia or the sea.
const OCCUPIED = [
  [31.5, 46.55], [32.6, 46.66], [33.4, 46.8], [34.3, 47.3], [35.3, 47.45], [35.8, 47.55],
  [36.3, 47.66], [36.8, 47.85], [37.3, 47.98], [37.2, 48.3], [37.7, 48.52], [37.9, 48.62],
  [38.1, 48.88], [37.8, 49.0], [37.6, 49.7], [37.9, 50.2], [40.5, 50.2], [40.5, 46.8],
  [36.6, 45.0], [33.4, 44.2], [32.2, 45.4],
];

async function fetchCached(url, name, binary = false) {
  const file = path.join(CACHE, name);
  if (!existsSync(file)) {
    process.stdout.write(`fetching ${name}\n`);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    writeFileSync(file, Buffer.from(await res.arrayBuffer()));
  }
  return binary ? readFileSync(file) : JSON.parse(readFileSync(file, 'utf8'));
}

// --- geometry ---------------------------------------------------------------

function simplify(pts, tol) {
  // Douglas-Peucker on a flat [x, y, x, y, ...] ring.
  const n = pts.length / 2;
  if (n < 4) return pts;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const ax = pts[a * 2], ay = pts[a * 2 + 1];
    const dx = pts[b * 2] - ax, dy = pts[b * 2 + 1] - ay;
    const len = dx * dx + dy * dy || 1e-9;
    let best = -1, far = t2;
    for (let i = a + 1; i < b; i++) {
      const px = pts[i * 2] - ax, py = pts[i * 2 + 1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len));
      const ex = px - t * dx, ey = py - t * dy;
      const d = ex * ex + ey * ey;
      if (d > far) { far = d; best = i; }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([a, best], [best, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(pts[i * 2], pts[i * 2 + 1]);
  return out;
}

function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) a += (r[j] - r[i]) * (r[j + 1] + r[i + 1]);
  return a / 2;
}

function inRing(r, x, y) {
  let inside = false;
  for (let i = 0, j = r.length - 2; i < r.length; j = i, i += 2) {
    const xi = r[i], yi = r[i + 1], xj = r[j], yj = r[j + 1];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function bbox(r) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < r.length; i += 2) {
    x0 = Math.min(x0, r[i]); x1 = Math.max(x1, r[i]);
    y0 = Math.min(y0, r[i + 1]); y1 = Math.max(y1, r[i + 1]);
  }
  return { x0, y0, x1, y1 };
}

const M = 300; // keep outlines a little past the edge so nothing ends at the frame
const touches = (b) => b.x1 > BOUNDS.x0 - M && b.x0 < BOUNDS.x1 + M && b.y1 > BOUNDS.y0 - M && b.y0 < BOUNDS.y1 + M;

/** Polygons of a GeoJSON geometry, projected, as [outer, ...holes] of flat rings. */
function polygonsOf(geom) {
  const polys = geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
  const out = [];
  for (const poly of polys) {
    // Skip anything on the other side of the world before projecting it: LAEA
    // folds the antipode into a ring at the edge of the disc.
    if (!poly[0].some(([lon, lat]) => lon > -40 && lon < 70 && lat > 20 && lat < 85)) continue;
    const rings = poly.map((ring) => {
      const flat = [];
      for (const [lon, lat] of ring) {
        const [x, y] = project(lon, lat);
        flat.push(x, y);
      }
      return flat;
    });
    if (!touches(bbox(rings[0]))) continue;
    out.push(rings);
  }
  return out;
}

// --- PNG, read and write, enough for Terrarium tiles and our own height map ---

function readPng(buf) {
  let p = 8, w = 0, h = 0, ch = 3;
  const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p);
    const type = buf.toString('ascii', p + 4, p + 8);
    const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      ch = { 2: 3, 6: 4, 0: 1 }[data[9]];
    } else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const out = new Uint8Array(w * h * ch);
  const stride = w * ch;
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)];
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? out[y * stride + x - ch] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= ch && y > 0 ? out[(y - 1) * stride + x - ch] : 0;
      let v = raw[src + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const pp = a + b - c;
        const pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[y * stride + x] = v & 255;
    }
  }
  return { w, h, ch, data: out };
}

function writePng(file, w, h, rgb) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let i = 0; i < w * 3; i++) raw[y * (w * 3 + 1) + 1 + i] = rgb[y * w * 3 + i];
  }
  writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]));
}

// --- elevation ----------------------------------------------------------------

const Z = 5;
const tileX = (lon) => ((lon + 180) / 360) * 2 ** Z;
const tileY = (lat) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** Z;
};

async function elevationSampler() {
  // Which tiles the map covers: walk the edge of the frame and its middle.
  let lo0 = 180, lo1 = -180, la0 = 90, la1 = -90;
  for (let i = 0; i <= 40; i++) {
    for (let j = 0; j <= 40; j++) {
      const x = BOUNDS.x0 + ((BOUNDS.x1 - BOUNDS.x0) * i) / 40;
      const y = BOUNDS.y0 + ((BOUNDS.y1 - BOUNDS.y0) * j) / 40;
      const [lon, lat] = unproject(x, y);
      lo0 = Math.min(lo0, lon); lo1 = Math.max(lo1, lon);
      la0 = Math.min(la0, lat); la1 = Math.max(la1, lat);
    }
  }
  const tx0 = Math.floor(tileX(lo0)), tx1 = Math.floor(tileX(lo1));
  const ty0 = Math.floor(tileY(la1)), ty1 = Math.floor(tileY(la0));
  const tiles = new Map();
  for (let ty = ty0; ty <= ty1; ty++) {
    for (let tx = tx0; tx <= tx1; tx++) {
      const png = await fetchCached(`${TILES}/${Z}/${tx}/${ty}.png`, `t${Z}-${tx}-${ty}.png`, true);
      tiles.set(`${tx},${ty}`, readPng(png));
    }
  }
  const at = (gx, gy) => {
    const tx = Math.floor(gx / 256), ty = Math.floor(gy / 256);
    const t = tiles.get(`${tx},${ty}`);
    if (!t) return 0;
    const px = Math.min(255, Math.max(0, gx - tx * 256));
    const py = Math.min(255, Math.max(0, gy - ty * 256));
    const i = (py * 256 + px) * t.ch;
    return t.data[i] * 256 + t.data[i + 1] + t.data[i + 2] / 256 - 32768;
  };
  return (lon, lat) => {
    const gx = tileX(lon) * 256 - 0.5, gy = tileY(lat) * 256 - 0.5;
    const x = Math.floor(gx), y = Math.floor(gy);
    const fx = gx - x, fy = gy - y;
    return (at(x, y) * (1 - fx) + at(x + 1, y) * fx) * (1 - fy)
      + (at(x, y + 1) * (1 - fx) + at(x + 1, y + 1) * fx) * fy;
  };
}

// --- build ------------------------------------------------------------------

const countriesGeo = await fetchCached(`${NE}/ne_50m_admin_0_countries.geojson`, 'ne_50m_countries.geojson');
const lakesGeo = await fetchCached(`${NE}/ne_50m_lakes.geojson`, 'ne_50m_lakes.geojson');

const countries = [];
const shapes = []; // [countryIndex, outer ring, ...holes]
for (const f of countriesGeo.features) {
  const p = f.properties;
  const code = p.ADM0_A3 === 'SDS' ? 'SSD' : p.ADM0_A3;
  const polys = polygonsOf(f.geometry);
  if (!polys.length) continue;
  const role = HOSTILE.includes(code) ? 'hostile' : NATO.includes(code) ? 'nato'
    : EUROPE.includes(code) ? 'europe' : 'outside';
  const index = countries.length;
  countries.push({ code, name: p.NAME, role });
  for (const rings of polys) shapes.push([index, ...rings]);
}

const lakes = [];
for (const f of lakesGeo.features) {
  for (const rings of polygonsOf(f.geometry)) {
    // Only the lakes you would see from orbit: Ladoga, Onega, Vänern, Peipus...
    if (Math.abs(ringArea(rings[0])) > 900) lakes.push(rings[0]);
  }
}

// The grid.
const cols = Math.round((BOUNDS.x1 - BOUNDS.x0) / CELL);
const rows = Math.round((BOUNDS.y1 - BOUNDS.y0) / CELL);
const SEA = 0, LAKE = 1;
const grid = new Uint8Array(cols * rows);        // 0 sea, 1 lake, 2+ country index
const occupied = new Uint8Array(cols * rows);    // held by Russia when the game opens
const shapeBoxes = shapes.map((s) => bbox(s[1]));
const lakeBoxes = lakes.map(bbox);
const occ = OCCUPIED.flatMap(([lon, lat]) => project(lon, lat));

function classify(x, y) {
  for (let i = 0; i < lakes.length; i++) {
    const b = lakeBoxes[i];
    if (x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && inRing(lakes[i], x, y)) return LAKE;
  }
  for (let i = 0; i < shapes.length; i++) {
    const b = shapeBoxes[i];
    if (x < b.x0 || x > b.x1 || y < b.y0 || y > b.y1) continue;
    const [index, outer, ...holes] = shapes[i];
    if (inRing(outer, x, y) && !holes.some((h) => inRing(h, x, y))) return index + 2;
  }
  return SEA;
}

// A cell is land if most of it is: five samples, centre and corners.
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    const cx = BOUNDS.x0 + (c + 0.5) * CELL, cy = BOUNDS.y0 + (r + 0.5) * CELL;
    const votes = new Map();
    for (const [dx, dy] of [[0, 0], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
      const v = classify(cx + dx * CELL, cy + dy * CELL);
      votes.set(v, (votes.get(v) || 0) + (dx === 0 ? 1.5 : 1));
    }
    let best = SEA, n = -1;
    for (const [v, k] of votes) if (k > n) { n = k; best = v; }
    const i = r * cols + c;
    grid[i] = best;
    if (best >= 2) {
      const code = countries[best - 2].code;
      if ((code === 'UKR' || code === 'RUS') && inRing(occ, cx, cy)) occupied[i] = 1;
    }
  }
}

// Elevation: per cell for the simulation, and a picture for the renderer.
const elevation = await elevationSampler();
const elev = new Int16Array(cols * rows);
for (let r = 0; r < rows; r++) {
  for (let c = 0; c < cols; c++) {
    let sum = 0;
    for (const [dx, dy] of [[0, 0], [-0.3, -0.3], [0.3, -0.3], [-0.3, 0.3], [0.3, 0.3]]) {
      const [lon, lat] = unproject(BOUNDS.x0 + (c + 0.5 + dx) * CELL, BOUNDS.y0 + (r + 0.5 + dy) * CELL);
      sum += elevation(lon, lat);
    }
    elev[r * cols + c] = Math.round(Math.max(-8000, Math.min(8000, sum / 5)));
  }
}

const rgb = new Uint8Array(RELIEF * RELIEF * 3);
for (let py = 0; py < RELIEF; py++) {
  for (let px = 0; px < RELIEF; px++) {
    // Row 0 is the north edge, as an image would have it.
    const x = BOUNDS.x0 + ((px + 0.5) / RELIEF) * (BOUNDS.x1 - BOUNDS.x0);
    const y = BOUNDS.y1 - ((py + 0.5) / RELIEF) * (BOUNDS.y1 - BOUNDS.y0);
    const [lon, lat] = unproject(x, y);
    // Land height in red and sea depth in green, each on a square-root scale:
    // the difference between 50 m and 300 m matters to the eye far more than
    // the difference between 3,000 m and 3,250 m, and eight bits a channel
    // compresses to a fraction of sixteen.
    const e = elevation(lon, lat);
    const i = (py * RELIEF + px) * 3;
    rgb[i] = Math.round(Math.sqrt(Math.min(1, Math.max(0, e) / RELIEF_TOP)) * 255);
    rgb[i + 1] = Math.round(Math.sqrt(Math.min(1, Math.max(0, -e) / RELIEF_DEEP)) * 255);
    rgb[i + 2] = 0;
  }
}
mkdirSync(path.join(ROOT, 'assets'), { recursive: true });
writePng(path.join(ROOT, 'assets', 'relief.png'), RELIEF, RELIEF, rgb);

// Out. Outlines are simplified and rounded to whole kilometres; the grid and the
// heights travel as base64, which both a browser and Node can read back.
const round = (ring) => simplify(ring, SIMPLIFY).map((v) => Math.round(v));
const outShapes = [];
for (const [index, outer, ...holes] of shapes) {
  const o = round(outer);
  if (o.length < 6 || Math.abs(ringArea(o)) < 40) continue;
  outShapes.push([index, o, ...holes.map(round).filter((h) => h.length >= 6)]);
}
const outLakes = lakes.map(round).filter((r) => r.length >= 6);
const b64 = (bytes) => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString('base64');

const body = `// Generated by tools/build-map.js from Natural Earth and Terrarium elevation.
// Do not edit by hand: change the script and run it again.
export default ${JSON.stringify({
  cell: CELL,
  x0: BOUNDS.x0,
  y0: BOUNDS.y0,
  cols,
  rows,
  countries,
  grid: b64(grid),
  occupied: b64(occupied),
  elev: b64(elev),
  shapes: outShapes,
  lakes: outLakes,
})};
`;
writeFileSync(path.join(ROOT, 'src', 'game', 'data', 'europe.js'), body);

const land = grid.reduce((n, v) => n + (v >= 2), 0);
console.log(`${countries.length} countries, ${outShapes.length} shapes, ${outLakes.length} lakes`);
console.log(`grid ${cols}×${rows}, ${land} land cells, ${occupied.reduce((a, b) => a + b, 0)} occupied`);
console.log(`europe.js ${(body.length / 1024).toFixed(0)} KB`);
