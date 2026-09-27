import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createMusicService } from './music.mjs';
import { sameSong } from '../dist/game.js';
import { DIFFICULTIES, isDifficulty, matchesDifficulty } from '../dist/difficulties.js';
const raw = id => ({ id, title: `Song ${id}`, title_short: `Song ${id}`, rank: 600000, artist: { id: 10, name: 'Artist' }, preview: 'https://example.com/preview.mp3', readable: true, album: { cover_medium: '' } });
const fake = async url => ({ ok: true, json: async () => url.includes('/radio/genres') ? { data: [{ id: 152, radios: [{ id: 1, title: 'Rock' }] }] } : url.includes('/radio/1/') ? { data: [raw(101), raw(102), { ...raw(103), preview: '' }] } : url.includes('/search?') ? { data: [raw(900), raw(900)] } : raw(101) });
async function cleanTemp(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('needle-drop-test-'));
  await rm(directory, { recursive: true, force: true });
}
test('live stations filter genre, unavailable previews, and already played songs', async () => {
  const service = createMusicService({ dataDir: '', fetcher: fake, random: () => 0 });
  const stationOnly = url => { assert.ok(!url.includes('/artist/')); return fake(url); };
  const serviceWithoutArtists = createMusicService({ dataDir: '', fetcher: async url => {
    const response = await stationOnly(url); const data = await response.json();
    if (url.includes('/radio/1/')) data.data.forEach(t => delete t.artist.id);
    return { ok: true, json: async () => data };
  }, random: () => 0 });
  assert.equal((await service.randomSong('Rock', [101], 'medium')).id, 102);
  await assert.rejects(serviceWithoutArtists.randomSong('Rock', [101, 102], 'medium'), /unplayed/);
  await assert.rejects(service.randomSong('Invalid'), /supported/);
});
test('easy uses only the first 100 chart entries, with genre charts and preview/exclusion filtering', async () => {
  const calls = [];
  const service = createMusicService({ dataDir: '', random: () => 0, fetcher: async url => {
    calls.push(new URL(url).pathname);
    return { ok: true, json: async () => ({ data: [raw(1), { ...raw(2), preview: '' }, { ...raw(3), readable: false },
      ...Array.from({ length: 97 }, (_, i) => raw(i + 4)), raw(101)] }) };
  } });
  assert.equal((await service.randomSong('All', [1], 'easy')).id, 4);
  assert.equal((await service.randomSong('Rock', [], 'easy')).genre, 'Rock');
  assert.equal((await service.randomSong('Electronic', [], 'easy')).genre, 'Electronic');
  assert.deepEqual(calls, ['/chart/0/tracks', '/chart/152/tracks', '/chart/106/tracks']);
  await assert.rejects(service.randomSong('All', Array.from({ length: 100 }, (_, i) => i + 1), 'easy'), { code: 'EMPTY_POOL' });
  assert.equal(calls.length, 3, 'exhaustion must not silently widen the chart pool');
});
test('popularity bands have no overlaps, gaps, or unranked tracks', () => {
  const examples = [[0, 'impossible'], [99999, 'impossible'], [100000, 'expert'], [199999, 'expert'],
    [200000, 'hard'], [499999, 'hard'], [500000, 'medium'], [1000000, 'medium']];
  for (const [rank, expected] of examples) {
    assert.deepEqual(Object.keys(DIFFICULTIES).filter(level => matchesDifficulty({ rank }, level)), [expected]);
  }
  for (const rank of [undefined, null, NaN, '1000', -1, Infinity]) {
    assert.ok(Object.keys(DIFFICULTIES).every(level => !matchesDifficulty({ rank }, level)));
  }
  assert.equal(isDifficulty('toString'), false);
});
test('every non-chart level filters real popularity scores and does not mix cached levels', async () => {
  const tracks = [raw(1), { ...raw(2), rank: 300000 }, { ...raw(3), rank: 150000 }, { ...raw(4), rank: 20000 },
    { ...raw(5), rank: undefined }, { ...raw(6), rank: 20000, preview: '' }];
  const service = createMusicService({ dataDir: '', random: () => 0, fetcher: async url => url.includes('/radio/1/')
    ? { ok: true, json: async () => ({ data: tracks }) } : fake(url) });
  for (const [index, difficulty] of ['medium', 'hard', 'expert', 'impossible'].entries()) {
    assert.equal((await service.randomSong('Rock', [], difficulty)).id, index + 1);
  }
});
test('deep levels explore station artists and paginate, enforcing preview, popularity and exclusion rules', async () => {
  const calls = [];
  const service = createMusicService({ dataDir: '', random: () => 0, fetcher: async url => {
    calls.push(url);
    if (!url.includes('/artist/')) return fake(url);
    assert.ok(url.includes('/artist/10/top?'));
    const tracks = new URL(url).searchParams.get('index') === '200'
      ? [{ ...raw(200), rank: 10000 }, { ...raw(201), rank: 5000 }]
      : [{ ...raw(202), rank: 800000 }, { ...raw(203), rank: 1000, readable: false }];
    return { ok: true, json: async () => ({ data: tracks }) };
  } });
  assert.equal((await service.randomSong('Rock', [200], 'impossible')).id, 201);
  assert.equal(calls.filter(url => url.includes('/artist/')).length, 2);
  assert.ok(calls.some(url => url.endsWith('index=100')));
  assert.ok(calls.some(url => url.endsWith('index=200')));
  await assert.rejects(service.randomSong('Rock', [200, 201], 'impossible'), { code: 'EMPTY_POOL' });
});
test('invalid difficulty or prototype genre is rejected before calling the provider', async () => {
  const service = createMusicService({ dataDir: '', fetcher: () => { throw new Error('Unexpected provider call'); } });
  for (const level of ['invalid', 'constructor', 'toString']) await assert.rejects(service.randomSong('Rock', [], level), /supported difficulty/);
  await assert.rejects(service.randomSong('constructor'), /supported genre/);
});
test('concurrent daily requests share one result, persist across restart, and rotate at UTC midnight', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'needle-drop-test-'));
  try {
    let date = new Date('2026-09-26T23:59:59Z');
    const first = createMusicService({ dataDir: directory, fetcher: fake, random: () => 0, now: () => date });
    const values = await Promise.all(Array.from({ length: 8 }, () => first.dailySong()));
    for (const value of values) assert.deepEqual(value, values[0]);
    const restarted = createMusicService({ dataDir: directory, fetcher: () => { throw new Error('Network must not be used'); }, now: () => date });
    assert.deepEqual(await restarted.dailySong(), values[0]);
    date = new Date('2026-09-27T00:00:00Z');
    const tomorrow = await first.dailySong();
    assert.equal(tomorrow.date, '2026-09-27'); assert.notEqual(tomorrow.song.id, values[0].song.id);
  } finally { await cleanTemp(directory); }
});
test('failed daily selection can be retried, without permanently caching the failure', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'needle-drop-test-'));
  try {
    let fails = true;
    const service = createMusicService({ dataDir: directory, fetcher: async url => { if (fails) throw new Error('Offline'); return fake(url); }, random: () => 0 });
    await assert.rejects(service.dailySong(), /Offline/); fails = false;
    assert.equal((await service.dailySong()).song.id, 101);
  } finally { await cleanTemp(directory); }
});
test('search uses the wider provider catalogue and deduplicates album copies', async () => {
  const service = createMusicService({ dataDir: '', fetcher: fake });
  assert.deepEqual(await service.search('x'), []);
  assert.deepEqual((await service.search('Anything')).map(s => s.id), [900]);
});
test('same song on another album is accepted, but a different artist is not', () => {
  const original = { id: 1, title: 'Song', artist: 'Artist' };
  assert.equal(sameSong(original, { id: 2, title: 'Song (Remastered)', artist: 'Artist' }), true);
  assert.equal(sameSong(original, { id: 3, title: 'Song', artist: 'Someone else' }), false);
});

test('concurrent equivalent searches share one provider lookup and reuse cached results', async () => {
  let calls = 0;
  const service = createMusicService({ dataDir: '', fetcher: async url => {
    calls++; await new Promise(resolve => setImmediate(resolve)); return fake(url);
  } });
  const results = await Promise.all(Array.from({ length: 100 }, (_, index) => service.search(index % 2 ? '  Some   SONG ' : 'some song')));
  assert.equal(calls, 1); assert.equal(results.length, 100);
  await service.search('SOME SONG'); assert.equal(calls, 1);
});

test('shared failed provider lookups are evicted and can be retried', async () => {
  let calls = 0;
  const service = createMusicService({ dataDir: '', fetcher: async url => {
    calls++; await new Promise(resolve => setImmediate(resolve));
    if (calls === 1) throw new Error('Offline'); return fake(url);
  } });
  const failed = await Promise.allSettled(Array.from({ length: 20 }, () => service.search('anything')));
  assert.equal(calls, 1); assert.ok(failed.every(result => result.status === 'rejected'));
  assert.equal((await service.search('anything'))[0].id, 900); assert.equal(calls, 2);
});

test('provider concurrency and backlog are bounded, and capacity recovers after a burst', async () => {
  const release = []; let active = 0, peak = 0, calls = 0, completed = 0;
  const service = createMusicService({ dataDir: '', fetcher: async () => {
    calls++; active++; peak = Math.max(peak, active);
    await new Promise(resolve => release.push(resolve)); active--;
    return { ok: true, json: async () => ({ data: [] }) };
  } });
  const all = Promise.allSettled(Array.from({ length: 120 }, (_, i) => service.search(`query ${i}`).finally(() => completed++)));
  assert.equal(calls, 12);
  while (completed < 120) {
    for (const resolve of release.splice(0)) resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
  const results = await all;
  assert.equal(peak, 12); assert.equal(calls, 112);
  assert.equal(results.filter(result => result.status === 'rejected').length, 8);
  const retry = service.search('query 119'); release.shift()(); await retry;
  assert.equal(calls, 113);
});
