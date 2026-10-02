/**
 * Fire, smoke, tracers and everything else that does not last.
 *
 * Particles live in two pools - one added on top of the picture for fire and
 * flashes, one blended normally for smoke and dust and spray - each a single
 * draw call however busy the sky is. Everything the simulation fires is drawn
 * from its own list every frame: tracers for bullets, glowing shells that arc,
 * missiles with a flame and a smoke trail behind them.
 *
 * The simulation says what happened through events; this file decides what that
 * looks like.
 */

import * as THREE from 'three';
import { TICK } from '../game/sim.js';

const POINT_VS = /* glsl */`
  attribute float aSize;
  attribute vec4 aColor;
  attribute float aSeed;
  uniform float uScale;
  varying vec4 vColor;
  varying float vSeed;
  void main() {
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = min(aSize * uScale / max(1.0, -mv.z), 512.0);
    vColor = aColor;
    vSeed = aSeed;
  }
`;

const FIRE_FS = /* glsl */`
  varying vec4 vColor;
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float d = length(c) * 2.0;
    float a = smoothstep(1.0, 0.0, d);
    a *= a;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor.rgb * a * vColor.a, 1.0);
  }
`;

const SMOKE_FS = /* glsl */`
  varying vec4 vColor;
  varying float vSeed;
  float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  void main() {
    vec2 c = gl_PointCoord - 0.5;
    float ang = atan(c.y, c.x);
    float wob = 0.85 + 0.15 * sin(ang * 5.0 + vSeed * 20.0) + 0.08 * sin(ang * 9.0 + vSeed * 7.0);
    float d = length(c) * 2.0 / wob;
    float a = smoothstep(1.0, 0.55, d);
    if (a < 0.01) discard;
    // A little shading from the top left, so puffs read as round.
    float lit = 0.8 + 0.35 * clamp(-c.x - c.y, -1.0, 1.0);
    gl_FragColor = vec4(vColor.rgb * lit, a * vColor.a);
  }
`;

class Pool {
  constructor(scene, capacity, additive) {
    this.cap = capacity;
    this.n = 0;
    this.pos = new Float32Array(capacity * 3);
    this.vel = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 4);
    this.size = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.life = new Float32Array(capacity);
    this.max = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.base = new Float32Array(capacity * 4); // starting colour
    this.end = new Float32Array(capacity * 4);  // colour at death
    this.size0 = new Float32Array(capacity);
    const g = new THREE.BufferGeometry();
    this.aPos = new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aCol = new THREE.BufferAttribute(this.col, 4).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.BufferAttribute(this.size, 1).setUsage(THREE.DynamicDrawUsage);
    this.aSeed = new THREE.BufferAttribute(this.seed, 1).setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', this.aPos);
    g.setAttribute('aColor', this.aCol);
    g.setAttribute('aSize', this.aSize);
    g.setAttribute('aSeed', this.aSeed);
    g.setDrawRange(0, 0);
    this.uniforms = { uScale: { value: 800 } };
    const mat = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: POINT_VS,
      fragmentShader: additive ? FIRE_FS : SMOKE_FS,
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(g, mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 5;
    scene.add(this.points);
  }

  /** One particle. Colours are [r, g, b, a] at birth and at death. */
  add(x, y, z, vx, vy, vz, size, life, c0, c1, opts = {}) {
    if (this.n >= this.cap) return;
    const i = this.n++;
    this.pos.set([x, y, z], i * 3);
    this.vel.set([vx, vy, vz], i * 3);
    this.base.set(c0, i * 4);
    this.end.set(c1, i * 4);
    this.col.set(c0, i * 4);
    this.size0[i] = this.size[i] = size;
    this.seed[i] = Math.random();
    this.life[i] = 0;
    this.max[i] = life;
    this.grow[i] = opts.grow ?? 1;
    this.drag[i] = opts.drag ?? 1.5;
    this.grav[i] = opts.grav ?? 0;
  }

  update(dt) {
    let w = 0;
    for (let i = 0; i < this.n; i++) {
      const life = this.life[i] + dt;
      if (life >= this.max[i]) continue;
      const t = life / this.max[i];
      const k = Math.exp(-this.drag[i] * dt);
      // Compact in place: survivors slide down over the dead.
      const o = w * 3, s = i * 3;
      this.vel[o] = this.vel[s] * k;
      this.vel[o + 1] = this.vel[s + 1] * k - this.grav[i] * dt;
      this.vel[o + 2] = this.vel[s + 2] * k;
      this.pos[o] = this.pos[s] + this.vel[o] * dt;
      this.pos[o + 1] = this.pos[s + 1] + this.vel[o + 1] * dt;
      this.pos[o + 2] = this.pos[s + 2] + this.vel[o + 2] * dt;
      for (let c = 0; c < 4; c++) {
        this.base[w * 4 + c] = this.base[i * 4 + c];
        this.end[w * 4 + c] = this.end[i * 4 + c];
        this.col[w * 4 + c] = this.base[i * 4 + c] + (this.end[i * 4 + c] - this.base[i * 4 + c]) * t;
      }
      // Fade in fast, fade out slow.
      this.col[w * 4 + 3] *= Math.min(1, t * 12);
      this.size0[w] = this.size0[i];
      this.grow[w] = this.grow[i];
      this.size[w] = this.size0[i] * (1 + (this.grow[i] - 1) * Math.sqrt(t));
      this.seed[w] = this.seed[i];
      this.life[w] = life;
      this.max[w] = this.max[i];
      this.drag[w] = this.drag[i];
      this.grav[w] = this.grav[i];
      w++;
    }
    this.n = w;
    this.points.geometry.setDrawRange(0, w);
    for (const a of [this.aPos, this.aCol, this.aSize, this.aSeed]) {
      a.needsUpdate = true;
      a.clearUpdateRanges();
      a.addUpdateRange(0, w * a.itemSize);
    }
  }
}

const rand = (a, b) => a + Math.random() * (b - a);
const FIRE0 = [1.6, 1.1, 0.5, 1];
const FIRE1 = [0.9, 0.25, 0.05, 0];
const SMOKE0 = [0.32, 0.3, 0.28, 0.85];
const SMOKE1 = [0.5, 0.48, 0.46, 0];
const DUST0 = [0.62, 0.55, 0.42, 0.7];
const DUST1 = [0.7, 0.65, 0.55, 0];
const SPRAY0 = [0.92, 0.97, 1, 0.9];
const SPRAY1 = [0.85, 0.92, 1, 0];

export class Fx {
  constructor(scene, terrain, quality) {
    this.scene = scene;
    this.terrain = terrain;
    this.detail = quality.trees >= 1 ? 1 : quality.trees >= 0.5 ? 0.7 : 0.45;
    this.fire = new Pool(scene, 9000, true);
    this.smoke = new Pool(scene, 7000, false);
    this.emitters = []; // burning wrecks, falling aircraft
    this.rings = [];
    this.shake = 0;

    // Tracers and missile bodies: instanced, glowing, drawn from the simulation's list.
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    tracerGeo.translate(-0.5, 0, 0);
    this.tracers = new THREE.InstancedMesh(tracerGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 1500);
    this.tracers.setColorAt(0, new THREE.Color());
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);
    const missileGeo = new THREE.CylinderGeometry(0.5, 0.5, 4, 6);
    missileGeo.rotateZ(-Math.PI / 2);
    this.missiles = new THREE.InstancedMesh(missileGeo, new THREE.MeshStandardMaterial({ color: 0xe8e8e0, roughness: 0.4, metalness: 0.3 }), 600);
    this.missiles.frustumCulled = false;
    scene.add(this.missiles);
    const ringGeo = new THREE.RingGeometry(0.85, 1, 48);
    ringGeo.rotateX(-Math.PI / 2);
    this.ringGeo = ringGeo;
  }

  ground(x, y) {
    return this.terrain.groundAt(x, y);
  }

  overWater(x, y) {
    return this.terrain.maskAt(x, y) < 0.5;
  }

  // --- building blocks --------------------------------------------------------

  fireball(x, y, z, size, n = 10) {
    n = Math.ceil(n * this.detail);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * 0.9;
      const s = size * rand(0.6, 1.6);
      this.fire.add(x, y, z, Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s * 1.2, Math.sin(a) * Math.cos(e) * s,
        size * rand(0.7, 1.3), rand(0.35, 0.8), FIRE0, FIRE1, { grow: 2.2, drag: 3 });
    }
    this.fire.add(x, y + size * 0.2, z, 0, 0, 0, size * 3.5, 0.18, [2.5, 2.1, 1.6, 1], [1.4, 0.7, 0.2, 0], { grow: 1.6 });
  }

  smokePuff(x, y, z, size, n = 6, life = 3, dark = 0) {
    n = Math.ceil(n * this.detail);
    const c0 = dark ? [0.12, 0.11, 0.1, 0.9] : SMOKE0;
    const c1 = dark ? [0.3, 0.28, 0.27, 0] : SMOKE1;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = size * rand(0.2, 0.7);
      this.smoke.add(x + rand(-1, 1) * size * 0.3, y, z + rand(-1, 1) * size * 0.3,
        Math.cos(a) * s, rand(0.4, 1.2) * size * 0.6, Math.sin(a) * s,
        size * rand(0.8, 1.4), life * rand(0.7, 1.3), c0, c1, { grow: 2.6, drag: 1.2 });
    }
  }

  debris(x, y, z, size, n = 8, color = [0.2, 0.18, 0.15, 1]) {
    n = Math.ceil(n * this.detail);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = size * rand(1, 3);
      this.smoke.add(x, y, z, Math.cos(a) * s, rand(1.5, 3) * size, Math.sin(a) * s,
        size * rand(0.15, 0.35), rand(0.8, 1.4), color, [color[0], color[1], color[2], 0], { grow: 1, drag: 0.4, grav: size * 6 });
    }
    // Sparks.
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = size * rand(2, 5);
      this.fire.add(x, y, z, Math.cos(a) * s, rand(1, 4) * size, Math.sin(a) * s,
        size * 0.12, rand(0.3, 0.7), [2, 1.4, 0.6, 1], [1, 0.3, 0, 0], { grow: 1, drag: 1, grav: size * 8 });
    }
  }

  spray(x, y, z, size, n = 12) {
    n = Math.ceil(n * this.detail);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = size * rand(0.2, 1);
      this.smoke.add(x, y, z, Math.cos(a) * s, rand(2, 5) * size, Math.sin(a) * s,
        size * rand(0.5, 1), rand(0.6, 1.2), SPRAY0, SPRAY1, { grow: 1.8, drag: 0.8, grav: size * 7 });
    }
  }

  ring(x, y, z, size, color, life = 0.6, opacity = 0.9) {
    const mat = new THREE.MeshBasicMaterial({
      color, transparent: true, opacity, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false,
    });
    const m = new THREE.Mesh(this.ringGeo, mat);
    m.position.set(x, y, z);
    m.renderOrder = 4;
    this.scene.add(m);
    this.rings.push({ m, t: 0, life, size, opacity });
  }

  // --- what things look like ------------------------------------------------------

  explosion(x, y, z, size, opts = {}) {
    const water = !opts.air && this.overWater(x, -z);
    if (water) {
      this.spray(x, y, z, size * 0.8, 14);
      this.fire.add(x, y + size * 0.2, z, 0, 0, 0, size * 2.5, 0.15, [2, 1.8, 1.4, 1], [1, 0.6, 0.2, 0]);
      this.ring(x, y + 0.3, z, size * 3, 0xd8f0ff, 0.8, 0.6);
      return;
    }
    this.fireball(x, y, z, size, opts.air ? 8 : 12);
    this.smokePuff(x, y + size * 0.5, z, size * 1.1, opts.air ? 4 : 7, opts.air ? 2 : 3.5, opts.dark);
    if (!opts.air) {
      this.debris(x, y, z, size * 0.6, 6);
      if (size > 4) this.ring(x, y + 0.4, z, size * 3.2, 0xffb070, 0.5, 0.7);
      for (let i = 0; i < 4 * this.detail; i++) {
        this.smoke.add(x, y, z, rand(-1, 1) * size * 2, rand(0, 0.5) * size, rand(-1, 1) * size * 2,
          size * 1.2, rand(1, 2), DUST0, DUST1, { grow: 2.5, drag: 2 });
      }
    }
  }

  muzzle(x, y, z, dir, size, smoke = false) {
    const fx = Math.cos(dir), fz = -Math.sin(dir);
    this.fire.add(x + fx * size, y, z + fz * size, fx * size * 2, 0, fz * size * 2, size * 1.6, 0.08, [2.4, 1.9, 1.1, 1], [1.4, 0.6, 0.1, 0], { grow: 1.4, drag: 6 });
    if (smoke) this.smokePuff(x + fx * size * 1.5, y, z + fz * size * 1.5, size * 0.8, 2, 1.2);
  }

  // --- the simulation's events ------------------------------------------------------

  event(ev, unitView, sim) {
    const g = (x, y) => this.ground(x, y);
    switch (ev.type) {
      case 'shot': {
        const u = sim.byId.get(ev.id);
        const yy = (ev.z || 0) + (u && u.layer === 'sea' ? 0 : g(ev.x, ev.y));
        if (ev.kind === 'bullet') {
          if (Math.random() < 0.5) this.muzzle(ev.x, yy + 3, -ev.y, ev.aim, 1.6);
        } else if (ev.kind === 'shell') {
          this.muzzle(ev.x, yy + 6, -ev.y, ev.aim, 3.2, true);
        } else if (ev.kind === 'missile' || ev.kind === 'sam' || ev.kind === 'cruise') {
          this.smokePuff(ev.x, yy + 3, -ev.y, 3, 2, 1.4);
        }
        break;
      }
      case 'impact': {
        const air = ev.layer === 'air' && ev.z > 5;
        const y = air ? g(ev.x, ev.y) + ev.z : g(ev.x, ev.y);
        const size = { bullet: 0, shell: 4.5, missile: 4, sam: 3.5, bomb: 8, cruise: 10, kamikaze: 9, big: 18 }[ev.kind] ?? 4;
        if (ev.kind === 'bullet') {
          if (Math.random() < 0.3) {
            this.smoke.add(ev.x, y + 1, -ev.y, rand(-2, 2), 3, rand(-2, 2), 2.5, 0.6, DUST0, DUST1, { grow: 2 });
            this.fire.add(ev.x, y + 1, -ev.y, 0, 0, 0, 1.6, 0.06, [2, 1.6, 0.8, 1], [1, 0.4, 0, 0]);
          }
          break;
        }
        this.explosion(ev.x, y, -ev.y, size, { air });
        if (size >= 8) this.shake = Math.min(1, this.shake + size / 40);
        break;
      }
      case 'death': {
        const big = { tank: 9, t90: 9, tor: 8, btr: 7, ship: 14, corvette: 13, jet: 9, su34: 10, drone: 6, shahed: 6, iskander: 10 }[ev.kind] || 4;
        if (ev.layer === 'air') {
          const y = g(ev.x, ev.y) + ev.z;
          this.explosion(ev.x, y, -ev.y, big * 0.7, { air: true });
          // Down it goes, burning.
          this.emitters.push({ x: ev.x, y, z: -ev.y, vx: rand(-15, 15), vy: 0, vz: rand(-15, 15), kind: 'fall', size: big * 0.5, t: 0, life: 6 });
        } else if (ev.layer === 'sea') {
          this.explosion(ev.x, 2, -ev.y, big, { air: true });
          this.spray(ev.x, 1, -ev.y, big * 0.8, 20);
          this.emitters.push({ x: ev.x, y: 1, z: -ev.y, kind: 'burn', size: big * 0.6, t: 0, life: 9 });
        } else {
          const y = g(ev.x, ev.y);
          if (ev.kind === 'rifles' || ev.kind === 'infantry') {
            this.smokePuff(ev.x, y + 2, -ev.y, 3.5, 3, 1.6);
            this.fireball(ev.x, y + 1, -ev.y, 2.5, 4);
          } else {
            this.explosion(ev.x, y + 2, -ev.y, big, { dark: true });
            this.emitters.push({ x: ev.x, y: y + 2, z: -ev.y, kind: 'burn', size: big * 0.5, t: 0, life: 7 });
          }
        }
        break;
      }
      case 'deploy': {
        const y = g(ev.x, ev.y) + 0.5;
        this.ring(ev.x, y, -ev.y, 26, 0x55b6ff, 0.7, 0.9);
        this.ring(ev.x, y, -ev.y, 16, 0xaee0ff, 0.5, 0.7);
        for (let i = 0; i < 8 * this.detail; i++) {
          this.smoke.add(ev.x, y, -ev.y, rand(-1, 1) * 18, rand(1, 4), rand(-1, 1) * 18, 6, rand(0.8, 1.4), DUST0, DUST1, { grow: 2, drag: 2.5 });
        }
        break;
      }
      case 'upgrade': {
        const y = g(ev.x, ev.y) + 1;
        this.ring(ev.x, y, -ev.y, 22, 0xffd860, 0.8, 1);
        for (let i = 0; i < 16; i++) {
          const a = (i / 16) * Math.PI * 2;
          this.fire.add(ev.x + Math.cos(a) * 10, y, -ev.y + Math.sin(a) * 10, 0, rand(10, 22), 0, 2.5, 0.8, [2, 1.6, 0.5, 1], [1, 0.7, 0.1, 0], { drag: 1 });
        }
        break;
      }
      case 'sell':
        this.ring(ev.x, g(ev.x, ev.y) + 1, -ev.y, 20, 0xffffff, 0.5, 0.6);
        break;
      case 'cityFell': {
        const y = g(ev.x, ev.y);
        this.ring(ev.x, y + 1, -ev.y, 70, 0xff3020, 1.4, 1);
        this.explosion(ev.x, y + 3, -ev.y, 12);
        this.emitters.push({ x: ev.x, y: y + 3, z: -ev.y, kind: 'burn', size: 9, t: 0, life: 25, spread: 10 });
        break;
      }
      case 'cityFreed':
        this.ring(ev.x, g(ev.x, ev.y) + 1, -ev.y, 70, 0x40a0ff, 1.4, 1);
        break;
      case 'strike': {
        const y = g(ev.x, ev.y);
        this.emitters.push({ x: ev.x, y: y + 2, z: -ev.y, kind: 'burn', size: 6, t: 0, life: 8 });
        break;
      }
      case 'landing':
        this.spray(ev.x, 1, -ev.y, 6, 20);
        break;
      default:
    }
  }

  // --- every frame --------------------------------------------------------------------

  update(dt, sim, alpha, camera, viewHeight) {
    const scale = viewHeight / (2 * Math.tan((camera.fov * Math.PI) / 360));
    this.fire.uniforms.uScale.value = scale;
    this.smoke.uniforms.uScale.value = scale;
    this.shake = Math.max(0, this.shake - dt * 1.5);

    // Emitters: wrecks that burn and aircraft that fall.
    const keep = [];
    for (const e of this.emitters) {
      e.t += dt;
      if (e.t > e.life) continue;
      if (e.kind === 'fall') {
        e.vy -= 60 * dt;
        e.x += e.vx * dt;
        e.y += e.vy * dt;
        e.z += e.vz * dt;
        const floor = Math.max(0, this.ground(e.x, -e.z));
        if (Math.random() < 0.8) this.fire.add(e.x, e.y, e.z, 0, 0, 0, e.size * 1.2, 0.3, FIRE0, FIRE1, { grow: 1.6 });
        this.smoke.add(e.x, e.y, e.z, rand(-1, 1), 2, rand(-1, 1), e.size * 1.3, 2.2, [0.15, 0.14, 0.13, 0.8], [0.4, 0.38, 0.36, 0], { grow: 2.5 });
        if (e.y <= floor) {
          this.explosion(e.x, floor + 1, e.z, e.size * 1.6, { dark: true });
          continue;
        }
      } else {
        const fade = 1 - e.t / e.life;
        const sp = e.spread || 0;
        if (Math.random() < 0.7 * this.detail) {
          this.smoke.add(e.x + rand(-sp, sp), e.y, e.z + rand(-sp, sp), rand(-1, 1), e.size * 1.2, rand(-1, 1), e.size * 1.4,
            rand(2.5, 4), [0.1, 0.09, 0.09, 0.7 * fade], [0.35, 0.33, 0.32, 0], { grow: 3, drag: 0.6 });
        }
        if (Math.random() < 0.5) {
          this.fire.add(e.x + rand(-sp, sp) * 0.6, e.y, e.z + rand(-sp, sp) * 0.6, 0, e.size * 0.8, 0, e.size * 0.8 * fade + 1, 0.4, FIRE0, FIRE1, { grow: 0.6 });
        }
      }
      keep.push(e);
    }
    this.emitters = keep;

    // Shock rings.
    this.rings = this.rings.filter((r) => {
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) {
        this.scene.remove(r.m);
        r.m.material.dispose();
        return false;
      }
      r.m.scale.setScalar(r.size * (0.15 + 0.85 * Math.sqrt(k)));
      r.m.material.opacity = r.opacity * (1 - k) * (1 - k);
      return true;
    });

    this.drawProjectiles(sim, alpha, dt);
    this.fire.update(dt);
    this.smoke.update(dt);
  }

  drawProjectiles(sim, alpha, dt) {
    let nt = 0, nm = 0;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const prev = new THREE.Vector3();
    const col = new THREE.Color();
    const up = new THREE.Vector3(0, 1, 0);
    const fwd = new THREE.Vector3();
    for (const pr of sim.projectiles) {
      const pos = (f, out) => {
        const x = pr.sx + (pr.tx - pr.sx) * f;
        const y = pr.sy + (pr.ty - pr.sy) * f;
        const len = Math.hypot(pr.tx - pr.sx, pr.ty - pr.sy);
        const g0 = pr.sz > 4 ? this.ground(pr.sx, pr.sy) + pr.sz : this.ground(pr.sx, pr.sy) + 4;
        const g1 = pr.tz > 4 ? this.ground(pr.tx, pr.ty) + pr.tz : this.ground(pr.tx, pr.ty) + 2;
        let h = g0 + (g1 - g0) * f;
        const arc = { shell: 0.18, cruise: 0.22, missile: 0.08, sam: 0.06, bomb: 0, bullet: 0.01 }[pr.kind] ?? 0;
        h += Math.sin(Math.PI * f) * len * arc;
        if (pr.kind === 'bomb') h = g0 + (g1 - g0) * f * f;
        return out.set(x, h, -y);
      };
      const f = Math.min(1, (pr.t + alpha * TICK) / pr.dur);
      pos(f, p);
      pos(Math.max(0, f - 0.04), prev);
      fwd.subVectors(p, prev);
      const len = fwd.length() || 1;
      fwd.divideScalar(len);
      q.setFromUnitVectors(new THREE.Vector3(1, 0, 0), fwd);

      if (pr.kind === 'bullet' && nt < this.tracers.instanceMatrix.count) {
        m.compose(p, q, s.set(7, 0.5, 0.5));
        this.tracers.setMatrixAt(nt, m);
        this.tracers.setColorAt(nt++, col.setRGB(pr.side === 'nato' ? 1.6 : 2.2, pr.side === 'nato' ? 1.6 : 0.9, pr.side === 'nato' ? 0.9 : 0.4));
      } else if (pr.kind === 'shell' && nt < this.tracers.instanceMatrix.count) {
        m.compose(p, q, s.set(4, 1.4, 1.4));
        this.tracers.setMatrixAt(nt, m);
        this.tracers.setColorAt(nt++, col.setRGB(3, 1.8, 0.7));
        if (Math.random() < 0.4 * this.detail) this.smoke.add(p.x, p.y, p.z, 0, 0.5, 0, 1.8, 0.6, [0.6, 0.6, 0.6, 0.4], [0.7, 0.7, 0.7, 0], { grow: 2 });
      } else if (nm < this.missiles.instanceMatrix.count) {
        const big = pr.kind === 'cruise' ? 1.6 : pr.kind === 'bomb' ? 1.3 : 0.9;
        m.compose(p, q, s.set(big, big, big));
        this.missiles.setMatrixAt(nm++, m);
        if (pr.kind !== 'bomb') {
          const tail = p.clone().addScaledVector(fwd, -2.5 * big);
          this.fire.add(tail.x, tail.y, tail.z, 0, 0, 0, 3.2 * big, 0.06, [3, 2.2, 1.2, 1], [1.5, 0.5, 0.1, 0]);
          if (Math.random() < 0.9 * this.detail) {
            this.smoke.add(tail.x, tail.y, tail.z, rand(-0.5, 0.5), rand(0, 0.5), rand(-0.5, 0.5), 2.6 * big, rand(1.2, 2),
              [0.85, 0.85, 0.85, 0.5], [0.9, 0.9, 0.9, 0], { grow: 3, drag: 1 });
          }
        }
      }
    }
    this.tracers.count = nt;
    this.tracers.instanceMatrix.needsUpdate = true;
    if (this.tracers.instanceColor) this.tracers.instanceColor.needsUpdate = true;
    this.missiles.count = nm;
    this.missiles.instanceMatrix.needsUpdate = true;
  }
}
