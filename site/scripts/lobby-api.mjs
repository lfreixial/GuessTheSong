import { LobbyError } from './lobbies.mjs';
import { isIP } from 'node:net';

const canonicalIP = address => address?.startsWith('::ffff:') && isIP(address.slice(7)) === 4 ? address.slice(7) : address;
export function trustedProxyIPs(value = '') {
  const addresses = value.split(',').map(address => address.trim()).filter(Boolean);
  if (addresses.some(address => !isIP(address))) throw new Error('TRUSTED_PROXY_IPS must contain comma-separated IP addresses.');
  return new Set(addresses.map(canonicalIP));
}
export function clientAddress(req, trustedProxies = new Set()) {
  let address = canonicalIP(req.socket.remoteAddress) || 'local';
  if (!trustedProxies.has(address)) return address;
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded !== 'string' || forwarded.length > 1024) return address;
  const hops = forwarded.split(',').map(hop => hop.trim());
  if (hops.length > 20 || hops.some(hop => !isIP(hop))) return address;
  for (const hop of hops.reverse()) {
    if (!trustedProxies.has(address)) break;
    address = canonicalIP(hop);
  }
  return address;
}

function readJSON(req) {
  if (!req.headers['content-type']?.startsWith('application/json')) throw new LobbyError('Send JSON for this request.', 415);
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', chunk => {
      size += Buffer.byteLength(chunk);
      if (size > 4096) { reject(new LobbyError('Request too large.', 413)); return; }
      chunks.push(Buffer.from(chunk));
    });
    req.on('end', () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
        resolve(value);
      } catch { reject(new LobbyError('Invalid JSON request.')); }
    });
    req.on('error', reject);
  });
}

export function createLobbyRouter(lobbies, { waitMs = 15000, trustedProxies = new Set(), log = () => {} } = {}) {
  const limits = new Map();
  return async function route(req, res, url) {
    if (!url.pathname.startsWith('/api/lobbies')) return false;
    const json = (status, data) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
    try {
      if (req.method === 'POST' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) throw new LobbyError('Use this site to change a lobby.', 403);
      const match = url.pathname.match(/^\/api\/lobbies(?:\/([A-Za-z0-9]{6})(?:\/(join|action|search))?)?$/);
      if (!match) throw new LobbyError('Lobby endpoint not found.', 404);
      const [, code, operation] = match;
      const token = req.headers['x-player-token'];
      if ((!code || operation === 'join') && req.method === 'POST') {
        const key = clientAddress(req, trustedProxies), time = Date.now();
        if (limits.size >= 5000) for (const [key, value] of limits) if (value.until < time) limits.delete(key);
        const limit = limits.get(key);
        if (limit && limit.until > time) {
          if (limit.count >= 30) throw new LobbyError('Too many join attempts. Try again in a minute.', 429);
          limit.count++;
        } else {
          if (limits.size >= 5000) throw new LobbyError('Please try again in a minute.', 429);
          limits.set(key, { count: 1, until: time + 60000 });
        }
        const body = await readJSON(req);
        json(201, code ? lobbies.join(code, body.name) : lobbies.create(body.name, body.settings));
      } else if (code && !operation && req.method === 'GET') {
        const after = url.searchParams.get('after');
        if (after === null) json(200, lobbies.state(code, token));
        else {
          if (!/^\d{1,15}$/.test(after)) throw new LobbyError('Invalid lobby version.');
          const abort = new AbortController(), onClose = () => abort.abort(), started = Date.now();
          res.once?.('close', onClose);
          try {
            const state = await lobbies.waitForState(code, token, Number(after), { timeoutMs: waitMs, signal: abort.signal });
            if (!res.destroyed) json(200, { ...state, waitMs: Date.now() - started });
          } finally { res.off?.('close', onClose); }
        }
      }
      else if (code && operation === 'search' && req.method === 'GET') json(200, await lobbies.search(code, token, (url.searchParams.get('q') || '').slice(0, 120)));
      else if (code && operation === 'action' && req.method === 'POST') json(200, lobbies.action(code, token, await readJSON(req)));
      else throw new LobbyError('Method not allowed.', 405);
    } catch (error) {
      if (res.destroyed) return true;
      if (!(error instanceof LobbyError)) log('error', 'lobby_request_failed');
      json(error instanceof LobbyError ? error.status : 503, { error: error instanceof LobbyError ? error.message : 'The lobby service is temporarily unavailable. Please retry.' });
    }
    return true;
  };
}
