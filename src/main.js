/**
 * Article 5: the page.
 *
 * Owns the loop and everything that is not the war or the picture: the menu,
 * input, the HUD, sound, and the score board. The simulation steps at a fixed
 * thirty a second; the picture draws as often as the screen wants, sliding
 * every unit between its last two positions, so a 120 Hz phone sees 120 smooth
 * frames of the same thirty-tick war.
 */

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { Renderer, guessQuality, QUALITY_ORDER } from './render/renderer.js';
import { Terrain } from './render/terrain.js';
import { UnitView } from './render/unitview.js';
import { Fx } from './render/fx.js';
import { CameraRig } from './render/camera.js';
import { Sim, TICK, PENALTY } from './game/sim.js';
import { NATO, NATO_ORDER, RU } from './game/units.js';
import { WAVES, DIFFICULTY } from './game/waves.js';
import { CITIES, COUNTRIES, country, terrain as cellTerrain, origin, N, LAND, FRIEND } from './game/map.js';
import { project as lonlat } from './game/proj.js';
import { Input } from './input.js';
import { Audio } from './audio.js';
import { Ui, ICONS, upgradeLabel, upgradeCost } from './ui.js';
import { Highscores, makeId, placeOf, levelOf } from './highscores.js';
import { boardFor } from './config.js';

const $ = (id) => document.getElementById(id);

// --- settings ---------------------------------------------------------------------

const SETTINGS_KEY = 'webta.settings.v1';
const settings = { difficulty: 'veteran', quality: 'auto', sound: true, seenHelp: false, ...readSettings() };
function readSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
  } catch {
    return {};
  }
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch { /* private mode */ }
}
const params = new URLSearchParams(location.search);

// --- the machinery ------------------------------------------------------------------

const audio = new Audio();
audio.setEnabled(settings.sound);
const ui = new Ui();
const highscores = new Highscores();
const BOARD = boardFor(location);

let renderer, scene, terrainView, units, fx, rig, sun;
let sim = null;
let mode = 'loading'; // loading, menu, play, paused, over
let acc = 0;
let speed = 1;
let selected = 0;
let placing = null;
let moving = false;
let lastOwner = -1;
let incomingFor = -1;
let incomingList = [];
let lastResult = null;
let rangeRing, ghostRing;

const outside = new Uint8Array(N);
const isLand = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  isLand[i] = cellTerrain[i] === LAND ? 1 : 0;
  outside[i] = cellTerrain[i] === LAND && COUNTRIES[country[i]].role === 'outside' ? 1 : 0;
}

// --- boot ------------------------------------------------------------------------------

async function boot() {
  const quality = params.get('quality') || (settings.quality === 'auto' ? guessQuality() : settings.quality);
  renderer = new Renderer($('view'), quality);
  renderer.autoAdjust = settings.quality === 'auto' && !params.get('quality');
  scene = renderer.scene;
  const sky = new THREE.Color('#9fbfd4');
  scene.background = sky;
  scene.fog = new THREE.Fog(sky, 3000, 9000);

  const pmrem = new THREE.PMREMGenerator(renderer.renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.35;

  sun = new THREE.DirectionalLight(0xfff1dc, 3.0);
  sun.castShadow = renderer.q.shadow > 0;
  sun.shadow.mapSize.set(renderer.q.shadow || 512, renderer.q.shadow || 512);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.6;
  scene.add(sun, sun.target);
  scene.add(new THREE.HemisphereLight(0xcfe4ff, 0x5a5038, 0.9));

  rig = new CameraRig(renderer.camera);
  terrainView = new Terrain(scene, renderer.q);
  $('loadingText').textContent = 'SURVEYING EUROPE';
  await terrainView.build('assets/relief.png');
  terrainView.uniforms.uSun.value.copy(new THREE.Vector3(-0.45, 0.75, 0.5).normalize());
  units = new UnitView(scene, terrainView);
  fx = new Fx(scene, terrainView, renderer.q);

  // Range circles: the selected unit's reach, and where a new one would go.
  const ringGeo = new THREE.RingGeometry(0.97, 1, 96);
  ringGeo.rotateX(-Math.PI / 2);
  const discGeo = new THREE.CircleGeometry(1, 96);
  discGeo.rotateX(-Math.PI / 2);
  const mkRange = (color) => {
    const g = new THREE.Group();
    const line = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }));
    const fill = new THREE.Mesh(discGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false, toneMapped: false }));
    g.add(line, fill);
    g.renderOrder = 3;
    line.renderOrder = fill.renderOrder = 3;
    g.visible = false;
    g.setColor = (c) => { line.material.color.set(c); fill.material.color.set(c); };
    scene.add(g);
    return g;
  };
  rangeRing = mkRange(0xffe066);
  ghostRing = mkRange(0x5fd17a);

  ui.makeCityLabels(CITIES);
  ui.makeBuildBar((kind) => startPlacing(kind));
  new Input($('view'), {
    pan: (dx, dy) => {
      const k = rig.dist / innerHeight * (renderer.camera.aspect < 1 ? 1.6 : 1.25);
      rig.pan(-dx * k, dy * k);
    },
    zoom: (f, px, py) => {
      const p = rig.pick(px, py, innerWidth, innerHeight);
      rig.zoom(f, p?.x, p?.y);
    },
    fling: (vx, vy) => {
      const k = rig.dist / innerHeight * 1.25;
      rig.fling(-vx * k, vy * k);
    },
    press: () => audio.unlock(),
    tap: (x, y) => tap(x, y),
    order: (x, y) => order(x, y),
    hover: (x, y) => hover(x, y),
    key: (e) => key(e),
  });
  addEventListener('resize', () => renderer.resize());
  wireMenus();

  // A war already under way behind the title: nobody defending, so you can
  // watch what happens when nobody does.
  demo();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) pause();
  });
  const [bx, by] = lonlat(24, 56.5);
  rig.flyTo(bx, by, 1700);
  rig.x = bx; rig.y = by;
  mode = 'menu';
  showMenu();
  $('loading').classList.add('hidden');
  requestAnimationFrame(frame);

  window.__ready = true;
  window.webta = { lonlat, startGame, terrainView, THREE, get sim() { return sim; }, rig, renderer, setSpeed: (s) => { speed = s; } };
}

// --- the loop ---------------------------------------------------------------------------

let lastT = performance.now();
function frame(now) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;

  if (mode === 'play' || mode === 'menu') {
    const pace = mode === 'menu' ? 1 : speed;
    acc += dt * pace;
    let steps = 0;
    while (acc >= TICK && steps < 12) {
      for (const u of sim.units) {
        u.px = u.x;
        u.py = u.y;
        u.pdir = u.dir;
      }
      sim.step();
      if (mode === 'menu' && sim.state === 'between') sim.command({ type: 'nextWave' });
      drain();
      acc -= TICK;
      steps++;
    }
    if (steps >= 12) acc = 0;
    if (mode === 'play' && sim.over) gameOver();
    if (mode === 'menu' && sim.over) demo();
  }
  const alpha = Math.min(1, acc / TICK);

  // Keyboard panning.
  if (mode === 'play') keyPan(dt);
  if (mode === 'menu') rig.pan(dt * 18, dt * 4);

  rig.update(dt, fx.shake * 0.6);
  audio.listener = { x: rig.x, y: rig.y, dist: rig.dist };
  updateSun();
  renderer.setTilt(THREE.MathUtils.clamp(1.1 - rig.dist / 2600, 0.15, 0.9));
  scene.fog.near = rig.dist * 1.3;
  scene.fog.far = rig.dist * 4.2;

  if (sim.ownerVersion !== lastOwner) {
    lastOwner = sim.ownerVersion;
    terrainView.updateOwners(sim.owner, origin, outside, isLand);
  }
  terrainView.update(dt, rig.dist);
  const sel = sim.byId.get(selected);
  if (selected && !sel) deselect();
  units.update(sim, alpha, dt, renderer.camera, selected);
  fx.update(dt, sim, alpha, renderer.camera, renderer.renderer.domElement.height);
  updateRanges(alpha);

  if (mode === 'play' || mode === 'paused') {
    ui.hud(sim, speed);
    if (sel) ui.unitCard(sel, sim);
    if (incomingFor !== sim.wave || (sim.state !== 'prep' && sim.state !== 'between')) {
      incomingFor = sim.wave;
      incomingList = sim.state === 'prep' || sim.state === 'between' ? sim.incoming() : [];
    }
    ui.incoming(incomingList, screenOf, () => callWave());
    if (ui.radialOpen && ui.radialAnchor) {
      const p = screenOf(ui.radialAnchor.x, ui.radialAnchor.y, ui.radialAnchor.h || 0);
      if (p) {
        $('radial').style.left = `${p.x}px`;
        $('radial').style.top = `${p.y}px`;
      }
    }
  } else {
    ui.incoming([], screenOf, () => {});
  }
  ui.cityLabels(sim, screenOf, rig.dist);
  renderer.render(dt);
}

function updateSun() {
  const tx = rig.x, tz = -rig.y;
  const dir = terrainView.uniforms.uSun.value;
  const reach = rig.dist * 1.2;
  sun.target.position.set(tx, 0, tz);
  sun.position.set(tx + dir.x * 3000, dir.y * 3000, tz + dir.z * 3000);
  const cam = sun.shadow.camera;
  cam.left = -reach;
  cam.right = reach;
  cam.top = reach;
  cam.bottom = -reach;
  cam.near = 100;
  cam.far = 6000;
  cam.updateProjectionMatrix();
}

/** A map point to screen pixels, or null if it is behind the camera or off screen. */
const _v = new THREE.Vector3();
function screenOf(x, y, h = 0) {
  _v.set(x, terrainView.groundAt(x, y) + h, -y).project(renderer.camera);
  if (_v.z > 1) return null;
  const sx = (_v.x * 0.5 + 0.5) * innerWidth;
  const sy = (-_v.y * 0.5 + 0.5) * innerHeight;
  if (sx < -60 || sy < -60 || sx > innerWidth + 60 || sy > innerHeight + 60) return null;
  return { x: sx, y: sy };
}

// --- what the war says -----------------------------------------------------------------

function drain() {
  const evs = sim.events;
  sim.events = [];
  for (const ev of evs) {
    fx.event(ev, units, sim);
    if (mode !== 'play') continue;
    switch (ev.type) {
      case 'shot':
        audio.shot(ev.kind, ev.x, ev.y);
        if (ev.shooter === 'jet' || ev.shooter === 'su34') audio.jet(ev.x, ev.y);
        break;
      case 'impact': {
        const size = { bullet: 0, shell: 4, missile: 4, sam: 3, bomb: 8, cruise: 10, kamikaze: 9, big: 18 }[ev.kind] ?? 4;
        if (size) audio.boom(size, ev.x, ev.y);
        if (ev.kind === 'big') renderer.flash = Math.max(renderer.flash, 0.25 * audio.near(ev.x, ev.y));
        break;
      }
      case 'death':
        if (ev.side === 'nato') {
          const cost = Math.round(lossOf(ev));
          floatAt(ev.x, ev.y, `−${cost.toLocaleString('en-US')}`);
          feed(`<b>${NATO[ev.kind].name}</b> lost`, 'bad', ev.x, ev.y);
        }
        audio.boom(ev.layer === 'land' && (ev.kind === 'rifles' || ev.kind === 'infantry') ? 2 : 7, ev.x, ev.y);
        break;
      case 'deploy':
        audio.deploy();
        break;
      case 'upgrade':
        audio.upgrade();
        break;
      case 'sell':
        audio.coin();
        break;
      case 'wave': {
        audio.siren();
        ui.banner(`WAVE ${ev.wave} OF ${WAVES.length}`, ev.title.toUpperCase(), ev.brief, '', 4200);
        feed(`Wave ${ev.wave}: <b>${ev.title}</b>`, 'bad');
        break;
      }
      case 'early':
        if (ev.bonus > 0) feed(`Called early: <b>+€${ev.bonus}M</b>`, 'gold');
        audio.coin();
        break;
      case 'cityFell': {
        const charge = ev.capital ? PENALTY.capital : PENALTY.city;
        audio.bell();
        renderer.alarm = 1;
        floatAt(ev.x, ev.y, `−${charge.toLocaleString('en-US')}`);
        feed(`<b>${ev.name}</b> has fallen`, 'bad', ev.x, ev.y, 8000);
        if (ev.capital) ui.banner('CAPITAL LOST', ev.name.toUpperCase(), `${sim.stats.capitalsLost} of ${sim.diff.capitalsToLose} - lose them all and the war is over.`, 'bad', 3200);
        terrainView.setCityOwner(ev.city, 2);
        break;
      }
      case 'cityFreed':
        audio.fanfare(true);
        floatAt(ev.x, ev.y, 'LIBERATED', 'good');
        feed(`<b>${ev.name}</b> liberated`, 'good', ev.x, ev.y);
        terrainView.setCityOwner(ev.city, 1);
        break;
      case 'strike': {
        const def = RU[ev.kind];
        floatAt(ev.x, ev.y, `−${Math.round(def.kamikaze.strike * (CITIES[ev.city].capital ? 1.4 : 1))}`);
        if (ev.kind === 'iskander') feed(`Missile strike on <b>${CITIES[ev.city].name}</b>`, 'bad', ev.x, ev.y);
        break;
      }
      case 'landing':
        feed('Enemy troops <b>landing</b> on the coast', 'bad', ev.x, ev.y);
        break;
      default:
    }
  }
}

function lossOf(ev) {
  const def = NATO[ev.kind];
  return def ? def.cost * PENALTY.unit : 0;
}

function floatAt(x, y, text, tone = '') {
  const p = screenOf(x, y, 25);
  if (p) ui.float(text, p.x, p.y, tone);
}

function feed(html, tone, x, y, ms) {
  ui.feed(html, tone, ms);
  const el = $('feed').firstChild;
  if (x != null && el) {
    el.style.pointerEvents = 'auto';
    el.style.cursor = 'pointer';
    el.addEventListener('click', () => rig.flyTo(x, y, Math.min(rig.want.dist, 1100)));
  }
}

// --- the player's hands -------------------------------------------------------------------

function pickAt(px, py) {
  return rig.pick(px, py, innerWidth, innerHeight, (x, y) => terrainView.groundAt(x, y));
}

function tap(px, py) {
  if (mode !== 'play') return;
  audio.unlock();
  if (ui.radialOpen) {
    // A tap anywhere else closes the menu; a tap on another unit of ours selects that instead.
    const was = ui.radialOpen;
    ui.closeRadial();
    const q = pickAt(px, py);
    const other = q && units.pick(sim, q.ray, 1);
    if (other) select(other);
    else if (was === 'unit') deselect();
    return;
  }
  const p = pickAt(px, py);
  if (!p) return;

  if (moving && selected) {
    order(px, py);
    return;
  }
  if (placing) {
    build(placing, p.x, p.y);
    return;
  }
  const u = units.pick(sim, p.ray, 1);
  if (u) {
    select(u);
    return;
  }
  deselect();
  openBuildMenu(px, py, p.x, p.y);
}

function order(px, py) {
  if (mode !== 'play') return;
  const u = sim.byId.get(selected);
  if (!u) return;
  const p = pickAt(px, py);
  if (!p) return;
  if (sim.command({ type: 'move', id: u.id, x: p.x, y: p.y })) {
    fx.ring(p.x, terrainView.groundAt(p.x, p.y) + 0.5, -p.y, 18, 0xffe066, 0.6, 1);
    audio.click();
  } else {
    audio.deny();
    ui.hint(u.layer === 'sea' ? 'Ships stay on open water' : 'Our ground only - this is a defence, not an invasion');
    setTimeout(() => ui.hint(placing ? placingHint(placing) : ''), 1800);
  }
  moving = false;
  ui.hint('');
}

function build(kind, x, y) {
  const why = sim.canBuild(kind, x, y);
  if (why) {
    audio.deny();
    ui.hint(`${NATO[kind].name}: ${why}`);
    return false;
  }
  if (sim.funds < NATO[kind].cost) {
    audio.deny();
    ui.hint(`Not enough budget for a ${NATO[kind].name.toLowerCase()} (€${NATO[kind].cost}M)`);
    return false;
  }
  const u = sim.command({ type: 'build', kind, x, y });
  if (u) {
    stopPlacing();
    firstBuild();
  }
  return Boolean(u);
}

function openBuildMenu(px, py, x, y) {
  const buttons = NATO_ORDER.map((kind) => {
    const def = NATO[kind];
    const why = sim.canBuild(kind, x, y);
    const poor = sim.funds < def.cost;
    return {
      html: ICONS[kind],
      label: def.name.toUpperCase(),
      cost: `€${def.cost}`,
      cls: why ? 'off' : poor ? 'poor' : '',
      title: why ? `${def.name}: ${why}` : def.blurb,
      onTap: () => {
        if (why) {
          audio.deny();
          ui.hint(`${def.name}: ${why}`);
          return;
        }
        if (build(kind, x, y)) ui.closeRadial();
      },
    };
  });
  if (buttons.every((b) => b.cls === 'off')) {
    audio.deny();
    const why = sim.canBuild('infantry', x, y);
    ui.hint(why === 'held by the enemy' ? 'Enemy-held ground: retake it with infantry or tanks first' : 'Nothing can be deployed here');
    setTimeout(() => ui.hint(''), 2200);
    return;
  }
  audio.click();
  ui.radial(px, py, buttons, 'build');
  ui.radialAnchor = { x, y, h: 0 };
  ui.radialOpenWas = 'build';
  showGhost(null);
}

function select(u) {
  selected = u.id;
  moving = false;
  stopPlacing();
  audio.click();
  const def = NATO[u.kind];
  const buttons = [];
  if (u.level < 2) {
    const price = upgradeCost(u.kind, u.level + 1);
    buttons.push({
      html: '<span class="ico">★</span>', label: upgradeLabel(u.kind, u.level), cost: `€${price}`,
      cls: `gold${sim.funds < price ? ' poor' : ''}`, title: 'Upgrade (U)',
      onTap: () => upgrade(),
    });
  }
  buttons.push({
    html: '<span class="ico">➜</span>', label: 'MOVE', title: 'Move (M), or right click the map',
    onTap: () => startMove(),
  });
  buttons.push({
    html: '<span class="ico">€</span>', label: 'STAND DOWN', cost: `+${sim.sellValue(u)}`, cls: 'red',
    title: 'Sell for part of what it cost (X). Not counted as a loss.',
    onTap: () => sell(),
  });
  const p = screenOf(u.x, u.y, 10);
  ui.radial(p ? p.x : innerWidth / 2, p ? p.y : innerHeight / 2, buttons, 'unit');
  ui.radialAnchor = { x: u.x, y: u.y, h: 10 };
  ui.radialOpenWas = 'unit';
  ui.hint(`${def.name}: ${def.blurb.toLowerCase()}`);
}

function deselect() {
  selected = 0;
  moving = false;
  ui.unitCard(null);
  if (ui.radialOpenWas === 'unit') ui.closeRadial();
  if (!placing) ui.hint('');
}

function upgrade() {
  const u = sim.byId.get(selected);
  if (!u) return;
  if (sim.command({ type: 'upgrade', id: u.id })) {
    ui.closeRadial();
    select(u);
  } else {
    audio.deny();
    ui.hint(u.level >= 2 ? 'Fully upgraded' : 'Not enough budget');
  }
}

function sell() {
  const u = sim.byId.get(selected);
  if (u && sim.command({ type: 'sell', id: u.id })) {
    ui.closeRadial();
    deselect();
  }
}

function startMove() {
  if (!sim.byId.get(selected)) return;
  ui.closeRadial();
  moving = true;
  ui.hint('Tap where it should go');
}

function startPlacing(kind) {
  if (mode !== 'play') return;
  audio.unlock();
  ui.closeRadial();
  if (placing === kind) {
    stopPlacing();
    return;
  }
  deselect();
  placing = kind;
  ui.setPlacing(kind);
  $('view').classList.add('placing');
  ui.hint(placingHint(kind));
  audio.click();
}

function placingHint(kind) {
  const def = NATO[kind];
  const where = def.layer === 'land' ? 'on our ground' : def.layer === 'sea' ? 'at sea, near our coast' : 'over our ground or coast';
  return `Tap ${where} to deploy a ${def.name.toLowerCase()} (€${def.cost}M)`;
}

function stopPlacing() {
  placing = null;
  ui.setPlacing(null);
  $('view').classList.remove('placing');
  showGhost(null);
  ui.hint('');
}

function hover(px, py) {
  if (!placing || mode !== 'play') return;
  const p = pickAt(px, py);
  showGhost(p ? { kind: placing, x: p.x, y: p.y } : null);
}

function showGhost(g) {
  if (!g) {
    ghostRing.visible = false;
    return;
  }
  const lv = NATO[g.kind].levels[0];
  const r = Math.max(...lv.weapons.map((w) => w.range));
  const ok = !sim.canBuild(g.kind, g.x, g.y) && sim.funds >= NATO[g.kind].cost;
  ghostRing.setColor(ok ? 0x5fd17a : 0xff5544);
  ghostRing.position.set(g.x, Math.max(0, terrainView.groundAt(g.x, g.y)) + 1, -g.y);
  ghostRing.scale.set(r, 1, r);
  ghostRing.visible = true;
}

function updateRanges(alpha) {
  const u = sim.byId.get(selected);
  if (!u) {
    rangeRing.visible = false;
    return;
  }
  const r = Math.max(...u.weapons.map((w) => w.range));
  const p = units.placeOf(u, alpha, new THREE.Vector3());
  const cx = u.layer === 'air' ? u.post.x : p.x;
  const cz = u.layer === 'air' ? -u.post.y : p.z;
  rangeRing.position.set(cx, Math.max(0, terrainView.groundAt(cx, -cz)) + 1, cz);
  const rr = u.layer === 'air' ? r + u.orbit : r;
  rangeRing.scale.set(rr, 1, rr);
  rangeRing.visible = true;
}

function callWave() {
  if (mode !== 'play') return;
  audio.unlock();
  if (!sim.command({ type: 'nextWave' })) audio.deny();
}

const PAN_KEYS = { KeyW: [0, 1], ArrowUp: [0, 1], KeyS: [0, -1], ArrowDown: [0, -1], KeyA: [-1, 0], ArrowLeft: [-1, 0], KeyD: [1, 0], ArrowRight: [1, 0] };
let keysDown = new Set();
addEventListener('keyup', (e) => keysDown.delete(e.code));
addEventListener('blur', () => keysDown.clear());

function keyPan(dt) {
  let dx = 0, dy = 0;
  for (const k of keysDown) {
    const v = PAN_KEYS[k];
    if (v) { dx += v[0]; dy += v[1]; }
  }
  if (dx || dy) rig.pan(dx * rig.dist * dt * 0.9, dy * rig.dist * dt * 0.9);
}

function key(e) {
  if (mode === 'menu' && (e.code === 'Enter' || e.code === 'Space')) {
    startGame();
    return;
  }
  if (e.code === 'Escape') {
    if (mode === 'paused') resume();
    else if (mode === 'play') {
      if (placing) stopPlacing();
      else if (moving) { moving = false; ui.hint(''); }
      else if (ui.radialOpen) { ui.closeRadial(); deselect(); }
      else if (selected) deselect();
      else pause();
    }
    return;
  }
  if (mode !== 'play') return;
  keysDown.add(e.code);
  if (e.code.startsWith('Digit')) {
    const n = Number(e.code.slice(5)) - 1;
    if (NATO_ORDER[n]) startPlacing(NATO_ORDER[n]);
  } else if (e.code === 'Space') {
    e.preventDefault();
    callWave();
  } else if (e.code === 'KeyF') {
    setSpeed(speed === 1 ? 2 : speed === 2 ? 3 : 1);
  } else if (e.code === 'KeyU') {
    upgrade();
  } else if (e.code === 'KeyX' || e.code === 'Delete' || e.code === 'Backspace') {
    sell();
  } else if (e.code === 'KeyM') {
    startMove();
  } else if (e.code === 'Equal' || e.code === 'NumpadAdd') {
    rig.zoom(0.8);
  } else if (e.code === 'Minus' || e.code === 'NumpadSubtract') {
    rig.zoom(1.25);
  } else if (e.code === 'KeyP') {
    pause();
  }
}

function setSpeed(s) {
  speed = s;
  audio.click();
}

// --- menus ---------------------------------------------------------------------------------

function wireMenus() {
  const seg = $('optDifficulty');
  const paint = () => {
    for (const b of seg.children) b.classList.toggle('on', b.dataset.v === settings.difficulty);
    $('optQuality').textContent = settings.quality.toUpperCase();
    $('optSound').textContent = settings.sound ? 'ON' : 'OFF';
    renderBoard();
  };
  for (const b of seg.children) {
    b.addEventListener('click', () => {
      settings.difficulty = b.dataset.v;
      saveSettings();
      audio.unlock();
      audio.click();
      paint();
    });
  }
  $('optQuality').addEventListener('click', () => {
    const order = ['auto', ...QUALITY_ORDER];
    settings.quality = order[(order.indexOf(settings.quality) + 1) % order.length];
    saveSettings();
    renderer.autoAdjust = settings.quality === 'auto';
    renderer.setQuality(settings.quality === 'auto' ? guessQuality() : settings.quality);
    sun.castShadow = renderer.q.shadow > 0;
    if (renderer.q.shadow) {
      sun.shadow.mapSize.set(renderer.q.shadow, renderer.q.shadow);
      sun.shadow.map?.dispose();
      sun.shadow.map = null;
    }
    paint();
  });
  $('optSound').addEventListener('click', () => {
    settings.sound = !settings.sound;
    saveSettings();
    audio.unlock();
    audio.setEnabled(settings.sound);
    audio.click();
    paint();
  });
  $('play').addEventListener('click', () => startGame());
  $('resume').addEventListener('click', () => resume());
  $('restart').addEventListener('click', () => startGame());
  $('quit').addEventListener('click', () => toMenu());
  $('btnPause').addEventListener('click', () => (mode === 'paused' ? resume() : pause()));
  $('btnSpeed').addEventListener('click', () => setSpeed(speed === 1 ? 2 : speed === 2 ? 3 : 1));
  $('btnWave').addEventListener('click', () => callWave());
  $('overAgain').addEventListener('click', () => startGame());
  $('overMenu').addEventListener('click', () => toMenu());
  $('nameOk').addEventListener('click', () => saveName());
  $('nameInput').addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') saveName();
  });
  paint();
}

function showMenu() {
  for (const id of ['hud', 'pause', 'gameover']) $(id).classList.add('hidden');
  $('menu').classList.remove('hidden');
  ui.closeRadial();
  ui.unitCard(null);
  renderBoard();
  syncBoard();
}

/** The war behind the title screen, started afresh whenever the last one ends. */
function demo() {
  sim = new Sim({ difficulty: 'veteran', seed: (Math.random() * 1e9) | 0 });
  sim.command({ type: 'nextWave' });
  lastOwner = -1;
  for (const c of CITIES) terrainView.setCityOwner(c.id, c.side);
}

function toMenu() {
  mode = 'menu';
  demo();
  stopPlacing();
  deselect();
  showMenu();
}

function startGame() {
  audio.unlock();
  sim = new Sim({ difficulty: settings.difficulty, seed: (Math.random() * 1e9) | 0 });
  mode = 'play';
  acc = 0;
  speed = 1;
  selected = 0;
  placing = null;
  moving = false;
  lastOwner = -1;
  incomingFor = -1;
  lastResult = null;
  for (const c of CITIES) terrainView.setCityOwner(c.id, c.side);
  for (const id of ['menu', 'pause', 'gameover']) $(id).classList.add('hidden');
  $('hud').classList.remove('hidden');
  const [bx, by] = lonlat(23.5, 57);
  rig.flyTo(bx, by, 1000);
  ui.banner(DIFFICULTY[settings.difficulty].label, 'HOLD THE LINE', 'Deploy along the Baltic border, then press START. Every square kilometre you lose is on the bill.', '', 5200);
  if (!settings.seenHelp) {
    setTimeout(() => ui.hint('Tap the map near Narva or Tartu to deploy your first units'), 1200);
  }
}

function firstBuild() {
  if (settings.seenHelp) return;
  settings.seenHelp = true;
  saveSettings();
  setTimeout(() => ui.hint('Good. Add more, then press START - or tap the red marker'), 300);
  setTimeout(() => ui.hint(''), 5000);
}

function pause() {
  if (mode !== 'play') return;
  mode = 'paused';
  $('pause').classList.remove('hidden');
}

function resume() {
  if (mode !== 'paused') return;
  mode = 'play';
  $('pause').classList.add('hidden');
}

// --- the end, and the board ----------------------------------------------------------------

function gameOver() {
  mode = 'over';
  ui.closeRadial();
  stopPlacing();
  deselect();
  const r = sim.result();
  audio.fanfare(r.won);
  const won = r.won;
  $('overTitle').textContent = won ? 'EUROPE HOLDS' : 'THE LINE BROKE';
  $('overTitle').className = won ? 'won' : 'lost';
  $('overKicker').textContent = `AFTER ACTION REPORT · ${DIFFICULTY[sim.difficulty].label}`;
  $('overLine').textContent = won
    ? `All ${WAVES.length} waves held. ${r.held}% of Europe still ours.`
    : `Too many capitals lost in wave ${sim.wave}. ${r.held}% of Europe still ours.`;
  const l = sim.losses;
  const fmt = (n) => Math.round(n).toLocaleString('en-US');
  const cost = (n) => (Math.round(n) > 0 ? `−${fmt(n)}` : '0');
  $('overStats').innerHTML = `
    <tr><td>Ground lost</td><td>${cost(l.territory)}</td></tr>
    <tr><td>Cities lost (${sim.stats.citiesLost})</td><td>${cost(l.cities)}</td></tr>
    <tr><td>Units lost (${sim.stats.lostUnits})</td><td>${cost(l.units)}</td></tr>
    <tr><td>Strikes that got through</td><td>${cost(l.strikes)}</td></tr>
    <tr><td>Enemy units destroyed</td><td>${fmt(sim.stats.kills)}</td></tr>
    <tr class="total"><td>LOSSES</td><td>${cost(sim.total)}</td></tr>`;
  lastResult = {
    id: makeId(), name: settings.name || '', waves: r.waves, won, losses: r.losses,
    held: r.held, kills: r.kills, citiesLost: r.citiesLost, at: Date.now(),
  };
  const ok = r.waves >= 1 && highscores.qualifies(sim.difficulty, lastResult);
  $('nameRow').classList.toggle('hidden', !ok);
  if (ok) {
    $('nameInput').value = settings.name || '';
    setTimeout(() => $('nameInput').focus(), 300);
  }
  setTimeout(() => $('gameover').classList.remove('hidden'), 1400);
}

function saveName() {
  if (!lastResult) return;
  const name = $('nameInput').value.toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 3);
  if (!name) return;
  settings.name = name;
  saveSettings();
  lastResult.name = name;
  const place = highscores.add(sim.difficulty, lastResult);
  $('nameRow').classList.add('hidden');
  $('overLine').textContent = place ? `On the board at number ${place}.` : $('overLine').textContent;
  syncBoard(true);
  audio.coin();
}

function renderBoard() {
  const level = levelOf(settings.difficulty);
  $('scoresLevel').textContent = `· ${DIFFICULTY[level].label}`;
  const rows = highscores.table(level);
  const mine = lastResult?.id;
  $('scoresBody').innerHTML = rows.length
    ? rows.map((r, i) => `<tr class="${r.won ? 'won' : ''}${r.id === mine ? ' me' : ''}"><td class="n">${i + 1}</td><td class="name">${r.name}</td><td class="w">${r.won ? 'HELD' : `W${r.waves}`}</td><td class="l">−${r.losses.toLocaleString('en-US')}</td></tr>`).join('')
    : '<tr><td class="dim">Nobody yet. Hold all fifteen waves and lose as little as you can.</td></tr>';
  $('scoresNote').textContent = BOARD ? 'Ranked by waves held, then by fewest losses.' : 'Ranked by waves held, then by fewest losses. Kept in this browser.';
}

async function syncBoard(post = false) {
  if (!BOARD) return;
  try {
    const res = post
      ? await fetch(BOARD, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ board: highscores.all() }) })
      : await fetch(BOARD);
    if (!res.ok) return;
    const body = await res.json();
    highscores.absorb(body.board || {});
    renderBoard();
  } catch { /* offline: the local board is still a board */ }
}

boot().catch((err) => {
  console.error(err);
  $('loadingText').textContent = `COULD NOT START: ${err.message}`;
});
