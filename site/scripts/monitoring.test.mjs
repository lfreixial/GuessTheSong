import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { createMonitoring, requestRoute } from './monitoring.mjs';
import { createLobbyService } from './lobbies.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'needle-monitoring-'));
  const m = await createMonitoring({ stdout: null, dataDir: join(dir, 'totals'), logDir: join(dir, 'logs'), ...options });
  t.after(async () => { await m.close(); await rm(dir, { recursive: true, force: true }); });
  return { m, dir };
}

test('counts successful joins once, tracks presence, running games and expires lobbies without identifying players', async t => {
  const { m } = await fixture(t);
  let now = 0;
  const service = createLobbyService({ music: { randomSong: async () => ({ id: 1 }), preview: async () => ({ preview: 'https://example.com/a' }) }, now: () => now, onEvent: m.event });
  m.setSnapshot(service.stats);
  const host = service.create('Secret host'), code = host.state.code, guest = service.join(code, 'Secret guest');
  assert.throws(() => service.join(code, 'Secret host'));
  for (let i = 0; i < 3; i++) service.state(code, host.token);
  assert.match(m.render(), /needle_events_total\{event="player_joined"\} 2\n/);
  assert.equal(service.stats().connectedPlayers, 2);
  now = 20000;
  assert.equal(service.stats().connectedPlayers, 0);
  service.state(code, host.token);
  service.action(code, guest.token, { type: 'ready', ready: true });
  service.action(code, host.token, { type: 'start' });
  assert.equal(service.stats().running, 1);
  await new Promise(resolve => setImmediate(resolve));
  now += 2 * 60 * 60 * 1000;
  assert.equal(service.stats().lobbies, 0);
  assert.equal(service.stats().seats, 0);
  assert.match(m.render(), /needle_events_total\{event="lobby_created"\} 1\n/);
  for (const secret of [code, host.token, guest.token, 'Secret host']) assert.ok(!m.render().includes(secret));
});

test('aggregate counters survive a clean restart and rejected events do not create label series', async t => {
  const { m, dir } = await fixture(t);
  m.event('lobby_created'); m.event('player_joined'); m.event('unknown_secret');
  await m.close();
  const restored = await createMonitoring({ dataDir: join(dir, 'totals'), stdout: null });
  t.after(() => restored.close());
  assert.match(restored.render(), /needle_events_total\{event="lobby_created"\} 1\n/);
  restored.event('player_joined');
  assert.match(restored.render(), /needle_events_total\{event="player_joined"\} 2\n/);
  assert.ok(!restored.render().includes('unknown_secret'));
  await restored.close();
});

test('body instrumentation preserves streaming and counts UTF-8 once across finish and close', async t => {
  const { m, dir } = await fixture(t);
  const req = new EventEmitter(); Object.assign(req, { url: '/api/lobbies/ABCDEF/action?q=secret', method: 'POST', headers: { 'x-player-token': 'private-token' } });
  const res = new EventEmitter();
  Object.assign(res, { statusCode: 201, writableFinished: false, write: () => true, end: () => res });
  let consumed = '';
  m.observeHttp(req, res);
  req.on('data', chunk => { consumed += chunk; });
  req.emit('data', Buffer.from('é')); req.emit('end');
  assert.equal(consumed, 'é');
  assert.equal(res.write('€'), true); assert.equal(res.end('é'), res);
  res.writableFinished = true; res.emit('finish'); res.emit('close');
  const metrics = m.render();
  assert.match(metrics, /needle_http_response_body_bytes_total\{[^\n]+\} 5\n/);
  assert.match(metrics, /needle_http_request_body_bytes_total\{[^\n]+\} 2\n/);
  assert.match(metrics, /needle_http_requests_total\{[^\n]+\} 1\n/);
  assert.match(metrics, /needle_http_in_flight 0\n/);
  assert.match(metrics, /needle_http_duration_seconds_bucket\{[^\n]+le="\+Inf"\} 1\n/);
  await m.flush();
  const files = await readdir(join(dir, 'logs'));
  const logs = (await Promise.all(files.map(file => readFile(join(dir, 'logs', file), 'utf8')))).join('');
  for (const secret of ['ABCDEF', 'secret', 'private-token']) assert.ok(!(metrics + logs).includes(secret));
  assert.equal(JSON.parse(logs).event, 'http_request');
});

test('aborted requests decrement in-flight and get a separate status', async t => {
  const { m } = await fixture(t);
  const req = Object.assign(new EventEmitter(), { url: '/api/lobbies/ABCDEF?after=12', method: 'GET' });
  const res = Object.assign(new EventEmitter(), { statusCode: 200, write() {}, end() {} });
  m.observeHttp(req, res); res.emit('close'); res.emit('finish');
  assert.match(m.render(), /route="\/api\/lobbies\/:code\/wait",method="GET",status="499"\} 1\n/);
  assert.match(m.render(), /needle_http_in_flight 0\n/);
});

test('rotated logs stay bounded, valid JSON and contain only allowed fields', async t => {
  const { m, dir } = await fixture(t, { maxLogBytes: 1, maxLogFiles: 2 });
  for (let i = 0; i < 6; i++) { m.log('info', 'test', { token: 'secret', name: 'private' }); await m.flush(); }
  const files = await readdir(join(dir, 'logs'));
  assert.equal(files.length, 2);
  for (const file of files) {
    const line = await readFile(join(dir, 'logs', file), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(line)).sort(), ['event', 'level', 'time']);
  }
});

test('arbitrary URLs cannot grow route labels or expose queries', () => {
  for (let i = 0; i < 1000; i++) assert.equal(requestRoute(`/unknown/${i}?token=private`), 'other');
  assert.equal(requestRoute('/api/track/123?q=secret'), '/api/track/:id');
  assert.equal(requestRoute('/api/lobbies/ABCDEF/search?q=secret'), '/api/lobbies/:code/search');
  assert.equal(requestRoute('/api/search?q=secret'), '/api/search');
  assert.equal(requestRoute('/random-file.js'), 'static');
});
