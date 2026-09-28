import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep, dirname } from 'node:path';
import { createMusicService, GENRES } from './music.mjs';
import { isDifficulty } from '../dist/difficulties.js';
import { createLobbyService } from './lobbies.mjs';
import { createLobbyRouter, trustedProxyIPs } from './lobby-api.mjs';
import { createMonitoring } from './monitoring.mjs';
import { createSoloService, createSoloRouter } from './solo.mjs';
const root = resolve('dist');
const dataDir = resolve(process.env.NEEDLE_DROP_DATA_DIR || '.data/daily');
const monitoring = await createMonitoring({ dataDir: resolve(dirname(dataDir), 'monitoring'), logDir: process.env.NEEDLE_DROP_LOG_DIR });
const music = createMusicService({ dataDir });
const lobbies = createLobbyService({ music, onEvent: monitoring.event });
const solo = createSoloService({ onEvent: monitoring.event });
monitoring.setSnapshot(() => ({ ...lobbies.stats(), soloPlayers: solo.stats().connectedPlayers }));
const lobbyRoute = createLobbyRouter(lobbies, { trustedProxies: trustedProxyIPs(process.env.TRUSTED_PROXY_IPS), log: monitoring.log });
const soloRoute = createSoloRouter(solo, { trustedProxies: trustedProxyIPs(process.env.TRUSTED_PROXY_IPS) });
const lobbyTimer = setInterval(() => lobbies.tick(), 250);
lobbyTimer.unref();
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  monitoring.observeHttp(req, res);
  try {
    const url = new URL(req.url, 'http://localhost');
    if (await lobbyRoute(req, res, url)) return;
    if (await soloRoute(req, res, url)) return;
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"status":"ok"}'); return; }
    if (url.pathname.startsWith('/api/')) {
      const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
      if (req.method !== 'GET') { json(405, { error: 'Method not allowed.' }); return; }
      try {
        if (url.pathname === '/api/daily') { json(200, await music.dailySong()); return; }
        if (url.pathname === '/api/random') {
          const genre = url.searchParams.get('genre') || 'All';
          if (genre !== 'All' && !Object.hasOwn(GENRES, genre)) { json(400, { error: 'Choose a supported genre.' }); return; }
          const difficulty = url.searchParams.get('difficulty') || 'easy';
          if (!isDifficulty(difficulty)) { json(400, { error: 'Choose a supported difficulty.' }); return; }
          const exclude = (url.searchParams.get('exclude') || '').split(',').slice(-500).map(Number).filter(Number.isSafeInteger);
          json(200, { song: await music.randomSong(genre, exclude, difficulty), difficulty }); return;
        }
        if (url.pathname === '/api/search') { json(200, { songs: await music.search(url.searchParams.get('q') || '') }); return; }
        const match = url.pathname.match(/^\/api\/track\/(\d+)$/);
        if (match) { json(200, await music.preview(Number(match[1]))); return; }
        json(404, { error: 'Not found.' });
      } catch (error) { monitoring.log('error', 'music_request_failed'); json(503, { error: error.code === 'EMPTY_POOL' ? error.message : 'Music could not be loaded. Please retry in a moment.' }); }
      return;
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(path); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(Number(process.env.PORT || 4173), process.env.HOST || '127.0.0.1', () => monitoring.log('info', 'server_started'));
// Separate listener: never publish the metrics port through the public game proxy.
const metricsServer = process.env.METRICS_PORT ? createServer((req, res) => {
  if (req.method !== 'GET' || req.url !== '/metrics') { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain; version=0.0.4; charset=utf-8', 'Cache-Control': 'no-store' }).end(monitoring.render());
}).listen(Number(process.env.METRICS_PORT), process.env.METRICS_HOST || '127.0.0.1') : null;
for (const listener of [server, metricsServer].filter(Boolean)) listener.on('error', async () => {
  monitoring.log('error', 'listener_failed'); await monitoring.close(); process.exit(1);
});
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  if (stopping) return; stopping = true;
  monitoring.log('info', 'server_stopping'); clearInterval(lobbyTimer);
  metricsServer?.close();
  server.close(async () => { await monitoring.close(); process.exit(0); });
  setTimeout(async () => { await monitoring.close(); process.exit(1); }, 15000).unref();
});
