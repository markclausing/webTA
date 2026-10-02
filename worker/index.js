/**
 * The score board, as a Cloudflare Worker.
 *
 * This is the only server the game has: the board, one Durable Object with one
 * key in it. Lifted from webfiba.
 *
 * It speaks exactly what server/board.js speaks, so the browser cannot tell
 * which one it is talking to and neither can the tests.
 *
 * See README.md next door for the two commands that put it live.
 */

import { merge, since, without } from '../src/highscores.js';
import { announcement, newRows } from './announce.js';

const MAX_BODY = 64 * 1024;

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type, x-admin-key',
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', ...CORS },
});

export class Board {
  constructor(state, env = {}) {
    this.state = state;
    // Cloudflare hands the object its bindings here, not to fetch(), which is
    // the only place the admin key can come from.
    this.env = env;
    this.board = null;
    this.clearedAt = 0;
    // Rows taken off by hand. Kept, because deleting a row does not delete it
    // from the browser that set it, and that browser will post it back.
    this.removed = [];
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/highscores/reset') return this.reset(request);
    if (url.pathname === '/highscores/remove') return this.remove(request);
    if (url.pathname === '/highscores') return this.scores(request);
    return new Response('Article 5 score board. Point the game at this address.', {
      headers: { 'content-type': 'text/plain; charset=utf-8', ...CORS },
    });
  }

  async load() {
    if (!this.board) {
      this.board = merge({}, (await this.state.storage.get('board')) || {});
      this.clearedAt = (await this.state.storage.get('clearedAt')) || 0;
      this.removed = (await this.state.storage.get('removed')) || [];
    }
    return this.board;
  }

  async scores(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method === 'GET') return json({ board: await this.load() });
    if (request.method !== 'POST') {
      return json({ error: 'GET to read the board, POST to add to it' }, 405);
    }

    const text = await request.text();
    if (text.length > MAX_BODY) return json({ error: 'that is not a score board' }, 413);

    let sent;
    try {
      sent = JSON.parse(text);
    } catch {
      return json({ error: 'not JSON' }, 400);
    }

    // The same merge the browser runs, so the two cannot disagree about what a
    // board is: rows that are not a plausible result do not survive it.
    const before = await this.load();
    // Anything set before the board was last emptied is not allowed back in.
    const arriving = without(since(sent?.board || {}, this.clearedAt), this.removed);
    const after = merge(before, arriving);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      this.board = after;
      await this.state.storage.put('board', after);
      // Anything that actually landed gets announced. Worked out from the board
      // rather than from what was sent, so a result that did not make the top ten
      // stays quiet and a result arriving for the second time is not news.
      await this.shout(newRows(before, after));
    }
    return json({ board: after });
  }

  /**
   * Wipes the board.
   *
   * A public list with no accounts on it will eventually collect something you
   * do not want on it - a joke name, an impossible score, or a test suite that
   * got pointed at the wrong server. This is the broom. It only works if you
   * have set a key:
   *
   *   npx wrangler secret put ADMIN_KEY
   *   curl -X POST -H "x-admin-key: ..." https://your-worker/highscores/reset
   *
   * With no key set the door is simply not there, which is the safe default for
   * anyone who deploys this and never reads about it.
   */
  async reset(request) {
    const denied = this.guard(request);
    if (denied) return denied;

    this.board = merge({}, {});
    // Remembered, or every browser still holding the old rows would post them
    // straight back and the board would refill itself.
    this.clearedAt = Date.now();
    await this.state.storage.put('board', this.board);
    await this.state.storage.put('clearedAt', this.clearedAt);
    return json({ board: this.board, cleared: true, clearedAt: this.clearedAt });
  }

  /**
   * Takes named rows off the board and keeps them off.
   *
   * The blunt version of this is reset(), which is no use when the board also
   * holds games people actually won. The ids are remembered, because a row
   * deleted here still exists in the browser that set it, and that browser will
   * post it back at the next sync.
   */
  async remove(request) {
    const denied = this.guard(request);
    if (denied) return denied;

    let ids;
    try {
      ids = JSON.parse(await request.text())?.ids;
    } catch {
      return json({ error: 'not JSON' }, 400);
    }
    if (!Array.isArray(ids) || !ids.length) return json({ error: 'send { ids: [...] }' }, 400);

    await this.load();
    this.board = without(this.board, ids);
    // Capped: this is a list of mistakes, not a database.
    this.removed = [...new Set([...this.removed, ...ids.map(String)])].slice(-200);
    await this.state.storage.put('board', this.board);
    await this.state.storage.put('removed', this.removed);
    return json({ board: this.board, removed: ids.length });
  }

  /** The two doors that change the board share one lock. */
  guard(request) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (request.method !== 'POST') return json({ error: 'POST here' }, 405);
    const key = this.env?.ADMIN_KEY;
    if (!key) return json({ error: 'no ADMIN_KEY set on this Worker' }, 404);
    if (request.headers.get('x-admin-key') !== key) return json({ error: 'wrong key' }, 403);
    return null;
  }

  /**
   * Tells Discord about it, if a webhook has been set.
   *
   * Discord being slow, rate limiting us or simply down must not make posting
   * a result fail: every failure is caught and logged, never thrown. The board
   * is the product here; the announcement is a nicety.
   */
  shout(rows) {
    const url = this.env?.DISCORD_WEBHOOK;
    if (!rows.length) return;
    if (!url) {
      console.log('announce: no DISCORD_WEBHOOK on this Worker');
      return;
    }
    // Awaited, with a short fuse. Left to run after the response, the post was
    // cut off with the request and never arrived; four seconds is plenty for
    // Discord and a slow Discord still cannot hold up a score for long.
    const post = fetch(url, {
      signal: AbortSignal.timeout(4000),
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(announcement(rows, this.env?.GAME_URL)),
    }).then(async (res) => {
      // Logged either way, so `wrangler tail` can say why a post did not appear.
      if (res.ok) console.log(`announce: posted ${rows.length} row(s)`);
      else console.log(`announce: Discord said ${res.status} ${(await res.text()).slice(0, 300)}`);
    }).catch((err) => console.log(`announce: failed ${err.message}`));
    return post;
  }
}

export default {
  fetch(request, env) {
    // Everything goes to the one object. Sixty rows of results are not worth
    // sharding, and two objects would be two boards.
    const id = env.BOARD.idFromName('global');
    return env.BOARD.get(id).fetch(request);
  },
};
