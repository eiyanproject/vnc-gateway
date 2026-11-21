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

  // ---------------------------------------------------------- keep profile
  const connected = (p) => waitFor(async () => (await p.textContent('#status')) === 'connected', 20000);
  const item = (p, name) => p.locator('#desktops li', { hasText: name });

  await page.fill('#name', 'Lab VNC');
  await page.fill('#host', '172.30.99.10');
  await page.fill('#port', '5900');
  await page.fill('#password', 'typed-but-not-kept');
  await page.click('#keep');
  check(Boolean(await waitFor(async () => (await item(page, 'Lab VNC').count()) === 1, 5000)), 'Keep profile adds it to the list');
  check((await item(page, 'Lab VNC').textContent()).includes('172.30.99.10:5900'), 'the profile shows its address');
  const listed = await (await page.request.get(`${BASE}/api/connections`)).text();
  check(!listed.includes('typed-but-not-kept'), 'the kept profile carries no password');
  check((await page.inputValue('#password')) === '', 'the password field is cleared after keeping');

  // ------------------------------------------- connect with a kept profile
  async function openProfile(p) {
    await item(p, 'Lab VNC').locator('button.open').click();
    await item(p, 'Lab VNC').locator('form.pw input').fill('e2e-pass');
    await item(p, 'Lab VNC').locator('form.pw input').press('Enter');
  }
  await openProfile(page);
  const allDisabled = await page.evaluate(() => [...document.querySelectorAll('#picker button')].every((b) => b.disabled));
  check(allDisabled, 'every button is disabled while connecting (no double sessions)');
  check(Boolean(await connected(page)), 'a kept profile connects after asking for the password');

  // ------------------------------------------------ one session per desktop
  const page2 = await (await browser.newContext({ viewport: { width: 640, height: 480 } })).newPage();
  page2.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(`[page2] ${m.text()}`); });
  await page2.goto(BASE);
  check(Boolean(await waitFor(async () => (await item(page2, 'Lab VNC').textContent()).includes('Open in another window'), 5000)),
    'the list shows the desktop is already open');
  await openProfile(page2);
  check(Boolean(await connected(page2)), 'a second window connects (same person takes over)');
  check(Boolean(await waitFor(async () => (await page.isVisible('#ended'))
    && (await page.textContent('#ended-msg')).includes('opened in another window'), 5000)),
  'the first window is told it was taken over', await page.textContent('#ended-msg'));

  // -------------------------------------------------------------- reconnect
  await page.click('#reconnect');
  check(Boolean(await connected(page)), 'Reconnect in the dialog reconnects without retyping the password');
  check(Boolean(await waitFor(async () => (await page2.isVisible('#ended'))
    && (await page2.textContent('#ended-msg')).includes('opened in another window'), 5000)),
  'and the other window is told in turn');
  await page2.click('#back');
  check(await page2.isVisible('#picker'), 'Back to list returns to the list');
  await waitFor(async () => (await item(page2, 'Lab VNC').textContent()).includes('Open in another window'), 3000);
  await page2.setViewportSize({ width: 900, height: 620 });
  await page2.screenshot({ path: '/out/list.png' });

  // ------------------------------------------------------------ view prefs
  await page.click('#scale'); // -> 1:1, remembered
  await page.reload();
  check(Boolean(await waitFor(async () => (await page.locator('#desktops li.last').textContent()).includes('Lab VNC'), 5000)),
    'the last-used desktop is highlighted after a reload');
  await openProfile(page);
  check(Boolean(await connected(page)), 'reconnects after a reload');
  check((await page.textContent('#scale')) === '1:1', '1:1 view is remembered');
  await page.click('#scale'); // back to Fit

  // ------------------------------------------------------------------ idle
  // IDLE_TIMEOUT_MINUTES=0.5 in e2e.env: warned at 15 s left, closed at 30 s.
  check(Boolean(await waitFor(() => page.isVisible('#idle-warning'), 25000)), 'an idle session is warned first');
  await page.click('#stay');
  check(!(await page.isVisible('#idle-warning')), '"Stay connected" dismisses the warning');
  const idleClosed = await waitFor(async () => (await page.isVisible('#ended'))
    && (await page.textContent('#ended-msg')).includes('without input'), 60000);
  check(Boolean(idleClosed), 'an idle session is closed by the server, with the reason', await page.textContent('#ended-msg'));
  check(Boolean(await waitFor(async () => /vncgw_active_sessions 0\b/.test(await (await page.request.get(`${BASE}/metrics`)).text()), 5000)),
    'and the desktop is free again');

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
