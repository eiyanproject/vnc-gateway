'use strict';

const $ = (id) => document.getElementById(id);
const viewport = $('viewport');

// guacamole-common-js client states
const STATE = { CONNECTING: 1, WAITING: 2, CONNECTED: 3, DISCONNECTED: 5 };

let client = null;
let keyboard = null;
let lastError = '';
let leaving = false;        // the user pressed Disconnect: no "session ended" dialog
let busy = false;           // a connect is in flight
let config = { idleTimeoutSeconds: 0 };

// The last connect request, so Reconnect can repeat it. Lives only in this
// page's memory (the password included) and is dropped on "Back to list".
let lastRequest = null;

// Idle tracking mirrors the server's: it decides, this only warns.
let lastInput = 0;
let lastMouse = null;

// ---------------------------------------------------------------- prefs
// Per-browser conveniences only. Storage can be unavailable (private mode),
// so every access is guarded and nothing depends on it.
const prefs = {
  get(k, d) { try { const v = localStorage.getItem(`vncgw.${k}`); return v === null ? d : v; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(`vncgw.${k}`, v); } catch { /* not available */ } },
};
let fit = prefs.get('fit', '1') === '1';

// ------------------------------------------------------------------ helpers
function setStatus(text, cls) {
  $('status').textContent = text;
  $('status').className = 'status ' + (cls || '');
}

function showError(msg) {
  $('error').textContent = msg || '';
  $('error').hidden = !msg;
}

// Errors land where the user is looking: the dialog if it is open.
function fail(msg) {
  if (!$('ended').hidden) $('ended-msg').textContent = msg;
  else showError(msg);
}

const timeOf = (iso) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// Every state-changing request carries X-VNCGW: 1. The server refuses
// cross-site POSTs without it (a custom header needs a CORS preflight, and that
// is never approved).
async function api(path, method = 'GET', body) {
  const opts = { method, headers: { 'X-VNCGW': '1' }, credentials: 'same-origin', redirect: 'error' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, opts);
  } catch {
    // Behind Cloudflare Access an expired session becomes a redirect to the
    // login page, which fetch cannot follow.
    throw new Error('Could not reach the gateway. If your Cloudflare Access session expired, reload the page to sign in again.');
  }
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `request failed (${res.status})`);
    err.status = res.status;
    err.since = data.since;
    throw err;
  }
  return data;
}

// Disable every control in the list while a connect is in flight, so a double
// click cannot open two sessions or burn the rate limit.
function setBusy(on, button) {
  busy = on;
  document.querySelectorAll('#picker button, #picker input, #ended button').forEach((el) => {
    if (on) el.disabled = true;
    else el.disabled = el.dataset.locked === '1';
  });
  if (on && button) {
    button.dataset.label = button.textContent;
    button.textContent = 'Connecting…';
  }
  if (!on) {
    document.querySelectorAll('button[data-label]').forEach((b) => { b.textContent = b.dataset.label; delete b.dataset.label; });
  }
}

// -------------------------------------------------------------------- list
function badge(item) {
  if (!item.busy) return null;
  const b = document.createElement('span');
  b.className = 'badge' + (item.busy.mine ? '' : ' warn');
  b.textContent = item.busy.mine
    ? 'Open in another window — connecting takes it over'
    : `In use since ${timeOf(item.busy.since)}`;
  return b;
}

function renderItem(item) {
  const li = document.createElement('li');
  li.className = 'item';
  li.dataset.key = item.key;
  if (item.key === prefs.get('last', '')) li.classList.add('last');

  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'open';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = item.name;
  const sub = document.createElement('span');
  sub.className = 'sub';
  sub.textContent = item.sub;
  open.append(name, sub);
  const b = badge(item);
  if (b) open.append(b);
  if (item.busy && !item.busy.mine) open.dataset.locked = '1';
  open.disabled = open.dataset.locked === '1';
  li.append(open);

  if (item.kind === 'connection') {
    open.onclick = () => connect({ connectionId: item.id }, item.name, item.key, open);
    return li;
  }

  // A kept profile: ask for the password inline, then connect.
  const actions = document.createElement('span');
  actions.className = 'actions';
  const rename = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost', textContent: 'Rename' });
  const del = Object.assign(document.createElement('button'), { type: 'button', className: 'ghost danger', textContent: 'Delete' });
  actions.append(rename, del);
  li.append(actions);

  const form = document.createElement('form');
  form.className = 'pw';
  form.hidden = true;
  const pw = Object.assign(document.createElement('input'), { type: 'password', placeholder: `VNC password for ${item.name}`, autocomplete: 'off' });
  const go = Object.assign(document.createElement('button'), { type: 'submit', className: 'primary', textContent: 'Connect' });
  const cancel = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Cancel' });
  form.append(pw, go, cancel);
  li.append(form);

  open.onclick = () => {
    document.querySelectorAll('form.pw').forEach((f) => { if (f !== form) f.hidden = true; });
    form.hidden = !form.hidden;
    if (!form.hidden) pw.focus();
  };
  cancel.onclick = () => { form.hidden = true; pw.value = ''; open.focus(); };
  form.onsubmit = (e) => {
    e.preventDefault();
    connect({ profileId: item.id, password: pw.value }, item.name, item.key, go);
  };
  rename.onclick = async () => {
    const n = window.prompt('Rename profile', item.name);
    if (n === null || !n.trim()) return;
    try { await api(`/api/profiles/${item.id}`, 'PATCH', { name: n }); await loadConnections(); } catch (e) { showError(e.message); }
  };
  del.onclick = async () => {
    if (!window.confirm(`Delete the profile "${item.name}"? The desktop itself is not affected.`)) return;
    try { await api(`/api/profiles/${item.id}`, 'DELETE'); await loadConnections(); } catch (e) { showError(e.message); }
  };
  return li;
}

async function loadConnections() {
  const data = await api('/api/connections');
  config = data;
  $('whoami').textContent = data.via === 'access' ? data.user : 'LAN';
  $('new').hidden = !data.freeformEnabled;
  $('recording-note').hidden = !data.recording;

  const items = [
    ...data.connections.map((c) => ({ kind: 'connection', key: `c:${c.id}`, id: c.id, name: c.label, sub: 'shared', busy: c.busy })),
    ...data.profiles.map((p) => ({ kind: 'profile', key: `p:${p.id}`, id: p.id, name: p.name, sub: `${p.host}:${p.port}`, busy: p.busy })),
  ];
  const list = $('desktops');
  list.replaceChildren(...items.map(renderItem));
  $('empty').hidden = items.length > 0;
  if (busy) setBusy(true);
}

// Keep the "in use" badges current while the list is on screen, unless the
// user is in the middle of typing into it.
setInterval(() => {
  const typing = document.activeElement && document.activeElement.matches('#picker input');
  const pwOpen = [...document.querySelectorAll('form.pw')].some((f) => !f.hidden);
  if (!$('picker').hidden && !busy && !typing && !pwOpen) loadConnections().catch(() => {});
}, 15000);

// ----------------------------------------------------------------- connect
async function connect(body, label, key, button) {
  if (busy) return;
  showError('');
  setBusy(true, button);
  setStatus('requesting session…');
  let session;
  try {
    // An ID (or a host the server validates) -- never a token or a key.
    session = await api('/api/sessions', 'POST', {
      ...body,
      width: Math.floor(window.innerWidth),
      height: Math.floor(window.innerHeight - 40),
    });
  } catch (e) {
    setBusy(false);
    setStatus('idle');
    fail(e.status === 409 && e.since ? `${e.message} In use since ${timeOf(e.since)}.` : e.message);
    if ($('ended').hidden) loadConnections().catch(() => {});
    return;
  }
  lastRequest = { body, label, key };
  if (key) prefs.set('last', key);
  $('target').textContent = label;
  openDisplay(session);
}

function rescale() {
  // The label follows the preference, not the display: it must be right even
  // before the first frame has arrived.
  $('scale').textContent = fit ? 'Fit' : '1:1';
  viewport.classList.toggle('one-to-one', !fit);
  if (!client) return;
  const display = client.getDisplay();
  const w = display.getWidth();
  const h = display.getHeight();
  if (!w || !h) return;
  // Never upscale: a blurry desktop is worse than a border.
  display.scale(fit ? Math.min(viewport.clientWidth / w, viewport.clientHeight / h, 1) : 1);
}

function openDisplay({ sid }) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const tunnel = new Guacamole.WebSocketTunnel(`${scheme}://${location.host}/`);
  client = new Guacamole.Client(tunnel);
  lastError = '';
  leaving = false;

  const display = client.getDisplay();
  const el = display.getElement();
  $('display').replaceChildren(el);

  // The server explains takeovers and idle timeouts through this.
  client.onerror = (status) => { lastError = (status && status.message) || 'The remote side closed the connection.'; };
  tunnel.onerror = (status) => { lastError = lastError || (status && status.message) || 'The connection to the gateway failed.'; };

  client.onstatechange = (state) => {
    if (state === STATE.CONNECTING || state === STATE.WAITING) setStatus('connecting…');
    if (state === STATE.CONNECTED) {
      setBusy(false);
      setStatus('connected', 'good');
      $('picker').hidden = true;
      $('ended').hidden = true;
      viewport.hidden = false;
      $('session-tools').hidden = false;
      lastInput = Date.now();
      viewport.focus();
      rescale();
    }
    if (state === STATE.DISCONNECTED) sessionEnded();
  };

  display.onresize = rescale;

  // Coordinates arrive in on-screen pixels; `true` divides by the display
  // scale so clicks land where they look like they land.
  const mouse = new Guacamole.Mouse(el);
  mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state) => {
    if (!client) return;
    lastMouse = state;
    lastInput = Date.now();
    client.sendMouseState(state, true);
  };
  el.addEventListener('mousedown', () => viewport.focus());

  keyboard = new Guacamole.Keyboard(viewport);
  keyboard.onkeydown = (sym) => { if (client) { lastInput = Date.now(); client.sendKeyEvent(1, sym); } };
  keyboard.onkeyup = (sym) => { if (client) client.sendKeyEvent(0, sym); };

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
  // The opaque handle is all the browser ever holds. The server claims it
  // during the WebSocket upgrade and it is dead after one use.
  client.connect(`sid=${encodeURIComponent(sid)}`);
}

// Drop the display, keep the page.
function closeDisplay() {
  if (keyboard) { keyboard.onkeydown = keyboard.onkeyup = null; keyboard.reset(); }
  const c = client;
  client = null;
  keyboard = null;
  lastMouse = null;
  if (c) {
    c.onstatechange = c.onerror = null; // a torn-down session must not end twice
    try { c.disconnect(); } catch { /* already gone */ }
  }
  $('display').replaceChildren();
  viewport.hidden = true;
  $('session-tools').hidden = true;
  $('clip-panel').hidden = true;
  $('idle-warning').hidden = true;
  if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
}

function sessionEnded() {
  const wasLeaving = leaving;
  closeDisplay();
  setBusy(false);
  if (wasLeaving) return backToList();
  setStatus('disconnected', 'bad');
  $('ended-msg').textContent = lastError || 'The session ended.';
  $('ended').hidden = false;
  $('picker').hidden = true;
  $('reconnect').focus();
}

function backToList() {
  closeDisplay();
  lastRequest = null; // the password goes with it
  $('ended').hidden = true;
  $('picker').hidden = false;
  $('target').textContent = '';
  setStatus('idle');
  loadConnections().catch((e) => showError(e.message));
}

// ------------------------------------------------------------- idle warning
// The server closes a session after IDLE_TIMEOUT_MINUTES without input. Warn
// before that, and let the user keep it with one click.
setInterval(() => {
  const timeout = config.idleTimeoutSeconds;
  if (!client || !timeout) { $('idle-warning').hidden = true; return; }
  const left = Math.ceil(timeout - (Date.now() - lastInput) / 1000);
  const warnAt = Math.min(60, Math.floor(timeout / 2));
  if (left <= warnAt && left > 0) {
    $('idle-text').textContent = `No input for a while — disconnecting in ${left}s.`;
    $('idle-warning').hidden = false;
  } else {
    $('idle-warning').hidden = true;
  }
}, 1000);

$('stay').onclick = () => {
  if (!client) return;
  // Re-send the pointer where it already is: real input to the server, no
  // visible effect on the desktop. Before any mouse use, tap Shift instead.
  if (lastMouse) client.sendMouseState(lastMouse, true);
  else { client.sendKeyEvent(1, 0xffe1); client.sendKeyEvent(0, 0xffe1); }
  lastInput = Date.now();
  $('idle-warning').hidden = true;
  viewport.focus();
};

// ------------------------------------------------------------------ toolbar
$('disconnect').onclick = () => {
  leaving = true;
  if (client) client.disconnect(); // -> DISCONNECTED -> back to the list
  else backToList();
};

$('reconnect').onclick = () => {
  if (!lastRequest) return backToList();
  const { body, label, key } = lastRequest;
  connect(body, label, key, $('reconnect'));
};
$('back').onclick = backToList;

$('scale').onclick = () => {
  fit = !fit;
  prefs.set('fit', fit ? '1' : '0');
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
  } catch { /* fullscreen refused */ }
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
  const writer = new Guacamole.StringWriter(client.createClipboardStream('text/plain'));
  writer.sendText(text);
  writer.sendEnd();
  lastInput = Date.now();
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
  lastInput = Date.now();
  viewport.focus();
};

// ---------------------------------------------------------- new connection
function formTarget() {
  const host = $('host').value.trim();
  const port = parseInt($('port').value, 10) || 5900;
  return { name: $('name').value.trim(), host, port };
}

$('adhoc').onsubmit = (e) => {
  e.preventDefault();
  const t = formTarget();
  const submit = $('adhoc').querySelector('button[type=submit]');
  connect({ host: t.host, port: t.port, password: $('password').value }, t.name || `${t.host}:${t.port}`, null, submit);
};

$('keep').onclick = async () => {
  const t = formTarget();
  if (!t.host) { $('host').reportValidity(); return; }
  showError('');
  try {
    // Name, host and port only. The password field is deliberately not read.
    const p = await api('/api/profiles', 'POST', { name: t.name, host: t.host, port: t.port });
    prefs.set('last', `p:${p.id}`);
    $('adhoc').reset();
    await loadConnections();
    const li = document.querySelector(`#desktops li[data-key="p:${p.id}"] .open`);
    if (li) li.focus();
  } catch (err) {
    showError(err.message);
  }
};

// --------------------------------------------------------------------- page
window.addEventListener('resize', rescale);
// Switching windows mid-keypress would otherwise leave Alt or Ctrl held down
// on the remote.
window.addEventListener('blur', () => { if (keyboard) keyboard.reset(); });
window.addEventListener('beforeunload', () => { leaving = true; if (client) client.disconnect(); });

rescale(); // apply the remembered Fit/1:1 label before anything connects
loadConnections()
  .then(() => {
    const last = document.querySelector('#desktops li.last .open:not(:disabled)');
    if (last) last.focus();
  })
  .catch((err) => showError(err.message));
