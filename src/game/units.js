/**
 * Every kind of unit in the game, both sides.
 *
 * Distances are kilometres and times are seconds, at a scale where a column of
 * tanks crosses Lithuania in about half a minute: this is a war at the speed of
 * a board game, not of a staff college.
 *
 * Your units come in three levels. Each level is a whole description rather than
 * a list of changes, so what an upgrade does can be read straight off the page.
 *
 * Layers decide who can shoot whom: 'land' is anything on the ground, 'sea' is
 * anything afloat and 'air' is anything in the sky.
 */

const shot = (targets, range, dmg, rate, kind, extra = {}) => ({
  targets, range, dmg, rate, kind,
  speed: { bullet: 520, shell: 300, missile: 190, bomb: 140, sam: 260, cruise: 150 }[kind],
  splash: 0,
  ap: kind === 'shell' || kind === 'missile' || kind === 'bomb' || kind === 'cruise',
  ...extra,
});

/** Yours. `cost` is in millions of euros, and so is everything else that costs. */
export const NATO = {
  infantry: {
    name: 'Infantry',
    blurb: 'Cheap, stubborn, takes ground back',
    layer: 'land',
    cost: 70,
    upgrade: [70, 120],
    radius: 12,
    retakes: true,
    levels: [
      { hp: 220, armor: 0, speed: 9, weapons: [shot(['land'], 58, 15, 0.45, 'bullet')] },
      { hp: 300, armor: 0.05, speed: 10, weapons: [shot(['land'], 64, 22, 0.42, 'bullet')] },
      {
        hp: 380, armor: 0.1, speed: 10,
        label: 'MANPADS',
        weapons: [shot(['land'], 68, 26, 0.4, 'bullet'), shot(['air'], 90, 60, 2.2, 'sam')],
      },
    ],
  },
  tank: {
    name: 'Tank',
    blurb: 'Main battle tank. Stops columns',
    layer: 'land',
    cost: 160,
    upgrade: [120, 200],
    radius: 16,
    retakes: true,
    levels: [
      { hp: 650, armor: 0.35, speed: 11, weapons: [shot(['land'], 84, 72, 1.5, 'shell', { splash: 14 })] },
      { hp: 850, armor: 0.42, speed: 12, weapons: [shot(['land'], 92, 105, 1.4, 'shell', { splash: 16 })] },
      { hp: 1080, armor: 0.5, speed: 12, weapons: [shot(['land', 'sea'], 104, 140, 1.3, 'shell', { splash: 19 })] },
    ],
  },
  drone: {
    name: 'Drone',
    blurb: 'Loiters overhead, picks off armour',
    layer: 'air',
    cost: 110,
    upgrade: [90, 150],
    radius: 11,
    altitude: 26,
    orbit: 38,
    levels: [
      { hp: 110, armor: 0, speed: 48, weapons: [shot(['land', 'sea'], 80, 46, 1.2, 'missile')] },
      { hp: 150, armor: 0, speed: 52, weapons: [shot(['land', 'sea'], 86, 66, 1.0, 'missile')] },
      {
        hp: 160, armor: 0.05, speed: 56,
        label: 'TWIN RAILS',
        weapons: [shot(['land', 'sea'], 94, 74, 0.8, 'missile'), shot(['land'], 72, 16, 0.3, 'bullet')],
      },
    ],
  },
  jet: {
    name: 'Fighter',
    blurb: 'Clears the sky over a whole region',
    layer: 'air',
    cost: 250,
    upgrade: [180, 260],
    radius: 17,
    altitude: 52,
    orbit: 115,
    levels: [
      { hp: 300, armor: 0.05, speed: 120, weapons: [shot(['air'], 155, 120, 1.7, 'missile')] },
      {
        hp: 320, armor: 0.08, speed: 125,
        label: 'STRIKE',
        weapons: [shot(['air'], 160, 140, 1.5, 'missile'), shot(['land', 'sea'], 72, 110, 2.6, 'bomb', { splash: 26 })],
      },
      {
        hp: 400, armor: 0.12, speed: 135,
        weapons: [shot(['air'], 175, 180, 1.2, 'missile'), shot(['land', 'sea'], 82, 150, 2.2, 'bomb', { splash: 30 })],
      },
    ],
  },
  ship: {
    name: 'Frigate',
    blurb: 'Guns, missiles and air defence at sea',
    layer: 'sea',
    cost: 300,
    upgrade: [200, 300],
    radius: 21,
    levels: [
      {
        hp: 900, armor: 0.25, speed: 15,
        weapons: [shot(['sea', 'land'], 125, 80, 1.5, 'shell', { splash: 15 }), shot(['air'], 130, 70, 1.3, 'sam')],
      },
      {
        hp: 1150, armor: 0.3, speed: 16,
        weapons: [shot(['sea', 'land'], 135, 110, 1.3, 'shell', { splash: 17 }), shot(['air'], 145, 95, 1.0, 'sam')],
      },
      {
        hp: 1450, armor: 0.35, speed: 16,
        label: 'CRUISE',
        weapons: [
          shot(['sea', 'land'], 140, 130, 1.2, 'shell', { splash: 19 }),
          shot(['air'], 155, 115, 0.8, 'sam'),
          shot(['land', 'sea'], 260, 160, 6, 'cruise', { splash: 30 }),
        ],
      },
    ],
  },
};

export const NATO_ORDER = ['infantry', 'tank', 'drone', 'jet', 'ship'];

/**
 * Theirs. Hit points scale with difficulty and nothing else does: a harder war
 * is the same war with tougher units in it, and more of them.
 */
export const RU = {
  rifles: {
    name: 'Rifle squad', layer: 'land', hp: 60, armor: 0, speed: 6.5, radius: 10, bounty: 8,
    captures: true, weapons: [shot(['land'], 38, 5, 1.0, 'bullet')],
  },
  btr: {
    name: 'BTR', layer: 'land', hp: 160, armor: 0.15, speed: 13, radius: 12, bounty: 18,
    captures: true, weapons: [shot(['land'], 46, 11, 0.7, 'bullet')],
  },
  t90: {
    name: 'T-90', layer: 'land', hp: 520, armor: 0.42, speed: 8, radius: 15, bounty: 45,
    captures: true, weapons: [shot(['land'], 66, 44, 2.2, 'shell', { splash: 10 })],
  },
  tor: {
    name: 'Tor SAM', layer: 'land', hp: 190, armor: 0.2, speed: 8.5, radius: 13, bounty: 36,
    captures: true, weapons: [shot(['air'], 115, 34, 1.7, 'sam')],
  },
  shahed: {
    name: 'Shahed', layer: 'air', hp: 42, armor: 0, speed: 30, radius: 8, bounty: 10, altitude: 18,
    kamikaze: { dmg: 95, splash: 22, strike: 250 }, weapons: [],
  },
  iskander: {
    name: 'Iskander', layer: 'air', hp: 70, armor: 0, speed: 125, radius: 8, bounty: 30, altitude: 70,
    kamikaze: { dmg: 220, splash: 32, strike: 900 }, weapons: [],
  },
  su34: {
    name: 'Su-34', layer: 'air', hp: 320, armor: 0.12, speed: 85, radius: 17, bounty: 60, altitude: 46,
    sortie: 24, weapons: [shot(['land', 'sea'], 55, 80, 2.6, 'bomb', { splash: 22 })],
  },
  corvette: {
    name: 'Corvette', layer: 'sea', hp: 700, armor: 0.25, speed: 10, radius: 19, bounty: 80,
    lands: 4,
    weapons: [shot(['land', 'sea'], 115, 42, 2.2, 'shell', { splash: 12 }), shot(['air'], 95, 30, 2.0, 'sam')],
  },
};

/** What an upgrade to `level` (1 or 2, counting from 0) costs. */
export const upgradeCost = (kind, level) => NATO[kind].upgrade[level - 1];

/** Everything sunk into a unit so far: what losing it costs you on the board. */
export function invested(kind, level) {
  let sum = NATO[kind].cost;
  for (let l = 1; l <= level; l++) sum += upgradeCost(kind, l);
  return sum;
}
