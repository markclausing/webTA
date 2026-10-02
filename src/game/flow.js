/**
 * How things find their way across the grid.
 *
 * The swarm does not plan routes one unit at a time: it reads a flow field, a
 * map of the distance from every cell to where it is going, and walks downhill.
 * One field serves every unit with the same destination, however many there
 * are, which is what makes three hundred of them affordable.
 *
 * Your own units are few and go where they are told, so they get A*.
 */

import { N, COLS, ROWS, NEIGHBOURS, terrain, origin, elev, LAND, SEA, FRIEND, HOSTILE, openSea } from './map.js';

/** A binary heap of cell indices keyed by a Float32Array of distances. */
class Heap {
  constructor() {
    this.items = new Int32Array(N * 2);
    this.keys = new Float32Array(N * 2);
    this.size = 0;
  }
  push(i, k) {
    let n = this.size++;
    while (n > 0) {
      const p = (n - 1) >> 1;
      if (this.keys[p] <= k) break;
      this.items[n] = this.items[p];
      this.keys[n] = this.keys[p];
      n = p;
    }
    this.items[n] = i;
    this.keys[n] = k;
  }
  pop() {
    const top = this.items[0];
    const lastI = this.items[--this.size];
    const lastK = this.keys[this.size];
    let n = 0;
    for (;;) {
      let c = n * 2 + 1;
      if (c >= this.size) break;
      if (c + 1 < this.size && this.keys[c + 1] < this.keys[c]) c++;
      if (this.keys[c] >= lastK) break;
      this.items[n] = this.items[c];
      this.keys[n] = this.keys[c];
      n = c;
    }
    this.items[n] = lastI;
    this.keys[n] = lastK;
    return top;
  }
  topKey() {
    return this.keys[0];
  }
}

const heap = new Heap();

/** What a step into a land cell costs: mountains are slow, the rest is not. */
function hill(i) {
  const e = elev[i];
  return e > 1800 ? 5 : e > 1100 ? 2.5 : e > 600 ? 1.4 : 1;
}

/** Ground the other side can drive on: anything Russian or defended. */
export const ruLand = new Float32Array(N);
/** Ground your units may drive on: defended land only - this is not an invasion. */
export const natoLand = new Float32Array(N);
/** Water a ship can sail. */
export const seaCost = new Float32Array(N);

for (let i = 0; i < N; i++) {
  const land = terrain[i] === LAND;
  ruLand[i] = land && (origin[i] === FRIEND || origin[i] === HOSTILE) ? hill(i) : Infinity;
  natoLand[i] = land && origin[i] === FRIEND ? hill(i) : Infinity;
  seaCost[i] = terrain[i] === SEA && openSea[i] ? 1 : Infinity;
}

/**
 * Distance from every cell to the nearest of `sources`, through `cost`.
 * Cells that cannot reach any source stay at Infinity.
 */
export function field(sources, cost) {
  const dist = new Float32Array(N).fill(Infinity);
  heap.size = 0;
  for (const s of sources) {
    if (s < 0) continue;
    dist[s] = 0;
    heap.push(s, 0);
  }
  while (heap.size) {
    const k = heap.topKey();
    const i = heap.pop();
    if (k > dist[i]) continue;
    const c = i % COLS, r = (i / COLS) | 0;
    for (const [dc, dr, len] of NEIGHBOURS) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const j = nr * COLS + nc;
      const step = cost[j];
      if (step === Infinity) continue;
      // No cutting corners between two cells you could not stand on.
      if (len > 1 && (cost[r * COLS + nc] === Infinity || cost[nr * COLS + c] === Infinity)) continue;
      const d = k + step * len;
      if (d < dist[j]) {
        dist[j] = d;
        heap.push(j, d);
      }
    }
  }
  return dist;
}

/**
 * The next cell downhill from i in a field, or -1 at the bottom.
 * `jitter` (0..1) lets a unit take a near-best step now and then, which is the
 * difference between a swarm and a conga line.
 */
export function downhill(dist, i, jitter = 0, cost = null) {
  const c = i % COLS, r = (i / COLS) | 0;
  let best = -1, bd = dist[i];
  for (let k = 0; k < 8; k++) {
    const [dc, dr, len] = NEIGHBOURS[k];
    const nc = c + dc, nr = r + dr;
    if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
    const j = nr * COLS + nc;
    if (cost && len > 1 && (cost[r * COLS + nc] === Infinity || cost[nr * COLS + c] === Infinity)) continue;
    const d = dist[j] + (jitter ? jitter * ((k * 7 + 3) % 5) * 0.05 : 0);
    if (d < bd) { bd = d; best = j; }
  }
  return best;
}

/** A* from a to b through cost; the path as a list of cells, a excluded. Null if none. */
export function path(a, b, cost) {
  if (a < 0 || b < 0 || cost[b] === Infinity) return null;
  if (a === b) return [];
  const g = new Float32Array(N).fill(Infinity);
  const from = new Int32Array(N).fill(-1);
  const bc = b % COLS, br = (b / COLS) | 0;
  const h = (i) => Math.hypot((i % COLS) - bc, ((i / COLS) | 0) - br);
  heap.size = 0;
  g[a] = 0;
  heap.push(a, h(a));
  let steps = 0;
  while (heap.size && steps++ < N) {
    const i = heap.pop();
    if (i === b) break;
    const c = i % COLS, r = (i / COLS) | 0;
    for (const [dc, dr, len] of NEIGHBOURS) {
      const nc = c + dc, nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
      const j = nr * COLS + nc;
      const step = cost[j];
      if (step === Infinity) continue;
      if (len > 1 && (cost[r * COLS + nc] === Infinity || cost[nr * COLS + c] === Infinity)) continue;
      const d = g[i] + step * len;
      if (d < g[j]) {
        g[j] = d;
        from[j] = i;
        heap.push(j, d + h(j));
      }
    }
  }
  if (from[b] < 0) return null;
  const out = [];
  for (let i = b; i !== a; i = from[i]) out.push(i);
  return out.reverse();
}
