// Anonymous solo sessions, not accounts or fingerprints. Telemetry never blocks play.
export function createSoloPresence({ fetcher = fetch, storage, page = document, every = setInterval, cancel = clearInterval } = {}) {
  const key = 'needle-drop:solo-session';
  let token, started = false, pending = false, timer;
  try { storage ??= globalThis.sessionStorage; token = storage?.getItem(key); } catch { /* An in-memory session still works. */ }
  async function heartbeat() {
    if (!started || page.hidden || pending) return;
    pending = true;
    try {
      const response = await fetcher('/api/solo/presence', { method: 'POST', cache: 'no-store',
        headers: { 'Content-Type': 'application/json', ...(token ? { 'X-Solo-Token': token } : {}) },
        body: '{}', signal: AbortSignal.timeout(8000) });
      if (!response.ok) return;
      const result = await response.json();
      if (/^[a-f0-9]{48}$/.test(result.token)) {
        token = result.token;
        try { storage?.setItem(key, token); } catch { /* Keep the current in-memory token. */ }
      }
    } catch { /* Retry on the next heartbeat; the game remains usable. */ }
    finally { pending = false; }
  }
  page.addEventListener('visibilitychange', heartbeat);
  return {
    start() { if (started) return; started = true; void heartbeat(); timer = every(heartbeat, 15000); },
    stop() { started = false; cancel(timer); },
    heartbeat,
  };
}
