import { DIFFICULTIES } from './difficulties.js';
import { CLIPS, SKIP_MULTIPLIER, clipStepFor, pointsFor } from './multiplayer-rules.js';

const $ = id => document.getElementById(id);
const STORE = 'needle-drop:party-seat';
let seat = null, state = null, offset = 0, connected = false, busy = false, dirty = false;
let pollTimer, searchTimer, searchVersion = 0, chosen = null, matches = [], selected = -1;
let audioRound = null, autoPlayed = false, settingsKey = '', clipTimer, lastPhase = '';
let polling = false;
let pollFailures = 0, pollAbort;
const audio = new Audio(); audio.preload = 'auto'; audio.volume = .8;
const serverNow = () => Date.now() + offset;
const isHost = () => state?.hostId === state?.selfId;
const canGuess = () => connected && state?.phase === 'playing' && serverNow() >= state.round.startsAt && serverNow() < state.round.endsAt
  && !state.round.correct && state.round.guesses.length < state.settings.maxGuesses;
const clipStep = () => clipStepFor(serverNow() - state.round.startsAt, state.round.unlockedStep);
const clipSeconds = () => state?.settings.clipMode === 'full' ? 30 : CLIPS[clipStep()];
function message(text = '', error = false) { $('party-status').textContent = text; $('party-status').classList.toggle('error', error); }
function readSeat() { try { return JSON.parse(sessionStorage.getItem(STORE)); } catch { return null; } }
function saveSeat() { try { sessionStorage.setItem(STORE, JSON.stringify(seat)); } catch { message('Keep this tab open: this browser cannot save your seat for a refresh.'); } }
async function request(path, body, useSeat = true, signal) {
  const start = Date.now(), currentSeat = seat;
  const response = await fetch(`/api/lobbies${path}`, { method: body ? 'POST' : 'GET', cache: 'no-store',
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(useSeat && currentSeat ? { 'X-Player-Token': currentSeat.token } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: signal || AbortSignal.timeout(15000) });
  const result = await response.json();
  if (!response.ok) { const error = new Error(result.error || 'The lobby could not be reached.'); error.status = response.status; throw error; }
  const snapshot = result.state || result;
  if (Number.isFinite(snapshot.serverNow) && (!state || snapshot.version >= state.version)) {
    const networkTime = Math.max(0, Date.now() - start - (result.waitMs || 0));
    offset = snapshot.serverNow - Date.now() + networkTime / 2;
  }
  return result;
}
function stopAudio() { audio.pause(); clearTimeout(clipTimer); $('party-play').textContent = '▶'; $('party-play').setAttribute('aria-label', 'Play song clip'); }
function closeSearch() {
  searchVersion++; clearTimeout(searchTimer); chosen = null; matches = []; selected = -1;
  $('party-suggestions').hidden = true; $('party-search').setAttribute('aria-expanded', 'false'); $('party-search').removeAttribute('aria-activedescendant');
  $('party-guess').disabled = true;
}
function abandonSeat() {
  pollAbort?.abort(); pollFailures = 0;
  clearTimeout(pollTimer); seat = null; state = null; connected = false; audioRound = null; lastPhase = ''; settingsKey = ''; dirty = false;
  stopAudio(); audio.removeAttribute('src'); audio.load(); closeSearch();
  try { sessionStorage.removeItem(STORE); } catch { /* Nothing to restore. */ }
  $('lobby').hidden = true; $('entry').hidden = false; $('connection').textContent = '';
}
async function poll() {
  if (polling) return;
  clearTimeout(pollTimer);
  const current = seat;
  if (!current) return;
  polling = true;
  const abort = new AbortController(); pollAbort = abort;
  const timeout = setTimeout(() => abort.abort(), 25000);
  try {
    const result = await request(`/${current.code}${state ? `?after=${state.version}` : ''}`, undefined, true, abort.signal);
    if (seat !== current) return;
    connected = true; pollFailures = 0; applyState(result);
  } catch (error) {
    if (seat !== current) return;
    connected = false;
    pollFailures++;
    if ([401, 404].includes(error.status)) { abandonSeat(); message(error.message, true); return; }
    $('connection').textContent = 'Reconnecting…'; refreshClock();
  } finally { clearTimeout(timeout); if (pollAbort === abort) pollAbort = null; polling = false; if (seat && seat !== current) pollTimer = setTimeout(poll, 0); }
  if (seat === current) pollTimer = setTimeout(poll, connected ? 0 : Math.min(15000, 1000 * 2 ** Math.min(pollFailures - 1, 4)));
}
async function enter(joining) {
  if (busy) return;
  const name = $('player-name').value.trim(), code = $('join-code').value.trim().toUpperCase();
  if (!name) { message('Enter your name first.', true); $('player-name').focus(); return; }
  if (joining && !/^[A-Z0-9]{6}$/.test(code)) { message('Enter the six-character lobby code.', true); return; }
  busy = true; $('create-lobby').disabled = $('join-lobby').disabled = true; message('Joining your lobby…');
  try {
    const result = await request(joining ? `/${code}/join` : '', { name }, false);
    seat = { code: result.state.code, token: result.token }; saveSeat(); connected = true;
    try { localStorage.setItem('needle-drop:player-name', name); } catch { /* Optional convenience. */ }
    history.replaceState(null, '', `${location.pathname}?code=${seat.code}`);
    applyState(result.state); message(); void poll();
  } catch (error) { message(error.message, true); }
  finally { busy = false; $('create-lobby').disabled = $('join-lobby').disabled = false; refreshClock(); }
}
async function action(type, extra = {}) {
  if (!seat || busy) return;
  busy = true; refreshClock();
  const current = seat;
  try {
    const result = await request(`/${current.code}/action`, { type, ...extra });
    if (seat !== current) return;
    if (result.left) { abandonSeat(); history.replaceState(null, '', location.pathname); message('You left the lobby.'); return; }
    connected = true;
    if (type === 'settings') { dirty = false; settingsKey = ''; }
    if (type === 'guess') { $('party-search').value = ''; closeSearch(); }
    applyState(result); message(type === 'settings' ? 'Settings saved. Everyone can ready up.' : '');
    if (type === 'hear-more' && state.round?.id === extra.roundId && canGuess()) {
      stopAudio(); void playClip();
      message(`${clipSeconds()} seconds unlocked. Each paid skip keeps ${Math.round(SKIP_MULTIPLIER * 100)}% of your remaining time-based points.`);
    }
  } catch (error) {
    if ([401, 404].includes(error.status)) abandonSeat();
    message(error.message, true);
  } finally { busy = false; refreshClock(); }
}
function applyState(next) {
  $('connection').textContent = '● Connected';
  if (state && next.version <= state.version) return;
  const previousRound = state?.round?.id;
  state = next;
  $('entry').hidden = true; $('lobby').hidden = false; $('connection').textContent = '● Connected';
  $('room-code').textContent = state.code;
  const waiting = state.phase === 'waiting';
  $('waiting-room').hidden = !waiting; $('round-panel').hidden = waiting;
  if (previousRound !== state.round?.id || state.phase !== 'playing') { closeSearch(); $('party-search').value = ''; }
  if (previousRound !== state.round?.id || !['countdown', 'playing', 'reveal'].includes(state.phase)) stopAudio();
  if (state.round?.preview && audioRound !== state.round.id) {
    audioRound = state.round.id; autoPlayed = false; audio.src = state.round.preview; audio.load(); $('audio-error').textContent = '';
  }
  if (lastPhase === 'playing' && state.phase !== 'playing') stopAudio();
  lastPhase = state.phase;
  renderSettings(); renderPlayers(); renderRound(); refreshClock();
}
function renderSettings() {
  const host = isHost(), s = state.settings, key = JSON.stringify(s);
  if (!host) dirty = false;
  if ((!dirty && key !== settingsKey) || !host) {
    $('setting-tracks').value = s.tracks; $('setting-difficulty').value = s.difficulty; $('setting-genre').value = s.genre;
    $('setting-guesses').value = s.maxGuesses; $('setting-players').value = s.maxPlayers; $('setting-clip').value = s.clipMode; $('setting-early').checked = s.endEarly;
    settingsKey = key;
  }
  $('host-settings').disabled = !host; $('save-settings').hidden = !host;
  $('settings-dirty').hidden = !dirty;
  $('host-note').textContent = host ? 'You’re the host. Share the code and choose how you’ll play.' : `${state.players.find(p => p.id === state.hostId)?.name || 'The host'} is choosing the settings.`;
  $('settings-summary').textContent = `${s.tracks} tracks · ${DIFFICULTIES[s.difficulty].label} · ${s.genre === 'All' ? 'All genres' : s.genre} · 60 seconds each. ${s.clipMode === 'progressive' ? 'Clips expand every 10 seconds: 1, 2, 4, 7, 11, then 16 seconds. Hear more anytime for 20% fewer points per skip. Skips only affect you.' : 'Replay the full preview anytime.'}`;
  const me = state.players.find(p => p.id === state.selfId);
  $('ready-button').textContent = me?.ready ? 'Ready ✓ — undo' : 'Ready up';
  $('ready-button').setAttribute('aria-pressed', String(!!me?.ready));
  $('start-game').hidden = !host;
}
function renderPlayers() {
  $('scores-title').textContent = state.phase === 'waiting' ? 'The crew' : state.phase === 'finished' ? 'Final standings' : 'Leaderboard';
  $('player-count').textContent = `${state.players.length} / ${state.settings.maxPlayers}`;
  const list = $('players'); list.replaceChildren();
  let previousScore, place;
  for (const [index, player] of state.players.entries()) {
    if (player.score !== previousScore) place = index + 1;
    previousScore = player.score;
    const row = document.createElement('li'); row.className = `player-row${player.id === state.selfId ? ' me' : ''}`;
    const position = document.createElement('span'); position.className = 'position'; position.textContent = state.phase === 'waiting' ? '♪' : place;
    const info = document.createElement('div'); info.className = 'player-info';
    const name = document.createElement('strong'); name.className = 'player-name'; name.textContent = `${player.name}${player.id === state.selfId ? ' (you)' : ''}`;
    const detail = document.createElement('span'); detail.className = 'player-detail';
    const status = !player.connected ? 'Reconnecting…' : state.phase === 'waiting' ? (player.ready ? 'Ready ✓' : 'Not ready') : player.correct ? 'Got it ✓' : player.guesses >= state.settings.maxGuesses ? 'Out of guesses' : ['reveal', 'finished'].includes(state.phase) ? 'No answer' : 'Listening';
    detail.textContent = `${player.id === state.hostId ? 'Host · ' : ''}${status}`; info.append(name, detail);
    const score = document.createElement('strong'); score.className = 'player-score'; score.textContent = player.score.toLocaleString();
    if (player.roundPoints > 0) { const gain = document.createElement('small'); gain.className = 'round-points'; gain.textContent = `+${player.roundPoints}`; score.append(gain); }
    row.append(position, info, score);
    if (isHost() && state.phase === 'waiting' && player.id !== state.selfId) {
      const kick = document.createElement('button'); kick.className = 'kick-button'; kick.textContent = '×'; kick.setAttribute('aria-label', `Remove ${player.name}`);
      kick.onclick = () => action('kick', { playerId: player.id }); row.append(kick);
    }
    list.append(row);
  }
}
function renderRound() {
  const r = state.round, phase = state.phase;
  const trackNumber = ['loading', 'load-error'].includes(phase) ? (r?.number || 0) + 1 : r?.number || 1;
  $('round-label').textContent = `TRACK ${trackNumber} / ${state.settings.tracks} · ${DIFFICULTIES[state.settings.difficulty].label.toUpperCase()}`;
  const titles = { loading: 'Finding your next track…', 'load-error': 'The record needs a retry.', countdown: 'Get ready to listen.', playing: r?.correct ? 'That’s the one!' : 'Name that song.', reveal: 'The track revealed.', finished: 'That’s a wrap.' };
  $('round-title').textContent = titles[phase] || '';
  $('round-note').textContent = phase === 'load-error' ? state.error : phase === 'finished' ? winnerText()
    : r?.correct && phase === 'playing' ? `+${r.points} points. Wait for the rest of the crew.`
    : phase === 'playing' && r.guesses.length >= state.settings.maxGuesses ? 'No guesses left. Listen along until the reveal.'
    : phase === 'playing' ? 'The sooner you guess, the more points you earn.'
    : phase === 'reveal' ? 'Compare your scores. The next step starts automatically.'
    : phase === 'countdown' ? 'Everyone’s timer starts together. Press play if your browser blocks autoplay.' : 'Everyone will get the same song.';
  $('party-guess-form').hidden = !['countdown', 'playing'].includes(phase) || !!r?.correct;
  $('guesses-left').textContent = `${state.settings.maxGuesses - (r?.guesses.length || 0)} guesses left`;
  $('party-attempts').replaceChildren();
  for (const guess of r?.guesses || []) {
    const item = document.createElement('li'); item.className = `attempt filled ${guess.correct ? 'correct' : 'wrong'}`;
    item.textContent = `${guess.correct ? '✓' : '×'} ${guess.title} — ${guess.artist}`; $('party-attempts').append(item);
  }
  $('answer-reveal').hidden = !r?.answer;
  if (r?.answer) {
    $('answer-title').textContent = r.answer.title; $('answer-artist').textContent = r.answer.artist;
    $('answer-link').href = r.answer.link;
    if ($('answer-cover').getAttribute('src') !== r.answer.cover) { $('answer-cover').src = r.answer.cover; $('answer-cover').hidden = !r.answer.cover; }
  }
  $('next-round').hidden = !(isHost() && phase === 'reveal');
  $('next-round').textContent = r?.number === state.settings.tracks ? 'Final standings ↗' : 'Next track ↗';
  $('retry-round').hidden = !(isHost() && phase === 'load-error');
  $('rematch').hidden = !(isHost() && ['finished', 'load-error'].includes(phase));
}
function winnerText() {
  const top = state.players[0]?.score || 0;
  if (!top) return 'No points this time. Another rotation?';
  const winners = state.players.filter(p => p.score === top).map(p => p.name);
  return `${winners.join(' & ')} ${winners.length > 1 ? 'tie for first' : 'wins'} with ${top.toLocaleString()} points!`;
}
function refreshClock() {
  if (!state) return;
  const r = state.round, time = serverNow();
  let remaining = 0, text = '…';
  if (state.phase === 'countdown') { remaining = Math.max(0, r.startsAt - time); text = String(Math.ceil(remaining / 1000)); }
  else if (state.phase === 'playing') { remaining = Math.max(0, r.endsAt - time); text = `0:${Math.ceil(remaining / 1000).toString().padStart(2, '0')}`; if (remaining > 59000) text = '1:00'; }
  else if (state.phase === 'reveal') { remaining = Math.max(0, state.revealEndsAt - time); text = `${Math.ceil(remaining / 1000)}s`; }
  else if (state.phase === 'finished') text = '✓';
  $('round-timer').textContent = text;
  $('round-timer').classList.toggle('urgent', state.phase === 'playing' && remaining < 10000);
  $('round-progress-fill').style.width = `${state.phase === 'playing' ? remaining / 60000 * 100 : 0}%`;
  $('party-search').disabled = !canGuess(); $('party-guess').disabled = !canGuess() || !chosen || busy;
  $('party-play').disabled = !connected || !r?.preview || !['playing', 'reveal'].includes(state.phase) || (state.phase === 'playing' && time >= r.endsAt);
  const expanding = state.settings.clipMode === 'progressive';
  const nextStep = r ? clipStep() + 1 : 0;
  $('hear-more').hidden = !expanding || !['countdown', 'playing'].includes(state.phase);
  $('hear-more').disabled = busy || !canGuess() || nextStep >= CLIPS.length;
  $('hear-more').textContent = nextStep < CLIPS.length ? `Hear more → ${CLIPS[nextStep]}s (−20% points)` : 'Full clip unlocked';
  $('potential-points').hidden = !canGuess();
  if (canGuess()) $('potential-points').textContent = `Worth about ${pointsFor(time - r.startsAt, r.skips).toLocaleString()} points now${r.skips ? ` · ${r.skips} paid ${r.skips === 1 ? 'skip' : 'skips'}` : ''}`;
  $('ready-button').disabled = busy || !connected;
  const active = state.players.filter(p => p.connected);
  $('start-game').disabled = busy || dirty || !connected || active.length < 2 || !active.every(p => p.ready);
  for (const id of ['save-settings', 'next-round', 'retry-round', 'rematch']) $(id).disabled = busy || !connected;
  if (r && ['countdown', 'playing', 'reveal'].includes(state.phase)) {
    $('audio-label').textContent = state.phase === 'countdown' ? 'Get your ears ready.' : audio.paused ? 'Play the clip' : 'Listening…';
    $('audio-note').textContent = `${clipSeconds()}s unlocked · Replay anytime`;
  }
  if (state.phase === 'playing' && time < r.endsAt && !autoPlayed && connected) { autoPlayed = true; void playClip(); }
  if (state.phase === 'playing' && time >= r.endsAt) stopAudio();
}
async function playClip() {
  if ($('party-play').disabled) return;
  if (!audio.paused) { stopAudio(); return; }
  const roundId = state.round.id;
  audio.currentTime = 0; $('audio-error').textContent = '';
  try {
    await audio.play();
    if (state?.round?.id !== roundId || !['playing', 'reveal'].includes(state.phase)) { stopAudio(); return; }
    $('party-play').textContent = 'Ⅱ'; $('party-play').setAttribute('aria-label', 'Pause song clip');
  } catch { $('audio-error').textContent = 'Press play to start the audio. If it cannot load, check your connection and try again.'; }
}
audio.addEventListener('playing', () => { clearTimeout(clipTimer); if (state?.round) clipTimer = setTimeout(stopAudio, Math.max(0, clipSeconds() - audio.currentTime) * 1000); });
audio.addEventListener('waiting', () => clearTimeout(clipTimer));
audio.addEventListener('timeupdate', () => { if (state?.round && audio.currentTime >= clipSeconds()) stopAudio(); });
audio.addEventListener('ended', stopAudio);
audio.addEventListener('error', () => { if (audio.getAttribute('src')) $('audio-error').textContent = 'The preview could not load. Press play to retry.'; });
$('answer-cover').onerror = () => { $('answer-cover').hidden = true; };
$('party-play').onclick = playClip;
$('hear-more').onclick = () => {
  if (!$('hear-more').disabled) return action('hear-more', { roundId: state.round.id, step: clipStep() + 1 });
};
$('party-volume').oninput = e => { audio.volume = Number(e.target.value); };
function showMatches(songs, empty = 'No matches. Try another title or artist.') {
  matches = songs.slice(0, 12); selected = -1; $('party-suggestions').replaceChildren();
  for (const [index, song] of matches.entries()) {
    const item = document.createElement('li'); item.id = `party-option-${index}`; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', 'false');
    const title = document.createElement('span'); title.textContent = song.title;
    const artist = document.createElement('small'); artist.textContent = song.artist;
    item.append(title, artist); item.onclick = () => choose(song); $('party-suggestions').append(item);
  }
  if (!matches.length) { const item = document.createElement('li'); item.className = 'no-results'; item.textContent = empty; $('party-suggestions').append(item); }
  $('party-suggestions').hidden = false; $('party-search').setAttribute('aria-expanded', 'true');
}
function choose(song) { closeSearch(); chosen = song; $('party-search').value = `${song.title} — ${song.artist}`; refreshClock(); }
$('party-search').oninput = () => {
  closeSearch();
  const query = $('party-search').value.trim();
  if (query.length < 2 || !canGuess()) return;
  const version = searchVersion, roundId = state.round.id, currentSeat = seat;
  showMatches([], 'Searching…');
  searchTimer = setTimeout(async () => {
    try {
      const result = await request(`/${currentSeat.code}/search?q=${encodeURIComponent(query)}`);
      if (version === searchVersion && seat === currentSeat && state.round?.id === roundId && canGuess()) showMatches(result.songs);
    } catch (error) { if (version === searchVersion) showMatches([], error.message); }
  }, 350);
};
$('party-search').onkeydown = e => {
  if (e.key === 'Escape') closeSearch();
  if ($('party-suggestions').hidden || !matches.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
    [...$('party-suggestions').children].forEach((el, i) => el.setAttribute('aria-selected', String(i === selected)));
    $('party-search').setAttribute('aria-activedescendant', `party-option-${selected}`); $('party-suggestions').children[selected].scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter' && selected >= 0) { e.preventDefault(); choose(matches[selected]); }
};
document.addEventListener('click', e => { if (!e.target.closest('.search-wrapper') && !e.target.closest('#party-guess')) { const selection = chosen; closeSearch(); chosen = selection; refreshClock(); } });
$('party-guess-form').onsubmit = e => { e.preventDefault(); if (chosen && canGuess()) void action('guess', { songId: chosen.id, roundId: state.round.id }); };
$('create-lobby').onclick = () => enter(false);
$('join-form').onsubmit = e => { e.preventDefault(); void enter(true); };
$('leave-lobby').onclick = () => { if (!connected) { abandonSeat(); message('Left this tab’s seat. The server will mark you disconnected.'); } else void action('leave'); };
$('ready-button').onclick = () => action('ready', { ready: !state.players.find(p => p.id === state.selfId).ready });
$('start-game').onclick = () => action('start');
$('next-round').onclick = () => action('next');
$('retry-round').onclick = () => action('retry');
$('rematch').onclick = () => action('reset');
$('settings-form').oninput = () => { dirty = true; $('settings-dirty').hidden = false; refreshClock(); };
$('settings-form').onsubmit = e => {
  e.preventDefault();
  void action('settings', { settings: { tracks: Number($('setting-tracks').value), genre: $('setting-genre').value,
    difficulty: $('setting-difficulty').value, maxGuesses: Number($('setting-guesses').value), maxPlayers: Number($('setting-players').value),
    clipMode: $('setting-clip').value, endEarly: $('setting-early').checked } });
};
async function copy(value) { try { await navigator.clipboard.writeText(value); message('Copied. Send it to your crew.'); } catch { message(`Copy this: ${value}`); } }
$('copy-code').onclick = () => copy(state.code);
$('copy-link').onclick = () => copy(`${location.origin}${location.pathname}?code=${state.code}`);
document.addEventListener('visibilitychange', () => { if (document.hidden) stopAudio(); else if (seat) void poll(); });
const invite = new URLSearchParams(location.search).get('code')?.toUpperCase();
if (invite && /^[A-Z0-9]{6}$/.test(invite)) $('join-code').value = invite;
try { $('player-name').value = localStorage.getItem('needle-drop:player-name') || ''; } catch { /* Optional convenience. */ }
const saved = readSeat();
if (saved?.token && /^[A-Z0-9]{6}$/.test(saved.code) && (!invite || invite === saved.code)) { seat = saved; message('Reconnecting to your lobby…'); void poll().then(() => { if (connected) message(); }); }
setInterval(refreshClock, 100);
