// Draws the app icons in a headless browser, with the game's own font, and
// writes them to icons/. Needs `npm start` running.
//
//   node tools/make-icons.js

import { writeFileSync, mkdirSync } from 'node:fs';
import { launch, open } from './browser.js';

const port = process.env.PORT || 8080;
const chrome = await launch();
const page = await open(`http://localhost:${port}/?quality=low`, { width: 600, height: 600 });
await page.ready(120);
await page.evaluate('document.fonts.ready');
const out = await page.evaluate(`(() => {
  const draw = (s) => {
    const c = document.createElement('canvas');
    c.width = c.height = s;
    const g = c.getContext('2d');
    // Navy field, a NATO-blue compass rose, a gold 5.
    const bg = g.createRadialGradient(s * 0.5, s * 0.4, s * 0.1, s * 0.5, s * 0.5, s * 0.75);
    bg.addColorStop(0, '#1d3557');
    bg.addColorStop(1, '#0b1320');
    g.fillStyle = bg;
    g.fillRect(0, 0, s, s);
    g.translate(s / 2, s / 2);
    g.fillStyle = 'rgba(58, 160, 255, 0.55)';
    for (let k = 0; k < 4; k++) {
      g.beginPath();
      g.moveTo(0, -s * 0.44);
      g.lineTo(s * 0.06, -s * 0.06);
      g.lineTo(0, 0);
      g.lineTo(-s * 0.06, -s * 0.06);
      g.closePath();
      g.fill();
      g.rotate(Math.PI / 2);
    }
    g.strokeStyle = 'rgba(255, 255, 255, 0.35)';
    g.lineWidth = Math.max(1, s * 0.02);
    g.beginPath();
    g.arc(0, 0, s * 0.3, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = '#f6c453';
    g.font = (s * 0.5) + "px 'Black Ops One'";
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.shadowColor = 'rgba(0, 0, 0, 0.5)';
    g.shadowBlur = s * 0.04;
    g.shadowOffsetY = s * 0.02;
    g.fillText('5', 0, s * 0.03);
    return c.toDataURL('image/png').split(',')[1];
  };
  return Object.fromEntries([32, 180, 192, 512].map((s) => [s, draw(s)]));
})()`);
mkdirSync('icons', { recursive: true });
for (const [s, b64] of Object.entries(out)) writeFileSync(`icons/icon-${s}.png`, Buffer.from(b64, 'base64'));
await page.close();
chrome.kill?.();
console.log('wrote', Object.keys(out).map((s) => `icon-${s}.png`).join(' '));
process.exit(0);
