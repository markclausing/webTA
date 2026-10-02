// The score board, checked without a network.
//
//   node tools/boardtest.js

import { merge, since, without, qualifies, placeOf, cleanEntry, Highscores, TABLE_SIZE } from '../src/highscores.js';
import { WAVES } from '../src/game/waves.js';

let failures = 0;
function ok(what, passed) {
  if (!passed) failures++;
  console.log(`  ${passed ? 'ok  ' : 'FAIL'} ${what}`);
}

const ALL = WAVES.length;
const row = (id, name, waves, losses, extra = {}) => ({
  id, name, waves, losses, won: waves === ALL, held: 90, kills: 300, citiesLost: 2, at: 1000 + losses, ...extra,
});

// --- What a result is -----------------------------------------------------------------

ok('a finished war is a result', cleanEntry(row('a', 'MJC', ALL, 12000)) !== null);
ok('so is one lost at wave six', cleanEntry(row('a', 'MJC', 6, 40000)) !== null);
ok('a war that never started is not', cleanEntry(row('a', 'MJC', 0, 0)) === null);
ok('nor one with more waves than there are', cleanEntry(row('a', 'MJC', ALL + 1, 10)) === null);
ok('nor negative losses', cleanEntry(row('a', 'MJC', 3, -5)) === null);
ok('a win needs every wave', cleanEntry(row('a', 'MJC', 9, 100, { won: true })).won === false);
ok('names are three letters of the alphabet', cleanEntry(row('a', 'm!x9zz', 3, 10)).name === 'MX9');

// --- Ordering ------------------------------------------------------------------------------

{
  const board = merge({}, { veteran: [row('a', 'AAA', ALL, 50000), row('b', 'BBB', 9, 1000), row('c', 'CCC', ALL, 20000)] });
  const ids = board.veteran.map((r) => r.id).join('');
  ok('holding out longest is on top, then the cheapest war', ids === 'cab');
}

{
  const full = Array.from({ length: TABLE_SIZE }, (_, i) => row(`x${i}`, 'AAA', ALL, 10000 + i * 1000));
  ok('a full board turns away a dearer war', !qualifies(full, row('n', 'NEW', ALL, 90000)));
  ok('and lets in a cheaper one', qualifies(full, row('n', 'NEW', ALL, 5000)));
  ok('at the right place', placeOf(full, row('n', 'NEW', ALL, 5000)) === 1);
  ok('a defeat does not push out a victory', !qualifies(full, row('n', 'NEW', 12, 100)));
}

// --- Merging ----------------------------------------------------------------------------------

{
  const a = { recruit: [row('a', 'AAA', 5, 400)] };
  const b = { recruit: [row('a', 'AAA', 5, 400), row('b', 'BBB', 7, 900, { at: 2000 })] };
  const m = merge(a, b);
  ok('merging keeps one copy of the same result', m.recruit.length === 2);
  ok('and drops lists it does not know', !('easy' in merge({}, { easy: [row('z', 'ZZZ', 2, 1)] })));
  ok('a cleared board refuses older rows', since(b, 1500).recruit.length === 1);
  ok('a removed row stays removed', without(b, ['a']).recruit.length === 1);
}

{
  const store = new Map();
  const mem = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const h = new Highscores(mem);
  const place = h.add('general', row('q', 'MJC', ALL, 33000));
  ok('the board keeps what it is given', place === 1 && new Highscores(mem).table('general')[0].name === 'MJC');
}

if (failures) {
  console.log(`\n${failures} failed`);
  process.exit(1);
}
console.log('\nall good');
