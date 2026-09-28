import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import vm from 'node:vm';
import { createLobbyService } from './lobbies.mjs';
import { createLobbyRouter, clientAddress, trustedProxyIPs } from './lobby-api.mjs';
import { DIFFICULTIES } from '../dist/difficulties.js';
import * as multiplayerRules from '../dist/multiplayer-rules.js';

const source = (await readFile(new URL('../dist/multiplayer.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const flush = () => new Promise(resolve => setImmediate(resolve));
const track = { id: 1, title: 'One', artist: 'Artist', cover: '', link: 'https://www.deezer.com/track/1' };
function harness() {
  let time = Date.now();
  const music = { randomSong: async () => track, preview: async () => ({ preview: 'https://example.com/p.mp3' }), search: async () => [track] };
  const service = createLobbyService({ music, now: () => time }), router = createLobbyRouter(service, { waitMs: 0 });
  async function fetchAPI(path, options = {}) {
    const req = Readable.from(options.body ? [options.body] : []);
    req.method = options.method || 'GET'; req.headers = Object.fromEntries(Object.entries(options.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    req.headers.host = 'localhost:4173'; req.socket = { remoteAddress: '127.0.0.1' };
    let status, body;
    const res = { writeHead(code) { status = code; return this; }, end(value) { body = JSON.parse(value); } };
    await router(req, res, new URL(path, 'http://localhost:4173'));
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }
  async function client(name, stored = new Map()) {
    const elements = new Map(), timers = new Map(), requests = []; let timerId = 0;
    function element() {
      return { value: '', hidden: false, disabled: false, checked: false, textContent: '', style: {}, attrs: {}, children: [],
        classList: { toggle() {} }, addEventListener() {}, focus() {}, scrollIntoView() {},
        append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
        setAttribute(key, value) { this.attrs[key] = value; }, getAttribute(key) { return this.attrs[key]; }, removeAttribute(key) { delete this.attrs[key]; } };
    }
    const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
    const context = vm.createContext({ DIFFICULTIES, ...multiplayerRules, AbortSignal, AbortController, URLSearchParams, console,
      Date: class extends Date { static now() { return time; } },
      Audio: class { paused = true; currentTime = 0; pause() { this.paused = true; } async play() { this.paused = false; } load() {} removeAttribute() {} addEventListener() {} },
      document: { getElementById: get, createElement: element, addEventListener() {} },
      sessionStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) },
      localStorage: { getItem: () => name, setItem() {} },
      location: { origin: 'http://localhost:4173', pathname: '/multiplayer.html', search: '' }, history: { replaceState() {} },
      navigator: { clipboard: { writeText: async () => {} } },
      setInterval() {}, setTimeout(fn, delay) { timers.set(++timerId, { fn, delay }); return timerId; }, clearTimeout(id) { timers.delete(id); },
      fetch: (...args) => { requests.push(args[0]); return fetchAPI(...args); },
    });
    const run = code => vm.runInContext(code, context);
    run(source); await flush();
    return { get, run, stored, requests, async poll() { await run('poll()'); await flush(); },
      async scheduledPoll() {
        const entry = [...timers].find(([, timer]) => [0, 1000].includes(timer.delay));
        assert.ok(entry, 'a follow-up poll is scheduled');
        timers.delete(entry[0]); await entry[1].fn(); await flush();
      },
      async search() { get('party-search').value = 'One'; get('party-search').oninput(); const [id, task] = [...timers].find(([, t]) => t.delay === 350); timers.delete(id); await task.fn(); },
    };
  }
  return { client, fetchAPI, service, step(ms) { time += ms; service.tick(); } };
}

test('two page controllers create, join, ready, play, guess, show standings and rematch together', async () => {
  const h = harness(), host = await h.client('Host'), guest = await h.client('Guest');
  await host.run('enter(false)'); await flush();
  const code = host.run('state.code');
  guest.get('join-code').value = code;
  await guest.run('enter(true)'); await flush(); await host.poll();
  assert.equal(host.get('entry').hidden, true); assert.equal(host.get('lobby').hidden, false);
  assert.equal(host.get('players').children.length, 2); assert.equal(guest.get('host-settings').disabled, true);
  await host.run('action("settings", { settings: { tracks: 1, endEarly: false } })');
  await guest.poll(); await guest.run('action("ready", { ready: true })'); await host.poll();
  assert.equal(host.get('start-game').disabled, false);
  await host.run('action("start")'); await flush(); await host.poll(); await guest.poll();
  assert.equal(host.run('state.phase'), 'countdown'); assert.equal(guest.run('state.round.id'), host.run('state.round.id'));
  assert.equal(host.get('party-play').disabled, true); assert.equal(host.get('answer-reveal').hidden, true);
  h.step(5000); await host.poll(); await guest.poll();
  assert.equal(host.get('party-search').disabled, false); assert.equal(guest.get('round-timer').textContent, '1:00');
  h.step(10000); await host.search();
  assert.equal(host.get('party-suggestions').children.length, 1);
  host.get('party-suggestions').children[0].onclick();
  assert.equal(host.get('party-guess').disabled, false);
  host.get('party-guess-form').onsubmit({ preventDefault() {} }); await flush();
  assert.equal(host.run('state.round.points'), 850); assert.equal(host.get('party-guess-form').hidden, true);
  h.step(50000); await host.poll(); await guest.poll();
  assert.equal(guest.get('answer-title').textContent, 'One'); assert.equal(guest.get('party-search').disabled, true);
  assert.equal(guest.run('state.players.find(p => p.name === "Host").score'), 850);
  h.step(8000); await host.poll(); await guest.poll();
  assert.equal(host.get('round-note').textContent, 'Host wins with 850 points!');
  assert.equal(host.get('rematch').hidden, false); assert.equal(guest.get('rematch').hidden, true);
  await host.run('action("reset")'); await guest.poll();
  assert.equal(guest.get('waiting-room').hidden, false); assert.equal(host.run('state.players[0].score'), 0);
});

test('waiting room learns ready changes through its scheduled snapshots without refreshing the page', async () => {
  const h = harness(), host = await h.client('Host'), guest = await h.client('Guest');
  await host.run('enter(false)'); await flush();
  guest.get('join-code').value = host.run('state.code'); await guest.run('enter(true)'); await flush();
  await host.scheduledPoll();
  assert.equal(host.get('start-game').disabled, true);
  await guest.run('action("ready", { ready: true })');
  await host.scheduledPoll();
  assert.equal(host.get('start-game').disabled, false);
  assert.ok(!host.requests.at(-1).includes('after='));
  assert.match(host.get('start-note').textContent, /Everyone is ready/);
  await host.get('start-game').onclick(); await flush();
  await host.scheduledPoll();
  assert.equal(host.run('state.phase'), 'countdown');
});

test('foreground resync cancels a stalled request and schedules a fresh snapshot', async () => {
  const h = harness(), host = await h.client('Host');
  await host.run('enter(false)'); await flush();
  host.run(`const realFetch = fetch; fetch = (_url, options) => new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('Aborted'))));`);
  const stalled = host.run('poll()'); await flush();
  await host.run('poll(true)'); await stalled;
  host.run('fetch = realFetch');
  await host.scheduledPoll();
  assert.equal(host.run('connected'), true);
  assert.ok(!host.requests.at(-1).includes('after='));
});

test('multiplayer skip song hides guessing and shows the answer once everyone finishes', async () => {
  const h = harness(), host = await h.client('Host'), guest = await h.client('Guest');
  await host.run('enter(false)'); await flush();
  guest.get('join-code').value = host.run('state.code'); await guest.run('enter(true)'); await flush();
  await guest.run('action("ready", { ready: true })'); await host.run('action("start")'); await flush();
  h.step(5000); await host.poll(); await guest.poll();
  assert.equal(guest.get('party-skip-song').disabled, false);
  await guest.get('party-skip-song').onclick();
  assert.equal(guest.run('state.round.passed'), true);
  assert.equal(guest.get('party-guess-form').hidden, true); assert.equal(guest.get('party-skip-song').hidden, true);
  assert.equal(guest.get('answer-reveal').hidden, true);
  await host.get('party-skip-song').onclick(); await guest.poll();
  assert.equal(guest.run('state.phase'), 'reveal'); assert.equal(guest.get('answer-reveal').hidden, false);
  assert.equal(host.run('state.players.every(p => p.score === 0)'), true);
});

test('refresh restores a seat and older responses cannot roll the UI back', async () => {
  const h = harness(), original = await h.client('Host');
  await original.run('enter(false)'); await flush();
  const restored = await h.client('Host', original.stored);
  assert.equal(restored.run('state.selfId'), original.run('state.selfId'));
  const old = restored.run('JSON.stringify(state)');
  await restored.run('action("settings", { settings: { tracks: 9 } })');
  restored.run(`applyState(${old})`);
  assert.equal(restored.get('setting-tracks').value, 9);
  await restored.run('action("leave")');
  assert.equal(restored.get('entry').hidden, false); assert.equal(restored.stored.size, 0);
});

test('host settings edits survive polling until saved', async () => {
  const h = harness(), host = await h.client('Host'); await host.run('enter(false)'); await flush();
  host.get('setting-tracks').value = 12; host.get('settings-form').oninput(); await host.poll();
  assert.equal(host.get('setting-tracks').value, 12); assert.equal(host.get('settings-dirty').hidden, false);
  assert.equal(host.get('start-game').disabled, true);
});

test('Hear more unlocks and plays only my longer clip, survives refresh, and lowers my awarded score', async () => {
  const h = harness(), host = await h.client('Host'), guest = await h.client('Guest');
  await host.run('enter(false)'); await flush();
  guest.get('join-code').value = host.run('state.code'); await guest.run('enter(true)'); await flush();
  await host.run('action("settings", { settings: { endEarly: false } })');
  await guest.run('action("ready", { ready: true })');
  await host.run('action("start")'); await flush(); await host.poll(); await guest.poll();
  assert.equal(guest.get('hear-more').disabled, true);
  h.step(5000); await host.poll(); await guest.poll();
  assert.equal(guest.run('clipSeconds()'), 1);
  assert.equal(guest.get('hear-more').textContent, 'Hear more → 2s (−20% points)');
  await guest.get('hear-more').onclick(); await host.poll();
  assert.equal(guest.run('clipSeconds()'), 2); assert.equal(guest.run('audio.paused'), false);
  assert.equal(host.run('clipSeconds()'), 1); assert.equal(host.run('state.round.skips'), 0);
  assert.match(guest.get('potential-points').textContent, /800 points now · 1 paid skip/);
  const restored = await h.client('Guest', guest.stored);
  assert.equal(restored.run('clipSeconds()'), 2); assert.equal(restored.run('state.round.skips'), 1);
  await restored.get('hear-more').onclick();
  assert.equal(restored.run('clipSeconds()'), 4);
  assert.match(restored.get('potential-points').textContent, /640 points now · 2 paid skips/);
  await restored.search(); restored.get('party-suggestions').children[0].onclick();
  restored.get('party-guess-form').onsubmit({ preventDefault() {} }); await flush();
  assert.equal(restored.run('state.round.points'), 640);
  assert.equal(restored.get('hear-more').disabled, true);
  await host.poll(); assert.equal(host.run('state.players.find(p => p.name === "Guest").score'), 640);
});

test('HTTP lobby routes validate authentication, method, origin, JSON and body size', async () => {
  const h = harness();
  const post = (path, body, headers = {}) => h.fetchAPI(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const created = await (await post('/api/lobbies', { name: 'Host' })).json();
  const code = created.state.code;
  assert.equal((await h.fetchAPI(`/api/lobbies/${code}`)).status, 401);
  assert.equal((await h.fetchAPI('/api/lobbies')).status, 405);
  assert.equal((await post('/api/lobbies', { name: 'Other' }, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await post('/api/lobbies', { name: 'Other' }, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await post('/api/lobbies', { name: 'a'.repeat(5000) })).status, 413);
  assert.equal((await post('/api/lobbies', null)).status, 400);
  const guest = await (await post(`/api/lobbies/${code}/join`, { name: 'Guest' })).json();
  assert.equal((await post(`/api/lobbies/${code}/action`, { type: 'start' }, { 'X-Player-Token': guest.token })).status, 403);
  const state = await (await h.fetchAPI(`/api/lobbies/${code}`, { headers: { 'X-Player-Token': created.token } })).json();
  assert.equal(state.players.length, 2); assert.ok(!JSON.stringify(state).includes(guest.token));
  const heartbeat = await (await h.fetchAPI(`/api/lobbies/${code}?after=${state.version}`, { headers: { 'X-Player-Token': created.token } })).json();
  assert.equal(heartbeat.version, state.version); assert.ok(heartbeat.waitMs >= 0);
  assert.equal((await h.fetchAPI(`/api/lobbies/${code}?after=NaN`, { headers: { 'X-Player-Token': created.token } })).status, 400);
});

test('join rate limiting trusts only configured proxy addresses, never arbitrary forwarded headers', () => {
  const req = (remoteAddress, forwarded) => ({ socket: { remoteAddress }, headers: { 'x-forwarded-for': forwarded } });
  const trusted = trustedProxyIPs('127.0.0.1, ::1, 10.0.0.2');
  assert.equal(clientAddress(req('203.0.113.10', '198.51.100.99'), trusted), '203.0.113.10');
  assert.equal(clientAddress(req('127.0.0.1', '203.0.113.10, 10.0.0.2'), trusted), '203.0.113.10');
  assert.equal(clientAddress(req('::ffff:127.0.0.1', '198.51.100.99, 203.0.113.10'), trusted), '203.0.113.10');
  assert.equal(clientAddress(req('127.0.0.1', 'malformed'), trusted), '127.0.0.1');
  assert.equal(clientAddress(req('127.0.0.1', '203.0.113.10')), '127.0.0.1');
  assert.throws(() => trustedProxyIPs('*'), /IP addresses/);
});

test('idle heartbeats restore connection status without treating server wait time as clock drift', async () => {
  const h = harness(), host = await h.client('Host'); await host.run('enter(false)'); await flush();
  host.get('connection').textContent = 'Reconnecting…';
  host.run(`fetch = async () => {
    const started = Date.now(); Date.now = () => started + 15000;
    return { ok: true, json: async () => ({ ...state, serverNow: started + 15000, waitMs: 15000 }) };
  }`);
  await host.poll();
  assert.equal(host.run('offset'), 0);
  assert.equal(host.get('connection').textContent, '● Connected');
});
