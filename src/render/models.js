/**
 * Every unit, built from primitives in code, Total Annihilation style: hard
 * edges, flat shading, a few hundred triangles each, and moving parts that
 * actually move - turrets that track, rotors that spin, radars that sweep.
 *
 * A model is a list of parts. Each part is one merged, vertex-coloured geometry
 * with a pivot and a way of moving:
 *
 *   body     follows the unit
 *   turret   turns to face the unit's target (yaw about its pivot)
 *   rotor    spins about the model's forward axis (propellers)
 *   radar    sweeps round about the vertical
 *
 * Models face +x and stand on y = 0, in units of roughly a metre; `scale` turns
 * that into kilometres on the map, exaggerated a long way so a tank can be seen
 * from orbit. Colours are baked into the vertices: blue-grey and NATO blue for
 * yours, dark green and red for theirs, so the two sides read at a glance.
 */

import * as THREE from 'three';
import { part, mergeColored } from './terrain.js';

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);
const cyl = (rt, rb, h, s = 10) => new THREE.CylinderGeometry(rt, rb, h, s);
const sph = (r, w = 10, h = 8) => new THREE.SphereGeometry(r, w, h);
const cone = (r, h, s = 10) => new THREE.ConeGeometry(r, h, s);
const X = [0, 0, -Math.PI / 2]; // a cylinder lying along +x

/** A flat outline in the x-z plane (x forward, z right), extruded `thick` upwards. */
function slab(points, thick, bevel = 0) {
  const shape = new THREE.Shape();
  shape.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) shape.lineTo(points[i][0], points[i][1]);
  shape.closePath();
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: thick, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel, bevelSegments: 1,
  });
  // Shape is drawn in x-y; lay it down so y becomes z and the extrusion goes up.
  g.rotateX(Math.PI / 2);
  g.translate(0, thick, 0);
  return g;
}

/** A symmetric outline: give the right half (z >= 0), get the whole thing. */
function mirrored(half) {
  const right = half.map(([x, z]) => [x, z]);
  const left = half.slice().reverse().map(([x, z]) => [x, -z]);
  return [...right, ...left];
}

const PAL = {
  nato: { hull: 0x7b8794, dark: 0x4a535e, team: 0x2f86ff, track: 0x26292d, light: 0xc9d2dc, glass: 0x1a2a3a },
  ru: { hull: 0x5b6440, dark: 0x3a4029, team: 0xd83a2a, track: 0x241f1b, light: 0x9b9a72, glass: 0x2a2018 },
};

function tank(p, heavy) {
  const L = heavy ? 7.4 : 7.6;
  const body = [
    part(box(L, 1.0, 3.3), p.hull, [0, 1.15, 0]),
    part(box(1.6, 0.7, 3.2), p.hull, [L / 2 - 0.2, 1.0, 0], [0, 0, -0.5]),
    part(box(L + 0.3, 1.0, 0.95), p.track, [0, 0.55, 1.55]),
    part(box(L + 0.3, 1.0, 0.95), p.track, [0, 0.55, -1.55]),
    part(box(L * 0.9, 0.15, 1.05), p.dark, [0, 1.12, 1.6]),
    part(box(L * 0.9, 0.15, 1.05), p.dark, [0, 1.12, -1.6]),
    part(box(1.0, 0.45, 2.6), p.dark, [-L / 2 + 0.3, 1.55, 0]),
  ];
  const turret = heavy
    ? [
      part(sph(1.75, 12, 8), p.hull, [0, 0, 0], [0, 0, 0], [1.15, 0.42, 1.0]),
      part(cyl(0.16, 0.2, 5.6), p.dark, [3.4, 0.15, 0], X),
      part(cyl(0.24, 0.24, 0.6), p.dark, [6.1, 0.15, 0], X),
      part(box(1.2, 0.25, 0.5), p.team, [-0.2, 0.55, 1.2]),
      part(box(1.2, 0.25, 0.5), p.team, [-0.2, 0.55, -1.2]),
      ...[-1, 1].map((s) => part(box(0.9, 0.35, 0.6), p.dark, [1.2, 0.35, s * 1.25], [0, s * 0.4, 0])),
    ]
    : [
      part(box(3.6, 1.0, 2.9), p.hull, [-0.2, 0, 0]),
      part(box(1.0, 0.85, 2.7), p.hull, [1.85, -0.05, 0], [0, 0, -0.35]),
      part(cyl(0.17, 0.2, 5.4), p.dark, [4.3, 0.1, 0], X),
      part(box(1.6, 0.3, 0.12), p.team, [-0.4, 0.15, 1.47]),
      part(box(1.6, 0.3, 0.12), p.team, [-0.4, 0.15, -1.47]),
      part(box(0.6, 0.5, 0.6), p.dark, [-0.8, 0.7, 0.7]),
    ];
  return {
    scale: heavy ? 3.9 : 4.0,
    parts: [
      { kind: 'body', geo: mergeColored(body) },
      { kind: 'turret', geo: mergeColored(turret), pivot: [heavy ? 0 : -0.3, 2.0, 0] },
    ],
  };
}

function soldier(p, x, z, a) {
  const at = (dx, dy, dz) => [x + dx, dy, z + dz];
  return [
    part(box(0.35, 0.8, 0.5), p.dark, at(0, 0.4, 0)),
    part(box(0.42, 0.75, 0.6), p.hull, at(0, 1.15, 0)),
    part(sph(0.22, 8, 6), 0xd9b48f, at(0.02, 1.68, 0)),
    part(sph(0.27, 8, 5), p.hull, at(0, 1.78, 0), [0, 0, 0], [1, 0.6, 1]),
    part(box(0.95, 0.09, 0.09), 0x1d1d1d, at(0.35, 1.2, 0.2), [0, a, 0]),
    part(box(0.12, 0.3, 0.62), p.team, at(0, 1.25, 0)),
  ];
}

function squad(p) {
  const men = [];
  const places = [[0.9, 0], [-0.1, 0.9], [-0.1, -0.9], [-1.1, 0.4], [-1.1, -0.5]];
  places.forEach(([x, z], i) => men.push(...soldier(p, x, z, (i % 3 - 1) * 0.2)));
  return {
    scale: 7.2,
    parts: [{ kind: 'body', geo: mergeColored(men) }],
  };
}

function drone(p) {
  const body = [
    part(cyl(0.32, 0.22, 4.4, 10), p.light, [0, 0, 0], X),
    part(sph(0.36, 10, 8), p.light, [2.2, 0.05, 0], [0, 0, 0], [1.3, 1, 1]),
    part(box(0.9, 0.06, 9.5), p.light, [0.3, 0.1, 0]),
    part(box(0.25, 0.08, 9.6), p.team, [0.05, 0.13, 0]),
    part(box(0.6, 0.05, 1.6), p.light, [-2.0, 0.35, 0.55], [0.7, 0, 0]),
    part(box(0.6, 0.05, 1.6), p.light, [-2.0, 0.35, -0.55], [-0.7, 0, 0]),
    part(sph(0.22, 8, 6), p.glass, [1.6, -0.3, 0]),
    part(box(0.5, 0.15, 0.15), p.dark, [0.6, -0.25, 1.7]),
    part(box(0.5, 0.15, 0.15), p.dark, [0.6, -0.25, -1.7]),
  ];
  const rotor = [
    part(box(0.08, 1.7, 0.18), p.dark, [0, 0, 0]),
    part(box(0.08, 0.18, 1.7), p.dark, [0, 0, 0]),
  ];
  return {
    scale: 3.9,
    parts: [
      { kind: 'body', geo: mergeColored(body) },
      { kind: 'rotor', geo: mergeColored(rotor), pivot: [-2.3, 0, 0] },
    ],
  };
}

function jet(p, big) {
  const wing = slab(mirrored([[1.2, 0.5], [-1.6, 4.4], [-2.6, 4.4], [-2.4, 0.5]]), 0.12);
  const tail = slab(mirrored([[-2.8, 0.4], [-4.1, 2.0], [-4.6, 2.0], [-4.4, 0.4]]), 0.1);
  const fin = slab([[-2.6, 0], [-4.2, 0], [-4.5, 0.12], [-3.6, 0.12]], 1.6);
  const body = [
    part(cyl(0.55, 0.65, 7.2, 10), p.hull, [-0.6, 0, 0], X),
    part(cone(0.55, 2.4, 10), p.hull, [4.2, 0, 0], X),
    part(sph(0.45, 10, 8), p.glass, [2.0, 0.42, 0], [0, 0, 0], [2.2, 0.8, 0.9]),
    part(wing, p.hull, [0, -0.1, 0]),
    part(tail, p.hull, [0, 0.05, 0]),
    part(fin, p.hull, [0, 0.2, 0.55], [0.25, 0, 0]),
    part(fin, p.hull, [0, 0.2, -0.55], [-0.25, 0, 0]),
    part(box(0.5, 0.05, 1.4), p.team, [-1.4, 0.04, 2.6]),
    part(box(0.5, 0.05, 1.4), p.team, [-1.4, 0.04, -2.6]),
    part(cyl(0.45, 0.4, 0.5, 10), p.dark, [-4.4, 0, 0], X),
  ];
  if (big) {
    // The Su-34's flattened duck nose and its canards.
    body.push(part(box(2.2, 0.5, 1.5), p.hull, [3.2, 0.1, 0]));
    body.push(part(slab(mirrored([[2.2, 0.5], [1.4, 1.6], [1.0, 1.6], [1.2, 0.5]]), 0.08), p.hull, [0, 0.1, 0]));
    body.push(part(cyl(0.4, 0.4, 0.5, 10), p.dark, [-4.4, 0, 0.6], X));
    body.push(part(cyl(0.4, 0.4, 0.5, 10), p.dark, [-4.4, 0, -0.6], X));
  }
  return { scale: big ? 4.0 : 3.7, parts: [{ kind: 'body', geo: mergeColored(body) }] };
}

function hull(len, beam, h, color) {
  return slab(mirrored([[len / 2 + 1.6, 0], [len / 2, beam / 2], [-len / 2, beam / 2 * 0.92], [-len / 2 - 0.1, 0]]), h);
}

function frigate(p) {
  const L = 12;
  const body = [
    part(hull(L, 2.6, 1.2), p.dark, [0, -0.5, 0]),
    part(hull(L - 0.4, 2.4, 0.15), p.light, [0, 0.7, 0]),
    part(box(4.2, 1.6, 2.0), p.hull, [-1.0, 1.55, 0]),
    part(box(2.0, 1.0, 1.6), p.hull, [0.8, 2.8, 0]),
    part(box(1.4, 1.4, 1.5), p.hull, [-3.6, 1.4, 0]),
    part(cyl(0.12, 0.2, 3.2, 6), p.dark, [0.6, 4.5, 0]),
    part(box(0.8, 0.5, 1.4), p.dark, [2.8, 1.0, 0]),
    part(box(4.4, 0.08, 0.2), p.team, [-1.0, 2.0, 1.02]),
    part(box(4.4, 0.08, 0.2), p.team, [-1.0, 2.0, -1.02]),
    part(cyl(0.35, 0.45, 0.9, 8), p.dark, [-2.2, 3.1, 0]),
  ];
  const turret = [
    part(sph(0.6, 10, 6), p.light, [0, 0, 0], [0, 0, 0], [1.2, 0.7, 1]),
    part(cyl(0.08, 0.1, 2.0, 6), p.dark, [1.2, 0.1, 0], X),
  ];
  const radar = [
    part(box(0.25, 0.6, 1.8), p.light, [0, 0, 0]),
    part(box(0.1, 0.12, 2.0), p.team, [0.12, 0.25, 0]),
  ];
  return {
    scale: 4.3,
    sea: true,
    parts: [
      { kind: 'body', geo: mergeColored(body) },
      { kind: 'turret', geo: mergeColored(turret), pivot: [4.0, 1.0, 0] },
      { kind: 'radar', geo: mergeColored(radar), pivot: [0.6, 5.9, 0] },
    ],
  };
}

function corvette(p) {
  const L = 10;
  const body = [
    part(hull(L, 2.3, 1.1), p.dark, [0, -0.5, 0]),
    part(hull(L - 0.4, 2.1, 0.15), 0x6e6f6a, [0, 0.6, 0]),
    part(box(3.4, 1.5, 1.8), 0x7d7f78, [-0.8, 1.4, 0]),
    part(box(1.6, 0.9, 1.4), 0x7d7f78, [0.4, 2.55, 0]),
    part(cyl(0.12, 0.18, 2.6, 6), p.dark, [0.3, 4.0, 0]),
    part(box(3.0, 0.1, 0.2), p.team, [-0.8, 1.8, 0.92]),
    part(box(3.0, 0.1, 0.2), p.team, [-0.8, 1.8, -0.92]),
    part(box(1.4, 0.6, 1.4), p.dark, [-3.4, 1.0, 0]),
  ];
  const turret = [
    part(box(1.0, 0.6, 0.9), 0x7d7f78, [0, 0, 0]),
    part(cyl(0.08, 0.1, 1.8, 6), p.dark, [1.1, 0.05, 0], X),
  ];
  const radar = [part(box(0.2, 0.5, 1.5), 0x9a9b94, [0, 0, 0])];
  return {
    scale: 4.1,
    sea: true,
    parts: [
      { kind: 'body', geo: mergeColored(body) },
      { kind: 'turret', geo: mergeColored(turret), pivot: [3.2, 0.95, 0] },
      { kind: 'radar', geo: mergeColored(radar), pivot: [0.3, 5.3, 0] },
    ],
  };
}

function btr(p) {
  const body = [
    part(slab(mirrored([[3.8, 0], [3.1, 1.4], [-3.4, 1.4], [-3.6, 0]]), 1.4), p.hull, [0, 0.75, 0]),
    part(box(1.4, 0.8, 2.5), p.hull, [2.9, 1.1, 0], [0, 0, -0.6]),
    part(box(6.4, 0.18, 0.2), p.team, [-0.2, 1.75, 1.42]),
    part(box(6.4, 0.18, 0.2), p.team, [-0.2, 1.75, -1.42]),
  ];
  for (let k = 0; k < 4; k++) {
    for (const s of [-1, 1]) body.push(part(cyl(0.62, 0.62, 0.45, 10), p.track, [2.4 - k * 1.55, 0.62, s * 1.38], [Math.PI / 2, 0, 0]));
  }
  const turret = [
    part(cyl(0.55, 0.65, 0.6, 8), p.hull, [0, 0, 0]),
    part(cyl(0.07, 0.09, 2.4, 6), p.dark, [1.3, 0.1, 0], X),
  ];
  return {
    scale: 3.8,
    parts: [
      { kind: 'body', geo: mergeColored(body) },
      { kind: 'turret', geo: mergeColored(turret), pivot: [0.6, 2.45, 0] },
    ],
  };
}

function tor(p) {
  const body = [
    part(box(6.4, 1.2, 3.0), p.hull, [0, 1.15, 0]),
    part(box(6.6, 0.9, 0.8), p.track, [0, 0.5, 1.35]),
    part(box(6.6, 0.9, 0.8), p.track, [0, 0.5, -1.35]),
    part(box(1.2, 0.8, 2.8), p.hull, [2.9, 1.3, 0], [0, 0, -0.4]),
  ];
  const turret = [
    part(box(2.8, 1.8, 2.4), p.light, [0, 0.9, 0]),
    part(box(2.9, 0.2, 2.5), p.team, [0, 1.4, 0]),
    part(box(0.2, 1.0, 1.6), p.dark, [1.45, 0.9, 0]),
  ];
  const radar = [
    part(box(0.25, 1.1, 2.6), p.dark, [0, 0.5, 0]),
    part(cyl(0.12, 0.12, 0.8, 6), p.dark, [0, -0.3, 0]),
  ];
  return {
    scale: 3.8,
    parts: [
      { kind: 'body', geo: mergeColored(body) },
      { kind: 'turret', geo: mergeColored(turret), pivot: [-0.6, 1.75, 0] },
      { kind: 'radar', geo: mergeColored(radar), pivot: [-1.2, 4.2, 0] },
    ],
  };
}

function shahed(p) {
  const body = [
    part(slab(mirrored([[1.6, 0], [0.9, 0.3], [-1.6, 2.5], [-2.0, 2.5], [-1.9, 0.25]]), 0.18), 0x8a8a7e, [0, 0, 0]),
    part(cyl(0.22, 0.2, 3.2, 8), 0x8a8a7e, [-0.2, 0.15, 0], X),
    part(box(0.6, 0.6, 0.06), 0x8a8a7e, [-1.8, 0.4, 2.45]),
    part(box(0.6, 0.6, 0.06), 0x8a8a7e, [-1.8, 0.4, -2.45]),
    part(box(0.5, 0.05, 1.2), p.team, [-0.6, 0.2, 1.3]),
    part(box(0.5, 0.05, 1.2), p.team, [-0.6, 0.2, -1.3]),
  ];
  const rotor = [part(box(0.06, 1.0, 0.12), p.dark, [0, 0, 0]), part(box(0.06, 0.12, 1.0), p.dark, [0, 0, 0])];
  return {
    scale: 4.3,
    parts: [
      { kind: 'body', geo: mergeColored(body) },
      { kind: 'rotor', geo: mergeColored(rotor), pivot: [-1.85, 0.15, 0] },
    ],
  };
}

function iskander(p) {
  const body = [
    part(cyl(0.45, 0.45, 5.0, 10), 0x6f7a5a, [0, 0, 0], X),
    part(cone(0.45, 1.8, 10), 0x6f7a5a, [3.4, 0, 0], X),
    part(box(0.8, 0.05, 1.8), p.dark, [-2.2, 0, 0]),
    part(box(0.8, 1.8, 0.05), p.dark, [-2.2, 0, 0]),
    part(cyl(0.47, 0.47, 0.3, 10), p.team, [1.5, 0, 0], X),
  ];
  return { scale: 4.0, parts: [{ kind: 'body', geo: mergeColored(body) }] };
}

/** Builds every model once. Keys match the unit kinds in game/units.js. */
export function buildModels() {
  const n = PAL.nato, r = PAL.ru;
  return {
    infantry: squad(n),
    tank: tank(n, false),
    drone: drone(n),
    jet: jet(n, false),
    ship: frigate(n),
    rifles: squad(r),
    btr: btr(r),
    t90: tank(r, true),
    tor: tor(r),
    shahed: shahed(r),
    iskander: iskander(r),
    su34: jet(r, true),
    corvette: corvette(r),
  };
}

/** A small model for the build menu and the title screen, as one mesh. */
export function previewMesh(model, material) {
  const g = new THREE.Group();
  for (const p of model.parts) {
    const m = new THREE.Mesh(p.geo, material);
    if (p.pivot) m.position.set(...p.pivot);
    g.add(m);
  }
  g.scale.setScalar(model.scale);
  return g;
}
