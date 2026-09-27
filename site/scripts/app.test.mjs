import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as game from '../dist/game.js';
import * as difficulties from '../dist/difficulties.js';

const source = (await readFile(new URL('../dist/app.js', import.meta.url), 'utf8')).replace(/^import .*;\n/gm, '');
const song = id => ({ id, title: `Song ${id}`, artist: 'Artist', genre: 'Rock', cover: '', link: '' });
const flush = () => new Promise(resolve => setImmediate(resolve));

// Exercise the real controller with a minimal DOM and controlled network responses.
async function setup(preference = 'easy') {
  const elements = new Map(), pending = [], stored = new Map([['needle-drop:difficulty', JSON.stringify(preference)]]);
  function element() {
    return { value: '', textContent: '', disabled: false, hidden: true, style: {}, children: [], attrs: {},
      classList: { toggle() {}, add() {} }, addEventListener() {}, focus() {},
      append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      setAttribute(key, value) { this.attrs[key] = value; }, removeAttribute(key) { delete this.attrs[key]; },
    };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  get('genre').value = 'All';
  const response = (body, ok = true) => ({ ok, headers: { get: () => null }, json: async () => body });
  const context = vm.createContext({ ...game, ...difficulties, AbortSignal, console,
    document: { getElementById: get, createElement: element, querySelector: get, addEventListener() {} },
    Audio: class { paused = true; currentTime = 0; pause() {} load() {} removeAttribute() {} addEventListener() {} },
    localStorage: { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value) },
    setInterval() {}, setTimeout, clearTimeout, cancelAnimationFrame() {},
    fetch: async url => {
      if (url === '/api/daily') return response({ date: game.utcDay(), song: song(1) });
      if (url.startsWith('/api/track/')) return response({ preview: 'https://example.com/clip.mp3' });
      return new Promise(resolve => pending.push({ url, succeed: id => resolve(response({ song: song(id) })),
        fail: () => resolve(response({ error: 'No unplayed previews for this level.' }, false)) }));
    },
  });
  const run = code => vm.runInContext(code, context);
  run(source); await flush();
  return { get, run, pending, stored };
}

test('difficulty is for Endless, persists on success, and preserves daily progress', async () => {
  const app = await setup('expert');
  assert.equal(app.get('difficulty').disabled, true);
  assert.equal(app.get('difficulty').value, 'expert');
  app.run('submit(null); setMode("endless")');
  assert.match(app.pending[0].url, /difficulty=expert/);
  app.pending[0].succeed(2); await flush();
  assert.equal(app.get('difficulty').disabled, false);
  assert.match(app.get('date-label').textContent, /Expert/);
  app.get('difficulty').value = 'impossible'; app.get('difficulty').onchange();
  assert.equal(app.get('skip').disabled, true);
  assert.match(app.pending[1].url, /difficulty=impossible/);
  app.pending[1].succeed(3); await flush();
  assert.equal(app.stored.get('needle-drop:difficulty'), '"impossible"');
  app.run('setMode("daily")');
  assert.equal(app.run('round.trackId'), 1);
  assert.equal(app.run('round.attempts.length'), 1);
  app.run('setMode("endless")');
  assert.equal(app.run('round.trackId'), 3);
  assert.equal(app.get('difficulty').value, 'impossible');
});

test('failed level changes restore the current round and retry the requested level', async () => {
  const app = await setup();
  app.run('setMode("endless")'); app.pending[0].succeed(2); await flush();
  app.run('submit(null)');
  app.get('difficulty').value = 'hard'; app.get('difficulty').onchange();
  app.run('submit(null)');
  assert.equal(app.run('round.attempts.length'), 1, 'no guesses while a new level loads');
  app.pending[1].fail(); await flush();
  assert.equal(app.get('difficulty').value, 'easy');
  assert.equal(app.run('round.trackId'), 2);
  assert.equal(app.get('skip').disabled, false);
  assert.equal(app.get('retry-music').hidden, false);
  app.get('retry-music').onclick();
  assert.match(app.pending[2].url, /difficulty=hard/);
  app.pending[2].succeed(3); await flush();
  assert.equal(app.get('difficulty').value, 'hard');
  assert.equal(app.run('round.attempts.length'), 0);
});

test('stale level responses cannot replace a newer choice or the daily round', async () => {
  const app = await setup();
  app.run('setMode("endless")'); app.pending[0].succeed(2); await flush();
  app.get('difficulty').value = 'hard'; app.get('difficulty').onchange();
  app.get('difficulty').value = 'expert'; app.get('difficulty').onchange();
  app.pending[2].succeed(4); await flush();
  app.pending[1].succeed(3); await flush();
  assert.equal(app.run('round.trackId'), 4);
  assert.equal(app.get('difficulty').value, 'expert');
  app.get('difficulty').value = 'impossible'; app.get('difficulty').onchange();
  app.run('setMode("daily")'); app.pending[3].succeed(5); await flush();
  assert.equal(app.run('round.trackId'), 1);
  assert.equal(app.get('difficulty').disabled, true);
  assert.equal(app.run('endlessDifficulty'), 'expert');
});

test('unknown saved preferences fall back to Easy', async () => {
  const app = await setup('toString');
  assert.equal(app.get('difficulty').value, 'easy');
});
