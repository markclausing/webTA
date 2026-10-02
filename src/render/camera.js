/**
 * The general's view: looking down on the map at an angle, the way you would
 * lean over a table. Drag to move it, pinch or scroll to zoom; zooming in tips
 * the camera a little lower, so close up you see the units side-on and far out
 * you see the whole continent like an atlas.
 *
 * Everything eases towards a target, so a flick of the finger keeps gliding and
 * a jump to a city is a move rather than a cut.
 */

import * as THREE from 'three';
import { X0, X1, Y0, Y1 } from '../game/map.js';

export const ZOOM_MIN = 260;
export const ZOOM_MAX = 4200;

export class CameraRig {
  constructor(camera) {
    this.camera = camera;
    // Where on the map the camera looks, in map kilometres, and how far away it is.
    this.x = 1000;
    this.y = 650;
    this.dist = 1500;
    this.want = { x: this.x, y: this.y, dist: this.dist };
    this.vel = { x: 0, y: 0 };
    this.yaw = 0;
    this.shake = 0;
    this.time = 0;
    this.glide = null;
  }

  /** How steep the view is at a given distance: lower close in, near top-down far out. */
  pitch(dist) {
    const t = (dist - ZOOM_MIN) / (ZOOM_MAX - ZOOM_MIN);
    return THREE.MathUtils.lerp(0.72, 1.12, Math.pow(Math.max(0, Math.min(1, t)), 0.6));
  }

  pan(dx, dy) {
    this.want.x += dx;
    this.want.y += dy;
    this.clamp();
  }

  /** Zoom by a factor, keeping the map point (ax, ay) under the same spot on screen. */
  zoom(factor, ax = null, ay = null) {
    const before = this.want.dist;
    this.want.dist = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, this.want.dist * factor));
    const k = 1 - this.want.dist / before;
    if (ax != null) {
      this.want.x += (ax - this.want.x) * k;
      this.want.y += (ay - this.want.y) * k;
    }
    this.clamp();
  }

  flyTo(x, y, dist = null) {
    this.want.x = x;
    this.want.y = y;
    if (dist) this.want.dist = dist;
    this.vel.x = this.vel.y = 0;
    this.clamp();
  }

  fling(vx, vy) {
    this.vel.x = vx;
    this.vel.y = vy;
  }

  clamp() {
    const m = 200;
    this.want.x = Math.max(X0 + m, Math.min(X1 - m, this.want.x));
    this.want.y = Math.max(Y0 + m - this.want.dist * 0.35, Math.min(Y1 - m, this.want.y));
  }

  update(dt, shake = 0) {
    this.time += dt;
    // Momentum after a flick, bleeding off.
    if (Math.abs(this.vel.x) + Math.abs(this.vel.y) > 1) {
      this.want.x += this.vel.x * dt;
      this.want.y += this.vel.y * dt;
      const k = Math.exp(-dt * 4);
      this.vel.x *= k;
      this.vel.y *= k;
      this.clamp();
    }
    const k = 1 - Math.exp(-dt * 9);
    this.x += (this.want.x - this.x) * k;
    this.y += (this.want.y - this.y) * k;
    this.dist += (this.want.dist - this.dist) * (1 - Math.exp(-dt * 7));

    const cam = this.camera;
    const portrait = cam.aspect < 1;
    cam.fov = portrait ? 50 : 36;
    cam.updateProjectionMatrix();

    const pitch = this.pitch(this.dist);
    const d = this.dist * (portrait ? 1.25 : 1);
    const lx = this.x, lz = -this.y;
    const cx = lx + Math.sin(this.yaw) * Math.cos(pitch) * d;
    const cz = lz + Math.cos(this.yaw) * Math.cos(pitch) * d;
    const cy = Math.sin(pitch) * d;
    const sh = (this.shake + shake) * this.dist * 0.006;
    cam.position.set(cx + (Math.random() - 0.5) * sh, cy + (Math.random() - 0.5) * sh, cz + (Math.random() - 0.5) * sh);
    cam.lookAt(lx, 0, lz);
    cam.far = d * 6 + 2000;
    cam.near = Math.max(2, d * 0.02);
    cam.updateProjectionMatrix();
  }

  /** The map point under a screen position (pixels), on the water plane, refined against the ground. */
  pick(px, py, w, h, groundAt) {
    const ndc = new THREE.Vector2((px / w) * 2 - 1, -(py / h) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const o = ray.ray.origin, dv = ray.ray.direction;
    if (dv.y >= -1e-4) return null;
    let level = 0;
    let t = 0;
    for (let i = 0; i < 4; i++) {
      t = (level - o.y) / dv.y;
      const x = o.x + dv.x * t, z = o.z + dv.z * t;
      level = groundAt ? groundAt(x, -z) : 0;
    }
    return { x: o.x + dv.x * t, y: -(o.z + dv.z * t), ray: ray.ray };
  }
}
