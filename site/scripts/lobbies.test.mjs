import test from 'node:test';
import assert from 'node:assert/strict';
import { createLobbyService, pointsFor } from './lobbies.mjs';

const song = id => ({ id, title: `Song ${id}`, artist: 'Artist', genre: 'Rock', cover: '', link: `https://www.deezer.com/track/${id}` });
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture(overrides = {}) {
  let time = 1000000, selected = 0;
  const calls = [];
  const music = { randomSong: async (...args) => { calls.push(args); return song(++selected); },
    preview: async () => ({ preview: 'https://example.com/preview.mp3' }),
    search: async () => [song(1), song(2), song(3), song(99), { ...song(100), title: 'Song 1 (Remastered)' }], ...overrides };
  const service = createLobbyService({ music, now: () => time });
  const host = service.create('Host', { endEarly: false });
  const code = host.state.code, guest = service.join(code.toLowerCase(), 'Guest');
  const state = who => service.state(code, (who || host).token);
  const action = (who, type, extra = {}) => service.action(code, who.token, { type, ...extra });
  const step = ms => { time += ms; service.tick(); };
  const search = who => service.search(code, (who || host).token, 'Song');
  async function start(settings = {}) {
    action(host, 'settings', { settings }); action(guest, 'ready', { ready: true }); action(host, 'start');
    await flush(); step(5000); return state();
  }
  return { service, host, guest, code, state, action, step, start, search, calls };
}
test('codes, private credentials, case-insensitive joining and seat restoration', () => {
  const f = fixture();
  assert.match(f.code, /^[A-HJ-NP-Z2-9]{6}$/);
  assert.notEqual(f.host.token, f.guest.token);
  assert.equal(f.state(f.guest).selfId, f.guest.state.selfId);
  assert.equal(f.state().players.length, 2);
  assert.ok(!JSON.stringify(f.state()).includes(f.guest.token));
  assert.throws(() => f.service.state(f.code, 'wrong'), { status: 401 });
  assert.throws(() => f.service.join(f.code, 'HOST'), /name is taken/);
  assert.throws(() => f.service.join('ZZZZZZ', 'Friend'), { status: 404 });
});
test('only the host can change settings, start, remove players or reset', () => {
  const f = fixture();
  for (const type of ['settings', 'start', 'kick', 'reset', 'retry', 'next']) assert.throws(() => f.action(f.guest, type), { status: 403 });
  f.action(f.guest, 'ready', { ready: true });
  f.action(f.host, 'settings', { settings: { difficulty: 'impossible', tracks: 10, genre: 'Rock' } });
  assert.equal(f.state().players.find(p => p.id === f.guest.state.selfId).ready, false);
  assert.throws(() => f.action(f.host, 'start'), /Ready/);
  for (const settings of [{ tracks: 0 }, { tracks: 21 }, { tracks: 1.5 }, { difficulty: 'constructor' }, { genre: 'toString' }, { maxPlayers: 1 }, { maxGuesses: 999 }, { clipMode: 'invalid' }, { endEarly: 'yes' }, { unknown: true }]) {
    assert.throws(() => f.action(f.host, 'settings', { settings }), { status: 400 });
  }
});
test('player capacity, names, kick and waiting-only joins are enforced', async () => {
  const f = fixture();
  f.action(f.host, 'settings', { settings: { maxPlayers: 2 } });
  assert.throws(() => f.service.join(f.code, 'Third'), /full/);
  f.action(f.host, 'kick', { playerId: f.guest.state.selfId });
  assert.throws(() => f.state(f.guest), { status: 401 });
  assert.throws(() => f.action(f.host, 'start'), /two connected/);
  for (const name of ['', 'a'.repeat(25), 'Name\n\u0000']) assert.throws(() => f.service.join(f.code, name), { status: 400 });
  const other = f.service.join(f.code, 'Other'); f.action(other, 'ready', { ready: true }); f.action(f.host, 'start');
  assert.throws(() => f.service.join(f.code, 'Late'), /started/);
  await flush();
});
test('everyone shares a single selected song, countdown and exact 60-second deadline', async () => {
  const f = fixture();
  const s = await f.start({ tracks: 2, genre: 'Rock', difficulty: 'hard' });
  assert.equal(s.phase, 'playing');
  const guest = f.state(f.guest);
  assert.equal(guest.round.id, s.round.id); assert.equal(guest.round.preview, s.round.preview);
  assert.equal(guest.round.startsAt, s.round.startsAt); assert.equal(s.round.endsAt - s.round.startsAt, 60000);
  assert.equal(f.calls.length, 1); assert.deepEqual(f.calls[0], ['Rock', [], 'hard']);
  assert.equal(s.round.answer, undefined);
  assert.ok(!JSON.stringify(s).includes('Song 1'));
  f.step(60000);
  assert.equal(f.state().phase, 'reveal'); assert.equal(f.state().round.answer.title, 'Song 1');
});
test('server scores faster correct answers higher, accepts equivalent editions, and keeps guesses private', async () => {
  const f = fixture(); const s = await f.start();
  await f.search(); await f.search(f.guest);
  f.step(10000);
  const won = f.action(f.host, 'guess', { roundId: s.round.id, songId: 1 });
  assert.equal(won.round.points, 850); assert.equal(won.round.correct, true);
  assert.equal(f.state(f.guest).round.guesses.length, 0);
  assert.equal(f.state(f.guest).players.find(p => p.id === f.host.state.selfId).score, 850);
  assert.throws(() => f.action(f.host, 'guess', { roundId: s.round.id, songId: 1 }), /finished/);
  f.step(20000);
  assert.equal(f.action(f.guest, 'guess', { roundId: s.round.id, songId: 100 }).round.points, 550);
});
test('forged, premature, stale, duplicate, rapid and late guesses cannot earn points', async () => {
  const f = fixture();
  assert.throws(() => f.action(f.host, 'guess', { songId: 1 }), { status: 409 });
  const s = await f.start();
  assert.throws(() => f.action(f.host, 'guess', { roundId: s.round.id, songId: 1, points: 99999 }), /Search and select/);
  await f.search();
  assert.throws(() => f.action(f.host, 'guess', { roundId: 'old-round', songId: 1 }), { status: 409 });
  f.action(f.host, 'guess', { roundId: s.round.id, songId: 99 });
  assert.throws(() => f.action(f.host, 'guess', { roundId: s.round.id, songId: 1 }), { status: 429 });
  f.step(1000);
  assert.throws(() => f.action(f.host, 'guess', { roundId: s.round.id, songId: 99 }), /already guessed/);
  f.step(59000);
  assert.throws(() => f.action(f.host, 'guess', { roundId: s.round.id, songId: 1 }), { status: 409 });
  assert.equal(f.state().players.every(p => p.score === 0), true);
});
test('guess limits and optional early finish apply to all players', async () => {
  const f = fixture(); const s = await f.start({ maxGuesses: 3, endEarly: true });
  await f.search(); await f.search(f.guest);
  for (const id of [2, 3, 99]) { f.action(f.host, 'guess', { roundId: s.round.id, songId: id }); f.step(1000); }
  assert.throws(() => f.action(f.host, 'guess', { roundId: s.round.id, songId: 1 }), /finished/);
  assert.equal(f.state().phase, 'playing');
  const result = f.action(f.guest, 'guess', { roundId: s.round.id, songId: 1 });
  assert.equal(result.phase, 'reveal');
  assert.equal(result.round.answer.id, 1);
});
test('automatic progression selects once, excludes previous tracks, finishes and supports a rematch', async () => {
  const f = fixture(); await f.start({ tracks: 2 });
  f.step(60000); f.step(8000); await flush();
  assert.equal(f.state().phase, 'countdown'); assert.equal(f.state().round.number, 2);
  assert.equal(f.calls.length, 2); assert.ok(f.calls[1][1].includes(1));
  f.step(5000); f.step(60000); f.step(8000);
  assert.equal(f.state().phase, 'finished');
  f.action(f.host, 'reset');
  assert.equal(f.state().phase, 'waiting'); assert.equal(f.state().round, null);
  assert.equal(f.state().players.every(p => p.score === 0), true);
  assert.equal(f.state().settings.tracks, 2);
});
test('loading failures do not consume tracks or start timers and can be retried', async () => {
  let fails = true;
  const f = fixture({ preview: async () => { if (fails) throw new Error('Offline'); return { preview: 'https://example.com/p.mp3' }; } });
  await f.start(); assert.equal(f.state().phase, 'load-error'); assert.equal(f.state().round, null);
  fails = false; f.action(f.host, 'retry'); await flush();
  assert.equal(f.state().phase, 'countdown'); assert.equal(f.state().round.number, 1);
});
test('parallel starts cannot choose two songs and guesses cannot happen during countdown', async () => {
  const f = fixture();
  f.action(f.guest, 'ready', { ready: true }); f.action(f.host, 'start');
  assert.throws(() => f.action(f.host, 'start'), /already started/);
  await flush(); const s = f.state();
  assert.equal(s.phase, 'countdown'); assert.equal(f.calls.length, 1);
  assert.throws(() => f.action(f.host, 'guess', { songId: 1, roundId: s.round.id }), { status: 409 });
});
test('host transfers after a disconnect and a returning player keeps their identity', () => {
  const f = fixture();
  f.step(30000); f.state(f.guest); f.step(16000);
  assert.equal(f.state(f.guest).hostId, f.guest.state.selfId);
  assert.equal(f.state().hostId, f.guest.state.selfId);
  assert.equal(f.state().selfId, f.host.state.selfId);
  assert.throws(() => f.action(f.host, 'settings', { settings: {} }), { status: 403 });
  f.action(f.guest, 'leave'); assert.equal(f.state().hostId, f.host.state.selfId);
});
test('empty and inactive lobbies expire and do not expose old seats', () => {
  const f = fixture(); f.action(f.guest, 'leave'); f.action(f.host, 'leave');
  assert.throws(() => f.state(), { status: 404 });
  const other = fixture(); other.step(2 * 60 * 60 * 1000);
  assert.throws(() => other.state(), { status: 404 });
});
test('versions remain stable for unchanged snapshots and increase on changes', () => {
  const f = fixture(); const before = f.state().version;
  assert.equal(before, f.state(f.guest).version);
  f.action(f.guest, 'ready', { ready: true });
  assert.ok(before < f.state().version);
});
test('scoring boundaries are deterministic', () => {
  assert.equal(pointsFor(0), 1000); assert.equal(pointsFor(30000), 550); assert.equal(pointsFor(59999), 101);
});

test('personal skips do not consume guesses or alter shared clocks, and score penalties stack', async () => {
  const f = fixture(); const s = await f.start();
  for (const step of [1, 2]) f.action(f.guest, 'hear-more', { roundId: s.round.id, step });
  const skipped = f.state(f.guest).round;
  assert.equal(skipped.skips, 2); assert.equal(skipped.unlockedStep, 2); assert.equal(skipped.guesses.length, 0);
  assert.equal(skipped.endsAt, s.round.endsAt); assert.equal(skipped.startsAt, s.round.startsAt);
  assert.equal(f.state().round.skips, 0); assert.equal(f.state().round.unlockedStep, 0);
  await f.search(); await f.search(f.guest); f.step(10000);
  assert.equal(f.action(f.guest, 'guess', { roundId: s.round.id, songId: 1, skips: 0 }).round.points, 544);
  assert.equal(f.action(f.host, 'guess', { roundId: s.round.id, songId: 1 }).round.points, 850);
});

test('skip retries and automatic unlock races do not apply another penalty', async () => {
  const f = fixture(); const s = await f.start();
  f.action(f.guest, 'hear-more', { roundId: s.round.id, step: 1 });
  f.action(f.guest, 'hear-more', { roundId: s.round.id, step: 1 });
  assert.equal(f.state(f.guest).round.skips, 1);
  f.step(10000);
  f.action(f.host, 'hear-more', { roundId: s.round.id, step: 1 });
  assert.equal(f.state().round.skips, 0, 'automatic progression is free');
  f.action(f.host, 'hear-more', { roundId: s.round.id, step: 2 });
  assert.equal(f.state().round.skips, 1);
});

test('clip unlocks validate round, mode, step and player eligibility, then reset each track', async () => {
  const f = fixture();
  assert.throws(() => f.action(f.guest, 'hear-more', { step: 1 }), { status: 409 });
  const s = await f.start();
  assert.throws(() => f.action(f.guest, 'hear-more', { roundId: 'stale', step: 1 }), { status: 409 });
  assert.throws(() => f.action(f.guest, 'hear-more', { roundId: s.round.id, step: 5 }), { status: 409 });
  for (const step of [0, -1, 1.5, 6, '1']) assert.throws(() => f.action(f.guest, 'hear-more', { roundId: s.round.id, step }), { status: 400 });
  for (let step = 1; step <= 5; step++) f.action(f.guest, 'hear-more', { roundId: s.round.id, step });
  assert.equal(f.state(f.guest).round.unlockedStep, 5); assert.equal(f.state(f.guest).round.skips, 5);
  await f.search(f.guest);
  assert.equal(f.action(f.guest, 'guess', { roundId: s.round.id, songId: 1 }).round.points, 327);
  assert.throws(() => f.action(f.guest, 'hear-more', { roundId: s.round.id, step: 5 }), { status: 409 });
  f.step(60000);
  assert.throws(() => f.action(f.host, 'hear-more', { roundId: s.round.id, step: 1 }), { status: 409 });
  f.step(8000); await flush();
  assert.equal(f.state(f.guest).round.skips, 0); assert.equal(f.state(f.guest).round.unlockedStep, 0);
  const full = fixture(); const round = await full.start({ clipMode: 'full' });
  assert.throws(() => full.action(full.guest, 'hear-more', { roundId: round.round.id, step: 1 }), /already unlocked/);
});

test('waiting updates wake on changes and remain player-specific', async () => {
  const f = fixture(); const current = f.state(f.guest);
  const pending = f.service.waitForState(f.code, f.guest.token, current.version, { timeoutMs: 1000 });
  f.action(f.host, 'ready', { ready: false });
  const next = await pending;
  assert.ok(next.version > current.version); assert.equal(next.selfId, f.guest.state.selfId);
  assert.equal(next.players.find(p => p.id === f.host.state.selfId).ready, false);
  const immediate = await f.service.waitForState(f.code, f.guest.token, current.version, { timeoutMs: 1000 });
  assert.equal(immediate.version, next.version);
});

test('idle waiting updates return a heartbeat without changing the version', async () => {
  const f = fixture(); const current = f.state();
  const heartbeat = await f.service.waitForState(f.code, f.host.token, current.version, { timeoutMs: 10 });
  assert.equal(heartbeat.version, current.version); assert.equal(heartbeat.selfId, current.selfId);
});

test('cancelled updates release their slots and each seat has a bounded number of pending requests', async () => {
  const f = fixture(), controllers = [new AbortController(), new AbortController()];
  const version = f.state().version;
  const pending = controllers.map(controller => f.service.waitForState(f.code, f.host.token, version, { timeoutMs: 1000, signal: controller.signal }));
  const outcomes = Promise.allSettled(pending);
  await assert.rejects(f.service.waitForState(f.code, f.host.token, version), { status: 429 });
  controllers.forEach(controller => controller.abort());
  assert.ok((await outcomes).every(result => result.status === 'rejected' && result.reason.status === 499));
  assert.equal((await f.service.waitForState(f.code, f.host.token, version, { timeoutMs: 1 })).version, version);
});

test('removal and expiry terminate pending updates with the correct error', async () => {
  const f = fixture();
  const kicked = assert.rejects(f.service.waitForState(f.code, f.guest.token, f.state().version), { status: 401 });
  f.action(f.host, 'kick', { playerId: f.guest.state.selfId }); await kicked;
  const expired = assert.rejects(f.service.waitForState(f.code, f.host.token, f.state().version), { status: 404 });
  f.step(2 * 60 * 60 * 1000); await expired;
});

test('round phase, personal skips, and disconnects wake waiting players', async () => {
  const f = fixture(); const initial = await f.start();
  const skipped = f.service.waitForState(f.code, f.guest.token, initial.version);
  f.action(f.guest, 'hear-more', { roundId: initial.round.id, step: 1 });
  assert.equal((await skipped).round.skips, 1);
  const disconnect = f.service.waitForState(f.code, f.host.token, f.state().version);
  f.step(20001);
  assert.equal((await disconnect).players.find(p => p.id === f.guest.state.selfId).connected, false);
  const reveal = f.service.waitForState(f.code, f.host.token, f.state().version);
  f.step(40000); assert.equal((await reveal).phase, 'reveal');
});
