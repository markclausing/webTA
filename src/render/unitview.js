/**
 * Draws every unit on the map.
 *
 * One InstancedMesh per part per kind of unit, so a swarm of four hundred rifle
 * squads is a single draw call and so is every turret on every T-90. Each frame
 * the simulation's units are walked once, interpolated between the last two
 * ticks, and their parts posed: hulls follow the ground, turrets turn to the
 * target, rotors spin, aircraft bank into their turns.
 *
 * Under every unit is a ring in its side's colour - the Kingdom Rush trick that
 * makes a crowded battle readable - and aircraft cast a soft blob on the ground
 * so you can tell how high they are. Health bars appear only on the hurt.
 */

import * as THREE from 'three';
import { buildModels } from './models.js';

const CAPACITY = {
  infantry: 160, tank: 160, drone: 120, jet: 80, ship: 60,
  rifles: 1000, btr: 320, t90: 220, tor: 100, shahed: 500, iskander: 80, su34: 80, corvette: 60,
};

const TEAM = { nato: new THREE.Color(0x3aa0ff), ru: new THREE.Color(0xff3b2a) };

const _m = new THREE.Matrix4();
const _m2 = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _q2 = new THREE.Quaternion();
const _e = new THREE.Euler();
const _p = new THREE.Vector3();
const _s = new THREE.Vector3();
const _c = new THREE.Color();
const _v = new THREE.Vector3();
const _q0 = new THREE.Quaternion();
const _local = new THREE.Matrix4();
const UP = new THREE.Vector3(0, 1, 0);
const RU_BAR = new THREE.Color(0xff5533);

export class UnitView {
  constructor(scene, terrain) {
    this.scene = scene;
    this.terrain = terrain;
    this.models = buildModels();
    this.material = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.5, metalness: 0.35, flatShading: true,
    });
    this.meshes = {};
    for (const [kind, model] of Object.entries(this.models)) {
      const cap = CAPACITY[kind] || 100;
      this.meshes[kind] = model.parts.map((p) => {
        const mesh = new THREE.InstancedMesh(p.geo, this.material, cap);
        mesh.count = 0;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = false;
        mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
        mesh.setColorAt(0, _c.set(1, 1, 1));
        scene.add(mesh);
        return mesh;
      });
    }

    // Team rings and aircraft shadows: flat, unlit, see-through.
    const ringGeo = new THREE.RingGeometry(0.78, 1, 32);
    ringGeo.rotateX(-Math.PI / 2);
    this.rings = new THREE.InstancedMesh(ringGeo, new THREE.MeshBasicMaterial({
      transparent: true, opacity: 0.85, depthWrite: false, toneMapped: false,
    }), 2400);
    this.rings.frustumCulled = false;
    this.rings.renderOrder = 2;
    this.rings.setColorAt(0, _c.set(1, 1, 1));
    scene.add(this.rings);
    const discGeo = new THREE.CircleGeometry(1, 24);
    discGeo.rotateX(-Math.PI / 2);
    this.discs = new THREE.InstancedMesh(discGeo, new THREE.MeshBasicMaterial({
      color: 0x000000, transparent: true, opacity: 0.28, depthWrite: false,
    }), 900);
    this.discs.frustumCulled = false;
    this.discs.renderOrder = 1;
    scene.add(this.discs);

    // Health bars: a dark back and a coloured front, turned to face the camera.
    const barGeo = new THREE.PlaneGeometry(1, 1);
    barGeo.translate(0.5, 0, 0);
    this.barBack = new THREE.InstancedMesh(barGeo, new THREE.MeshBasicMaterial({
      color: 0x111111, transparent: true, opacity: 0.75, depthTest: false, toneMapped: false,
    }), 1200);
    this.barFill = new THREE.InstancedMesh(barGeo, new THREE.MeshBasicMaterial({
      depthTest: false, toneMapped: false,
    }), 1200);
    this.barFill.setColorAt(0, _c.set(1, 1, 1));
    for (const b of [this.barBack, this.barFill]) {
      b.frustumCulled = false;
      b.renderOrder = 10;
      scene.add(b);
    }

    this.state = new Map(); // id -> per-unit animation state
    this.time = 0;
  }

  /** Where a unit is drawn right now: interpolated, on the ground or in the air. */
  placeOf(u, alpha, out) {
    const x = u.px == null ? u.x : u.px + (u.x - u.px) * alpha;
    const y = u.py == null ? u.y : u.py + (u.y - u.py) * alpha;
    let h;
    if (u.layer === 'sea') h = 0;
    else if (u.layer === 'land') h = this.terrain.groundAt(x, y);
    else h = Math.max(this.terrain.groundAt(x, y), 0) + u.z;
    return out.set(x, h, -y);
  }

  update(sim, alpha, dt, camera, selectedId) {
    this.time += dt;
    const counts = {};
    for (const k of Object.keys(this.meshes)) counts[k] = 0;
    let rings = 0, discs = 0, bars = 0;
    const seen = new Set();
    const camQ = camera.quaternion;

    for (const u of sim.units) {
      const model = this.models[u.kind];
      const meshes = this.meshes[u.kind];
      if (!model) continue;
      const i = counts[u.kind];
      if (i >= meshes[0].instanceMatrix.count) continue;
      counts[u.kind]++;
      seen.add(u.id);

      let st = this.state.get(u.id);
      if (!st) {
        st = { turret: 0, rotor: Math.random() * 6, radar: Math.random() * 6, born: this.time, bank: 0, bob: Math.random() * 6 };
        this.state.set(u.id, st);
      }

      this.placeOf(u, alpha, _p);
      let dir = u.pdir == null ? u.dir : u.pdir + angleDiff(u.pdir, u.dir) * alpha;

      // Arriving: dropped in from above, growing as it lands.
      const age = this.time - st.born;
      const drop = u.side === 'nato' ? Math.max(0, 1 - age / 0.7) : Math.max(0, 1 - age / 0.4);
      const grow = 1 - drop * drop;
      if (u.side === 'nato' && u.layer !== 'air') _p.y += drop * drop * 60;

      const moving = Math.hypot(u.vx || 0, u.vy || 0) > 1;
      if (u.layer === 'land' && moving) _p.y += Math.abs(Math.sin(this.time * 9 + st.bob)) * (u.kind === 'infantry' || u.kind === 'rifles' ? 0.9 : 0.25);
      if (u.layer === 'sea') _p.y += Math.sin(this.time * 1.6 + st.bob) * 0.3;
      if (u.layer === 'air') _p.y += Math.sin(this.time * 1.3 + st.bob) * 0.8;

      const s = model.scale * grow;
      st.bank += ((u.bank || 0) - st.bank) * Math.min(1, dt * 4);
      const roll = u.layer === 'air' ? -st.bank * 0.7 : u.layer === 'sea' ? Math.sin(this.time * 1.1 + st.bob) * 0.04 : 0;
      const pitch = u.kind === 'iskander' ? -0.5 : 0;
      // Yaw about the vertical first, then roll about the nose, then pitch.
      _q.setFromAxisAngle(UP, dir);
      _q2.setFromEuler(_e.set(roll, 0, pitch));
      _q.multiply(_q2);
      _s.setScalar(s);
      _m.compose(_p, _q, _s);

      // Turret: towards the target if there is one, otherwise back to straight ahead.
      const want = u.target ? angleDiff(dir, u.aim) : 0;
      st.turret += angleDiff(st.turret, want) * Math.min(1, dt * 5);
      st.rotor += dt * 40;
      st.radar += dt * 2.2;

      const flash = this.time - (u.hitAt ?? -9) < 0.08 ? 2.2 : 1;
      if (u.hit !== st.lastHit) {
        st.lastHit = u.hit;
        u.hitAt = this.time;
      }

      model.parts.forEach((p, k) => {
        const mesh = meshes[k];
        if (p.kind === 'body') {
          mesh.setMatrixAt(i, _m);
        } else {
          const pv = p.pivot || [0, 0, 0];
          if (p.kind === 'turret') _local.makeRotationY(st.turret);
          else if (p.kind === 'radar') _local.makeRotationY(st.radar);
          else if (p.kind === 'rotor') _local.makeRotationX(st.rotor);
          _local.setPosition(pv[0], pv[1], pv[2]);
          _m2.multiplyMatrices(_m, _local);
          mesh.setMatrixAt(i, _m2);
        }
        mesh.setColorAt(i, _c.setScalar(flash));
      });

      // Ring, or a shadow on the ground for anything flying.
      const ground = u.layer === 'sea' ? 0.2 : this.terrain.groundAt(_p.x, -_p.z) + 0.25;
      const r = (u.radius || 10) * (u.layer === 'air' ? 0.9 : 1.15) * grow;
      if (rings < this.rings.instanceMatrix.count) {
        _s.set(r, 1, r);
        _m2.compose(_v.set(_p.x, ground, _p.z), _q0, _s);
        this.rings.setMatrixAt(rings, _m2);
        _c.copy(TEAM[u.side]);
        if (u.id === selectedId) _c.set(0xffe066);
        this.rings.setColorAt(rings++, _c);
      }
      if (u.layer === 'air' && discs < this.discs.instanceMatrix.count) {
        const k = r * 0.75;
        _s.set(k, 1, k);
        _m2.compose(_v.set(_p.x, ground + 0.1, _p.z), _q0, _s);
        this.discs.setMatrixAt(discs++, _m2);
      }

      // Health, if hurt or selected.
      const hp = Math.max(0, u.hp / u.maxHp);
      if ((hp < 0.999 || u.id === selectedId) && bars < this.barFill.instanceMatrix.count) {
        const w = Math.max(10, (u.radius || 10) * 1.8);
        const top = _p.y + model.scale * (u.layer === 'sea' ? 7 : u.layer === 'air' ? 2 : 4);
        // Starts half a bar to the camera's left, so it sits centred over the unit.
        _v.set(1, 0, 0).applyQuaternion(camQ);
        _v.multiplyScalar(-w / 2).add(_p).setY(top);
        _m2.compose(_v, camQ, _s.set(w, 1.8, 1));
        this.barBack.setMatrixAt(bars, _m2);
        _m2.compose(_v, camQ, _s.set(w * hp, 1.8, 1));
        this.barFill.setMatrixAt(bars, _m2);
        _c.setHSL(0.33 * hp, 0.9, 0.5);
        if (u.side === 'ru') _c.lerp(RU_BAR, 0.35);
        this.barFill.setColorAt(bars++, _c);
      }
    }

    for (const [kind, meshes] of Object.entries(this.meshes)) {
      for (const mesh of meshes) {
        mesh.count = counts[kind];
        mesh.instanceMatrix.needsUpdate = true;
        if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      }
    }
    this.rings.count = rings;
    this.rings.instanceMatrix.needsUpdate = true;
    if (this.rings.instanceColor) this.rings.instanceColor.needsUpdate = true;
    this.discs.count = discs;
    this.discs.instanceMatrix.needsUpdate = true;
    this.barBack.count = this.barFill.count = bars;
    this.barBack.instanceMatrix.needsUpdate = true;
    this.barFill.instanceMatrix.needsUpdate = true;
    if (this.barFill.instanceColor) this.barFill.instanceColor.needsUpdate = true;

    if (this.state.size > seen.size + 200) {
      for (const id of this.state.keys()) if (!seen.has(id)) this.state.delete(id);
    }
  }

  /** The unit under a screen ray, if any: the nearest whose ring the ray passes through. */
  pick(sim, ray, alpha, side = 'nato') {
    let best = null, bd = Infinity;
    const p = new THREE.Vector3();
    for (const u of sim.units) {
      if (side && u.side !== side) continue;
      this.placeOf(u, alpha, p);
      const d = ray.distanceToPoint(p);
      const reach = Math.max(14, (u.radius || 10) * 1.6);
      if (d < reach && d < bd) { bd = d; best = u; }
    }
    return best;
  }
}

export function angleDiff(a, b) {
  return Math.atan2(Math.sin(b - a), Math.cos(b - a));
}
