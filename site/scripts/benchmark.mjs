// Local HTTP benchmark with synthetic music. Never calls Deezer or a live deployment.
import { createServer } from 'node:http';
import { performance } from 'node:perf_hooks';
import { createLobbyService } from './lobbies.mjs';
import { createLobbyRouter } from './lobby-api.mjs';
import { createMusicService } from './music.mjs';

const mode = process.argv[2] || 'wait', playerCount = Number(process.argv[3] || 320), duration = Number(process.argv[4] || 16) * 1000;
if (!['poll', 'wait'].includes(mode) || !Number.isInteger(playerCount) || playerCount < 2 || playerCount > 3200 || duration < 1000 || duration > 120000) throw new Error('Usage: node scripts/benchmark.mjs [poll|wait] [2–3200 players] [1–120 seconds]');
const song = { id: 1, title: 'Benchmark song', artist: 'Test artist', genre: 'Rock', cover: '', link: '' };
const music = { randomSong: async () => song, preview: async () => ({ preview: 'https://example.invalid/preview' }), search: async () => [song] };
const lobbies = createLobbyService({ music }), route = createLobbyRouter(lobbies);
const seats = [];
for (let remaining = playerCount; remaining > 0;) {
  const count = Math.min(16, remaining), host = lobbies.create('Player 0', { maxPlayers: 16, endEarly: false });
  const code = host.state.code; seats.push({ code, token: host.token });
  for (let i = 1; i < count; i++) {
    const guest = lobbies.join(code, `Player ${i}`); seats.push({ code, token: guest.token });
    lobbies.action(code, guest.token, { type: 'ready', ready: true });
  }
  if (count >= 2) lobbies.action(code, host.token, { type: 'start' });
  remaining -= count;
}
await new Promise(resolve => setImmediate(resolve));
const server = createServer(async (req, res) => { if (!await route(req, res, new URL(req.url, 'http://localhost'))) res.writeHead(404).end(); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${server.address().port}/api/lobbies`;
const ticker = setInterval(lobbies.tick, 250), stop = new AbortController();
const deadline = setTimeout(() => stop.abort(), duration);
let requests = 0, responses = 0, bytes = 0, errors = 0, peakRss = process.memoryUsage().rss;
const latencies = [], cpuStart = process.cpuUsage(), started = performance.now();
const memoryTimer = setInterval(() => { peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 250);
async function call(seat, suffix, body) {
  const began = performance.now(); requests++;
  const res = await fetch(`${base}/${seat.code}${suffix}`, { method: body ? 'POST' : 'GET', signal: stop.signal,
    headers: { 'X-Player-Token': seat.token, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await res.text(), data = JSON.parse(text); responses++; bytes += Buffer.byteLength(text);
  if (!res.ok) throw new Error(data.error);
  latencies.push(Math.max(0, performance.now() - began - (data.waitMs || 0)));
  return data;
}
try {
  await Promise.all(seats.map(async (seat, index) => {
    let version, guessed = false;
    while (!stop.signal.aborted) {
      try {
        const state = await call(seat, mode === 'wait' && version !== undefined ? `?after=${version}` : ''); version = state.version;
        if (!guessed && index % 2 === 0 && state.phase === 'playing') {
          guessed = true; await call(seat, '/search?q=Benchmark');
          const result = await call(seat, '/action', { type: 'guess', roundId: state.round.id, songId: 1 }); version = result.version;
        }
        if (mode === 'poll') await new Promise(resolve => setTimeout(resolve, 1000));
      } catch { if (!stop.signal.aborted) { errors++; await new Promise(resolve => setTimeout(resolve, 1000)); } }
    }
  }));
} finally {
  clearTimeout(deadline); clearInterval(ticker); clearInterval(memoryTimer);
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
}
const cpu = process.cpuUsage(cpuStart);
latencies.sort((a, b) => a - b);
let providerCalls = 0;
const provider = createMusicService({ dataDir: '', fetcher: async () => {
  providerCalls++; await new Promise(resolve => setTimeout(resolve, 10));
  return { ok: true, json: async () => ({ data: [] }) };
} });
await Promise.all(Array.from({ length: 100 }, () => provider.search('same search')));
console.log(JSON.stringify({ mode, players: playerCount, seconds: Math.round((performance.now() - started) / 1000),
  requests, responses, responseMiB: +(bytes / 1048576).toFixed(2), errors,
  cpuSeconds: +((cpu.user + cpu.system) / 1000000).toFixed(2), peakRssMiB: Math.round(peakRss / 1048576),
  p95ResponseMsExcludingWait: Math.round(latencies[Math.floor(latencies.length * .95)] || 0),
  upstreamCallsFor100IdenticalSearches: providerCalls,
  note: 'Synthetic music; client and server share this process. Not a production capacity guarantee.' }, null, 2));
