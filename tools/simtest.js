// The war, played headless: checks that it runs, that it is the same war every
// time from the same seed, and that it can be won - and lost.
//
//   node tools/simtest.js            # the checks
//   node tools/simtest.js --report   # and the numbers, per difficulty
//
// The player here is a bot with simple habits: before each wave it reads where
// the wave is going, puts something in the way near each target - armour for
// columns, a frigate for a fleet, a fighter for drones and missiles - and spends
// what is left on upgrades. It is not good. If it can win on the easy setting,
// a person can win on the middle one.

import { Sim, CITY_BY_KEY } from '../src/game/sim.js';
import { WAVES, DIFFICULTIES } from '../src/game/waves.js';
import { NATO, RU } from '../src/game/units.js';
import { cellAt, cx, cy, nearest, terrain, origin, LAND, FRIEND, CITIES } from '../src/game/map.js';
import { seaCost } from '../src/game/flow.js';

const report = process.argv.includes('--report');
let failed = 0;
const check = (ok, what) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

// --- the bot ---------------------------------------------------------------------------

function spot(sim, kind, x, y) {
  const def = NATO[kind];
  const c = cellAt(x, y);
  if (c < 0) return null;
  const j = def.layer === 'sea'
    ? nearest(c, 8, (k) => seaCost[k] !== Infinity && !sim.canBuild(kind, cx(k), cy(k)))
    : nearest(c, 8, (k) => terrain[k] === LAND && origin[k] === FRIEND && !sim.canBuild(kind, cx(k), cy(k)));
  if (j < 0) return null;
  return [cx(j) + (sim.random() - 0.5) * 10, cy(j) + (sim.random() - 0.5) * 10];
}

function plan(sim) {
  const w = WAVES[sim.wave];
  if (!w) return;
  const threats = new Map();
  for (const gr of w.groups) {
    const to = CITY_BY_KEY[gr.to], from = CITY_BY_KEY[gr.from];
    const layer = RU[gr.unit].layer;
    const key = `${gr.to}:${layer}`;
    const t = threats.get(key) || { to, from, layer, weight: 0 };
    t.weight += gr.n * (RU[gr.unit].hp / 60);
    threats.set(key, t);
  }
  const list = [...threats.values()].sort((a, b) => b.weight - a.weight);
  for (const t of list) {
    // A point between the target and where the threat comes from, on our side.
    const dx = t.from.x - t.to.x, dy = t.from.y - t.to.y;
    const d = Math.hypot(dx, dy) || 1;
    const k = Math.min(0.5, 90 / d);
    const x = t.to.x + dx * k, y = t.to.y + dy * k;
    const kinds = t.layer === 'air' ? ['jet', 'drone'] : t.layer === 'sea' ? ['ship', 'drone'] : t.weight > 30 ? ['tank', 'tank', 'infantry'] : ['tank', 'infantry'];
    for (const kind of kinds) {
      if (sim.funds < NATO[kind].cost) continue;
      const at = spot(sim, kind, x, y);
      if (at) sim.command({ type: 'build', kind, x: at[0], y: at[1] });
    }
  }
}

function upgrades(sim) {
  const mine = sim.units.filter((u) => u.side === 'nato' && u.level < 2).sort((a, b) => a.level - b.level);
  for (const u of mine) {
    const price = NATO[u.kind].upgrade[u.level];
    if (sim.funds - price < 120) break;
    sim.command({ type: 'upgrade', id: u.id });
  }
}

/** Retake fallen cities: send the nearest ground unit. */
function counter(sim) {
  for (const c of sim.cities) {
    if (c.side !== FRIEND || c.owner === FRIEND) continue;
    let best = null, bd = Infinity;
    for (const u of sim.units) {
      if (u.side !== 'nato' || u.layer !== 'land' || u.path) continue;
      const d = Math.hypot(u.x - c.x, u.y - c.y);
      if (d < bd && d < 400) { bd = d; best = u; }
    }
    if (best && bd > 30) sim.command({ type: 'move', id: best.id, x: c.x, y: c.y });
  }
}

export function play(difficulty, seed, { bot = true, early = false, log = false } = {}) {
  const sim = new Sim({ difficulty, seed });
  if (bot) plan(sim);
  sim.command({ type: 'nextWave' });
  let planned = sim.wave;
  let t = 0;
  while (!sim.over && t < 30 * 60 * 40) {
    sim.step();
    t++;
    if (bot && sim.state === 'between' && planned !== sim.wave) {
      planned = sim.wave;
      if (log) {
        const nato = sim.units.filter((u) => u.side === 'nato');
        console.log(`  after wave ${sim.wave}: funds ${Math.round(sim.funds)} nato ${nato.length} (lv ${nato.map((u) => u.level).join('')}) ru ${sim.units.length - nato.length} `
          + `lost ${sim.stats.lostUnits} kills ${sim.stats.kills} cities ${sim.cities.filter((c) => c.side === FRIEND && c.owner !== FRIEND).map((c) => c.name).join(',')}`);
      }
      plan(sim);
      upgrades(sim);
    }
    if (bot && t % 90 === 0) {
      upgrades(sim);
      counter(sim);
    }
    if (early && sim.state === 'between' && sim.nextWaveIn < 20) sim.command({ type: 'nextWave' });
    sim.events.length = 0;
  }
  return sim;
}

// --- checks ---------------------------------------------------------------------------------

for (const w of WAVES) {
  for (const gr of w.groups) {
    check(CITY_BY_KEY[gr.from] && CITY_BY_KEY[gr.to] && RU[gr.unit], `${w.title}: ${gr.from} -> ${gr.to} (${gr.unit}) are real`);
    const from = CITY_BY_KEY[gr.from];
    if (RU[gr.unit]?.layer === 'sea') check(from.port >= 0 && CITY_BY_KEY[gr.to].port >= 0, `${w.title}: ${gr.from} and ${gr.to} have ports`);
  }
}
check(CITIES.every((c) => c.cell >= 0 && terrain[c.cell] === LAND), 'every city stands on land');

const a = play('veteran', 42);
const b = play('veteran', 42);
check(a.total === b.total && a.wave === b.wave && a.t === b.t, `same seed, same war (${a.total} / ${b.total})`);

const none = play('veteran', 5, { bot: false });
check(none.state === 'lost', `nobody defending loses (wave ${none.wave})`);

const easy = play('recruit', 11);
check(easy.state === 'won', `the bot holds on recruit (${easy.state}, wave ${easy.wave}, losses ${easy.total})`);

if (process.argv.includes('--log')) play(process.argv.includes('--recruit') ? 'recruit' : 'veteran', 101, { log: true });

if (report) {
  console.log('');
  for (const d of DIFFICULTIES) {
    const runs = [1, 2, 3, 4].map((s) => play(d, s * 101));
    const won = runs.filter((s) => s.state === 'won').length;
    const avg = (f) => Math.round(runs.reduce((n, s) => n + f(s), 0) / runs.length);
    console.log(`${d.padEnd(8)} won ${won}/${runs.length}  waves ${avg((s) => s.result().waves)}  losses ${avg((s) => s.total)}  `
      + `held ${avg((s) => s.held() * 100)}%  cities ${avg((s) => s.stats.citiesLost)}  units lost ${avg((s) => s.stats.lostUnits)}  `
      + `built ${avg((s) => s.stats.built)}  kills ${avg((s) => s.stats.kills)}`);
    for (const s of runs) {
      const l = s.losses;
      console.log(`         ${s.state.padEnd(5)} w${s.wave} terr ${Math.round(l.territory)} cities ${Math.round(l.cities)} units ${Math.round(l.units)} strikes ${Math.round(l.strikes)} `
        + `lost: ${s.cities.filter((c) => c.side === FRIEND && c.owner !== FRIEND).map((c) => c.name).join(', ')}`);
    }
  }
}

if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall good');
