/**
 * Europe, as a table-top model.
 *
 * The land is one mesh, its height read from real elevation data and then
 * exaggerated: at true scale the Alps would be a crease you could not see from
 * a hundred kilometres up, which is where the camera lives. The colour is all
 * shader - latitude decides between olive groves, farmland and taiga, height
 * brings rock and then snow, and the coast gets a strip of sand.
 *
 * On top of that is the war: who holds every 25 km cell comes in as a small
 * texture, filtered so the front line is a soft curve rather than a staircase,
 * and the shader paints the enemy's ground in rust, freshly taken ground in
 * hatched red, and the line between them in a glow that breathes.
 *
 * The sea is a separate plane with its own shader: colour by depth, waves, sun
 * glint and lines of surf that roll in at every coast, the way a painted map
 * would draw them.
 */

import * as THREE from 'three';
import { X0, Y0, X1, Y1, COLS, ROWS, SHAPES, LAKES, COUNTRIES, CITIES, FRIEND, HOSTILE } from '../game/map.js';

const W = X1 - X0;
const H = Y1 - Y0;
const MASK = 2048;
const CPU = 1024;

/** Map kilometres to world: x east, z south, y up. */
export const toWorld = (x, y) => [x, -y];

export function landHeight(e) {
  return 0.6 + 26 * Math.pow(Math.max(0, e) / 4800, 0.8);
}
export function seaHeight(d) {
  return -1.4 - 16 * Math.sqrt(Math.max(0, d) / 5500);
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

function canvas(w, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

/** Traces a flat [x, y, x, y...] ring of map kilometres onto a canvas of size s. */
function trace(ctx, ring, s) {
  ctx.moveTo(((ring[0] - X0) / W) * s, ((Y1 - ring[1]) / H) * s);
  for (let i = 2; i < ring.length; i += 2) ctx.lineTo(((ring[i] - X0) / W) * s, ((Y1 - ring[i + 1]) / H) * s);
  ctx.closePath();
}

function drawLand(ctx, s) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, s, s);
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  for (const [, outer, ...holes] of SHAPES) {
    trace(ctx, outer, s);
    for (const h of holes) trace(ctx, h, s);
  }
  ctx.fill('evenodd');
  ctx.fillStyle = '#000';
  ctx.beginPath();
  for (const l of LAKES) trace(ctx, l, s);
  ctx.fill();
}

/** Separable box blur, three times over, which is near enough a gaussian. */
function blur(src, w, h, r) {
  let a = Float32Array.from(src);
  let b = new Float32Array(a.length);
  for (let pass = 0; pass < 3; pass++) {
    for (let y = 0; y < h; y++) {
      let sum = 0;
      for (let x = -r; x <= r; x++) sum += a[y * w + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[y * w + x] = sum / (2 * r + 1);
        sum += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let y = -r; y <= r; y++) sum += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = sum / (2 * r + 1);
        sum += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

const NOISE = /* glsl */`
  float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
  }
  float vnoise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1, 0)), u.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float s = 0.0, a = 0.5;
    for (int k = 0; k < 4; k++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
    return s;
  }
`;

export class Terrain {
  constructor(scene, quality) {
    this.scene = scene;
    this.q = quality;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.uniforms = {
      uTime: { value: 0 },
      uOwner: { value: null },
      uLand: { value: null },
      uCoast: { value: null },
      uRelief: { value: null },
      uSun: { value: new THREE.Vector3(-0.45, 0.75, 0.5).normalize() },
      uFogColor: { value: new THREE.Color('#8fb3c9') },
      uFogNear: { value: 3000 },
      uFogFar: { value: 9000 },
      uHighlight: { value: 0 },
    };
  }

  async build(reliefUrl) {
    const relief = await loadImage(reliefUrl);

    // Land, at two sizes: a sharp one for the GPU and a small one to read back.
    const land = canvas(MASK);
    const lctx = land.getContext('2d');
    drawLand(lctx, MASK);
    // Borders: every country outline stroked, which the shader keeps inland only.
    lctx.globalCompositeOperation = 'source-over';
    const borders = canvas(MASK);
    const bctx = borders.getContext('2d');
    bctx.strokeStyle = '#fff';
    bctx.lineWidth = 1.5;
    bctx.lineJoin = 'round';
    for (const [index, outer] of SHAPES) {
      if (COUNTRIES[index].role === 'outside' && COUNTRIES[index].code !== 'GEO') continue;
      bctx.beginPath();
      trace(bctx, outer, MASK);
      bctx.stroke();
    }
    // Pack: red is land, green is borders.
    const li = lctx.getImageData(0, 0, MASK, MASK);
    const bi = bctx.getImageData(0, 0, MASK, MASK);
    // Softened a touch, so the line is smooth when the camera is close.
    const strokes = new Float32Array(MASK * MASK);
    for (let i = 0; i < strokes.length; i++) strokes[i] = bi.data[i * 4];
    const soft = blur(strokes, MASK, MASK, 1);
    for (let i = 0; i < li.data.length; i += 4) {
      li.data[i + 1] = Math.min(255, soft[i / 4] * 1.6);
      li.data[i + 2] = 0;
    }
    lctx.putImageData(li, 0, 0);
    this.landTex = new THREE.CanvasTexture(land);
    this.landTex.anisotropy = 4;
    this.landTex.colorSpace = THREE.NoColorSpace;

    const small = canvas(CPU);
    const sctx = small.getContext('2d');
    drawLand(sctx, CPU);
    const sd = sctx.getImageData(0, 0, CPU, CPU).data;
    this.mask = new Float32Array(CPU * CPU);
    for (let i = 0; i < CPU * CPU; i++) this.mask[i] = sd[i * 4] / 255;

    // The coast, blurred both ways: surf on the water side, sand on the land side.
    const C = 512;
    const down = new Float32Array(C * C);
    for (let y = 0; y < C; y++) for (let x = 0; x < C; x++) down[y * C + x] = this.mask[(y * 2) * CPU + x * 2];
    const wide = blur(down, C, C, 5);
    const tight = blur(down, C, C, 2);
    const coastData = new Uint8Array(C * C * 4);
    // Rows flipped on the way in: the canvas has north at the top, a texture at v = 1.
    for (let y = 0; y < C; y++) {
      for (let x = 0; x < C; x++) {
        const i = y * C + x, o = ((C - 1 - y) * C + x) * 4;
        coastData[o] = Math.round(wide[i] * 255);
        coastData[o + 1] = Math.round(tight[i] * 255);
        coastData[o + 3] = 255;
      }
    }
    this.coastTex = new THREE.DataTexture(coastData, C, C, THREE.RGBAFormat);
    this.coastTex.magFilter = THREE.LinearFilter;
    this.coastTex.minFilter = THREE.LinearFilter;
    this.coastTex.needsUpdate = true;

    // Heights, read back from the relief image.
    const rc = canvas(relief.width, relief.height);
    const rctx = rc.getContext('2d', { willReadFrequently: true });
    rctx.drawImage(relief, 0, 0);
    const rd = rctx.getImageData(0, 0, relief.width, relief.height).data;
    this.rw = relief.width;
    this.rh = relief.height;
    this.elevArr = new Float32Array(this.rw * this.rh);
    for (let i = 0; i < this.rw * this.rh; i++) {
      const up = (rd[i * 4] / 255) ** 2 * 4800;
      const deep = (rd[i * 4 + 1] / 255) ** 2 * 5500;
      this.elevArr[i] = up > 0 ? up : -deep;
    }
    this.reliefTex = new THREE.Texture(relief);
    this.reliefTex.colorSpace = THREE.NoColorSpace;
    this.reliefTex.minFilter = THREE.LinearFilter;
    this.reliefTex.needsUpdate = true;

    // Who holds what: one texel per cell.
    this.ownerData = new Uint8Array(COLS * ROWS * 4);
    this.ownerTex = new THREE.DataTexture(this.ownerData, COLS, ROWS, THREE.RGBAFormat);
    this.ownerTex.magFilter = THREE.LinearFilter;
    this.ownerTex.minFilter = THREE.LinearFilter;

    Object.assign(this.uniforms, {
      uOwner: { value: this.ownerTex },
      uLand: { value: this.landTex },
      uCoast: { value: this.coastTex },
      uRelief: { value: this.reliefTex },
    });

    this.buildLand();
    this.buildSea();
    this.buildTrees();
    this.buildCities();
  }

  /** Bilinear read of a float grid laid over the map, row 0 north. */
  sample(arr, w, h, x, y) {
    const fx = ((x - X0) / W) * w - 0.5;
    const fy = ((Y1 - y) / H) * h - 0.5;
    const ix = Math.max(0, Math.min(w - 2, Math.floor(fx)));
    const iy = Math.max(0, Math.min(h - 2, Math.floor(fy)));
    const tx = Math.max(0, Math.min(1, fx - ix)), ty = Math.max(0, Math.min(1, fy - iy));
    const a = arr[iy * w + ix], b = arr[iy * w + ix + 1];
    const c = arr[(iy + 1) * w + ix], d = arr[(iy + 1) * w + ix + 1];
    return (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
  }

  maskAt(x, y) {
    return this.sample(this.mask, CPU, CPU, x, y);
  }

  elevationAt(x, y) {
    return this.sample(this.elevArr, this.rw, this.rh, x, y);
  }

  /** The height of the model's surface at a map position, water level being zero. */
  heightAt(x, y) {
    if (x < X0 || x > X1 || y < Y0 || y > Y1) return seaHeight(3000);
    const m = this.maskAt(x, y);
    const e = this.elevationAt(x, y);
    const t = Math.max(0, Math.min(1, (m - 0.3) / 0.4));
    const s = t * t * (3 - 2 * t);
    return seaHeight(Math.max(0, -e)) * (1 - s) + landHeight(e) * s;
  }

  /** Ground height for something standing on it: never below the water. */
  groundAt(x, y) {
    return Math.max(0, this.heightAt(x, y));
  }

  buildLand() {
    const seg = this.q.terrain;
    const geo = new THREE.PlaneGeometry(W, H, seg, seg);
    geo.rotateX(-Math.PI / 2);
    geo.translate(X0 + W / 2, 0, -(Y0 + H / 2));
    const pos = geo.attributes.position;
    const step = W / seg;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = -pos.getZ(i);
      // Near land, the mesh stays above the water and the shader cuts the coast;
      // further out it drops to the sea floor, which nobody sees.
      let near = 0;
      for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) near = Math.max(near, this.maskAt(x + dx * step, y + dy * step));
      const e = this.elevationAt(x, y);
      pos.setY(i, near > 0.01 ? landHeight(Math.max(0, e)) * Math.min(1, 0.3 + this.maskAt(x, y)) + 0.35 : seaHeight(Math.max(0, -e)));
    }
    geo.computeVertexNormals();

    const mat = new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 });
    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
          varying vec2 vMap;
          varying float vSlope;
          varying float vH;
          varying float vViewDist;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          vMap = uv;
          vSlope = 1.0 - normal.y;
          vH = position.y;`)
        .replace('#include <project_vertex>', `#include <project_vertex>
          vViewDist = -mvPosition.z;`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
          uniform sampler2D uOwner, uLand, uCoast, uRelief;
          uniform float uTime, uHighlight;
          varying vec2 vMap;
          varying float vSlope;
          varying float vH;
          varying float vViewDist;
          vec3 frontGlow;
          ${NOISE}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
          {
            vec4 lnd = texture2D(uLand, vMap);
            // The coast is wherever the sharp mask says, not wherever the mesh
            // happens to cross the water: the sea shows through the gap.
            if (lnd.r < 0.5) discard;
            vec4 cst = texture2D(uCoast, vMap);
            float relief = texture2D(uRelief, vMap).r;
            float elev = relief * relief * 4800.0;
            float lat = vMap.y;
            float n = fbm(vMap * 90.0);
            float n2 = fbm(vMap * 400.0 + 3.0);

            // Latitude: dry south, farmland in the middle, taiga, then tundra.
            vec3 dry = vec3(0.62, 0.58, 0.33);
            vec3 farm = vec3(0.36, 0.55, 0.22);
            vec3 field2 = vec3(0.55, 0.6, 0.27);
            vec3 taiga = vec3(0.2, 0.37, 0.2);
            vec3 tundra = vec3(0.52, 0.53, 0.42);
            vec3 col = mix(dry, farm, smoothstep(0.2, 0.42, lat + (n - 0.5) * 0.12));
            col = mix(col, field2, smoothstep(0.55, 0.8, n2) * 0.6 * (1.0 - smoothstep(0.6, 0.75, lat)));
            col = mix(col, taiga, smoothstep(0.6, 0.72, lat + (n - 0.5) * 0.08));
            col = mix(col, tundra, smoothstep(0.86, 0.95, lat + (n - 0.5) * 0.06));
            col *= 0.86 + n * 0.28;

            // Height: rock, then snow, lower in the north.
            float rockiness = smoothstep(700.0, 1700.0, elev + (n - 0.5) * 500.0) + smoothstep(0.08, 0.25, vSlope) * 0.6;
            col = mix(col, vec3(0.47, 0.42, 0.37) * (0.85 + n2 * 0.3), clamp(rockiness, 0.0, 1.0));
            float snowline = 2300.0 - lat * 1700.0;
            col = mix(col, vec3(0.95, 0.96, 1.0), smoothstep(snowline, snowline + 400.0, elev + (n2 - 0.5) * 300.0) * (1.0 - smoothstep(0.35, 0.6, vSlope)));

            // A strip of sand where the land meets the sea, if the coast is low.
            float beach = smoothstep(0.66, 0.5, cst.g) * (1.0 - smoothstep(40.0, 200.0, elev));
            col = mix(col, vec3(0.86, 0.78, 0.55), beach * 0.75);

            // The war. r: enemy holds it. g: it was ours. b: nobody's business.
            vec4 own = texture2D(uOwner, vMap);
            float enemy = smoothstep(0.42, 0.58, own.r);
            float lost = enemy * own.g;
            vec3 rust = vec3(dot(col, vec3(0.3, 0.55, 0.15))) * vec3(1.02, 0.74, 0.64);
            col = mix(col, rust, enemy * (1.0 - own.g) * 0.72);
            float hatch = step(0.5, fract((vMap.x + vMap.y) * 260.0 + uTime * 0.15));
            col = mix(col, mix(vec3(0.62, 0.1, 0.07), vec3(0.78, 0.18, 0.1), hatch), lost * 0.62);
            col = mix(col, col * 0.55 + vec3(0.08), own.b * 0.7);

            // Borders, inland only, darker where they divide the two sides.
            float inland = smoothstep(0.88, 0.98, cst.g);
            float border = smoothstep(0.35, 0.85, lnd.g) * inland * (1.0 - own.b * 0.6);
            col = mix(col, vec3(0.16, 0.13, 0.1), border * 0.42);

            // The front: a thin line where enemy ground meets ours, that breathes.
            float edge = 1.0 - abs(own.r - 0.5) * 2.0;
            edge = smoothstep(0.55, 0.95, edge) * (1.0 - own.b) * smoothstep(0.85, 1.0, own.a);
            frontGlow = vec3(1.0, 0.35, 0.08) * edge * (0.9 + 0.6 * sin(uTime * 3.0 + vMap.x * 300.0));

            // Everything above is picked by eye in sRGB; lighting wants it linear.
            diffuseColor.rgb = pow(col, vec3(2.2));
          }`)
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
          totalEmissiveRadiance += frontGlow * 1.4;`);
    };
    this.land = new THREE.Mesh(geo, mat);
    this.land.receiveShadow = true;
    this.group.add(this.land);
  }

  buildSea() {
    const size = Math.max(W, H) * 4;
    const geo = new THREE.PlaneGeometry(size, size, 1, 1);
    geo.rotateX(-Math.PI / 2);
    geo.translate(X0 + W / 2, 0, -(Y0 + H / 2));
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        ...this.uniforms,
        uMapMin: { value: new THREE.Vector2(X0, Y0) },
        uMapSize: { value: new THREE.Vector2(W, H) },
      },
      vertexShader: /* glsl */`
        varying vec3 vWorld;
        varying float vViewDist;
        void main() {
          vec4 w = modelMatrix * vec4(position, 1.0);
          vWorld = w.xyz;
          vec4 mv = viewMatrix * w;
          vViewDist = -mv.z;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: /* glsl */`
        uniform sampler2D uCoast, uRelief;
        uniform float uTime, uFogNear, uFogFar;
        uniform vec3 uSun, uFogColor;
        uniform vec2 uMapMin, uMapSize;
        varying vec3 vWorld;
        varying float vViewDist;
        ${NOISE}
        void main() {
          vec2 map = vec2(vWorld.x, -vWorld.z);
          vec2 uv = (map - uMapMin) / uMapSize;
          float inside = step(0.0, uv.x) * step(uv.x, 1.0) * step(0.0, uv.y) * step(uv.y, 1.0);
          float depthS = mix(1.0, texture2D(uRelief, uv).g, inside);
          vec4 cst = inside > 0.5 ? texture2D(uCoast, uv) : vec4(0.0);

          // Depth: turquoise shallows, a blue shelf, navy deep water.
          vec3 shallow = vec3(0.22, 0.62, 0.66);
          vec3 mid = vec3(0.1, 0.38, 0.58);
          vec3 deep = vec3(0.04, 0.18, 0.36);
          float shallowness = max(smoothstep(0.3, 0.0, depthS), smoothstep(0.1, 0.55, cst.r) * 0.75);
          vec3 col = mix(deep, mid, smoothstep(0.75, 0.3, depthS));
          col = mix(col, shallow, shallowness);

          // Waves: two scrolling layers of noise for a normal.
          vec2 p = map * 0.02;
          float h0 = fbm(p + vec2(uTime * 0.05, uTime * 0.03));
          float h1 = fbm(p * 2.7 - vec2(uTime * 0.04, -uTime * 0.06));
          float hx = fbm(p + vec2(0.05, 0.0) + vec2(uTime * 0.05, uTime * 0.03)) - h0;
          float hz = fbm(p + vec2(0.0, 0.05) + vec2(uTime * 0.05, uTime * 0.03)) - h0;
          vec3 nrm = normalize(vec3(-hx * 3.0 - (h1 - 0.5) * 0.15, 1.0, hz * 3.0 - (h1 - 0.5) * 0.15));
          vec3 view = normalize(cameraPosition - vWorld);
          vec3 hv = normalize(uSun + view);
          float spec = pow(max(dot(nrm, hv), 0.0), 120.0) * 1.6;
          float fres = pow(1.0 - max(dot(nrm, view), 0.0), 4.0);
          col = mix(col, vec3(0.62, 0.78, 0.9), fres * 0.45);
          col *= 0.82 + 0.3 * max(dot(nrm, uSun), 0.0);
          col += vec3(1.0, 0.95, 0.85) * spec;

          // Surf: lines that roll in towards every coast.
          float c = cst.r;
          // Lakes are calm: no surf where the water is mostly hemmed in by land.
          float open = smoothstep(0.72, 0.5, c);
          float band = smoothstep(0.04, 0.3, c) * smoothstep(0.62, 0.42, c) * open;
          float waves = smoothstep(0.8, 0.97, sin(c * 22.0 - uTime * 1.4 + fbm(map * 0.04) * 5.0));
          col = mix(col, vec3(0.92, 0.97, 1.0), waves * band * 0.4);
          float line = smoothstep(0.3, 0.45, cst.g) * smoothstep(0.62, 0.48, cst.g);
          col = mix(col, vec3(0.95, 0.98, 1.0), line * 0.75 * inside * open);

          col = pow(col, vec3(2.2));
          float fog = smoothstep(uFogNear, uFogFar, vViewDist);
          col = mix(col, uFogColor, max(fog, (1.0 - inside) * 0.35));
          gl_FragColor = vec4(col, 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }
      `,
    });
    this.sea = new THREE.Mesh(geo, mat);
    this.sea.renderOrder = -1;
    this.group.add(this.sea);
  }

  buildTrees() {
    const want = Math.round(16000 * this.q.trees);
    if (!want) return;
    // Two kinds: a conifer, and a round broadleaf.
    const conifer = mergeColored([
      part(new THREE.CylinderGeometry(0.18, 0.25, 0.9, 5), 0x5a3d22, [0, 0.45, 0]),
      part(new THREE.ConeGeometry(1.0, 1.8, 7), 0x2f5a2c, [0, 1.5, 0]),
      part(new THREE.ConeGeometry(0.75, 1.4, 7), 0x376b31, [0, 2.4, 0]),
    ]);
    const broad = mergeColored([
      part(new THREE.CylinderGeometry(0.18, 0.26, 1.1, 5), 0x5e4126, [0, 0.55, 0]),
      part(new THREE.IcosahedronGeometry(1.05, 0), 0x4f7f2e, [0, 1.7, 0]),
    ]);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.9, flatShading: true });
    const cMesh = new THREE.InstancedMesh(conifer, mat, want);
    const bMesh = new THREE.InstancedMesh(broad, mat, want);
    let nc = 0, nb = 0;
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const col = new THREE.Color();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    // Forest grows in clumps: a coarse noise decides where, a fine one how thick.
    const clump = (x, y) => {
      const v = Math.sin(x * 0.011 + Math.sin(y * 0.007) * 2) * Math.cos(y * 0.013 + Math.cos(x * 0.005) * 2);
      return v * 0.5 + 0.5;
    };
    let tries = 0;
    while (nc + nb < want && tries++ < want * 30) {
      const x = X0 + rnd() * W, y = Y0 + rnd() * H;
      if (this.maskAt(x, y) < 0.95) continue;
      const e = this.elevationAt(x, y);
      const lat = (y - Y0) / H;
      if (e > 1700 - lat * 900 || lat > 0.93) continue;
      if (lat < 0.22 && rnd() > 0.35) continue; // dry south: sparse
      if (clump(x, y) < 0.45 + rnd() * 0.25) continue;
      if (this.cityNear(x, y, 22)) continue;
      const northern = lat + (rnd() - 0.5) * 0.25 > 0.6 || e > 900;
      const k = 3.2 + rnd() * 2.2;
      s.set(k, k * (0.9 + rnd() * 0.4), k);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI * 2);
      p.set(x, this.heightAt(x, y) - 0.3, -y);
      m.compose(p, q, s);
      const tint = 0.8 + rnd() * 0.35;
      col.setRGB(tint, tint * (0.95 + rnd() * 0.1), tint * 0.9);
      if (northern) {
        cMesh.setMatrixAt(nc, m);
        cMesh.setColorAt(nc++, col);
      } else {
        bMesh.setMatrixAt(nb, m);
        bMesh.setColorAt(nb++, col);
      }
    }
    for (const [mesh, n] of [[cMesh, nc], [bMesh, nb]]) {
      mesh.count = n;
      mesh.castShadow = this.q.shadow >= 2048;
      mesh.receiveShadow = true;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      mesh.frustumCulled = false;
      this.group.add(mesh);
    }
  }

  cityNear(x, y, r) {
    for (const c of CITIES) if ((c.x - x) ** 2 + (c.y - y) ** 2 < r * r) return true;
    return false;
  }

  buildCities() {
    // Little towns: a ring of blocks round a taller middle, roofs in two colours.
    const block = mergeColored([
      part(new THREE.BoxGeometry(1, 1, 1), 0xd8ccb4, [0, 0.5, 0]),
      part(new THREE.ConeGeometry(0.8, 0.55, 4), 0xc65a3c, [0, 1.27, 0], [0, Math.PI / 4, 0]),
    ]);
    const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.75, flatShading: true });
    const max = CITIES.length * 26;
    const mesh = new THREE.InstancedMesh(block, mat, max);
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3();
    const p = new THREE.Vector3();
    const col = new THREE.Color();
    let n = 0;
    let seed = 11;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    this.cityBlocks = [];
    for (const c of CITIES) {
      const count = c.capital ? 22 : 13;
      const from = n;
      for (let k = 0; k < count && n < max; k++) {
        const a = rnd() * Math.PI * 2;
        const r = k === 0 ? 0 : (Math.sqrt(rnd()) * (c.capital ? 11 : 8));
        const x = c.x + Math.cos(a) * r, y = c.y + Math.sin(a) * r;
        const tall = k === 0 ? (c.capital ? 9 : 6) : 2 + rnd() * (r < 5 ? 3.5 : 2);
        const wide = 2.2 + rnd() * 1.8;
        s.set(wide, tall, wide * (0.8 + rnd() * 0.5));
        q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * Math.PI);
        p.set(x, this.groundAt(x, y) - 0.2, -y);
        m.compose(p, q, s);
        mesh.setMatrixAt(n, m);
        mesh.setColorAt(n, col.set(c.side === HOSTILE ? 0x9a8a80 : 0xffffff));
        n++;
      }
      this.cityBlocks.push([from, n]);
    }
    mesh.count = n;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    this.cityMesh = mesh;
    this.group.add(mesh);
  }

  /** Re-tints a city's blocks when it changes hands. */
  setCityOwner(id, owner) {
    const [a, b] = this.cityBlocks[id];
    const col = new THREE.Color(owner === HOSTILE ? 0x9a8a80 : 0xffffff);
    for (let i = a; i < b; i++) this.cityMesh.setColorAt(i, col);
    this.cityMesh.instanceColor.needsUpdate = true;
  }

  /** Copies the simulation's grid of owners into the texture. */
  updateOwners(owner, origin, outside, isLand) {
    const d = this.ownerData;
    for (let i = 0; i < owner.length; i++) {
      const o = i * 4;
      const hostile = owner[i] === HOSTILE;
      d[o] = hostile ? 255 : 0;
      d[o + 1] = hostile && origin[i] === FRIEND ? 255 : 0;
      d[o + 2] = outside[i] ? 255 : 0;
      d[o + 3] = isLand[i] ? 255 : 0;
    }
    // Water takes the colours of the land next to it, or every coast would fade
    // to "ours" half a cell out and the enemy's shores would wear a pale fringe.
    for (let i = 0; i < owner.length; i++) {
      if (isLand[i]) continue;
      const c = i % COLS, r = (i / COLS) | 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          const nc = c + dc, nr = r + dr;
          if (nc < 0 || nr < 0 || nc >= COLS || nr >= ROWS) continue;
          const j = nr * COLS + nc;
          if (!isLand[j]) continue;
          for (let k = 0; k < 3; k++) d[i * 4 + k] = Math.max(d[i * 4 + k], d[j * 4 + k]);
        }
      }
    }
    this.ownerTex.needsUpdate = true;
  }

  update(dt, camDist) {
    this.uniforms.uTime.value += dt;
    this.uniforms.uFogNear.value = camDist * 1.4;
    this.uniforms.uFogFar.value = camDist * 4.5;
  }
}

/** One primitive, coloured and placed, ready to merge. */
export function part(geo, color, at = [0, 0, 0], rot = [0, 0, 0], scale = null) {
  const g = geo.index ? geo.toNonIndexed() : geo;
  if (scale) g.scale(scale[0], scale[1], scale[2]);
  g.rotateX(rot[0]);
  g.rotateY(rot[1]);
  g.rotateZ(rot[2]);
  g.translate(at[0], at[1], at[2]);
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const colors = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'color'].includes(k)) g.deleteAttribute(k);
  return g;
}

/** Merges coloured primitives into one geometry. */
export function mergeColored(parts) {
  let count = 0;
  for (const p of parts) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nrm = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o * 3);
    nrm.set(p.attributes.normal.array, o * 3);
    col.set(p.attributes.color.array, o * 3);
    o += p.attributes.position.count;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
