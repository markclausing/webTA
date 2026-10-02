/**
 * The picture: three.js, physically based, through a post chain.
 *
 *   scene -> bloom -> tilt-shift -> grade (vignette, warmth) -> tone map -> SMAA
 *
 * The tilt-shift is what makes a continent look like a table you could lean
 * over: everything above and below a band across the middle of the screen goes
 * soft, the way a macro lens does it, and the eye reads the whole thing as a
 * model. It is the Kingdom Rush half of the look; the units are the Total
 * Annihilation half.
 *
 * Everything that costs real time hangs off a quality level, and the level
 * steps down by itself if the frame rate drops for a while.
 */

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';

export const QUALITY = {
  low: { ratio: 1, shadow: 0, bloom: false, tilt: false, smaa: false, terrain: 256, trees: 0.25 },
  medium: { ratio: 1.5, shadow: 1024, bloom: true, tilt: true, smaa: false, terrain: 384, trees: 0.55 },
  high: { ratio: 1.75, shadow: 2048, bloom: true, tilt: true, smaa: true, terrain: 512, trees: 1 },
  ultra: { ratio: 2, shadow: 4096, bloom: true, tilt: true, smaa: true, terrain: 768, trees: 1.4 },
};
export const QUALITY_ORDER = ['low', 'medium', 'high', 'ultra'];

/** A first guess: phones and small screens start lower, everything else high. */
export function guessQuality() {
  const touch = matchMedia?.('(pointer: coarse)').matches;
  const small = Math.min(screen.width, screen.height) < 700;
  if (touch || small) return 'medium';
  return 'high';
}

const TiltShader = {
  uniforms: {
    tDiffuse: { value: null },
    uDir: { value: new THREE.Vector2(1, 0) },
    uAmount: { value: 1.6 },
    uFocus: { value: 0.5 },
    uBand: { value: 0.24 },
    uRes: { value: new THREE.Vector2(1, 1) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform vec2 uDir, uRes;
    uniform float uAmount, uFocus, uBand;
    varying vec2 vUv;
    void main() {
      float d = max(0.0, abs(vUv.y - uFocus) - uBand);
      float r = d * d * 30.0 * uAmount;
      vec2 step = uDir / uRes * r;
      vec4 sum = texture2D(tDiffuse, vUv) * 0.2270270270;
      sum += texture2D(tDiffuse, vUv + step * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv - step * 1.3846153846) * 0.3162162162;
      sum += texture2D(tDiffuse, vUv + step * 3.2307692308) * 0.0702702703;
      sum += texture2D(tDiffuse, vUv - step * 3.2307692308) * 0.0702702703;
      gl_FragColor = sum;
    }
  `,
};

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uVignette: { value: 0.38 },
    uSaturation: { value: 1.12 },
    uFlash: { value: 0 },
    uAlarm: { value: 0 },
  },
  vertexShader: TiltShader.vertexShader,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uVignette, uSaturation, uFlash, uAlarm;
    varying vec2 vUv;
    void main() {
      vec3 col = texture2D(tDiffuse, vUv).rgb;
      float l = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(l), col, uSaturation);
      vec2 c = vUv - 0.5;
      float r2 = dot(c, c);
      col *= 1.0 - uVignette * smoothstep(0.1, 0.7, r2 * 1.8);
      // The edge of the screen goes red when a city falls.
      col = mix(col, col * vec3(1.5, 0.35, 0.3), uAlarm * smoothstep(0.12, 0.5, r2 * 1.8));
      col += uFlash * vec3(1.0, 0.9, 0.75);
      gl_FragColor = vec4(max(col, 0.0), 1.0);
    }
  `,
};

export class Renderer {
  constructor(canvas, quality = 'high') {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    const r = this.renderer;
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.0;
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(36, 16 / 9, 2, 16000);
    this.frameTimes = [];
    this.onQuality = null;
    this.autoAdjust = false;
    this.alarm = 0;
    this.flash = 0;
    this.setQuality(quality);
  }

  setQuality(level) {
    if (!QUALITY[level]) level = 'high';
    this.level = level;
    this.q = QUALITY[level];
    const r = this.renderer;
    r.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.q.ratio));
    r.shadowMap.enabled = this.q.shadow > 0;
    this.buildComposer();
    this.resize();
    this.onQuality?.(level, this.q);
  }

  buildComposer() {
    const r = this.renderer;
    this.composer?.dispose?.();
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    const composer = new EffectComposer(r, target);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = null;
    if (this.q.bloom) {
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.45, 1.05);
      composer.addPass(this.bloom);
    }
    this.tilt = [];
    if (this.q.tilt) {
      for (const dir of [[1, 0], [0, 1]]) {
        const p = new ShaderPass(TiltShader);
        p.uniforms.uDir.value.set(dir[0], dir[1]);
        composer.addPass(p);
        this.tilt.push(p);
      }
    }
    this.grade = new ShaderPass(GradeShader);
    composer.addPass(this.grade);
    composer.addPass(new OutputPass());
    if (this.q.smaa) composer.addPass(new SMAAPass(size.x, size.y));
    this.composer = composer;
  }

  resize() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.composer?.setSize(w, h);
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    for (const p of this.tilt || []) p.uniforms.uRes.value.set(size.x, size.y);
  }

  /** How strong the miniature look is: more when the camera is close in. */
  setTilt(amount) {
    for (const p of this.tilt) p.uniforms.uAmount.value = amount;
  }

  render(dt) {
    this.alarm = Math.max(0, this.alarm - dt * 0.6);
    this.flash = Math.max(0, this.flash - dt * 3);
    this.grade.uniforms.uAlarm.value = this.alarm;
    this.grade.uniforms.uFlash.value = this.flash;
    this.composer.render(dt);
    this.watch(dt);
  }

  /**
   * Steps the quality down if the game has been running slow for a while. Never
   * up: a machine that struggled once will struggle again, and flicking between
   * two levels is worse than either of them.
   */
  watch(dt) {
    if (!this.autoAdjust) return;
    this.frameTimes.push(dt);
    if (this.frameTimes.length < 240) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1];
    this.frameTimes.length = 0;
    const at = QUALITY_ORDER.indexOf(this.level);
    if (median > 1 / 40 && at > 0) this.setQuality(QUALITY_ORDER[at - 1]);
  }
}
