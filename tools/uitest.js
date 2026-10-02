// Plays the opening of a game through the real page with a real mouse and a
// real finger: the menu, deploying from the radial menu, selecting, upgrading,
// moving, calling the wave. Needs `npm start` running.
//
//   node tools/uitest.js [--shots]

import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, open, sleep } from './browser.js';

const port = process.env.PORT || 8080;
const shots = process.argv.includes('--shots');
let failed = 0;
const check = (ok, what) => {
  if (!ok) failed++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${what}`);
};

const chrome = await launch();
for (const [label, w, h, finger] of [['desktop', 1440, 900, false], ['phone', 390, 844, true]]) {
  console.log(`\n${label}`);
  const page = await open(`http://localhost:${port}/?quality=low`, { width: w, height: h });
  check(await page.ready(120), 'the page comes up');
  await page.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 1, mobile: finger });
  if (finger) await page.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  const tap = (x, y) => (finger ? page.touch([[x, y]]) : page.click(x, y));
  const centre = async (sel) => page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect(); return r && r.width ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()`);
  const snap = async (name) => { if (shots) { mkdirSync('shots', { recursive: true }); writeFileSync(`shots/ui-${label}-${name}.png`, await page.screenshot()); } };

  const play = await centre('#play');
  check(Boolean(play), 'the menu has a deploy button');
  await tap(...play);
  await sleep(1500);
  check(await page.evaluate("!document.getElementById('hud').classList.contains('hidden')"), 'deploy starts a game');

  // Tap the map just west of Tartu: our ground, so a build menu should open.
  const at = await page.evaluate(`(() => { const [x, y] = webta.lonlat(26.4, 58.35); webta.rig.flyTo(x, y, 900); webta.rig.x = x; webta.rig.y = y; webta.rig.dist = 900; return [x, y]; })()`);
  await sleep(600);
  const spot = await page.evaluate(`(() => { const v = new webta.THREE.Vector3(${at[0]}, webta.terrainView.groundAt(${at[0]}, ${at[1]}), ${-at[1]}).project(webta.renderer.camera); return [(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight]; })()`);
  await tap(spot[0], spot[1]);
  await sleep(500);
  const buttons = await page.evaluate("document.querySelectorAll('#radial .rbtn').length");
  check(buttons === 5, `tapping our ground opens the build menu (${buttons} buttons)`);
  await snap('radial');

  // The tank is the second button.
  const tank = await page.evaluate("(() => { const r = document.querySelectorAll('#radial .rbtn')[1]?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()");
  await tap(...tank);
  await sleep(900);
  const units = await page.evaluate("webta.sim.units.filter((u) => u.side === 'nato').map((u) => u.kind)");
  check(units.length === 1 && units[0] === 'tank', `the tank button deploys a tank (${units.join(',')})`);
  check(await page.evaluate("document.getElementById('radial').classList.contains('hidden')"), 'and the menu closes');

  // Tap the tank: the unit menu, with an upgrade.
  const funds0 = await page.evaluate('webta.sim.funds');
  const tpos = await page.evaluate(`(() => { const u = webta.sim.units[0]; const v = new webta.THREE.Vector3(u.x, webta.terrainView.groundAt(u.x, u.y) + 6, -u.y).project(webta.renderer.camera); return [(v.x * 0.5 + 0.5) * innerWidth, (-v.y * 0.5 + 0.5) * innerHeight]; })()`);
  await tap(...tpos);
  await sleep(500);
  const unitButtons = await page.evaluate("[...document.querySelectorAll('#radial .rbtn .t')].map((e) => e.textContent)");
  check(unitButtons.length === 3, `tapping the tank opens its menu (${unitButtons.join(' / ')})`);
  await snap('unit');
  const up = await page.evaluate("(() => { const r = document.querySelectorAll('#radial .rbtn')[0]?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()");
  await tap(...up);
  await sleep(400);
  const level = await page.evaluate('webta.sim.units[0].level');
  const funds1 = await page.evaluate('webta.sim.funds');
  check(level === 1 && funds1 < funds0, `upgrade works (level ${level}, €${Math.round(funds0)} -> €${Math.round(funds1)})`);

  // Move: the button, then a tap somewhere else on our ground.
  const move = await page.evaluate("(() => { const b = [...document.querySelectorAll('#radial .rbtn')].find((e) => e.textContent.includes('MOVE')); const r = b?.getBoundingClientRect(); return r ? [r.x + r.width / 2, r.y + r.height / 2] : null; })()");
  if (move) {
    await tap(...move);
    await sleep(300);
    await tap(spot[0] - 60, spot[1] + 40);
    await sleep(300);
    check(await page.evaluate('Boolean(webta.sim.units[0].path)'), 'move sends the tank somewhere');
  } else check(false, 'the unit menu has a move button');

  // Drag pans the map.
  const before = await page.evaluate('[webta.rig.want.x, webta.rig.want.y]');
  if (finger) await page.touch([[200, 400], [220, 420], [260, 460], [300, 500]]);
  else {
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 700, y: 400, button: 'left', buttons: 1, clickCount: 1 });
    for (const [x, y] of [[720, 420], [760, 460], [800, 500]]) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 800, y: 500, button: 'left', buttons: 0, clickCount: 1 });
  }
  await sleep(200);
  const after = await page.evaluate('[webta.rig.want.x, webta.rig.want.y]');
  check(Math.hypot(after[0] - before[0], after[1] - before[1]) > 20, 'dragging pans the map');

  // The big button starts the war.
  const wave = await centre('#btnWave');
  await tap(...wave);
  await sleep(1500);
  check(await page.evaluate("webta.sim.state === 'wave'"), 'the wave button starts wave 1');
  await snap('wave');

  for (const l of page.logs) if (l.level === 'error') console.log(`[error] ${l.text}`.slice(0, 300));
  check(!page.logs.some((l) => l.level === 'error'), 'no errors on the console');
  await page.close();
}
chrome.kill?.();
if (failed) {
  console.log(`\n${failed} failed`);
  process.exit(1);
}
console.log('\nall good');
process.exit(0);
