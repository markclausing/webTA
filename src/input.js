/**
 * Fingers, mice and touchpads, turned into four things the game cares about:
 *
 *   pan     one finger or a held mouse button dragging the map
 *   zoom    a pinch, a scroll wheel, or a two-finger swipe on a touchpad
 *   tap     a press and release that did not wander (click, or a touch)
 *   order   a right click: "go there", for the unit you have selected
 *
 * Pointer Events cover all of it, so a laptop with a touch screen and a mouse
 * plugged in does what you would expect with both.
 */

const TAP_SLOP = 9; // px a press may wander and still count as a tap

export class Input {
  constructor(el, handlers) {
    this.el = el;
    this.h = handlers;
    this.pointers = new Map();
    this.drag = null;
    this.pinch = null;
    this.keys = new Set();
    this.mouse = { x: innerWidth / 2, y: innerHeight / 2, inside: false };
    this.history = [];

    el.addEventListener('pointerdown', (e) => this.down(e));
    el.addEventListener('pointermove', (e) => this.move(e));
    el.addEventListener('pointerup', (e) => this.up(e));
    el.addEventListener('pointercancel', (e) => this.up(e, true));
    el.addEventListener('pointerleave', () => { this.mouse.inside = false; });
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    // Safari's own pinch, on a Mac trackpad.
    el.addEventListener('gesturestart', (e) => { e.preventDefault(); this.gScale = 1; });
    el.addEventListener('gesturechange', (e) => {
      e.preventDefault();
      this.h.zoom?.(this.gScale / e.scale, e.clientX, e.clientY);
      this.gScale = e.scale;
    });
    addEventListener('keydown', (e) => {
      if (e.target instanceof HTMLInputElement) return;
      this.keys.add(e.code);
      this.h.key?.(e);
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
  }

  down(e) {
    this.el.setPointerCapture?.(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, type: e.pointerType });
    this.mouse = { x: e.clientX, y: e.clientY, inside: true };
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      this.drag = null;
      this.cancelTap = true;
    } else if (this.pointers.size === 1) {
      this.cancelTap = false;
      this.drag = { x: e.clientX, y: e.clientY, moved: false };
      this.history = [{ x: e.clientX, y: e.clientY, t: performance.now() }];
      this.h.press?.();
    }
  }

  move(e) {
    this.mouse = { x: e.clientX, y: e.clientY, inside: true };
    const p = this.pointers.get(e.pointerId);
    if (!p) {
      this.h.hover?.(e.clientX, e.clientY);
      return;
    }
    p.x = e.clientX;
    p.y = e.clientY;
    if (this.pinch && this.pointers.size >= 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      if (d > 0 && this.pinch.d > 0) this.h.zoom?.(this.pinch.d / d, mx, my);
      this.h.pan?.(mx - this.pinch.mx, my - this.pinch.my);
      this.pinch = { d, mx, my };
      return;
    }
    if (this.drag) {
      const dx = e.clientX - this.drag.x, dy = e.clientY - this.drag.y;
      if (!this.drag.moved && Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > TAP_SLOP) this.drag.moved = true;
      if (this.drag.moved && p.button !== 2) this.h.pan?.(dx, dy);
      this.drag.x = e.clientX;
      this.drag.y = e.clientY;
      this.history.push({ x: e.clientX, y: e.clientY, t: performance.now() });
      if (this.history.length > 6) this.history.shift();
    }
  }

  up(e, cancelled = false) {
    const p = this.pointers.get(e.pointerId);
    this.pointers.delete(e.pointerId);
    if (!p) return;
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 1) {
      // One finger lifted from a pinch: carry on dragging with the other, quietly.
      const [q] = [...this.pointers.values()];
      this.drag = { x: q.x, y: q.y, moved: true };
      return;
    }
    if (cancelled || this.cancelTap) {
      this.drag = null;
      return;
    }
    const moved = this.drag?.moved;
    this.drag = null;
    if (!moved) {
      if (p.button === 2) this.h.order?.(e.clientX, e.clientY);
      else this.h.tap?.(e.clientX, e.clientY, p.type);
      return;
    }
    // A flick keeps the map gliding.
    const h = this.history;
    if (h.length >= 2) {
      const a = h[0], b = h[h.length - 1];
      const dt = (b.t - a.t) / 1000;
      if (dt > 0 && dt < 0.25 && performance.now() - b.t < 80) this.h.fling?.((b.x - a.x) / dt, (b.y - a.y) / dt);
    }
  }

  wheel(e) {
    e.preventDefault();
    if (e.ctrlKey) {
      // Pinch on a touchpad arrives as a wheel with ctrl held.
      this.h.zoom?.(Math.exp(e.deltaY * 0.012), e.clientX, e.clientY);
    } else if (e.deltaMode === 0 && Math.abs(e.deltaX) > 0.5 && Math.abs(e.deltaY) < 50) {
      // Two fingers sliding on a touchpad: pan, like every map on a laptop.
      this.h.pan?.(-e.deltaX, -e.deltaY);
    } else {
      const k = e.deltaMode === 1 ? 0.06 : 0.0016;
      this.h.zoom?.(Math.exp(e.deltaY * k), e.clientX, e.clientY);
    }
  }
}
