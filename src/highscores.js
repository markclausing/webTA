/**
 * The score board.
 *
 * Ten per list, kept in localStorage so a browser on its own needs nothing at
 * all, and merged with a shared board when there is one. Every entry carries an
 * id and the time it was set, which is what lets two boards from two devices be
 * merged later without either winning by being loaded second.
 *
 * A score here is a bill, not a tally: what the war cost you in ground, cities,
 * units and strikes that got through. Lowest wins - but only among those who
 * held out as long. A general who lost at wave three spent less than one who
 * saw it through, and should not be above them, so the order is waves held
 * first, then losses, then whoever got there first.
 *
 * One list per difficulty. Nothing in here touches the simulation, and the
 * store is injectable so the tests can run it without a browser.
 */

import { WAVES, DIFFICULTIES } from './game/waves.js';

/** Its own key: every game in this family lives on the same github.io origin. */
export const KEY = 'webta.highscores.v1';

export const LEVELS = DIFFICULTIES;
export const TABLE_SIZE = 10;
export const NAME_LENGTH = 3;
export const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-';

/** No war in this game can cost more than this; the bound keeps a corrupt row out. */
const MAX_LOSSES = 2_000_000;

const empty = () => Object.fromEntries(LEVELS.map((l) => [l, []]));

function cleanName(name) {
  const up = String(name ?? '').toUpperCase();
  let out = '';
  for (const ch of up) {
    if (ALPHABET.includes(ch) && out.length < NAME_LENGTH) out += ch;
  }
  return out.padEnd(NAME_LENGTH, '-');
}

function clampNumber(value, lo, hi) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

/**
 * One row, from anywhere: our own storage, another device, or a shared board.
 * Anything unusable comes back null rather than throwing.
 */
export function cleanEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const waves = Math.round(Number(raw.waves));
  const losses = Math.round(Number(raw.losses));
  if (!Number.isFinite(waves) || !Number.isFinite(losses)) return null;
  if (waves < 1 || waves > WAVES.length || losses < 0 || losses > MAX_LOSSES) return null;
  const won = Boolean(raw.won) && waves === WAVES.length;
  const at = Number(raw.at);
  return {
    id: String(raw.id || '').slice(0, 40) || makeId(),
    name: cleanName(raw.name),
    waves,
    won,
    losses,
    // The story rather than the ranking.
    held: Math.max(0, Math.min(100, Math.round(Number(raw.held) * 10) / 10 || 0)),
    kills: clampNumber(raw.kills, 0, 99999),
    citiesLost: clampNumber(raw.citiesLost, 0, 999),
    at: Number.isFinite(at) && at > 0 ? at : Date.now(),
  };
}

export function makeId() {
  const rand = Math.floor(Math.random() * 0xffffff).toString(36);
  return `${Date.now().toString(36)}-${rand}`;
}

/** Furthest first; then cheapest; then earliest. */
export function compare(a, b) {
  if (b.waves !== a.waves) return b.waves - a.waves;
  if (a.won !== b.won) return a.won ? -1 : 1;
  if (a.losses !== b.losses) return a.losses - b.losses;
  return a.at - b.at;
}

export function sortTable(entries) {
  return [...entries].sort(compare).slice(0, TABLE_SIZE);
}

export function qualifies(table, entry) {
  const clean = cleanEntry(entry);
  if (!clean) return false;
  const rows = sortTable(table || []);
  if (rows.length < TABLE_SIZE) return true;
  return compare(clean, rows[rows.length - 1]) < 0;
}

export function placeOf(table, entry) {
  const clean = cleanEntry(entry);
  if (!clean) return 0;
  const rows = sortTable([...(table || []), clean]);
  const at = rows.findIndex((r) => r.id === clean.id);
  return at < 0 ? 0 : at + 1;
}

function normalise(board) {
  const out = {};
  for (const [key, rows] of Object.entries(board || {})) {
    if (!Array.isArray(rows) || !LEVELS.includes(key)) continue;
    (out[key] ||= []).push(...rows);
  }
  return out;
}

/** Two boards into one. Same id means the same result, however far it has travelled. */
export function merge(mine, theirs) {
  const out = empty();
  const a = normalise(mine);
  const b = normalise(theirs);
  for (const level of LEVELS) {
    const seen = new Map();
    for (const raw of [...(a[level] || []), ...(b[level] || [])]) {
      const entry = cleanEntry(raw);
      if (entry && !seen.has(entry.id)) seen.set(entry.id, entry);
    }
    out[level] = sortTable([...seen.values()]);
  }
  return out;
}

/** A board with everything set before `when` dropped: what makes emptying the shared board stick. */
export function since(board, when) {
  if (!when) return merge({}, board);
  const from = normalise(board);
  const out = {};
  for (const level of LEVELS) out[level] = (from[level] || []).filter((row) => Number(row?.at) >= when);
  return merge({}, out);
}

/** A board with these ids taken out, wherever they sit. */
export function without(board, ids) {
  const drop = new Set(ids || []);
  const from = normalise(board);
  const out = {};
  for (const level of LEVELS) out[level] = (from[level] || []).filter((row) => !drop.has(row?.id));
  return merge({}, out);
}

export function levelOf(difficulty) {
  return LEVELS.includes(difficulty) ? difficulty : 'veteran';
}

export class Highscores {
  constructor(store = globalThis.localStorage, key = KEY) {
    this.store = store;
    this.key = key;
    this.tables = this.read();
  }

  read() {
    try {
      const raw = this.store?.getItem(this.key);
      if (!raw) return empty();
      return merge(empty(), JSON.parse(raw));
    } catch {
      return empty();
    }
  }

  write() {
    try {
      this.store?.setItem(this.key, JSON.stringify(this.tables));
    } catch { /* private mode: the board just will not stick */ }
  }

  table(difficulty) {
    return this.tables[levelOf(difficulty)] || [];
  }

  qualifies(difficulty, entry) {
    return qualifies(this.table(difficulty), entry);
  }

  /** Adds a result and returns where it landed, or 0 if it missed the board. */
  add(difficulty, entry) {
    const clean = cleanEntry(entry);
    if (!clean) return 0;
    const level = levelOf(difficulty);
    this.tables[level] = sortTable([...this.table(level), clean]);
    this.write();
    return this.tables[level].findIndex((r) => r.id === clean.id) + 1;
  }

  absorb(theirs) {
    this.tables = merge(this.tables, theirs);
    this.write();
    return this.tables;
  }

  all() {
    return this.tables;
  }
}
