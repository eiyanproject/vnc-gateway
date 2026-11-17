'use strict';

// Fixed-window limiter for session minting. Each minted session is a guacd
// connection attempt against a real host, so an unthrottled endpoint is a way
// to hammer VNC passwords or sweep the allowlisted range for open ports.
// In-memory is enough for a single replica.

function createLimiter({ perMinute }) {
  const windows = new Map(); // key -> { start, count }

  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    for (const [k, w] of windows) if (w.start < cutoff) windows.delete(k);
  }, 60_000).unref();

  return function allow(key) {
    const now = Date.now();
    const w = windows.get(key);
    if (!w || now - w.start >= 60_000) {
      windows.set(key, { start: now, count: 1 });
      return { ok: true };
    }
    if (w.count >= perMinute) {
      return { ok: false, retryAfter: Math.ceil((w.start + 60_000 - now) / 1000) };
    }
    w.count += 1;
    return { ok: true };
  };
}

module.exports = { createLimiter };
