import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { createMusicService } from './music.mjs';
import { sameSong } from '../dist/game.js';
const raw = id => ({ id, title: `Song ${id}`, title_short: `Song ${id}`, artist: { name: 'Artist' }, preview: 'https://example.com/preview.mp3', readable: true, album: { cover_medium: '' } });
const fake = async url => ({ ok: true, json: async () => url.includes('/radio/genres') ? { data: [{ id: 152, radios: [{ id: 1, title: 'Rock' }] }] } : url.includes('/radio/1/') ? { data: [raw(101), raw(102), { ...raw(103), preview: '' }] } : url.includes('/search?') ? { data: [raw(900), raw(900)] } : raw(101) });
async function cleanTemp(directory) {
  assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
  assert.ok(basename(directory).startsWith('needle-drop-test-'));
  await rm(directory, { recursive: true, force: true });
}
test('live stations filter genre, unavailable previews, and already played songs', async () => {
  const service = createMusicService({ dataDir: '', fetcher: fake, random: () => 0 });
  assert.equal((await service.randomSong('Rock', [101])).id, 102);
  await assert.rejects(service.randomSong('Rock', [101, 102]), /unplayed/);
  await assert.rejects(service.randomSong('Invalid'), /supported/);
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
