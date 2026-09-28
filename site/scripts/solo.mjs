import { randomBytes } from 'node:crypto';
import { LobbyError } from './lobbies.mjs';
import { clientAddress, readJSON } from './lobby-api.mjs';

const ACTIVE_MS = 45000, SESSION_MS = 30 * 60 * 1000;
export function createSoloService({ now = Date.now, onEvent = () => {}, maxSessions = 10000 } = {}) {
  const sessions = new Map();
  function prune() { for (const [token, lastSeen] of sessions) if (now() - lastSeen >= SESSION_MS) sessions.delete(token); }
  function has(token) { return typeof token === 'string' && sessions.has(token) && now() - sessions.get(token) < SESSION_MS; }
  function heartbeat(token) {
    if (!has(token)) {
      prune();
      if (sessions.size >= maxSessions) throw new LobbyError('Solo presence is busy.', 503);
      token = randomBytes(24).toString('hex');
      onEvent('solo_session_started');
    }
    sessions.set(token, now());
    return { token };
  }
  function stats() {
    prune();
    return { connectedPlayers: [...sessions.values()].filter(lastSeen => now() - lastSeen < ACTIVE_MS).length };
  }
  return { heartbeat, has, stats };
}

export function createSoloRouter(solo, { trustedProxies = new Set() } = {}) {
  const limits = new Map();
  return async (req, res, url) => {
    if (url.pathname !== '/api/solo/presence') return false;
    const json = (status, value) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Vary': 'X-Solo-Token' }).end(JSON.stringify(value));
    try {
      if (req.method !== 'POST') throw new LobbyError('Method not allowed.', 405);
      if (req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new LobbyError('Use this site to update your presence.', 403);
      const body = await readJSON(req);
      if (Object.keys(body).length) throw new LobbyError('Presence does not accept player details.');
      const token = req.headers['x-solo-token'];
      if (!solo.has(token)) {
        const time = Date.now(), address = clientAddress(req, trustedProxies);
        if (limits.size >= 5000) for (const [key, limit] of limits) if (limit.until <= time) limits.delete(key);
        let limit = limits.get(address);
        if (!limit || limit.until <= time) {
          if (limits.size >= 5000) throw new LobbyError('Try again later.', 429);
          limit = { count: 0, until: time + 60000 }; limits.set(address, limit);
        }
        if (++limit.count > 30) throw new LobbyError('Try again later.', 429);
      }
      json(200, solo.heartbeat(token));
    } catch (error) { json(error instanceof LobbyError ? error.status : 503, { error: 'Presence could not be updated.' }); }
    return true;
  };
}
