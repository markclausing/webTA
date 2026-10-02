/**
 * The one thing you have to fill in yourself.
 *
 * The shared score board needs a server: a board that lives in one browser is
 * not a board anybody else can see. Everything else in this game runs off static
 * files, and this is the single line that changes that.
 *
 * It should be a Worker of this game's own rather than one of the other games':
 * the board is one Durable Object, and a war in webfiba's would
 * be a row its merge throws away. A Worker of its own is two commands. See
 * worker/README.md.
 *
 * Leave it empty and the game still plays, with your own board and nobody
 * else's. Only the shared half goes quiet.
 *
 *   export const DEFAULT_BOARD = 'https://webta.your-name.workers.dev';
 */
export const DEFAULT_BOARD = 'https://webta.vibecoach.workers.dev';

/**
 * Which server this page should talk to. A `?board=` in the address always wins,
 * so you can point a tab at a different one without editing anything. On
 * localhost the page assumes the server that served it, because that is what
 * `npm start` gives you.
 */
export function boardFor(location) {
  const override = new URLSearchParams(location.search || '').get('board');
  if (override) return `${override.replace(/\/+$/, '')}/highscores`;
  if (isLocal(location)) return `${location.origin}/highscores`;
  if (!DEFAULT_BOARD) return null;
  return `${DEFAULT_BOARD.replace(/\/+$/, '')}/highscores`;
}

/**
 * Are we being served by something on this machine? Read from the host rather
 * than only from hostname: they should agree, and quietly deciding a page is
 * remote because one field was missing would send a local test to the internet.
 */
function isLocal(location) {
  const name = location.hostname || String(location.host || '').split(':')[0];
  return /^(localhost|127\.0\.0\.1|\[?::1\]?)$/.test(name);
}
