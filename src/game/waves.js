/**
 * The war, one wave at a time.
 *
 * It starts the way people expect it would: a probe over the Estonian border
 * that is supposed to look like nothing much. Each wave opens a front or two
 * more, from the Baltics to the Suwałki gap, the Baltic Fleet, Belarus, the
 * Black Sea, the Arctic, and then everything at once.
 *
 * A group is one stream of units: what, how many, from where, towards which
 * city, starting `at` seconds into the wave and one every `every` seconds.
 * The number is for the middle difficulty; the others scale it.
 *
 * Places are the keys of map.js's CITY table.
 */

const g = (from, unit, n, to, at = 0, every = 1) => ({ from, unit, n, to, at, every });

export const WAVES = [
  {
    title: 'Grey Zone',
    brief: 'Unmarked troops cross into Estonia near Narva. Nobody has said the word war yet.',
    groups: [
      g('pskov', 'rifles', 6, 'tartu', 0, 1.6),
      g('stpetersburg', 'rifles', 5, 'narva', 6, 1.6),
      g('pskov', 'btr', 1, 'tartu', 12),
    ],
  },
  {
    title: 'Narva',
    brief: 'Armour follows the infantry. The first drones go for Tallinn.',
    groups: [
      g('stpetersburg', 'rifles', 10, 'tallinn', 0, 1.2),
      g('stpetersburg', 'btr', 3, 'tallinn', 8, 3),
      g('pskov', 'rifles', 8, 'tartu', 4, 1.3),
      g('pskov', 'shahed', 3, 'tallinn', 14, 2),
    ],
  },
  {
    title: 'Latgale',
    brief: 'A second push into Latvia, towards Daugavpils and Riga.',
    groups: [
      g('pskov', 'rifles', 12, 'daugavpils', 0, 1),
      g('pskov', 'btr', 4, 'riga', 6, 2.5),
      g('vitebsk', 'rifles', 8, 'daugavpils', 10, 1.2),
      g('pskov', 't90', 1, 'riga', 16),
      g('pskov', 'shahed', 5, 'riga', 8, 1.6),
    ],
  },
  {
    title: 'Suwałki Gap',
    brief: 'Kaliningrad and Belarus move to close the corridor between them.',
    groups: [
      g('kaliningrad', 'rifles', 12, 'kaunas', 0, 1),
      g('grodno', 'rifles', 12, 'bialystok', 2, 1),
      g('grodno', 'btr', 5, 'vilnius', 8, 2.2),
      g('kaliningrad', 't90', 2, 'gdansk', 14, 5),
      g('kaliningrad', 'corvette', 1, 'klaipeda', 4),
      g('minsk', 'shahed', 6, 'vilnius', 10, 1.4),
    ],
  },
  {
    title: 'Baltic Fleet',
    brief: 'Ships leave Kronstadt. Karelia empties towards the Finnish border.',
    groups: [
      g('stpetersburg', 'corvette', 2, 'helsinki', 0, 8),
      g('petrozavodsk', 'rifles', 14, 'lappeenranta', 2, 1),
      g('petrozavodsk', 'btr', 5, 'helsinki', 8, 2.4),
      g('stpetersburg', 'su34', 1, 'tallinn', 18),
      g('pskov', 'rifles', 10, 'riga', 6, 1.1),
      g('stpetersburg', 'shahed', 6, 'helsinki', 12, 1.3),
    ],
  },
  {
    title: 'The Belarus Front',
    brief: 'Brest opens up on Poland. Warsaw is the prize now.',
    groups: [
      g('brest', 'rifles', 18, 'lublin', 0, 0.8),
      g('brest', 'btr', 7, 'warsaw', 5, 1.8),
      g('brest', 't90', 3, 'warsaw', 14, 4),
      g('brest', 'tor', 1, 'warsaw', 18),
      g('minsk', 'rifles', 12, 'vilnius', 4, 1),
      g('minsk', 'shahed', 9, 'warsaw', 10, 1.1),
    ],
  },
  {
    title: 'Black Sea',
    brief: 'The fleet sails from Sevastopol for Odesa and the Romanian coast.',
    groups: [
      g('sevastopol', 'corvette', 2, 'odesa', 0, 6),
      g('novorossiysk', 'corvette', 1, 'constanta', 6),
      g('sevastopol', 'rifles', 14, 'odesa', 2, 0.9),
      g('sevastopol', 'btr', 5, 'odesa', 8, 2),
      g('sevastopol', 'shahed', 10, 'chisinau', 4, 1),
      g('donetsk', 'shahed', 6, 'bucharest', 12, 1.2),
    ],
  },
  {
    title: 'Kyiv Axis',
    brief: 'Columns from Gomel for Kyiv, from Belgorod for Kharkiv. The jets come west.',
    groups: [
      g('gomel', 'rifles', 18, 'kyiv', 0, 0.8),
      g('gomel', 'btr', 6, 'kyiv', 6, 1.8),
      g('gomel', 't90', 4, 'kyiv', 12, 3),
      g('gomel', 'tor', 2, 'kyiv', 16, 6),
      g('belgorod', 'rifles', 14, 'kharkiv', 2, 0.9),
      g('belgorod', 't90', 2, 'kharkiv', 14, 4),
      g('minsk', 'su34', 2, 'warsaw', 20, 6),
    ],
  },
  {
    title: 'Arctic',
    brief: 'The Northern Fleet and the Kola garrison move on Finnmark and Lapland.',
    groups: [
      g('murmansk', 'rifles', 12, 'kirkenes', 0, 1),
      g('murmansk', 'btr', 5, 'rovaniemi', 6, 2),
      g('murmansk', 'corvette', 2, 'tromso', 2, 8),
      g('petrozavodsk', 'rifles', 12, 'oulu', 4, 1),
      g('pskov', 'rifles', 14, 'riga', 6, 0.9),
      g('pskov', 't90', 3, 'riga', 14, 4),
      g('stpetersburg', 'su34', 2, 'helsinki', 18, 6),
    ],
  },
  {
    title: 'Escalation',
    brief: 'Every Baltic front at once, and the missiles start.',
    groups: [
      g('stpetersburg', 'rifles', 16, 'tallinn', 0, 0.7),
      g('pskov', 'rifles', 16, 'riga', 0, 0.7),
      g('grodno', 'rifles', 16, 'bialystok', 2, 0.7),
      g('kaliningrad', 'btr', 8, 'gdansk', 4, 1.4),
      g('brest', 't90', 5, 'warsaw', 8, 3),
      g('minsk', 'tor', 2, 'vilnius', 10, 5),
      g('kaliningrad', 'iskander', 2, 'berlin', 16, 6),
      g('minsk', 'shahed', 14, 'warsaw', 6, 0.8),
      g('stpetersburg', 'su34', 2, 'riga', 20, 5),
    ],
  },
  {
    title: 'Two Fronts',
    brief: 'Poland and Romania together, to split what you have.',
    groups: [
      g('brest', 'rifles', 22, 'warsaw', 0, 0.6),
      g('brest', 'btr', 8, 'lublin', 4, 1.3),
      g('brest', 't90', 5, 'krakow', 10, 3),
      g('sevastopol', 'corvette', 3, 'constanta', 0, 6),
      g('sevastopol', 'rifles', 18, 'odesa', 2, 0.7),
      g('donetsk', 'btr', 6, 'dnipro', 4, 1.6),
      g('sevastopol', 'tor', 2, 'odesa', 12, 5),
      g('moscow', 'iskander', 3, 'bucharest', 16, 5),
      g('minsk', 'su34', 3, 'warsaw', 18, 5),
    ],
  },
  {
    title: 'Fire Storm',
    brief: 'Drone swarms by the hundred, aimed at capitals far from the front.',
    groups: [
      g('kaliningrad', 'shahed', 18, 'berlin', 0, 0.6),
      g('minsk', 'shahed', 18, 'warsaw', 0, 0.6),
      g('stpetersburg', 'shahed', 14, 'stockholm', 4, 0.7),
      g('sevastopol', 'shahed', 14, 'bucharest', 4, 0.7),
      g('moscow', 'iskander', 4, 'prague', 10, 4),
      g('pskov', 'rifles', 20, 'riga', 2, 0.6),
      g('grodno', 'btr', 8, 'kaunas', 6, 1.4),
    ],
  },
  {
    title: 'Breakthrough',
    brief: 'Heavy armour on every road west. The Baltic Fleet sails again.',
    groups: [
      g('grodno', 't90', 8, 'warsaw', 0, 2.2),
      g('brest', 't90', 8, 'lublin', 2, 2.2),
      g('pskov', 't90', 6, 'riga', 4, 2.4),
      g('grodno', 'tor', 3, 'warsaw', 8, 4),
      g('brest', 'btr', 10, 'warsaw', 0, 1.2),
      g('gomel', 'rifles', 24, 'kyiv', 0, 0.5),
      g('kaliningrad', 'corvette', 3, 'gdansk', 2, 6),
      g('stpetersburg', 'corvette', 2, 'stockholm', 4, 8),
      g('stpetersburg', 'su34', 4, 'gdansk', 14, 4),
    ],
  },
  {
    title: 'Total War',
    brief: 'From the Arctic to the Black Sea. Missiles for every capital in range.',
    groups: [
      g('murmansk', 'rifles', 18, 'tromso', 0, 0.7),
      g('petrozavodsk', 'btr', 10, 'helsinki', 0, 1.2),
      g('stpetersburg', 'rifles', 22, 'tallinn', 2, 0.5),
      g('pskov', 't90', 6, 'riga', 4, 2.4),
      g('grodno', 'rifles', 26, 'vilnius', 2, 0.5),
      g('brest', 't90', 8, 'warsaw', 6, 2),
      g('belgorod', 'btr', 10, 'kharkiv', 4, 1.2),
      g('sevastopol', 'corvette', 3, 'varna', 0, 6),
      g('moscow', 'iskander', 6, 'berlin', 12, 3),
      g('kaliningrad', 'su34', 4, 'berlin', 16, 4),
      g('minsk', 'shahed', 20, 'warsaw', 6, 0.5),
    ],
  },
  {
    title: 'The Last Push',
    brief: 'Everything they have left. Hold, and it is over.',
    groups: [
      g('stpetersburg', 't90', 8, 'helsinki', 0, 2),
      g('pskov', 'rifles', 30, 'riga', 0, 0.4),
      g('grodno', 't90', 10, 'warsaw', 2, 1.8),
      g('brest', 'btr', 14, 'krakow', 2, 1),
      g('gomel', 't90', 8, 'kyiv', 4, 2),
      g('minsk', 'tor', 4, 'warsaw', 8, 3),
      g('kaliningrad', 'corvette', 3, 'copenhagen', 0, 5),
      g('sevastopol', 'corvette', 4, 'constanta', 0, 5),
      g('moscow', 'iskander', 8, 'paris', 10, 2.5),
      g('kaliningrad', 'su34', 6, 'berlin', 14, 3),
      g('minsk', 'shahed', 28, 'berlin', 4, 0.4),
    ],
  },
];

/** How much of everything each difficulty sends, and what you start with. */
export const DIFFICULTY = {
  recruit: { label: 'RECRUIT', hp: 0.8, count: 0.75, funds: 800, income: 7, capitalsToLose: 7 },
  veteran: { label: 'VETERAN', hp: 1, count: 1, funds: 650, income: 6, capitalsToLose: 6 },
  general: { label: 'GENERAL', hp: 1.2, count: 1.25, funds: 550, income: 5, capitalsToLose: 5 },
};
export const DIFFICULTIES = Object.keys(DIFFICULTY);
