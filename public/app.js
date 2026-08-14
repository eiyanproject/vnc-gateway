'use strict';

const $ = (id) => document.getElementById(id);
const statusEl = $('status');
const errorEl = $('error');

let client = null;
let keyboard = null;

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}

function showError(msg) {
  errorEl.textContent = msg;
  errorEl.hidden = false;
}

async function loadConnections() {
  const res = await fetch('/api/connections');
  if (!res.ok) return showError('Not authorised (' + res.status + ')');
  const data = await res.json();

  $('whoami').textContent = data.user;
  $('freeform').hidden = !data.freeformEnabled;

  const list = $('connections');
  list.innerHTML = '';
  if (data.connections.length === 0) {
    list.innerHTML = '<li class="hint">Nothing in connections.json yet.</li>';
  }
  for (const conn of data.connections) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.textContent = conn.label;
    btn.onclick = () => connect({ connectionId: conn.id });
    li.appendChild(btn);
    list.appendChild(li);
  }
}

async function connect(body) {
  errorEl.hidden = true;
  setStatus('requesting session…');

  // Ask the server for a session. Note what we send: an ID (or a host the
  // server will validate). No credentials, no encryption key -- the browser is
  // never trusted to choose its own target.
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...body,
      width: Math.floor(window.innerWidth),
      height: Math.floor(window.innerHeight - 40),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setStatus('failed', 'bad');
    return showError(err.error || 'Session request failed (' + res.status + ')');
  }

  const { sid, guacToken } = await res.json();
  openDisplay(sid, guacToken);
}

function openDisplay(sid, guacToken) {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
  const tunnel = new Guacamole.WebSocketTunnel(`${scheme}://${location.host}/`);

  client = new Guacamole.Client(tunnel);

  const display = $('display');
  display.innerHTML = '';
  display.appendChild(client.getDisplay().getElement());

  client.onerror = (err) => {
    setStatus('error', 'bad');
    showError('Guacamole: ' + (err && err.message ? err.message : 'connection failed'));
    disconnect();
  };

  tunnel.onerror = (err) => {
    setStatus('tunnel error', 'bad');
    showError('Tunnel: ' + (err && err.message ? err.message : 'websocket failed'));
  };

  client.onstatechange = (state) => {
    // 3 = CONNECTED in guacamole-common-js
    if (state === 3) {
      setStatus('connected', 'good');
      $('picker').hidden = true;
      $('cad').hidden = false;
      $('disconnect').hidden = false;
    }
  };

  const el = client.getDisplay().getElement();
  const mouse = new Guacamole.Mouse(el);
  mouse.onmousedown = mouse.onmouseup = mouse.onmousemove = (state) => {
    client.sendMouseState(state);
  };

  keyboard = new Guacamole.Keyboard(document);
  keyboard.onkeydown = (sym) => client.sendKeyEvent(1, sym);
  keyboard.onkeyup = (sym) => client.sendKeyEvent(0, sym);

  setStatus('connecting…');
  // The handle rides along in the query string; the server claims it during the
  // WebSocket upgrade and it is dead the moment it is used once.
  client.connect(`token=${encodeURIComponent(guacToken)}&sid=${encodeURIComponent(sid)}`);
}

function disconnect() {
  if (client) { try { client.disconnect(); } catch (e) { /* already gone */ } }
  if (keyboard) keyboard.onkeydown = keyboard.onkeyup = null;
  client = null;
  keyboard = null;
  $('display').innerHTML = '';
  $('picker').hidden = false;
  $('cad').hidden = true;
  $('disconnect').hidden = true;
  setStatus('idle');
}

// Ctrl-Alt-Del can't be captured from a browser -- the OS eats it first -- so it
// has to be injected as explicit keysyms.
$('cad').onclick = () => {
  if (!client) return;
  const keys = [0xffe3, 0xffe9, 0xffff]; // Control_L, Alt_L, Delete
  keys.forEach((k) => client.sendKeyEvent(1, k));
  keys.reverse().forEach((k) => client.sendKeyEvent(0, k));
};

$('disconnect').onclick = disconnect;

$('adhoc').onsubmit = (e) => {
  e.preventDefault();
  connect({
    host: $('host').value.trim(),
    port: parseInt($('port').value, 10) || 5900,
    password: $('password').value,
  });
};

loadConnections().catch((err) => showError(err.message));
