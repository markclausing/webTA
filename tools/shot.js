// Photographs the game in a headless browser.
//
//   node tools/shot.js [out.png] [--play] [--wait=4] [--quality=high] [--eval="js"]
//
// Needs `npm start` running (or PORT set to wherever it is).

import { writeFileSync } from 'node:fs';
import { launch, open, sleep } from './browser.js';

const args = process.argv.slice(2);
const out = args.find((a) => !a.startsWith('--')) || 'shot.png';
const opt = (k, d) => (args.find((a) => a.startsWith(`--${k}=`)) || '').split('=').slice(1).join('=') || d;
const port = process.env.PORT || 8080;
const quality = opt('quality', 'medium');
const url = `http://localhost:${port}/?quality=${quality}&noreplay${opt('extra', '')}`;

const chrome = await launch({ width: 1600, height: 900 });
const page = await open(url, { width: Number(opt('w', 1600)), height: Number(opt('h', 900)) });
const ok = await page.ready(120);
if (!ok) console.log('never became ready');
if (args.includes('--play')) await page.evaluate('window.webta.startGame()');
const script = opt('eval', '');
if (script) console.log(await page.evaluate(script));
await sleep(Number(opt('wait', 4)) * 1000);
const after = opt('after', '');
if (after) console.log(await page.evaluate(after));
const frames = Number(opt('frames', 1));
const every = Number(opt('every', 500));
for (let i = 0; i < frames; i++) {
  const name = frames > 1 ? out.replace(/\.png$/, `-${i}.png`) : out;
  writeFileSync(name, await page.screenshot());
  const probe = opt('probe', '');
  if (probe) console.log(i, await page.evaluate(probe));
  if (i < frames - 1) await sleep(every);
}
for (const l of page.logs) if (l.level === 'error' || l.level === 'warning') console.log(`[${l.level}] ${l.text}`.slice(0, 400));
await page.close();
chrome.kill?.();
console.log('wrote', out);
process.exit(0);
