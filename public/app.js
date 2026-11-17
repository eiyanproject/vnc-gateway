'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const errorEl = $('error');
const viewport = $('viewport');

// guacamole-common-js client states
const STATE = { IDLE: 0, CONNECTING: 1, WAITING: 2, CONNECTED: 3, DISCONNECTING: 4, DISCONNECTED: 5 };

let client = null;
let keyboard = null;
let fit = true;
let lastError = '';

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = !msg;
}

// Every state-changing request carries X-VNCGW: 1. The server refuses POSTs
// without it: a cross-site page cannot add a custom header without a CORS
// preflight, and that preflight is never approved.
async function api(path, body) {
  const opts = body === undefined
    ? { headers: { 'X-VNCGW': '1' } }
    : { method: 'POST', headers: { 'X-VNCGW': '1', 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  let res;
  try {
    res = await fetch(path, { ...opts, credentials: 'same-origin', redirect: 'error' });
  } catch (e) {
    // Behind Cloudflare Access an expired session turns into a redirect to the
    // login page, which fetch cannot follow cross-origin.
    throw new Error('Could not reach the gateway. If your Cloudflare Access session expired, reload the page to sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    throw err;
  }
  return data;
}

async function loadConnections() {
  const data = await api('/api/connections');
  $('whoami').textContent = data.via === 'access' ? data.user : 'LAN';
  $('freeform').hidden = !data.freeformEnabled;
  $('recording-note').hidden = !data.recording;

  const list = $('connections');
  list.innerHTML = '';
  if (data.connections.length === 0) {
    const li = document.createElement('li');
    li.className = 'hint';
    li.textContent = 'No saved connections for you in connections.json.';
    list.appendChild(li);
  }
  for (const conn of data.connections) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = conn.label;
    btn.onclick = () => connect({ connectionId: conn.id }, conn.label);
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function connect(body, label) {
  showError('');
  lastError = '';
  setStatus('requesting session…');
  let session;
  try {
    // An ID (or a host the server validates) -- never credentials or a key.
    session = await api('/api/sessions', {
      ...body,
      width: Math.floor(window.innerWidth),
      height: Math.floor(window.innerHeight - 40),
    });
  } catch (e) {
    setStatus('failed', 'bad');
    return showError(e.message);
  }
  $('target').textContent = label;
  openDisplay(session);
}

function rescale() {
  if (!client) return;
  const display = client.getDisplay();
  const w = display.getWidth();
  const h = display.getHeight();
  if (!w || !h) return;
  // Never upscale: a blurry desktop is worse than a border.
  const s = fit ? Math.min(viewport.clientWidth / w, viewport.clientHeight / h, 1) : 1;
  display.scale(s);
  viewport.classList.toggle('one-to-one', !fit);
}

function openDisplay({ sid }) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const tunnel = new Guacamole.WebSocketTunnel(`${scheme}://${location.host}/`);
  client = new Guacamole.Client(tunnel);

  const display = client.getDisplay();
  const el = display.getElement();
  $('display').innerHTML = '';
  $('display').appendChild(el);

  client.onerror = (status) => {
    lastError = (status && status.message) || 'the remote side closed the connection';
  };
  tunnel.onerror = (status) => {
    lastError = (status && status.message) || 'the connection to the gateway failed';
  };

  client.onstatechange = (state) => {
    if (state === STATE.CONNECTING || state === STATE.WAITING) setStatus('connecting…');
    if (state === STATE.CONNECTED) {
      setStatus('connected', 'good');
      $('picker').hidden = true;
      viewport.hidden = false;
      $('session-tools').hidden = false;
      viewport.focus();
      rescale();
    }
    if (state === STATE.DISCONNECTED) teardown(lastError);
  };

  display.onresize = rescale;

  // Coordinates arrive in on-screen pixels; `true` divides by the current
  // display scale so clicks land where they look like they land.
  const mouse = new Guacamole.Mouse(el);
  mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state) => client && client.sendMouseState(state, true);
  el.addEventListener('mousedown', () => viewport.focus());

  keyboard = new Guacamole.Keyboard(viewport);
  keyboard.onkeydown = (sym) => { if (client) client.sendKeyEvent(1, sym); };
  keyboard.onkeyup = (sym) => { if (client) client.sendKeyEvent(0, sym); };

  // Text copied on the remote machine.
  client.onclipboard = (stream, mimetype) => {
    if (!/^text\//.test(mimetype)) return;
    const reader = new Guacamole.StringReader(stream);
    let data = '';
    reader.ontext = (t) => { data += t; };
    reader.onend = () => {
      $('clip-text').value = data;
      // Only works in a secure context (https, i.e. through Cloudflare).
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(data).then(
          () => { $('clip-state').textContent = 'remote clipboard copied to this device'; },
          () => { $('clip-state').textContent = 'remote clipboard received'; },
        );
      } else {
        $('clip-state').textContent = 'remote clipboard received';
      }
    };
  };

  setStatus('connecting…');
  // The opaque handle is all the browser ever holds. The server claims it during
  // the WebSocket upgrade, swaps in the connection token it kept for itself, and
  // the handle is dead the moment it is used once.
  client.connect(`sid=${encodeURIComponent(sid)}`);
}

function teardown(reason) {
  if (keyboard) { keyboard.onkeydown = keyboard.onkeyup = null; keyboard.reset(); }
  const c = client;
  client = null;
  keyboard = null;
  if (c) { try { c.disconnect(); } catch (e) { /* already gone */ } }
  $('display').innerHTML = '';
  viewport.hidden = true;
  $('session-tools').hidden = true;
  $('clip-panel').hidden = true;
  $('picker').hidden = false;
  $('target').textContent = '';
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
  if (reason) {
    setStatus('disconnected', 'bad');
    showError(reason);
  } else {
    setStatus('idle');
  }
}

// ------------------------------------------------------------------ toolbar
$('disconnect').onclick = () => teardown('');

$('scale').onclick = () => {
  fit = !fit;
  $('scale').textContent = fit ? 'Fit' : '1:1';
  rescale();
  viewport.focus();
};

$('fullscreen').onclick = async () => {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen();
    } else {
      await document.documentElement.requestFullscreen();
      // Chromium only: lets Esc, Alt-Tab and the Windows key reach the remote
      // while fullscreen. Hold Esc to leave.
      if (navigator.keyboard && navigator.keyboard.lock) navigator.keyboard.lock().catch(() => {});
    }
  } catch (e) { /* fullscreen refused; nothing to do */ }
  viewport.focus();
};
document.addEventListener('fullscreenchange', () => {
  $('fullscreen').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
  rescale();
});

$('clip').onclick = () => {
  const p = $('clip-panel');
  p.hidden = !p.hidden;
  if (!p.hidden) $('clip-text').focus(); else viewport.focus();
};

$('clip-send').onclick = () => {
  if (!client) return;
  const text = $('clip-text').value;
  const stream = client.createClipboardStream('text/plain');
  const writer = new Guacamole.StringWriter(stream);
  writer.sendText(text);
  writer.sendEnd();
  $('clip-state').textContent = `sent ${text.length} characters - paste on the remote with Ctrl-V`;
  viewport.focus();
};

// Ctrl-Alt-Del cannot be captured from a browser -- the OS eats it first -- so
// it is injected as explicit keysyms.
$('cad').onclick = () => {
  if (!client) return;
  const keys = [0xffe3, 0xffe9, 0xffff]; // Control_L, Alt_L, Delete
  keys.forEach((k) => client.sendKeyEvent(1, k));
  keys.slice().reverse().forEach((k) => client.sendKeyEvent(0, k));
  viewport.focus();
};

$('adhoc').onsubmit = (e) => {
  e.preventDefault();
  const host = $('host').value.trim();
  const port = parseInt($('port').value, 10) || 5900;
  connect({ host, port, password: $('password').value }, `${host}:${port}`);
};

window.addEventListener('resize', rescale);
// Switching windows mid-keypress would otherwise leave Alt or Ctrl held down
// on the remote.
window.addEventListener('blur', () => { if (keyboard) keyboard.reset(); });
window.addEventListener('beforeunload', () => { if (client) client.disconnect(); });

loadConnections().catch((err) => showError(err.message));
