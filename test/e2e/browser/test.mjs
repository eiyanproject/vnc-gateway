// End-to-end: a real Chromium drives the real UI, through the real app and
// guacd, to a real VNC server. Checks pixels, mouse mapping under scaling,
// keyboard, clipboard both ways, recording, metrics and the page's console.

import { chromium } from 'playwright';
import fs from 'node:fs';

const BASE = process.env.BASE_URL;
const fails = [];
const check = (ok, msg, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${msg}${!ok && detail ? `  (${detail})` : ''}`);
  if (!ok) fails.push(msg);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    await sleep(200);
  }
  return null;
}
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

const REMOTE_W = 1024;
const REMOTE_H = 768;

const browser = await chromium.launch();
const page = await (await browser.newContext({ viewport: { width: 640, height: 480 } })).newPage();
const consoleErrors = [];
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
page.on('pageerror', (e) => consoleErrors.push(String(e)));

try {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'E2E desktop' }).click({ timeout: 10000 });

  check(Boolean(await waitFor(async () => (await page.textContent('#status')) === 'connected', 20000)),
    'connects through guacd to a real VNC server', await page.textContent('#status'));

  // ---------------------------------------------------------------- pixels
  // The first canvas is the default layer, at remote resolution.
  const sample = await waitFor(() => page.evaluate(() => {
    const c = document.querySelector('#display canvas');
    if (!c || c.width < 100) return null;
    const d = c.getContext('2d').getImageData(100, 100, 1, 1).data;
    return d[3] ? { w: c.width, h: c.height, rgb: [d[0], d[1], d[2]] } : null;
  }), 15000);
  check(sample && sample.w === REMOTE_W && sample.h === REMOTE_H, 'canvas is the remote resolution', JSON.stringify(sample));
  const near = (a, b) => Math.abs(a - b) <= 24; // guacd may JPEG-encode
  check(sample && near(sample.rgb[0], 48) && near(sample.rgb[1], 96) && near(sample.rgb[2], 192),
    'real remote pixels arrived (root window colour)', JSON.stringify(sample && sample.rgb));

  // --------------------------------------------------------------- scaling
  const rect = await page.evaluate(() => {
    const r = document.querySelector('#display canvas').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  });
  const expected = Math.min(640 / REMOTE_W, (480 - 40) / REMOTE_H);
  const scale = rect.w / REMOTE_W;
  check(Math.abs(scale - expected) < 0.02, 'desktop is scaled to fit the window', `scale ${scale.toFixed(3)} vs ${expected.toFixed(3)}`);
  await page.screenshot({ path: '/out/connected.png' });

  // ----------------------------------------------------- mouse + keyboard
  // Point at the middle of the terminal (remote 730,570). Its keyboard focus
  // follows the pointer, so the text only arrives if coordinates are divided by
  // the display scale on the way out.
  const x = rect.x + 730 * scale;
  const y = rect.y + 570 * scale;
  await page.mouse.move(x, y);
  await page.mouse.click(x, y);
  await sleep(300);
  await page.keyboard.type('hello-e2e', { delay: 30 });
  await page.keyboard.press('Enter');
  check(Boolean(await waitFor(() => read('/shared/typed').includes('hello-e2e'), 10000)),
    'mouse lands where it looks like it lands, and keystrokes reach the remote', JSON.stringify(read('/shared/typed')));

  // ------------------------------------------------------------- clipboard
  fs.writeFileSync('/shared/clip-set', 'from-remote-123');
  check(Boolean(await waitFor(async () => (await page.inputValue('#clip-text')) === 'from-remote-123', 10000)),
    'remote clipboard reaches the browser');

  await page.click('#clip');
  await page.fill('#clip-text', 'from-browser-456');
  await page.click('#clip-send');
  check(Boolean(await waitFor(() => (read('/shared/clip-out-clipboard') + read('/shared/clip-out-primary')).includes('from-browser-456'), 10000)),
    'browser clipboard reaches the remote');
  await page.click('#clip');

  // ----------------------------------------------------------- 1:1 toggle
  await page.click('#scale');
  await sleep(300);
  const one = await page.evaluate(() => document.querySelector('#display canvas').getBoundingClientRect().width);
  check(Math.abs(one - REMOTE_W) < 2, '1:1 mode shows real pixels', String(one));
  await page.click('#scale');

  // ------------------------------------------------------------ metrics
  const during = await (await page.request.get(`${BASE}/metrics`)).text();
  check(/vncgw_active_sessions 1\b/.test(during), 'metrics show one active session');
  check(/vncgw_sessions_total\{kind="saved"\} 1\b/.test(during), 'metrics count the opened session');

  // ---------------------------------------------------------- disconnect
  await page.click('#disconnect');
  check(Boolean(await waitFor(async () => (await page.textContent('#status')) === 'idle' && await page.isVisible('#picker'), 5000)),
    'disconnect returns to the connection list');
  check(Boolean(await waitFor(async () => /vncgw_active_sessions 0\b/.test(await (await page.request.get(`${BASE}/metrics`)).text()), 5000)),
    'metrics show the session closed');

  // ------------------------------------------------------------ recording
  const rec = await waitFor(() => {
    const files = fs.readdirSync('/recordings').filter((f) => !f.startsWith('.'));
    const sized = files.filter((f) => fs.statSync(`/recordings/${f}`).size > 1000);
    return sized.length ? sized : null;
  }, 10000);
  check(Boolean(rec), 'guacd wrote a session recording', JSON.stringify(fs.readdirSync('/recordings')));
  if (rec) {
    const head = fs.readFileSync(`/recordings/${rec[0]}`, 'utf8').slice(0, 200);
    check(!head.includes('e2e-pass'), 'recording does not contain the VNC password');
  }

  // --------------------------------------------------------------- page
  check(consoleErrors.length === 0, 'no console errors or CSP violations', consoleErrors.join(' | ').slice(0, 500));
} catch (err) {
  check(false, 'test run completed', err.message);
  await page.screenshot({ path: '/out/failure.png' }).catch(() => {});
} finally {
  await browser.close();
}

console.log(`\n${fails.length === 0 ? 'ALL PASSED' : `${fails.length} FAILED`}`);
process.exit(fails.length ? 1 : 0);
