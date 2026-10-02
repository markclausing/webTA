/**
 * Everything drawn in HTML on top of the map: the bar along the top, the build
 * cards, the radial menus, city names, incoming-wave markers, the feed, and the
 * numbers that float up when something is lost.
 *
 * None of it decides anything. It shows what the simulation says and hands
 * taps back to main.js.
 */

import { NATO, NATO_ORDER, upgradeCost } from './game/units.js';
import { WAVES } from './game/waves.js';
import { FRIEND, HOSTILE } from './game/map.js';

const $ = (id) => document.getElementById(id);

/** Unit silhouettes, side on, in one colour so CSS can tint them. */
export const ICONS = {
  infantry: '<svg viewBox="0 0 40 30"><g fill="#cfe3ff"><circle cx="13" cy="7" r="4"/><path d="M8 6h10v2H8z"/><path d="M9 12h8l1 9h-3l-1 8h-3l-1-8H8z"/><circle cx="27" cy="9" r="3.4"/><path d="M23 13.5h8l1 7.5h-3l-1 7h-3l-1-7h-2z"/><path d="M16 14l16-4 .6 1.6-16 4z" fill="#8fb3dd"/></g></svg>',
  tank: '<svg viewBox="0 0 40 30"><g fill="#cfe3ff"><rect x="3" y="17" width="34" height="8" rx="4"/><path d="M6 13h28l3 4H3z"/><path d="M12 8h13l2 5H10z"/><rect x="25" y="9.2" width="14" height="2" rx="1"/></g><g fill="#3a5a80"><circle cx="9" cy="21" r="2"/><circle cx="16" cy="21" r="2"/><circle cx="24" cy="21" r="2"/><circle cx="31" cy="21" r="2"/></g></svg>',
  drone: '<svg viewBox="0 0 40 30"><g fill="#cfe3ff"><rect x="4" y="13" width="32" height="3" rx="1.5"/><ellipse cx="20" cy="15" rx="4" ry="9"/><path d="M14 25l6-3 6 3-1 2-5-2-5 2z"/><circle cx="20" cy="5" r="2.5"/></g></svg>',
  jet: '<svg viewBox="0 0 40 30"><path fill="#cfe3ff" d="M20 1l3 9 13 9v3l-12-3-1 6 4 3v2l-7-2-7 2v-2l4-3-1-6-12 3v-3l13-9z"/></svg>',
  ship: '<svg viewBox="0 0 40 30"><g fill="#cfe3ff"><path d="M2 19h36l-5 7H7z"/><rect x="13" y="12" width="12" height="7"/><rect x="16" y="7" width="6" height="5"/><rect x="18.4" y="2" width="1.2" height="5"/><rect x="27" y="15" width="6" height="4"/><rect x="31" y="15.6" width="7" height="1.2"/></g></svg>',
  wave: '<svg viewBox="0 0 24 24"><path d="M12 2l3 7h7l-5.5 4.5L18.5 21 12 16.5 5.5 21l2-7.5L2 9h7z"/></svg>',
  air: '<svg viewBox="0 0 24 24"><path d="M12 2l2 6 8 6v2l-8-2-.5 4 3 2v1.5L12 20l-4.5 1.5V20l3-2-.5-4-8 2v-2l8-6z"/></svg>',
  sea: '<svg viewBox="0 0 24 24"><path d="M2 14h20l-3 5H5z M8 9h7v5H8z M10 5h3v4h-3z"/></svg>',
  land: '<svg viewBox="0 0 24 24"><path d="M2 14h20v4H2z M5 10h14l2 4H3z M8 6h7l1 4H7z M15 7h8v1.4h-8z"/></svg>',
};

export class Ui {
  constructor() {
    this.labels = $('labels');
    this.feedEl = $('feed');
    this.cityEls = new Map();
    this.markers = [];
    this.lastFunds = -1;
    this.lastLosses = -1;
    this.buildCards = {};
    this.onBuildCard = null;
  }

  // --- the build bar ----------------------------------------------------------------

  makeBuildBar(onPick) {
    const bar = $('buildbar');
    bar.innerHTML = '';
    NATO_ORDER.forEach((kind, i) => {
      const def = NATO[kind];
      const b = document.createElement('button');
      b.className = 'bcard';
      b.title = `${def.name} - ${def.blurb} (${i + 1})`;
      b.innerHTML = `<span class="hk">${i + 1}</span>${ICONS[kind]}<span class="nm">${def.name.toUpperCase()}</span><span class="c">€${def.cost}</span>`;
      b.addEventListener('click', (e) => {
        e.stopPropagation();
        onPick(kind);
      });
      bar.appendChild(b);
      this.buildCards[kind] = b;
    });
  }

  setPlacing(kind) {
    for (const [k, b] of Object.entries(this.buildCards)) b.classList.toggle('on', k === kind);
  }

  // --- the bar along the top ------------------------------------------------------------

  hud(sim, speed) {
    const funds = Math.floor(sim.funds);
    if (funds !== this.lastFunds) {
      $('funds').textContent = funds.toLocaleString('en-US');
      if (funds > this.lastFunds + 5 && this.lastFunds >= 0) {
        const p = $('funds').parentElement;
        p.classList.remove('bump');
        void p.offsetWidth;
        p.classList.add('bump');
      }
      this.lastFunds = funds;
      for (const [k, b] of Object.entries(this.buildCards)) b.classList.toggle('poor', NATO[k].cost > funds);
    }
    const losses = sim.total;
    if (losses !== this.lastLosses) {
      $('losses').textContent = losses.toLocaleString('en-US');
      $('losses').classList.toggle('zero', losses === 0);
      if (losses > this.lastLosses && this.lastLosses >= 0) {
        const p = $('losses').parentElement;
        p.classList.remove('hit');
        void p.offsetWidth;
        p.classList.add('hit');
      }
      this.lastLosses = losses;
    }
    $('waveNo').textContent = sim.wave;
    $('waveMax').textContent = WAVES.length;
    const w = WAVES[Math.max(0, sim.wave - 1)];
    $('waveTitle').textContent = sim.state === 'prep' ? 'DEPLOY YOUR FORCES' : w.title.toUpperCase();
    $('capitals').textContent = sim.stats.capitalsLost;
    $('capitalsMax').textContent = sim.diff.capitalsToLose;
    if (sim.tick % 15 === 0) $('held').textContent = (sim.held() * 100).toFixed(1);

    // The big button: start, or the countdown to the next wave with its bonus.
    const btn = $('btnWave');
    const ring = $('waveRing');
    let label = 'START', bonus = '', ready = false, off = false, frac = 0;
    if (sim.state === 'prep') {
      ready = true;
    } else if (sim.state === 'between') {
      label = `${Math.ceil(sim.nextWaveIn)}`;
      bonus = `+€${Math.round(sim.nextWaveIn * 3)}`;
      ready = true;
      frac = 1 - sim.nextWaveIn / 30;
    } else if (sim.state === 'wave') {
      label = 'WAVE';
      bonus = `${sim.wave}/${WAVES.length}`;
      off = true;
      frac = 1;
    } else {
      label = 'LAST';
      bonus = `${Math.ceil(sim.finalT)}s`;
      off = true;
    }
    $('waveBtnLbl').textContent = label;
    $('waveBonus').textContent = bonus;
    btn.classList.toggle('ready', ready);
    btn.classList.toggle('off', off);
    ring.style.strokeDashoffset = String(289 * (1 - frac));
    $('btnSpeed').textContent = `${speed}×`;
  }

  feed(html, tone = '', ms = 5000) {
    const el = document.createElement('div');
    el.className = `feedItem ${tone}`;
    el.innerHTML = html;
    this.feedEl.prepend(el);
    while (this.feedEl.children.length > 5) this.feedEl.lastChild.remove();
    setTimeout(() => { el.style.opacity = '0'; }, ms);
    setTimeout(() => el.remove(), ms + 700);
  }

  banner(kicker, big, sub = '', tone = '', ms = 3600) {
    const el = $('banner');
    $('bannerKicker').textContent = kicker;
    $('bannerBig').textContent = big;
    $('bannerSub').textContent = sub;
    el.className = tone;
    clearTimeout(this.bannerT);
    this.bannerT = setTimeout(() => el.classList.add('hidden'), ms);
  }

  hint(text) {
    const el = $('hint');
    if (!text) {
      el.classList.add('hidden');
      return;
    }
    el.textContent = text;
    el.classList.remove('hidden');
  }

  // --- labels on the map ---------------------------------------------------------------

  makeCityLabels(cities) {
    for (const c of cities) {
      const el = document.createElement('div');
      el.className = `city${c.capital ? ' cap' : ''}${c.side === HOSTILE ? ' hostile' : ''}`;
      el.innerHTML = `<span class="nm">${c.name}</span><span class="siege hidden"><i></i></span>`;
      this.labels.appendChild(el);
      this.cityEls.set(c.id, { el, bar: el.querySelector('.siege'), fill: el.querySelector('.siege i'), owner: c.side, vis: true, x: 0, y: 0 });
    }
  }

  /** Places labels; `project` turns a map point into screen pixels (or null if behind). */
  cityLabels(sim, project, dist) {
    for (const c of sim.cities) {
      const L = this.cityEls.get(c.id);
      const p = project(c.x, c.y, 8);
      // Zoomed out, only capitals and anything in trouble keep a name.
      const show = p && (dist < 1500 || c.capital || c.siege > 0 || (c.side === FRIEND && c.owner !== FRIEND)) && !(c.side === HOSTILE && dist > 2600);
      if (!show) {
        if (L.vis) { L.el.style.display = 'none'; L.vis = false; }
        continue;
      }
      if (!L.vis) { L.el.style.display = ''; L.vis = true; }
      L.el.style.transform = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
      if (L.owner !== c.owner) {
        L.owner = c.owner;
        L.el.classList.toggle('fallen', c.side === FRIEND && c.owner !== FRIEND);
      }
      const sieged = c.siege > 0.01;
      L.bar.classList.toggle('hidden', !sieged);
      if (sieged) L.fill.style.width = `${Math.round(c.siege * 100)}%`;
    }
  }

  /** The red markers where the next wave will come from. Tap one to call it in. */
  incoming(list, project, onTap) {
    if (list !== this.markerList) {
      for (const m of this.markers) m.el.remove();
      this.markers = (list || []).map((e) => {
        const el = document.createElement('div');
        el.className = 'incoming';
        el.style.pointerEvents = 'auto';
        el.innerHTML = `${ICONS[e.layer]}<span class="n">${e.units} → ${e.to.slice(0, 2).join(', ')}</span>`;
        el.title = `${e.units} units heading for ${e.to.join(', ')}`;
        el.addEventListener('click', (ev) => { ev.stopPropagation(); onTap(); });
        this.labels.appendChild(el);
        return { el, e };
      });
      this.markerList = list;
    }
    for (const m of this.markers) {
      const p = project(m.e.x, m.e.y, 20);
      if (!p) { m.el.style.display = 'none'; continue; }
      m.el.style.display = '';
      m.el.style.left = `${p.x}px`;
      m.el.style.top = `${p.y}px`;
    }
  }

  float(text, x, y, tone = '') {
    const el = document.createElement('div');
    el.className = `float ${tone}`;
    el.textContent = text;
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    this.labels.appendChild(el);
    setTimeout(() => el.remove(), 1700);
  }

  // --- radial menus -------------------------------------------------------------------

  closeRadial() {
    $('radial').classList.add('hidden');
    $('radial').innerHTML = '';
    this.radialOpen = null;
  }

  /** Buttons in a ring round a screen point. Each: { html, title, cost, cls, onTap }. */
  radial(px, py, buttons, kind) {
    const el = $('radial');
    el.innerHTML = '<div class="hub"></div>';
    // A full ring for the build menu, a fan above the unit for its orders.
    const full = buttons.length > 3;
    const R = full ? 66 : 64;
    const x = Math.max(R + 40, Math.min(innerWidth - R - 40, px));
    const y = Math.max(R + 60, Math.min(innerHeight - R - 50, py));
    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
    const n = buttons.length;
    buttons.forEach((b, i) => {
      const a = full ? -Math.PI / 2 + (i / n) * Math.PI * 2 : -Math.PI / 2 + (i - (n - 1) / 2) * 1.3;
      const btn = document.createElement('button');
      btn.className = `rbtn ${b.cls || ''}`;
      btn.style.left = `${Math.cos(a) * R}px`;
      btn.style.top = `${Math.sin(a) * R + (full ? 0 : 10)}px`;
      btn.style.animationDelay = `${i * 0.03}s`;
      btn.title = b.title || '';
      const label = !full && b.label ? `<span class="t">${b.label}</span>` : '';
      btn.innerHTML = `${b.html}${label}${b.cost != null ? `<span class="c">${b.cost}</span>` : ''}`;
      btn.addEventListener('pointerdown', (e) => e.stopPropagation());
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        b.onTap();
      });
      el.appendChild(btn);
    });
    el.classList.remove('hidden');
    this.radialOpen = kind;
    this.radialAt = { x, y };
  }

  unitCard(u, sim) {
    const el = $('unitCard');
    if (!u) {
      el.classList.add('hidden');
      return;
    }
    const def = NATO[u.kind];
    const lv = def.levels[u.level];
    const stars = '★'.repeat(u.level + 1) + '☆'.repeat(2 - u.level);
    const w = lv.weapons.map((x) => `${x.targets.map((t) => t[0].toUpperCase()).join('')} ${x.range}km`).join(' · ');
    el.innerHTML = `<b>${def.name.toUpperCase()}</b><span class="stars">${stars}</span><span>${Math.ceil(u.hp)}/${lv.hp} HP</span><span class="dim">${w}</span>`;
    el.classList.remove('hidden');
  }
}

/** What upgrading a unit would give it, in a word or two. */
export function upgradeLabel(kind, level) {
  const next = NATO[kind].levels[level + 1];
  if (!next) return '';
  return next.label || `LEVEL ${level + 2}`;
}

export { upgradeCost };
