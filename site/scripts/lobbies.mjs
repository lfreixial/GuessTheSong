import { randomBytes, randomInt } from 'node:crypto';
import { sameSong } from '../dist/game.js';
import { isDifficulty } from '../dist/difficulties.js';
import { GENRES } from './music.mjs';
import { CLIPS, clipStepFor, pointsFor } from '../dist/multiplayer-rules.js';
export { pointsFor } from '../dist/multiplayer-rules.js';

const ROUND_MS = 60000, COUNTDOWN_MS = 5000, REVEAL_MS = 8000;
const CONNECTED_MS = 20000, HOST_GRACE_MS = 45000, ROOM_TTL = 2 * 60 * 60 * 1000;
const DEFAULTS = { tracks: 5, genre: 'All', difficulty: 'easy', maxGuesses: 6, maxPlayers: 12, clipMode: 'progressive', endEarly: true };
export class LobbyError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
function requireThat(condition, message, status) { if (!condition) throw new LobbyError(message, status); }
function displayName(value) {
  requireThat(typeof value === 'string', 'Enter your name.');
  const name = value.trim().replace(/\s+/g, ' ');
  requireThat(name.length >= 1 && name.length <= 24 && !/[\p{Cc}\p{Cf}]/u.test(name), 'Use a name between 1 and 24 characters.');
  return name;
}
function settingsFor(value = {}, current = DEFAULTS) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value), 'Invalid lobby settings.');
  requireThat(Object.keys(value).every(key => Object.hasOwn(DEFAULTS, key)), 'Unknown lobby setting.');
  const s = { ...current, ...value };
  requireThat(Number.isInteger(s.tracks) && s.tracks >= 1 && s.tracks <= 20, 'Choose 1–20 tracks.');
  requireThat(s.genre === 'All' || Object.hasOwn(GENRES, s.genre), 'Choose a supported genre.');
  requireThat(isDifficulty(s.difficulty), 'Choose a supported level.');
  requireThat([3, 6, 10].includes(s.maxGuesses), 'Choose 3, 6, or 10 guesses.');
  requireThat(Number.isInteger(s.maxPlayers) && s.maxPlayers >= 2 && s.maxPlayers <= 16, 'Choose space for 2–16 players.');
  requireThat(['progressive', 'full'].includes(s.clipMode), 'Choose a supported clip mode.');
  requireThat(typeof s.endEarly === 'boolean', 'Invalid early-finish setting.');
  return s;
}

export function createLobbyService({ music, now = Date.now }) {
  const rooms = new Map();
  function changed(room) {
    room.version++;
    // Coalesce simultaneous guesses into one update per player instead of one per guess.
    if (room.waiters.size && !room.notifyTimer) room.notifyTimer = setTimeout(() => {
      room.notifyTimer = null;
      for (const waiter of [...room.waiters]) if (waiter.after !== room.version) waiter.wake();
    }, 50);
  }
  function player(name) {
    return { id: randomBytes(8).toString('hex'), token: randomBytes(24).toString('hex'), name: displayName(name), ready: false,
      score: 0, connected: true, lastSeen: now(), lastGuess: -Infinity, lastSearch: -Infinity };
  }
  function find(code) {
    const room = rooms.get(String(code).toUpperCase());
    requireThat(room && now() - room.touched < ROOM_TTL, 'Lobby not found or expired. Check the code or create a new lobby.', 404);
    return room;
  }
  function authenticate(room, token) {
    let p;
    for (const candidate of room.players.values()) if (candidate.token === token) { p = candidate; break; }
    requireThat(p, 'Your seat is no longer in this lobby. Join again with the code.', 401);
    p.lastSeen = now(); room.touched = now();
    if (!p.connected) { p.connected = true; changed(room); }
    return p;
  }
  function active(room) { return [...room.players.values()].filter(p => now() - p.lastSeen < CONNECTED_MS); }
  function host(room, p) { requireThat(room.hostId === p.id, 'Only the host can do that.', 403); }
  function finishRound(room) {
    if (room.phase !== 'playing') return;
    room.phase = 'reveal'; room.revealEndsAt = now() + REVEAL_MS;
    changed(room);
  }
  function everyoneDone(room) {
    const entries = active(room).map(p => room.round?.results.get(p.id)).filter(Boolean);
    return entries.length >= 1 && entries.every(result => result.correct || result.guesses.length >= room.settings.maxGuesses);
  }
  async function loadNext(room) {
    if (room.phase === 'loading') return;
    room.phase = 'loading'; room.error = ''; room.choices.clear();
    changed(room);
    const generation = ++room.generation;
    try {
      const song = await music.randomSong(room.settings.genre, [...room.seen], room.settings.difficulty);
      const { preview } = await music.preview(song.id);
      if (room.generation !== generation || !rooms.has(room.code)) return;
      const startsAt = now() + COUNTDOWN_MS;
      room.round = { id: randomBytes(12).toString('hex'), number: (room.round?.number || 0) + 1, song, preview,
        startsAt, endsAt: startsAt + ROUND_MS, results: new Map([...room.players.keys()].map(id => [id, { guesses: [], correct: false, points: 0, unlockedStep: 0, skips: 0 }])) };
      room.seen.push(song.id); room.phase = 'countdown';
      changed(room);
    } catch {
      if (room.generation !== generation || !rooms.has(room.code)) return;
      room.phase = 'load-error'; room.error = 'This track could not be loaded. The host can retry or return to the lobby to change settings. No points were lost.';
      changed(room);
    }
  }
  function advance(room) {
    for (const p of room.players.values()) {
      const connected = now() - p.lastSeen < CONNECTED_MS;
      if (connected !== p.connected) { p.connected = connected; changed(room); }
    }
    if (room.phase === 'countdown' && now() >= room.round.startsAt) { room.phase = 'playing'; changed(room); }
    if (room.phase === 'playing' && (now() >= room.round.endsAt || (room.settings.endEarly && everyoneDone(room)))) finishRound(room);
    if (room.phase === 'reveal' && now() >= room.revealEndsAt) {
      if (room.round.number >= room.settings.tracks) { room.phase = 'finished'; changed(room); }
      else void loadNext(room);
    }
    const currentHost = room.players.get(room.hostId);
    if (!currentHost || now() - currentHost.lastSeen >= HOST_GRACE_MS) {
      const successor = active(room).find(p => p.id !== room.hostId);
      if (successor) { room.hostId = successor.id; successor.ready = true; changed(room); }
    }
  }
  function snapshot(room, p) {
    advance(room);
    const r = room.round, mine = r?.results.get(p.id), reveal = ['reveal', 'finished'].includes(room.phase);
    if (room.rosterVersion !== room.version) {
      room.roster = [...room.players.values()].map(player => {
        const result = r?.results.get(player.id);
        return { id: player.id, name: player.name, ready: player.ready, connected: now() - player.lastSeen < CONNECTED_MS,
          score: player.score, correct: !!result?.correct, guesses: result?.guesses.length || 0, roundPoints: result?.points || 0 };
      }).sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
      room.rosterVersion = room.version;
    }
    return { version: room.version, code: room.code, selfId: p.id, hostId: room.hostId, phase: room.phase, settings: room.settings,
      serverNow: now(), players: room.roster, error: room.error, revealEndsAt: room.revealEndsAt,
      round: r ? { id: r.id, number: r.number, startsAt: r.startsAt, endsAt: r.endsAt,
        preview: ['countdown', 'playing', 'reveal'].includes(room.phase) ? r.preview : undefined,
        answer: reveal ? r.song : undefined,
        guesses: mine?.guesses || [], correct: !!mine?.correct, points: mine?.points || 0,
        unlockedStep: mine?.unlockedStep || 0, skips: mine?.skips || 0 } : null };
  }
  function credentials(room, p) { return { token: p.token, state: snapshot(room, p) }; }
  function create(name, settings) {
    requireThat(rooms.size < 200, 'The server is full. Please try again later.', 503);
    const p = player(name); p.ready = true;
    let code;
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
    const room = { code, hostId: p.id, players: new Map([[p.id, p]]), settings: settingsFor(settings), phase: 'waiting',
      touched: now(), generation: 0, version: 1, waiters: new Set(), seen: [], choices: new Map(), round: null, error: '' };
    rooms.set(code, room); return credentials(room, p);
  }
  function join(code, name) {
    const room = find(code); advance(room);
    requireThat(room.phase === 'waiting', 'This game has started. Ask the host to return to the lobby before joining.', 409);
    requireThat(room.players.size < room.settings.maxPlayers, 'This lobby is full.', 409);
    const p = player(name);
    requireThat(![...room.players.values()].some(other => other.name.toLowerCase() === p.name.toLowerCase()), 'That name is taken. Choose another name.');
    room.players.set(p.id, p); room.touched = now(); changed(room); return credentials(room, p);
  }
  function state(code, token) {
    const room = find(code); const p = authenticate(room, token); return snapshot(room, p);
  }
  async function waitForState(code, token, after, { timeoutMs = 15000, signal } = {}) {
    const room = find(code), p = authenticate(room, token); advance(room);
    if (after !== room.version || timeoutMs === 0) return snapshot(room, p);
    requireThat([...room.waiters].filter(waiter => waiter.playerId === p.id).length < 2, 'Too many open lobby updates.', 429);
    await new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => { clearTimeout(timer); room.waiters.delete(waiter); signal?.removeEventListener('abort', abort); };
      const waiter = { playerId: p.id, after, wake: () => { cleanup(); resolve(); } };
      const abort = () => { cleanup(); reject(new LobbyError('Lobby update cancelled.', 499)); };
      if (signal?.aborted) { abort(); return; }
      room.waiters.add(waiter); signal?.addEventListener('abort', abort, { once: true });
      timer = setTimeout(waiter.wake, timeoutMs);
    });
    return state(code, token);
  }
  async function search(code, token, query) {
    const room = find(code), p = authenticate(room, token); advance(room);
    requireThat(room.phase === 'playing', 'Wait for the next track.', 409);
    requireThat(typeof query === 'string' && query.trim().length >= 2, 'Type at least two characters.');
    requireThat(now() - p.lastSearch >= 250, 'Please wait a moment before searching again.', 429);
    p.lastSearch = now();
    const roundId = room.round.id;
    const songs = await music.search(query);
    requireThat(room.phase === 'playing' && room.round.id === roundId && now() < room.round.endsAt, 'That round has ended.', 409);
    for (const song of songs) {
      if (room.choices.size >= 2000) room.choices.delete(room.choices.keys().next().value);
      room.choices.set(song.id, song);
    }
    return { songs, roundId };
  }
  function reset(room) {
    room.generation++; room.phase = 'waiting'; room.round = null; room.seen = []; room.error = ''; room.choices.clear();
    for (const p of room.players.values()) { p.score = 0; p.ready = p.id === room.hostId; }
    changed(room);
  }
  function action(code, token, input) {
    const room = find(code), p = authenticate(room, token); advance(room);
    requireThat(input && typeof input === 'object', 'Invalid action.');
    if (input.type === 'guess') {
      requireThat(room.phase === 'playing' && input.roundId === room.round.id, 'That round is not accepting guesses.', 409);
      const r = room.round, result = r.results.get(p.id);
      requireThat(result && !result.correct && result.guesses.length < room.settings.maxGuesses, 'You have finished this round.', 409);
      requireThat(now() - p.lastGuess >= 1000, 'Wait one second between guesses.', 429);
      const song = room.choices.get(input.songId);
      requireThat(song, 'Search and select a song before guessing.');
      requireThat(!result.guesses.some(guess => guess.id === song.id), 'You already guessed that song.');
      p.lastGuess = now();
      result.correct = sameSong(song, r.song);
      result.guesses.push({ id: song.id, title: song.title, artist: song.artist, correct: result.correct });
      if (result.correct) { result.points = pointsFor(now() - r.startsAt, result.skips); p.score += result.points; }
      changed(room);
    } else if (input.type === 'hear-more') {
      requireThat(room.phase === 'playing' && input.roundId === room.round.id, 'That round is not accepting skips.', 409);
      requireThat(room.settings.clipMode === 'progressive', 'The full preview is already unlocked.', 409);
      const r = room.round, result = r.results.get(p.id);
      requireThat(result && !result.correct && result.guesses.length < room.settings.maxGuesses, 'You have finished this round.', 409);
      const currentStep = clipStepFor(now() - r.startsAt, result.unlockedStep);
      requireThat(Number.isInteger(input.step) && input.step >= 1 && input.step < CLIPS.length, 'Choose a valid clip step.');
      requireThat(input.step <= currentStep + 1, 'Unlock one clip at a time.', 409);
      // A retry, or a request overtaken by an automatic unlock, must not charge twice.
      if (input.step > currentStep) { result.unlockedStep = input.step; result.skips++; changed(room); }
    } else if (input.type === 'ready') {
      requireThat(room.phase === 'waiting', 'The game has already started.', 409);
      requireThat(typeof input.ready === 'boolean', 'Invalid ready status.');
      if (p.ready !== input.ready) { p.ready = input.ready; changed(room); }
    } else if (input.type === 'leave') {
      room.players.delete(p.id);
      changed(room);
      if (!room.players.size) { room.generation++; rooms.delete(room.code); }
      else advance(room);
      return { left: true };
    } else {
      host(room, p);
      if (input.type === 'settings') {
        requireThat(room.phase === 'waiting', 'Settings can only change in the lobby.', 409);
        const settings = settingsFor(input.settings, room.settings);
        requireThat(settings.maxPlayers >= room.players.size, 'Player limit cannot be lower than the current player count.');
        room.settings = settings;
        for (const player of room.players.values()) player.ready = player.id === room.hostId;
        changed(room);
      } else if (input.type === 'start') {
        requireThat(room.phase === 'waiting', 'The game has already started.', 409);
        const connected = active(room);
        requireThat(connected.length >= 2, 'At least two connected players are needed.');
        requireThat(connected.every(p => p.ready), 'Wait for everyone to press Ready.');
        void loadNext(room);
      } else if (input.type === 'retry') {
        requireThat(room.phase === 'load-error', 'There is no failed track to retry.', 409); void loadNext(room);
      } else if (input.type === 'next') {
        requireThat(room.phase === 'reveal', 'Wait for the current round to finish.', 409);
        room.revealEndsAt = now(); advance(room);
      } else if (input.type === 'reset') {
        requireThat(['finished', 'load-error', 'waiting'].includes(room.phase), 'Finish the game before returning to the lobby.', 409); reset(room);
      } else if (input.type === 'kick') {
        requireThat(room.phase === 'waiting', 'Players can only be removed before the game starts.', 409);
        requireThat(input.playerId !== p.id, 'Use Leave lobby to leave yourself.');
        if (room.players.delete(input.playerId)) changed(room);
      } else throw new LobbyError('Unknown action.');
    }
    return snapshot(room, p);
  }
  function tick() {
    for (const room of rooms.values()) {
      if (now() - room.touched >= ROOM_TTL) { room.generation++; rooms.delete(room.code); changed(room); }
      else advance(room);
    }
  }
  return { create, join, state, waitForState, search, action, tick };
}
