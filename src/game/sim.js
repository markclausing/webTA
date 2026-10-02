/**
 * The war: thirty ticks a second, seeded, no DOM. Runs in Node as happily as in
 * a browser, which is how tools/simtest.js plays whole campaigns in seconds.
 *
 * What it keeps track of:
 *
 *   - who holds every cell of the grid, and every city;
 *   - every unit on the map, both sides, and every shell and missile in the air;
 *   - the waves, the money, and the bill.
 *
 * The bill is the score. You start owing nothing, and everything you lose is
 * charged: ground by the cell, cities by the city, your own units at what you
 * paid for them, and every drone or missile that gets through to a city.
 * Ground taken back earns half its charge back. The best war is the cheapest.
 *
 * The renderer reads all of this and changes none of it. It hears about things
 * that happen in a tick (a shot, a hit, a city falling) through `events`, which
 * it drains after each frame.
 */

import {
  N, CELL, X0, Y0, X1, Y1, CITIES, terrain, origin, LAND, FRIEND, HOSTILE,
  cellAt, cx, cy, around, nearest, FRIENDLY_CELLS,
} from './map.js';
import { field, downhill, path, ruLand, natoLand, seaCost } from './flow.js';
import { NATO, RU, invested, upgradeCost } from './units.js';
import { WAVES, DIFFICULTY } from './waves.js';
import { rng } from './rng.js';

export const TICK = 1 / 30;

/** What losing things costs, in points. */
export const PENALTY = {
  cell: 60,         // 625 km² of ground
  cellBack: 30,     // ...of which you get this much back by retaking it
  city: 1500,
  capital: 4000,
  unit: 1.5,        // times what you had spent on it
};

const BREAK = 30;           // seconds between waves
const FINAL_GRACE = 120;    // after the last wave: this long to clear the map
const SELL_BACK = 0.6;
const REACH_LAND = 260;     // km: how far a column looks for its next city
const REACH_MILITIA = 150;  // ...and a city's own militia
const REACH_SEA = 700;

const BUCKET = 64;
const BCOLS = Math.ceil((X1 - X0) / BUCKET);
const BROWS = Math.ceil((Y1 - Y0) / BUCKET);

const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;

export class Sim {
  constructor({ difficulty = 'veteran', seed = 1 } = {}) {
    this.difficulty = DIFFICULTY[difficulty] ? difficulty : 'veteran';
    this.diff = DIFFICULTY[this.difficulty];
    this.random = rng(seed);
    this.t = 0;
    this.tick = 0;

    this.state = 'prep';      // prep, wave, between, final, won, lost
    this.wave = 0;            // waves started so far
    this.waveT = 0;
    this.queue = [];
    this.nextWaveIn = 0;
    this.finalT = 0;

    this.funds = this.diff.funds;
    this.losses = { territory: 0, units: 0, cities: 0, strikes: 0 };
    this.stats = { kills: 0, lostUnits: 0, built: 0, spent: 0, citiesLost: 0, capitalsLost: 0, cellsLost: 0 };

    this.owner = origin.slice();
    this.ownerVersion = 0;
    this.cities = CITIES.map((c) => ({ ...c, owner: c.side, siege: 0, militiaT: 10, militia: 0 }));

    this.units = [];
    this.byId = new Map();
    this.projectiles = [];
    this.events = [];
    this.nextId = 1;

    this.cityFields = new Map();
    this.seaFields = new Map();

    this.head = new Int32Array(BCOLS * BROWS);
    this.link = new Int32Array(4096);
    this.natoZone = new Uint8Array(N);
    this.ruNear = new Uint8Array(N);
    this.controlT = 0;
    this.cityT = 0;
  }

  // --- reading ------------------------------------------------------------

  get total() {
    const l = this.losses;
    return Math.max(0, Math.round(l.territory + l.units + l.cities + l.strikes));
  }

  get over() {
    return this.state === 'won' || this.state === 'lost';
  }

  /** Share of defended ground still held, 0..1. */
  held() {
    let n = 0;
    for (let i = 0; i < N; i++) if (origin[i] === FRIEND && this.owner[i] === FRIEND) n++;
    return n / FRIENDLY_CELLS;
  }

  enemiesAlive() {
    let n = 0;
    for (const u of this.units) if (u.side === 'ru') n++;
    return n;
  }

  /** Where the next wave comes from, for the markers you see before it starts. */
  incoming() {
    const w = WAVES[this.wave];
    if (!w) return [];
    const seen = new Map();
    for (const gr of w.groups) {
      const from = CITY_BY_KEY[gr.from];
      const key = `${gr.from}:${RU[gr.unit].layer}`;
      const e = seen.get(key) || { x: from.x, y: from.y, layer: RU[gr.unit].layer, units: 0, to: new Set() };
      e.units += Math.max(1, Math.round(gr.n * this.diff.count));
      e.to.add(CITY_BY_KEY[gr.to].name);
      seen.set(key, e);
    }
    return [...seen.values()].map((e) => ({ ...e, to: [...e.to] }));
  }

  // --- commands -------------------------------------------------------------

  /** Can a unit of this kind be put down here? Returns '' if so, or why not. */
  canBuild(kind, x, y) {
    const def = NATO[kind];
    if (!def) return 'unknown unit';
    const cell = cellAt(x, y);
    if (cell < 0) return 'off the map';
    if (def.layer === 'land') {
      if (terrain[cell] !== LAND) return 'needs land';
      if (origin[cell] !== FRIEND) return 'not our ground';
      if (this.owner[cell] !== FRIEND) return 'held by the enemy';
      return '';
    }
    if (def.layer === 'sea') {
      if (seaCost[cell] === Infinity) return 'needs open sea';
      return this.nearFriendlyCoast(cell) ? '' : 'too far from our coast';
    }
    // Aircraft take off from our ground and our coastal waters.
    if (terrain[cell] === LAND) {
      if (origin[cell] !== FRIEND || this.owner[cell] !== FRIEND) return 'needs our ground';
      return '';
    }
    return this.nearFriendlyCoast(cell) ? '' : 'too far from our coast';
  }

  nearFriendlyCoast(cell) {
    return nearest(cell, 7, (j) => terrain[j] === LAND && origin[j] === FRIEND && this.owner[j] === FRIEND) >= 0;
  }

  /** Every input from the player goes through here, so a replay or a bot can make the same moves. */
  command(cmd) {
    switch (cmd.type) {
      case 'build': return this.build(cmd.kind, cmd.x, cmd.y);
      case 'upgrade': return this.upgrade(cmd.id);
      case 'sell': return this.sell(cmd.id);
      case 'move': return this.move(cmd.id, cmd.x, cmd.y);
      case 'nextWave': return this.callWave();
      default: return false;
    }
  }

  build(kind, x, y) {
    if (this.over || this.canBuild(kind, x, y)) return false;
    const def = NATO[kind];
    if (this.funds < def.cost) return false;
    this.funds -= def.cost;
    this.stats.built++;
    this.stats.spent += def.cost;
    const u = this.spawnNato(kind, x, y);
    this.events.push({ type: 'deploy', id: u.id, kind, x, y });
    return u;
  }

  upgrade(id) {
    const u = this.byId.get(id);
    if (!u || u.side !== 'nato' || u.level >= 2 || this.over) return false;
    const price = upgradeCost(u.kind, u.level + 1);
    if (this.funds < price) return false;
    this.funds -= price;
    this.stats.spent += price;
    u.level++;
    const lv = NATO[u.kind].levels[u.level];
    u.hp += lv.hp - u.maxHp;
    this.applyLevel(u);
    this.events.push({ type: 'upgrade', id, kind: u.kind, level: u.level, x: u.x, y: u.y });
    return true;
  }

  sell(id) {
    const u = this.byId.get(id);
    if (!u || u.side !== 'nato' || this.over) return false;
    this.funds += Math.round(invested(u.kind, u.level) * SELL_BACK);
    this.remove(u);
    this.events.push({ type: 'sell', id, kind: u.kind, x: u.x, y: u.y });
    return true;
  }

  sellValue(u) {
    return Math.round(invested(u.kind, u.level) * SELL_BACK);
  }

  move(id, x, y) {
    const u = this.byId.get(id);
    if (!u || u.side !== 'nato') return false;
    const to = cellAt(x, y);
    if (to < 0) return false;
    if (u.layer === 'air') {
      u.post = { x, y };
      u.path = null;
      this.events.push({ type: 'order', id, x, y });
      return true;
    }
    const cost = u.layer === 'land' ? natoLand : seaCost;
    if (cost[to] === Infinity) return false;
    const p = path(cellAt(u.x, u.y), to, cost);
    if (!p) return false;
    u.path = p;
    u.pi = 0;
    u.post = { x, y };
    this.events.push({ type: 'order', id, x, y });
    return true;
  }

  callWave() {
    if (this.state === 'prep') {
      this.startWave();
      return true;
    }
    if (this.state === 'between') {
      // Calling it early is worth what the wait would have earned, and a bit.
      const bonus = Math.round(this.nextWaveIn * 3);
      this.funds += bonus;
      this.events.push({ type: 'early', bonus });
      this.startWave();
      return true;
    }
    return false;
  }

  // --- units ------------------------------------------------------------------

  applyLevel(u) {
    const lv = NATO[u.kind].levels[u.level];
    u.maxHp = lv.hp;
    u.armor = lv.armor;
    u.speed = lv.speed;
    u.weapons = lv.weapons;
    while (u.cd.length < u.weapons.length) u.cd.push(this.random() * 0.5);
  }

  newUnit(side, kind, def, x, y) {
    const u = {
      id: this.nextId++,
      side, kind, layer: def.layer,
      x, y, z: def.altitude || 0,
      vx: 0, vy: 0, dir: 0, aim: 0, target: 0,
      hp: 1, maxHp: 1, armor: 0, speed: 0, radius: def.radius,
      weapons: [], cd: [],
      level: 0, born: this.t, hit: -9, cell: cellAt(x, y),
    };
    this.units.push(u);
    this.byId.set(u.id, u);
    return u;
  }

  spawnNato(kind, x, y) {
    const def = NATO[kind];
    const u = this.newUnit('nato', kind, def, x, y);
    this.applyLevel(u);
    u.hp = u.maxHp;
    u.post = { x, y };
    u.path = null;
    u.pi = 0;
    u.orbit = def.orbit || 0;
    u.orbitA = this.random() * Math.PI * 2;
    u.dir = Math.PI / 2;
    return u;
  }

  spawnRu(kind, x, y, to, from) {
    const def = RU[kind];
    const u = this.newUnit('ru', kind, def, x, y);
    u.maxHp = u.hp = def.hp * this.diff.hp;
    u.armor = def.armor;
    u.speed = def.speed * (0.92 + this.random() * 0.16);
    u.weapons = def.weapons;
    u.cd = def.weapons.map(() => this.random());
    u.to = to;
    u.from = from;
    u.next = -1;
    u.retarget = 0;
    // Each unit walks a little to one side of the route, so a column spreads out.
    const a = this.random() * Math.PI * 2;
    const r = (this.random() ** 0.5) * CELL * 0.45;
    u.ox = Math.cos(a) * r;
    u.oy = Math.sin(a) * r;
    u.jit = this.random();
    u.sortie = def.sortie || 0;
    u.landed = false;
    // Facing the way they are going from the start, rather than snapping round.
    const target = this.cities[to];
    u.dir = Math.atan2(target.y - y, target.x - x);
    return u;
  }

  remove(u) {
    const at = this.units.indexOf(u);
    if (at >= 0) this.units.splice(at, 1);
    this.byId.delete(u.id);
    u.dead = true;
  }

  kill(u, by) {
    if (u.dead) return;
    this.remove(u);
    this.events.push({ type: 'death', id: u.id, kind: u.kind, side: u.side, layer: u.layer, x: u.x, y: u.y, z: u.z });
    if (u.side === 'nato') {
      this.losses.units += invested(u.kind, u.level) * PENALTY.unit;
      this.stats.lostUnits++;
    } else {
      if (by === 'nato') {
        this.funds += RU[u.kind].bounty;
        this.stats.kills++;
      }
      if (u.militiaOf != null) this.cities[u.militiaOf].militia--;
    }
  }

  damage(u, amount, ap, by) {
    if (u.dead) return;
    const cut = u.armor * (ap ? 0.35 : 1);
    u.hp -= amount * (1 - cut);
    u.hit = this.t;
    if (u.hp <= 0) this.kill(u, by);
  }

  // --- the clock ----------------------------------------------------------------

  step() {
    if (this.over) return;
    const dt = TICK;
    this.t += dt;
    this.tick++;

    this.runWaves(dt);
    this.bucket();
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (!u || u.dead) continue;
      if (u.side === 'ru') this.thinkRu(u, dt);
      else this.thinkNato(u, dt);
    }
    for (let i = this.units.length - 1; i >= 0; i--) {
      const u = this.units[i];
      if (u && !u.dead) this.fight(u, dt);
    }
    this.flyProjectiles(dt);

    this.controlT -= dt;
    if (this.controlT <= 0) {
      this.controlT = 0.5;
      this.control();
    }
    this.cityT -= dt;
    if (this.cityT <= 0) {
      this.cityT = 0.25;
      this.sieges(0.25);
    }
    this.checkEnd();
  }

  runWaves(dt) {
    if (this.state === 'prep') return;
    this.funds += this.diff.income * dt;
    if (this.state === 'wave') {
      this.waveT += dt;
      while (this.queue.length && this.queue[0].t <= this.waveT) this.spawnFromQueue(this.queue.shift());
      if (!this.queue.length) {
        if (this.wave >= WAVES.length) {
          this.state = 'final';
          this.finalT = FINAL_GRACE;
        } else {
          this.state = 'between';
          this.nextWaveIn = BREAK;
        }
      }
    } else if (this.state === 'between') {
      this.nextWaveIn -= dt;
      if (this.nextWaveIn <= 0) this.startWave();
    } else if (this.state === 'final') {
      this.finalT -= dt;
    }
  }

  startWave() {
    const w = WAVES[this.wave];
    if (!w) return;
    if (this.wave > 0) this.funds += 40 + 8 * this.wave;
    this.wave++;
    this.waveT = 0;
    this.state = 'wave';
    const list = [];
    for (const gr of w.groups) {
      const n = Math.max(1, Math.round(gr.n * this.diff.count));
      for (let k = 0; k < n; k++) {
        list.push({ t: gr.at + k * gr.every * (0.85 + this.random() * 0.3), from: gr.from, unit: gr.unit, to: gr.to });
      }
    }
    list.sort((a, b) => a.t - b.t);
    this.queue = list;
    this.events.push({ type: 'wave', wave: this.wave, title: w.title, brief: w.brief });
  }

  spawnFromQueue(q) {
    const from = CITY_BY_KEY[q.from];
    const to = CITY_BY_KEY[q.to];
    const def = RU[q.unit];
    let x = from.x, y = from.y;
    if (def.layer === 'sea') {
      if (from.port < 0) return;
      x = cx(from.port);
      y = cy(from.port);
    }
    x += (this.random() - 0.5) * CELL * 1.2;
    y += (this.random() - 0.5) * CELL * 1.2;
    if (def.layer === 'land' && ruLand[cellAt(x, y)] === Infinity) { x = from.x; y = from.y; }
    if (def.layer === 'sea' && seaCost[cellAt(x, y)] === Infinity) { x = cx(from.port); y = cy(from.port); }
    this.spawnRu(q.unit, x, y, to.id, from.id);
  }

  // --- the other side's thinking ---------------------------------------------------

  /** Distance field to one city, over land or water, built on first use. */
  cityField(city, sea) {
    const cache = sea ? this.seaFields : this.cityFields;
    let f = cache.get(city.id);
    if (!f) {
      f = sea ? field([city.port], seaCost) : field([city.cell], ruLand);
      cache.set(city.id, f);
    }
    return f;
  }

  /**
   * The field a unit should walk down, or null to dig in where it is.
   *
   * Once its city has fallen a unit looks for the next one, but only nearby: a
   * column that has taken Tartu pushes on to Tallinn, it does not set off for
   * Lisbon. Further than that it holds what it took, and the war spreads the
   * slower way - through the troops every fallen city raises.
   */
  objective(u, sea) {
    let c = this.cities[u.to];
    const done = c.owner !== FRIEND || (sea && (c.port < 0 || u.visited === c.id));
    if (done) {
      c = this.nextTarget(u, sea);
      if (!c) return null;
      u.to = c.id;
    }
    const f = this.cityField(c, sea);
    return f[u.cell] === Infinity ? null : f;
  }

  nextTarget(u, sea) {
    const reach = sea ? REACH_SEA : u.militiaOf != null ? REACH_MILITIA : REACH_LAND;
    let best = null, bd = reach * reach;
    for (const c of this.cities) {
      if (c.side !== FRIEND || c.owner !== FRIEND || (sea && (c.port < 0 || c.id === u.visited))) continue;
      const d = dist2(c.x, c.y, u.x, u.y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  thinkRu(u, dt) {
    const def = RU[u.kind];
    if (u.layer === 'air') return this.flyRu(u, def, dt);

    const sea = u.layer === 'sea';
    const cost = sea ? seaCost : ruLand;
    const cell = cellAt(u.x, u.y);
    if (cell !== u.cell || (u.retarget -= dt) <= 0) {
      u.cell = cell;
      u.retarget = 1;
      const f = this.objective(u, sea);
      u.next = f ? downhill(f, cell, u.jit, cost) : -2;
      if (u.next === -1) {
        // Arrived. A ship puts its troops ashore once, then goes looking for the next port.
        const here = this.nearestCity(u.x, u.y);
        if (sea && def.lands && !u.landed) {
          u.landed = true;
          const beach = nearest(cell, 3, (j) => terrain[j] === LAND && origin[j] !== 0);
          if (beach >= 0) {
            for (let k = 0; k < def.lands; k++) {
              const r = this.spawnRu('rifles', cx(beach) + (this.random() - 0.5) * 20, cy(beach) + (this.random() - 0.5) * 20, here.id, here.id);
              r.cell = beach;
            }
            this.events.push({ type: 'landing', x: cx(beach), y: cy(beach) });
          }
        }
        if (sea) u.visited = u.to;
      }
    }

    // Stand and fight anything in range on the ground or the water.
    if (this.engaged(u, sea ? ['land', 'sea'] : ['land'])) {
      u.vx *= 0.8;
      u.vy *= 0.8;
      this.integrate(u, dt, cost);
      return;
    }

    let tx, ty;
    if (u.next >= 0) {
      tx = cx(u.next) + u.ox;
      ty = cy(u.next) + u.oy;
    } else if (u.next === -1) {
      const c = this.cities[u.to];
      tx = (sea && c.port >= 0 ? cx(c.port) : c.x) + u.ox;
      ty = (sea && c.port >= 0 ? cy(c.port) : c.y) + u.oy;
    } else {
      tx = u.x;
      ty = u.y;
    }
    this.steer(u, tx, ty, u.speed, dt, cost);
  }

  nearestCity(x, y) {
    let best = null, bd = Infinity;
    for (const c of this.cities) {
      const d = dist2(c.x, c.y, x, y);
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  flyRu(u, def, dt) {
    let c = this.cities[u.to];
    if (c.owner !== FRIEND) {
      // Its target is already gone: the nearest one that is not.
      let best = null, bd = Infinity;
      for (const k of this.cities) {
        if (k.side !== FRIEND || k.owner !== FRIEND) continue;
        const d = dist2(k.x, k.y, u.x, u.y);
        if (d < bd) { bd = d; best = k; }
      }
      if (!best) { this.remove(u); return; }
      u.to = best.id;
      c = best;
    }
    if (def.kamikaze) {
      const d = Math.hypot(c.x - u.x, c.y - u.y);
      if (d < 8) return this.detonate(u, def, c);
      return this.steer(u, c.x, c.y, u.speed, dt, null, 2.2);
    }
    // A strike sortie: fly in, circle the target bombing whatever is there, go home.
    const home = this.cities[u.from];
    if (u.sortie > 0) {
      const d = Math.hypot(c.x - u.x, c.y - u.y);
      if (d < 90) u.sortie -= dt;
      const a = Math.atan2(u.y - c.y, u.x - c.x) + 0.6;
      this.steer(u, c.x + Math.cos(a) * 55, c.y + Math.sin(a) * 55, u.speed, dt, null, 1.4);
    } else {
      if (Math.hypot(home.x - u.x, home.y - u.y) < 30) { this.remove(u); return; }
      this.steer(u, home.x, home.y, u.speed, dt, null, 1.4);
    }
  }

  detonate(u, def, city) {
    const k = def.kamikaze;
    this.splash(u.x, u.y, k.splash, k.dmg, ['land', 'sea'], 'ru', true);
    if (city.owner === FRIEND) {
      this.losses.strikes += k.strike * (city.capital ? 1.4 : 1);
      this.events.push({ type: 'strike', city: city.id, x: u.x, y: u.y, kind: u.kind });
    }
    this.events.push({ type: 'impact', kind: u.kind === 'iskander' ? 'big' : 'kamikaze', x: u.x, y: u.y, z: 0 });
    this.remove(u);
  }

  // --- your side's thinking ---------------------------------------------------------

  thinkNato(u, dt) {
    if (u.layer === 'air') {
      const dx = u.post.x - u.x, dy = u.post.y - u.y;
      const d = Math.hypot(dx, dy);
      if (d > u.orbit + 25) {
        this.steer(u, u.post.x, u.post.y, u.speed, dt, null, 2);
      } else {
        u.orbitA += (u.speed / Math.max(20, u.orbit)) * dt * 0.55;
        const tx = u.post.x + Math.cos(u.orbitA) * u.orbit;
        const ty = u.post.y + Math.sin(u.orbitA) * u.orbit;
        this.steer(u, tx, ty, u.speed * 0.7, dt, null, 2.4);
      }
      return;
    }
    const cost = u.layer === 'land' ? natoLand : seaCost;
    if (u.path) {
      const last = u.pi >= u.path.length - 1;
      const c = u.path[Math.min(u.pi, u.path.length - 1)];
      const tx = last ? u.post.x : cx(c), ty = last ? u.post.y : cy(c);
      if (Math.hypot(tx - u.x, ty - u.y) < (last ? 3 : CELL * 0.6)) {
        if (last) u.path = null;
        else u.pi++;
      }
      this.steer(u, tx, ty, u.speed, dt, cost);
    } else {
      const d = Math.hypot(u.post.x - u.x, u.post.y - u.y);
      if (d > 10) this.steer(u, u.post.x, u.post.y, u.speed * 0.6, dt, cost);
      else {
        u.vx *= 0.85;
        u.vy *= 0.85;
        this.integrate(u, dt, cost);
      }
    }
  }

  // --- movement -----------------------------------------------------------------------

  steer(u, tx, ty, speed, dt, cost, turn = 3.5) {
    const dx = tx - u.x, dy = ty - u.y;
    const d = Math.hypot(dx, dy) || 1;
    let s = speed;
    if (u.layer === 'land') {
      const e = cost ? cost[cellAt(u.x, u.y)] : 1;
      if (e > 1 && e !== Infinity) s /= Math.sqrt(e);
    }
    if (u.layer !== 'air' && d < 12) s *= d / 12;
    const want = Math.atan2(dy, dx);
    if (u.layer === 'air') {
      // Aircraft fly the way they face and turn at a rate, which is what makes them bank.
      let da = want - u.dir;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      u.dir += Math.max(-turn * dt, Math.min(turn * dt, da));
      u.vx = Math.cos(u.dir) * s;
      u.vy = Math.sin(u.dir) * s;
      u.bank = Math.max(-1, Math.min(1, da * 2));
      u.x += u.vx * dt;
      u.y += u.vy * dt;
      return;
    }
    const k = Math.min(1, dt * 4);
    u.vx += ((dx / d) * s - u.vx) * k;
    u.vy += ((dy / d) * s - u.vy) * k;
    this.integrate(u, dt, cost);
  }

  integrate(u, dt, cost) {
    // Keep out of each other's way: ground units and ships push apart.
    let px = 0, py = 0;
    this.query(u.x, u.y, u.radius * 2, (o) => {
      if (o === u || o.layer !== u.layer) return;
      const dx = u.x - o.x, dy = u.y - o.y;
      const want = (u.radius + o.radius) * 0.75;
      const d2 = dx * dx + dy * dy;
      if (d2 >= want * want) return;
      const d = Math.sqrt(d2) || 0.01;
      const push = (want - d) / want;
      px += (dx / d) * push;
      py += (dy / d) * push;
    });
    let nx = u.x + (u.vx + px * 12) * dt;
    let ny = u.y + (u.vy + py * 12) * dt;
    if (cost) {
      // Slide along a coast or a border rather than through it.
      if (cost[cellAt(nx, ny)] === Infinity) {
        if (cost[cellAt(nx, u.y)] !== Infinity) ny = u.y;
        else if (cost[cellAt(u.x, ny)] !== Infinity) nx = u.x;
        else { nx = u.x; ny = u.y; }
      }
    }
    u.x = nx;
    u.y = ny;
    const sp = Math.hypot(u.vx, u.vy);
    if (sp > 0.5) {
      let da = Math.atan2(u.vy, u.vx) - u.dir;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      u.dir += da * Math.min(1, dt * 6);
    }
  }

  // --- the spatial index --------------------------------------------------------------

  bucket() {
    this.head.fill(-1);
    if (this.link.length < this.units.length) this.link = new Int32Array(this.units.length * 2);
    for (let i = 0; i < this.units.length; i++) {
      const u = this.units[i];
      const b = this.bucketOf(u.x, u.y);
      this.link[i] = this.head[b];
      this.head[b] = i;
    }
    this.indexed = this.units.slice();
  }

  bucketOf(x, y) {
    const c = Math.max(0, Math.min(BCOLS - 1, Math.floor((x - X0) / BUCKET)));
    const r = Math.max(0, Math.min(BROWS - 1, Math.floor((y - Y0) / BUCKET)));
    return r * BCOLS + c;
  }

  query(x, y, r, fn) {
    const c0 = Math.max(0, Math.floor((x - r - X0) / BUCKET)), c1 = Math.min(BCOLS - 1, Math.floor((x + r - X0) / BUCKET));
    const r0 = Math.max(0, Math.floor((y - r - Y0) / BUCKET)), r1 = Math.min(BROWS - 1, Math.floor((y + r - Y0) / BUCKET));
    const list = this.indexed;
    for (let br = r0; br <= r1; br++) {
      for (let bc = c0; bc <= c1; bc++) {
        for (let i = this.head[br * BCOLS + bc]; i >= 0; i = this.link[i]) {
          const o = list[i];
          if (!o.dead) fn(o);
        }
      }
    }
  }

  // --- fighting ------------------------------------------------------------------------

  /** The nearest enemy in reach of a weapon, or null. Sticks with the current target while it lasts. */
  pick(u, w) {
    const r = w.range;
    const cur = u.target && this.byId.get(u.target);
    if (cur && cur.side !== u.side && w.targets.includes(cur.layer)
      && dist2(cur.x, cur.y, u.x, u.y) <= (r + cur.radius) ** 2) return cur;
    let best = null, bd = Infinity;
    this.query(u.x, u.y, r + 16, (o) => {
      if (o.side === u.side || !w.targets.includes(o.layer)) return;
      const d = dist2(o.x, o.y, u.x, u.y);
      if (d <= (r + o.radius) ** 2 && d < bd) { bd = d; best = o; }
    });
    return best;
  }

  /** Is there anything on these layers to shoot at right now? */
  engaged(u, layers) {
    for (const w of u.weapons) {
      if (!w.targets.some((l) => layers.includes(l))) continue;
      const t = this.pick(u, w);
      if (t && layers.includes(t.layer)) return true;
    }
    return false;
  }

  fight(u, dt) {
    let aimed = false;
    for (let k = 0; k < u.weapons.length; k++) {
      u.cd[k] -= dt;
      const w = u.weapons[k];
      const t = this.pick(u, w);
      if (!t) continue;
      if (!aimed) {
        u.aim = Math.atan2(t.y - u.y, t.x - u.x);
        u.target = t.id;
        aimed = true;
      }
      if (u.cd[k] > 0) continue;
      u.cd[k] = w.rate * (0.9 + this.random() * 0.2);
      this.fire(u, t, w, k);
    }
    if (!aimed) u.target = 0;
  }

  fire(u, t, w, slot) {
    const d = Math.hypot(t.x - u.x, t.y - u.y);
    const p = {
      id: this.nextId++,
      kind: w.kind, side: u.side, from: u.id, shooter: u.kind, slot,
      target: t.id, layer: t.layer,
      sx: u.x, sy: u.y, sz: u.z,
      x: u.x, y: u.y, z: u.z,
      tx: t.x, ty: t.y, tz: t.z,
      t: 0, dur: Math.max(0.08, d / w.speed),
      dmg: w.dmg, splash: w.splash, ap: w.ap, targets: w.targets,
    };
    this.projectiles.push(p);
    this.events.push({ type: 'shot', kind: w.kind, side: u.side, shooter: u.kind, id: u.id, x: u.x, y: u.y, z: u.z, aim: u.aim });
  }

  flyProjectiles(dt) {
    const keep = [];
    for (const p of this.projectiles) {
      p.t += dt;
      const t = this.byId.get(p.target);
      if (t && p.kind !== 'bomb') {
        p.tx = t.x;
        p.ty = t.y;
        p.tz = t.z;
      }
      const f = Math.min(1, p.t / p.dur);
      p.x = p.sx + (p.tx - p.sx) * f;
      p.y = p.sy + (p.ty - p.sy) * f;
      p.z = p.sz + (p.tz - p.sz) * f;
      if (f < 1) {
        keep.push(p);
        continue;
      }
      if (p.splash > 0) this.splash(p.tx, p.ty, p.splash, p.dmg, p.targets, p.side, p.ap, t);
      else if (t) this.damage(t, p.dmg, p.ap, p.side);
      this.events.push({ type: 'impact', kind: p.kind, x: p.tx, y: p.ty, z: p.tz, layer: p.layer, side: p.side });
    }
    this.projectiles = keep;
  }

  /** Area damage: full at the middle, half at the edge, the aimed-at target always full. */
  splash(x, y, r, dmg, layers, side, ap, direct = null) {
    if (direct && !direct.dead) this.damage(direct, dmg, ap, side);
    this.query(x, y, r + 16, (o) => {
      if (o === direct || o.side === side || !layers.includes(o.layer)) return;
      const d = Math.hypot(o.x - x, o.y - y);
      if (d > r + o.radius) return;
      this.damage(o, dmg * (1 - 0.5 * Math.min(1, d / r)), ap, side);
    });
  }

  // --- ground ----------------------------------------------------------------------------

  /**
   * Who holds what. Every half second: the enemy's ground units take the cells
   * they stand on and next to, unless one of your ground units is close enough to
   * contest them; yours take back captured ground the same way, if nothing of
   * theirs is near.
   */
  control() {
    const zone = this.natoZone, near = this.ruNear;
    zone.fill(0);
    near.fill(0);
    for (const u of this.units) {
      if (u.layer !== 'land') continue;
      const c = cellAt(u.x, u.y);
      if (c < 0) continue;
      if (u.side === 'nato') around(c, 2, (j) => { zone[j] = 1; });
      else around(c, 2, (j) => { near[j] = 1; });
    }
    let changed = false;
    for (const u of this.units) {
      if (u.layer !== 'land') continue;
      const c = cellAt(u.x, u.y);
      if (c < 0) continue;
      if (u.side === 'ru') {
        around(c, 1, (j) => {
          if (this.owner[j] === FRIEND && origin[j] === FRIEND && !zone[j]) {
            this.owner[j] = HOSTILE;
            this.losses.territory += PENALTY.cell;
            this.stats.cellsLost++;
            changed = true;
          }
        });
      } else if (NATO[u.kind].retakes) {
        around(c, 1, (j) => {
          if (this.owner[j] === HOSTILE && origin[j] === FRIEND && !near[j]) {
            this.owner[j] = FRIEND;
            this.losses.territory -= PENALTY.cellBack;
            changed = true;
          }
        });
      }
    }
    if (changed) this.ownerVersion++;
  }

  /** Cities: besieged by the enemy's ground units, defended by yours, and taken back the same way. */
  sieges(dt) {
    for (const c of this.cities) {
      if (c.side !== FRIEND) continue;
      let ru = 0, nato = 0;
      this.query(c.x, c.y, 50, (o) => {
        if (o.layer !== 'land') return;
        const d = Math.hypot(o.x - c.x, o.y - c.y);
        if (o.side === 'ru' && d < 32) ru++;
        if (o.side === 'nato' && d < 48) nato++;
      });
      if (c.owner === FRIEND) {
        if (ru && !nato) {
          c.siege += dt * (0.03 + 0.012 * Math.min(ru, 10));
          if (c.siege >= 1) this.fall(c);
        } else {
          c.siege = Math.max(0, c.siege - dt * 0.12);
        }
      } else {
        if (nato && !ru) {
          c.siege += dt * (0.08 + 0.03 * Math.min(nato, 5));
          if (c.siege >= 1) this.free(c);
        } else {
          c.siege = Math.max(0, c.siege - dt * 0.1);
        }
        this.militia(c, dt);
      }
    }
  }

  fall(c) {
    c.owner = HOSTILE;
    c.siege = 0;
    c.militiaT = 12;
    this.losses.cities += c.capital ? PENALTY.capital : PENALTY.city;
    this.stats.citiesLost++;
    if (c.capital) this.stats.capitalsLost++;
    around(c.cell, 2, (j) => {
      if (this.owner[j] === FRIEND && origin[j] === FRIEND) {
        this.owner[j] = HOSTILE;
        this.losses.territory += PENALTY.cell;
        this.stats.cellsLost++;
      }
    });
    this.ownerVersion++;
    this.events.push({ type: 'cityFell', city: c.id, name: c.name, capital: c.capital, x: c.x, y: c.y });
  }

  free(c) {
    c.owner = FRIEND;
    c.siege = 0;
    const charge = c.capital ? PENALTY.capital : PENALTY.city;
    this.losses.cities -= charge / 2;
    this.stats.citiesLost--;
    if (c.capital) this.stats.capitalsLost--;
    this.events.push({ type: 'cityFreed', city: c.id, name: c.name, capital: c.capital, x: c.x, y: c.y });
  }

  /** A captured city raises troops of its own: left alone, the swarm grows from inside. */
  militia(c, dt) {
    if (this.state !== 'wave' && this.state !== 'between') return;
    c.militiaT -= dt;
    if (c.militiaT > 0) return;
    c.militiaT = 20;
    if (c.militia >= 4) return;
    for (let k = 0; k < 2; k++) {
      const u = this.spawnRu('rifles', c.x + (this.random() - 0.5) * 20, c.y + (this.random() - 0.5) * 20, c.id, c.id);
      u.militiaOf = c.id;
      c.militia++;
    }
  }

  checkEnd() {
    if (this.stats.capitalsLost >= this.diff.capitalsToLose) {
      this.state = 'lost';
      this.events.push({ type: 'lost' });
      return;
    }
    if (this.state === 'final' && (this.enemiesAlive() === 0 || this.finalT <= 0)) {
      // Whatever is still standing when the clock runs out goes home; whatever it
      // took stays taken, and stays on the bill.
      this.state = 'won';
      this.events.push({ type: 'won' });
    }
  }

  /** The result, in the shape the score board wants. */
  result() {
    return {
      won: this.state === 'won',
      waves: this.state === 'won' ? WAVES.length : Math.max(0, this.wave - 1),
      losses: this.total,
      held: Math.round(this.held() * 1000) / 10,
      kills: this.stats.kills,
      lostUnits: this.stats.lostUnits,
      citiesLost: this.stats.citiesLost,
    };
  }
}

const CITY_BY_KEY = Object.fromEntries(CITIES.map((c) => [c.key, c]));
export { CITY_BY_KEY };
