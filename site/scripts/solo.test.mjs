import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createSoloService, createSoloRouter } from './solo.mjs';
import { createSoloPresence } from '../dist/presence.js';

test('solo heartbeat counts one anonymous session across refreshes, expires presence and bounds retention', () => {
  let time = 0; const events = [];
  const solo = createSoloService({ now: () => time, onEvent: event => events.push(event), maxSessions: 2 });
  const first = solo.heartbeat(); const second = solo.heartbeat();
  assert.match(first.token, /^[a-f0-9]{48}$/); assert.notEqual(first.token, second.token);
  assert.equal(solo.stats().connectedPlayers, 2);
  assert.throws(() => solo.heartbeat('forged'), { status: 503 });
  assert.equal(solo.heartbeat(first.token).token, first.token);
  assert.equal(events.length, 2);
  time += 45000; assert.equal(solo.stats().connectedPlayers, 0);
  solo.heartbeat(first.token); assert.equal(events.length, 2);
  assert.equal(solo.stats().connectedPlayers, 1);
  time += 30 * 60 * 1000;
  assert.equal(solo.has(first.token), false);
  assert.notEqual(solo.heartbeat(first.token).token, first.token);
  assert.equal(events.length, 3);
});

test('solo presence endpoint validates method, origin, size and schema, and limits session creation', async () => {
  const solo = createSoloService(), route = createSoloRouter(solo);
  async function request({ method = 'POST', body = '{}', token, origin, type = 'application/json' } = {}) {
    const req = Readable.from([body]);
    req.method = method; req.socket = { remoteAddress: '127.0.0.1' };
    req.headers = { host: 'localhost', 'content-type': type, ...(token ? { 'x-solo-token': token } : {}), ...(origin ? { origin } : {}) };
    let status, value;
    await route(req, { writeHead(code) { status = code; return this; }, end(body) { value = JSON.parse(body); } }, new URL('http://localhost/api/solo/presence'));
    return { status, value };
  }
  assert.equal((await request({ method: 'GET' })).status, 405);
  assert.equal((await request({ origin: 'https://evil.example' })).status, 403);
  assert.equal((await request({ type: 'text/plain' })).status, 415);
  assert.equal((await request({ body: 'invalid' })).status, 400);
  assert.equal((await request({ body: JSON.stringify({ name: 'Private name' }) })).status, 400);
  assert.equal((await request({ body: 'x'.repeat(5000) })).status, 413);
  const first = await request(); assert.equal(first.status, 200);
  for (let i = 1; i < 30; i++) assert.equal((await request()).status, 200);
  assert.equal((await request()).status, 429);
  assert.equal((await request({ token: first.value.token })).status, 200);
  assert.equal(solo.stats().connectedPlayers, 30);
});

test('solo browser tracking reuses its token, pauses when hidden and tolerates failed telemetry', async () => {
  let visibility, intervals = 0, requests = [], fail = false;
  const stored = new Map(), page = { hidden: false, addEventListener(_name, fn) { visibility = fn; } };
  const token = 'a'.repeat(48);
  const options = { page, storage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    every: () => ++intervals, cancel() {},
    fetcher: async (_url, init) => { requests.push(init); if (fail) throw new Error('Offline'); return { ok: true, json: async () => ({ token }) }; } };
  const client = createSoloPresence(options);
  client.start(); await new Promise(resolve => setImmediate(resolve)); client.start();
  assert.equal(intervals, 1); assert.equal(requests.length, 1);
  await client.heartbeat(); assert.equal(requests[1].headers['X-Solo-Token'], token);
  page.hidden = true; await visibility(); await client.heartbeat(); assert.equal(requests.length, 2);
  page.hidden = false; await visibility(); assert.equal(requests.length, 3);
  fail = true; await assert.doesNotReject(client.heartbeat());
  fail = false; client.stop();
  const restored = createSoloPresence(options); restored.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(requests.at(-1).headers['X-Solo-Token'], token);
  restored.stop();
});

test('unavailable browser storage does not prevent solo presence from working', async () => {
  let token;
  const client = createSoloPresence({ page: { hidden: false, addEventListener() {} }, every() {}, cancel() {},
    storage: { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Blocked'); } },
    fetcher: async (_url, init) => { token = init.headers['X-Solo-Token']; return { ok: true, json: async () => ({ token: 'b'.repeat(48) }) }; } });
  client.start(); await new Promise(resolve => setImmediate(resolve));
  await client.heartbeat(); assert.equal(token, 'b'.repeat(48)); client.stop();
});
