/**
 * Every sound in the game, synthesised: nothing is loaded.
 *
 * Gunfire is filtered noise with a sharp edge, a tank gun is a thump under a
 * crack, an explosion is noise falling through a low-pass, a missile is a hiss
 * that rises. A wave starts with a siren and a city falls to a low bell.
 *
 * A war has a lot of guns in it, so each kind of sound has a budget per tenth
 * of a second and is quieter the further it is from where you are looking.
 */

export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
    this.budget = new Map();
    this.listener = { x: 0, y: 0, dist: 1500 };
  }

  /** Browsers only allow sound after a gesture; call this from one. */
  unlock() {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') this.ctx.resume();
      return;
    }
    try {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      this.ctx = null;
      return;
    }
    const c = this.ctx;
    this.master = c.createGain();
    this.master.gain.value = 0.55;
    const comp = c.createDynamicsCompressor();
    comp.threshold.value = -16;
    comp.ratio.value = 6;
    this.master.connect(comp).connect(c.destination);
    // A second of white noise, reused by everything that needs it.
    this.noise = c.createBuffer(1, c.sampleRate, c.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  setEnabled(on) {
    this.enabled = on;
    if (this.master) this.master.gain.value = on ? 0.55 : 0;
  }

  /** How loud something at (x, y) is from where the camera is. */
  near(x, y) {
    if (x == null) return 1;
    const l = this.listener;
    const d = Math.hypot(x - l.x, y - l.y);
    const reach = l.dist * 0.9;
    const v = Math.max(0, 1 - d / reach) * Math.min(1, 900 / l.dist + 0.25);
    return v;
  }

  allow(kind, per) {
    if (!this.ctx || !this.enabled) return false;
    const now = this.ctx.currentTime;
    const b = this.budget.get(kind) || { t: 0, n: 0 };
    if (now - b.t > 0.1) { b.t = now; b.n = 0; }
    if (b.n >= per) return false;
    b.n++;
    this.budget.set(kind, b);
    return true;
  }

  burst({ gain = 0.5, dur = 0.2, f0 = 1000, f1 = 300, q = 0.7, type = 'lowpass', delay = 0 }) {
    const c = this.ctx;
    const t = c.currentTime + delay;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.7 + Math.random() * 0.6;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    f.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.05);
  }

  tone({ gain = 0.3, dur = 0.3, f0 = 440, f1 = f0, type = 'sine', delay = 0, attack = 0.01 }) {
    const c = this.ctx;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // --- the sounds ---------------------------------------------------------------

  shot(kind, x, y) {
    const v = this.near(x, y);
    if (v < 0.03) return;
    if (kind === 'bullet') {
      if (!this.allow('bullet', 3)) return;
      this.burst({ gain: 0.12 * v, dur: 0.07, f0: 3500, f1: 900, type: 'bandpass', q: 1.2 });
    } else if (kind === 'shell') {
      if (!this.allow('shell', 2)) return;
      this.burst({ gain: 0.4 * v, dur: 0.35, f0: 1800, f1: 120 });
      this.tone({ gain: 0.3 * v, dur: 0.25, f0: 110, f1: 40 });
    } else {
      if (!this.allow('missile', 2)) return;
      this.burst({ gain: 0.16 * v, dur: 0.7, f0: 400, f1: 3000, type: 'bandpass', q: 2 });
    }
  }

  boom(size, x, y) {
    const v = this.near(x, y);
    if (v < 0.03 || !this.allow(size > 8 ? 'bigboom' : 'boom', size > 8 ? 2 : 3)) return;
    const k = Math.min(1, size / 12);
    this.burst({ gain: (0.25 + 0.45 * k) * v, dur: 0.5 + k * 1.1, f0: 900 + 600 * k, f1: 50 });
    this.tone({ gain: (0.2 + 0.4 * k) * v, dur: 0.4 + k * 0.6, f0: 90, f1: 30, attack: 0.005 });
  }

  jet(x, y) {
    const v = this.near(x, y);
    if (v < 0.1 || !this.allow('jet', 1)) return;
    this.burst({ gain: 0.18 * v, dur: 1.6, f0: 300, f1: 1800, type: 'bandpass', q: 0.8 });
  }

  deploy() {
    if (!this.allow('ui', 4)) return;
    this.tone({ gain: 0.2, dur: 0.12, f0: 520, f1: 780, type: 'triangle' });
    this.tone({ gain: 0.15, dur: 0.2, f0: 780, f1: 1040, type: 'triangle', delay: 0.08 });
    this.burst({ gain: 0.2, dur: 0.4, f0: 600, f1: 90, delay: 0.25 });
  }

  click() {
    if (!this.allow('ui', 4)) return;
    this.tone({ gain: 0.12, dur: 0.06, f0: 900, f1: 700, type: 'square' });
  }

  deny() {
    if (!this.allow('ui', 4)) return;
    this.tone({ gain: 0.14, dur: 0.18, f0: 180, f1: 140, type: 'square' });
  }

  coin() {
    if (!this.allow('ui', 4)) return;
    this.tone({ gain: 0.14, dur: 0.1, f0: 1300, type: 'triangle' });
    this.tone({ gain: 0.14, dur: 0.25, f0: 1950, type: 'triangle', delay: 0.07 });
  }

  upgrade() {
    if (!this.allow('ui', 4)) return;
    [523, 659, 784, 1046].forEach((f, i) => this.tone({ gain: 0.14, dur: 0.18, f0: f, type: 'triangle', delay: i * 0.06 }));
  }

  siren() {
    if (!this.ctx || !this.enabled) return;
    const c = this.ctx;
    const t = c.currentTime;
    const o = c.createOscillator();
    o.type = 'sawtooth';
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    const g = c.createGain();
    o.frequency.setValueAtTime(320, t);
    o.frequency.linearRampToValueAtTime(620, t + 1.1);
    o.frequency.linearRampToValueAtTime(330, t + 2.4);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09, t + 0.4);
    g.gain.setValueAtTime(0.09, t + 1.9);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 2.5);
    o.connect(f).connect(g).connect(this.master);
    o.start(t);
    o.stop(t + 2.6);
  }

  bell() {
    if (!this.ctx || !this.enabled) return;
    for (const [f, k] of [[110, 1], [220, 0.5], [331, 0.3], [440, 0.15]]) {
      this.tone({ gain: 0.25 * k, dur: 2.8, f0: f, type: 'sine', attack: 0.004 });
    }
  }

  fanfare(win) {
    if (!this.ctx || !this.enabled) return;
    const notes = win ? [392, 523, 659, 784, 1046] : [392, 349, 311, 262];
    notes.forEach((f, i) => this.tone({ gain: 0.18, dur: 0.5, f0: f, type: 'triangle', delay: i * 0.18 }));
  }
}
