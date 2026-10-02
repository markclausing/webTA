/**
 * What gets said in Discord when somebody puts a war on the board.
 *
 * Kept apart from the Worker so the wording can be tested without a network
 * anywhere near it. It says which game is talking, because every game in the
 * family can post into the same channel.
 */

import { LEVELS } from '../src/highscores.js';
import { DIFFICULTY, WAVES } from '../src/game/waves.js';

/** How many results one post will mention before it just counts the rest. */
const MAX_LINES = 3;

/**
 * Which rows are new, and where they landed. Worked out from the board before
 * and after rather than from what was sent: a result that did not make the top
 * ten is not news, and the same result arriving from a second device is not
 * news either, because merging matches it by id.
 */
export function newRows(before, after) {
  const rows = [];
  for (const level of LEVELS) {
    const had = new Set((before?.[level] || []).map((r) => r.id));
    const now = after?.[level] || [];
    for (let i = 0; i < now.length; i++) {
      if (!had.has(now[i].id)) rows.push({ entry: now[i], level, place: i + 1 });
    }
  }
  return rows.sort((a, b) => a.place - b.place);
}

function ordinal(n) {
  if (n === 1) return '**top of the board**';
  if (n === 2) return 'second';
  if (n === 3) return 'third';
  return `number ${n}`;
}

function line({ entry, level, place }) {
  const tier = DIFFICULTY[level]?.label.toLowerCase() || 'some';
  const cost = `**−${entry.losses.toLocaleString('en-US')}**`;
  const what = entry.won
    ? `🛡️ **${entry.name}** held all ${WAVES.length} waves on ${tier} for ${cost}`
    : `🎖️ **${entry.name}** held out ${entry.waves} wave${entry.waves > 1 ? 's' : ''} on ${tier} for ${cost}`;
  return `${what}, ${entry.held}% of Europe still standing — ${ordinal(place)}`;
}

/** Where the game lives. Overridden with a GAME_URL variable. */
export const GAME_URL = 'https://markclausing.github.io/webTA/';

/** NATO blue. */
const COLOUR = 0x3aa0ff;

export function announcement(rows, gameUrl = GAME_URL) {
  const shown = rows.slice(0, MAX_LINES).map(line);
  if (rows.length > MAX_LINES) shown.push(`…and ${rows.length - MAX_LINES} more.`);
  const url = gameUrl || GAME_URL;
  const plural = rows.length > 1 ? 'New results' : 'A new result';
  return {
    username: 'Article 5',
    embeds: [{
      title: `⭐ ${plural} in Article 5`,
      url,
      description: shown.join('\n'),
      color: COLOUR,
      footer: { text: `Play at ${url.replace(/^https?:\/\//, '').replace(/\/$/, '')}` },
    }],
    // Names are three characters of A-Z, 0-9 and a dash and cannot spell a
    // mention, but a board this open should not be one webhook from pinging a
    // whole server, whatever anybody changes later.
    allowed_mentions: { parse: [] },
  };
}
