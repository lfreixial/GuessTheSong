import { CLIPS, utcDay, normalize, sameSong, newRound, hasWon, isFinished, clipLength, makeGuess, restoreRound } from './game.js';
import { DIFFICULTIES, isDifficulty } from './difficulties.js';
const $ = id => document.getElementById(id);
let catalog = [], mode = 'daily', round, daily, endless, chosen = null, matches = [], activeOption = -1, seen = [], clockOffset = 0, loadVersion = 0, ready = false;
const audio = new Audio();
audio.preload = 'auto'; audio.volume = .8;
let frame, clipTimer, playRequest = 0, endlessGenre = 'All';
let searchTimer, searchVersion = 0, roundRequest = 0, dailyLoading = false, dailyRetryAt = 0, retryAction;
const savedDifficulty = storageRead('needle-drop:difficulty');
let endlessDifficulty = isDifficulty(savedDifficulty) ? savedDifficulty : 'easy', roundLoading = false;
$('difficulty').value = endlessDifficulty;
async function api(path) {
  const response = await fetch(`/api/${path}`, { cache: 'no-store', signal: AbortSignal.timeout(90000) });
  const serverTime = Date.parse(response.headers.get('date'));
  if (Number.isFinite(serverTime)) clockOffset = serverTime - Date.now();
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Music is temporarily unavailable.');
  return result;
}
function remember(songs) { for (const song of songs) { if (song && Number.isSafeInteger(song.id) && typeof song.title === 'string' && typeof song.artist === 'string' && !catalog.some(t => t.id === song.id)) catalog.push(song); } }
function musicError(action, message = 'Music could not be loaded. Please retry in a moment.') { retryAction = action; $('retry-music').hidden = false; status(message, true); }
$('retry-music').onclick = () => retryAction?.();
const bars = [];
for (let i = 0; i < 86; i++) {
  const bar = document.createElement('span');
  bar.style.height = `${12 + Math.abs(Math.sin(i * 1.91) * Math.cos(i * .23)) * 60}px`;
  $('waveform').append(bar); bars.push(bar);
}
function now() { return new Date(Date.now() + clockOffset); }
function status(message = '', error = false) { $('status').textContent = message; $('status').classList.toggle('error', error); }
function storageRead(key) { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } }
function save() { if (mode === 'daily') { try { localStorage.setItem(`needle-drop:v2:${daily.date}`, JSON.stringify({ ...daily, songs: catalog.filter(t => t.id === daily.trackId || daily.attempts.some(a => a.id === t.id)) })); } catch { status('Progress cannot be saved in this browser. Keep this tab open.'); } } }
function track() { return catalog.find(t => t.id === round.trackId); }
function updateClock() {
  if (!round || roundLoading) return;
  const time = now();
  if (daily && daily.date !== utcDay(time) && !dailyLoading && Date.now() > dailyRetryAt) refreshDaily();
  const remaining = 86400 - ((time.getUTCHours() * 3600) + time.getUTCMinutes() * 60 + time.getUTCSeconds());
  const h = Math.floor(remaining / 3600).toString().padStart(2, '0');
  const m = Math.floor(remaining / 60 % 60).toString().padStart(2, '0');
  const s = (remaining % 60).toString().padStart(2, '0');
  $('reset-timer').textContent = mode === 'daily' ? `NEXT DROP IN ${h}:${m}:${s}` : `${seen.length} ${seen.length === 1 ? 'track' : 'tracks'} in rotation`;
}
function stopAudio() {
  playRequest++; audio.pause(); clearTimeout(clipTimer); cancelAnimationFrame(frame);
  $('play-icon').textContent = '▶'; $('play').setAttribute('aria-label', 'Play song clip');
  $('play-caption').textContent = ready ? 'Play the clip' : 'Loading the record…';
}
function renderProgress() {
  const duration = clipLength(round);
  $('elapsed').textContent = `0:${Math.floor(audio.currentTime || 0).toString().padStart(2, '0')}`;
  bars.forEach((bar, i) => { bar.classList.toggle('unlocked', i / bars.length < duration / 16); bar.classList.toggle('heard', i / bars.length < (audio.currentTime || 0) / 16); });
}
function animate() {
  renderProgress();
  if (audio.currentTime >= clipLength(round)) { stopAudio(); return; }
  if (!audio.paused) frame = requestAnimationFrame(animate);
}
audio.addEventListener('playing', () => {
  $('play-icon').textContent = 'Ⅱ'; $('play-caption').textContent = 'Listening…'; $('play').setAttribute('aria-label', 'Pause song clip');
  clearTimeout(clipTimer);
  clipTimer = setTimeout(stopAudio, Math.max(0, clipLength(round) - audio.currentTime) * 1000);
  frame = requestAnimationFrame(animate);
});
audio.addEventListener('waiting', () => { clearTimeout(clipTimer); $('play-caption').textContent = 'Buffering…'; });
audio.addEventListener('timeupdate', () => { if (round && audio.currentTime >= clipLength(round)) stopAudio(); });
audio.addEventListener('ended', stopAudio);
audio.addEventListener('error', () => { if (audio.getAttribute('src')) { ready = false; stopAudio(); $('play').disabled = false; $('play-caption').textContent = 'Retry the clip'; status('This preview could not load. Press play to retry; no guess was used.', true); } });
function providerTrack(id) { return api(`track/${id}`); }
async function loadPreview() {
  const version = ++loadVersion;
  ready = false; $('play').disabled = true; $('play-caption').textContent = 'Loading the record…';
  try {
    const data = await providerTrack(round.trackId);
    if (version !== loadVersion) return;
    audio.src = data.preview; audio.load(); ready = true;
    $('play').disabled = false; $('play-caption').textContent = 'Play the clip';
    $('play').setAttribute('aria-label', 'Play song clip');
  } catch {
    if (version !== loadVersion) return;
    $('play').disabled = false; $('play-caption').textContent = 'Retry the clip';
    status('The audio provider is unavailable. Press play to retry; your guesses are safe.', true);
  }
}
$('play').addEventListener('click', async () => {
  if (!round || roundLoading) return;
  if (!audio.paused) { stopAudio(); return; }
  if (!ready) { await loadPreview(); if (!ready) return; }
  const request = ++playRequest;
  status(); audio.currentTime = 0;
  try { await audio.play(); if (request !== playRequest) return; }
  catch { if (request === playRequest) { stopAudio(); status('Playback was interrupted. Press play to try again.', true); } }
});
$('volume').addEventListener('input', e => { audio.volume = Number(e.target.value); });
document.addEventListener('visibilitychange', () => { if (document.hidden) stopAudio(); else updateClock(); });
function closeSuggestions() { searchVersion++; clearTimeout(searchTimer); $('suggestions').hidden = true; $('song-search').setAttribute('aria-expanded', 'false'); $('song-search').removeAttribute('aria-activedescendant'); activeOption = -1; }
function selectSong(song) { chosen = song; $('song-search').value = `${song.title} — ${song.artist}`; $('guess').disabled = false; closeSuggestions(); }
function showSuggestions(songs, emptyText = 'No songs found. Try an artist or a different spelling.') {
  matches = songs.slice(0, 12);
  $('suggestions').replaceChildren(); activeOption = -1;
  for (const [i, song] of matches.entries()) {
    const item = document.createElement('li'); item.id = `suggestion-${i}`; item.setAttribute('role', 'option'); item.setAttribute('aria-selected', 'false');
    const title = document.createElement('span'); title.textContent = song.title;
    const artist = document.createElement('small'); artist.textContent = song.artist;
    item.append(title, artist); item.addEventListener('click', () => selectSong(song)); $('suggestions').append(item);
  }
  if (!matches.length) { const item = document.createElement('li'); item.className = 'no-results'; item.textContent = emptyText; $('suggestions').append(item); }
  $('suggestions').hidden = false; $('song-search').setAttribute('aria-expanded', 'true');
}
function search() {
  clearTimeout(searchTimer); const version = ++searchVersion;
  chosen = null; $('guess').disabled = true;
  const query = $('song-search').value.trim();
  if (query.length < 2) { closeSuggestions(); return; }
  showSuggestions([], 'Searching the music catalogue…');
  searchTimer = setTimeout(async () => {
    try {
      const { songs } = await api(`search?q=${encodeURIComponent(query)}`);
      if (version !== searchVersion || isFinished(round)) return;
      remember(songs);
      const local = catalog.filter(t => normalize(`${t.title} ${t.artist}`).includes(normalize(query)));
      showSuggestions([...new Map([...songs, ...local].map(t => [t.id, t])).values()]);
    } catch { if (version === searchVersion) showSuggestions(catalog.filter(t => normalize(`${t.title} ${t.artist}`).includes(normalize(query))), 'Search is unavailable. Type again to retry.'); }
  }, 300);
}
$('song-search').addEventListener('input', search);
$('song-search').addEventListener('keydown', e => {
  if (e.key === 'Escape') closeSuggestions();
  if ($('suggestions').hidden || !matches.length) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault(); activeOption = (activeOption + (e.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
    [...$('suggestions').children].forEach((el, i) => el.setAttribute('aria-selected', String(i === activeOption)));
    $('song-search').setAttribute('aria-activedescendant', `suggestion-${activeOption}`);
    $('suggestions').children[activeOption].scrollIntoView({ block: 'nearest' });
  }
  if (e.key === 'Enter' && activeOption >= 0) { e.preventDefault(); selectSong(matches[activeOption]); }
});
document.addEventListener('click', e => { if (!e.target.closest('.search-wrapper')) closeSuggestions(); });
function submit(id) {
  if (roundLoading) return;
  const activeRound = round;
  updateClock();
  if (mode === 'daily' && (!daily || daily.date !== utcDay(now()))) { status('A new daily drop is loading. Please wait before guessing.'); return; }
  if (round !== activeRound) return;
  if (!round || isFinished(round)) return;
  if (id !== null && !catalog.some(t => t.id === id)) return;
  if (id !== null && sameSong(catalog.find(t => t.id === id), track())) id = round.trackId;
  if (!makeGuess(round, id)) { status('You already tried that song. Pick another one.'); return; }
  stopAudio(); audio.currentTime = 0; chosen = null; $('song-search').value = ''; closeSuggestions();
  render(); save();
  status(isFinished(round) ? (hasWon(round) ? 'That’s the one. Nicely heard!' : 'Out of guesses. Meet your mystery track below.') : (id === null ? `Skipped. You now have ${clipLength(round)} seconds to listen.` : `Not this time. You now have ${clipLength(round)} seconds to listen.`));
  if (!isFinished(round)) $('song-search').focus();
}
$('guess-form').addEventListener('submit', e => { e.preventDefault(); if (chosen) submit(chosen.id); else status('Choose a song from the search results first.'); });
$('skip').addEventListener('click', () => submit(null));
function render() {
  const finished = isFinished(round), song = track(), count = round.attempts.length;
  $('daily-mode').classList.toggle('active', mode === 'daily'); $('endless-mode').classList.toggle('active', mode === 'endless');
  $('daily-mode').setAttribute('aria-pressed', String(mode === 'daily')); $('endless-mode').setAttribute('aria-pressed', String(mode === 'endless'));
  $('genre').disabled = mode === 'daily';
  $('difficulty').disabled = mode === 'daily';
  $('difficulty-note').textContent = mode === 'daily' ? 'Endless mode' : '5 levels';
  $('difficulty-description').textContent = mode === 'daily' ? 'Choose Endless rotation to pick a level, from Top 100 hits to obscure deep cuts.' : DIFFICULTIES[endlessDifficulty].description;
  $('genre-note').textContent = mode === 'daily' ? 'Endless mode' : 'Live catalogue';
  $('genre-description').textContent = mode === 'daily' ? 'Today’s track is the same for everyone. Come back for a fresh drop tomorrow.' : 'Pick a genre and discover your next mystery track. Change it anytime for a new round.';
  $('session-label').textContent = mode === 'daily' ? 'DAILY DROP' : 'ENDLESS ROTATION';
  $('date-label').textContent = mode === 'daily' ? new Date(`${round.date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : `${$('genre').value} · ${DIFFICULTIES[endlessDifficulty].label}`;
  $('track-label').textContent = finished ? 'THE TRACK REVEALED' : 'THE MYSTERY TRACK';
  $('player-title').textContent = finished ? (hasWon(round) ? 'You know your music.' : 'One for your playlist.') : 'A little sound. A big clue.';
  $('player-subtitle').textContent = finished ? (hasWon(round) ? `Found in ${count} ${count === 1 ? 'guess' : 'guesses'}. Keep that good feeling.` : 'There’s always another song to fall in love with.') : 'Press play and see what rings a bell.';
  $('clip-length').textContent = `${clipLength(round)}s`; $('clip-description').textContent = count ? `${clipLength(round)} seconds of your mystery track` : 'Start with a one-second clip';
  $('song-search').disabled = finished; $('guess').disabled = true; $('skip').disabled = finished;
  $('guess-form').hidden = finished; $('attempt-count').textContent = `${count} / 6`;
  $('attempt-label').textContent = `${6 - count} ${count === 5 ? 'guess' : 'guesses'} to find your song`;
  $('skip').innerHTML = count < 5 ? `Skip <span>+${CLIPS[count + 1] - CLIPS[count]}s →</span>` : 'Reveal song';
  $('attempts').replaceChildren();
  for (let i = 0; i < 6; i++) {
    const attempt = round.attempts[i], item = document.createElement('li'); item.className = 'attempt';
    const number = document.createElement('span'); number.className = 'attempt-number'; number.textContent = String(i + 1).padStart(2, '0'); item.append(number);
    const text = document.createElement('span'); text.className = 'attempt-text';
    if (attempt) {
      item.classList.add('filled'); const guess = catalog.find(t => t.id === attempt.id);
      text.textContent = guess ? `${guess.title} — ${guess.artist}` : 'Skipped';
      item.classList.add(attempt.id === song.id ? 'correct' : 'wrong');
      const mark = document.createElement('span'); mark.className = 'attempt-mark'; mark.textContent = attempt.id === song.id ? '✓' : guess ? '×' : '—'; item.append(text, mark);
    } else { text.textContent = !finished && i === count ? 'Your next guess' : '—'; item.append(text); }
    $('attempts').append(item);
  }
  $('result').hidden = !finished; $('result').replaceChildren();
  if (finished) {
    const top = document.createElement('div'); top.className = 'result-top';
    const cover = document.createElement('img'); cover.src = song.cover; cover.alt = 'Album artwork'; cover.addEventListener('error', () => cover.hidden = true);
    const details = document.createElement('div'); const title = document.createElement('h3'); title.textContent = song.title; const artist = document.createElement('p'); artist.textContent = `${song.artist} · ${song.genre}`;
    const link = document.createElement('a'); link.href = song.link; link.target = '_blank'; link.rel = 'noreferrer'; link.textContent = 'Listen on Deezer ↗'; details.append(title, artist, link); top.append(cover, details);
    const actions = document.createElement('div'); actions.className = 'result-actions';
    const next = document.createElement('button'); next.className = 'guess-button'; next.textContent = mode === 'daily' ? 'Keep playing in endless ↗' : 'Next track ↗'; next.onclick = () => mode === 'daily' ? setMode('endless') : nextEndless(); actions.append(next);
    $('result').append(top, actions);
  }
  $('bottom-caption').textContent = mode === 'daily' ? 'A new track, every day. Resets at 00:00 UTC.' : `${DIFFICULTIES[endlessDifficulty].label} · ${DIFFICULTIES[endlessDifficulty].summary}. Recent tracks excluded.`;
  document.querySelector('.game-panel').setAttribute('aria-busy', 'false'); renderProgress(); updateClock();
}
function loadRound() { stopAudio(); audio.removeAttribute('src'); audio.load(); ready = false; chosen = null; $('song-search').value = ''; closeSuggestions(); $('retry-music').hidden = true; status(); render(); loadPreview(); }
async function nextEndless(genre = $('genre').value, difficulty = $('difficulty').value) {
  const version = ++roundRequest;
  roundLoading = true; loadVersion++; closeSuggestions(); chosen = null;
  stopAudio(); status(`Finding your ${DIFFICULTIES[difficulty].label} track…`); $('retry-music').hidden = true;
  document.querySelector('.game-panel').setAttribute('aria-busy', 'true');
  for (const id of ['play', 'song-search', 'guess', 'skip']) $(id).disabled = true;
  try {
    const { song } = await api(`random?genre=${encodeURIComponent(genre)}&difficulty=${encodeURIComponent(difficulty)}&exclude=${seen.slice(-500).join(',')}`);
    if (version !== roundRequest) return;
    roundLoading = false;
    remember([song]); seen.push(song.id); endlessGenre = genre; endlessDifficulty = difficulty; mode = 'endless'; $('genre').value = genre; $('difficulty').value = difficulty;
    try { localStorage.setItem('needle-drop:difficulty', JSON.stringify(difficulty)); } catch { /* The current session still keeps the level. */ }
    endless = newRound(song, utcDay(now())); round = endless; loadRound();
  } catch (error) {
    if (version !== roundRequest) return;
    roundLoading = false; $('genre').value = mode === 'daily' ? 'All' : endlessGenre; $('difficulty').value = endlessDifficulty;
    if (mode === 'daily' && daily) round = daily;
    if (round) { render(); $('play').disabled = false; }
    else document.querySelector('.game-panel').setAttribute('aria-busy', 'false');
    musicError(() => nextEndless(genre, difficulty), error.message);
  }
}
function setMode(next) {
  const wasLoading = roundLoading;
  roundRequest++; roundLoading = false;
  if (mode === next && round && !wasLoading) return;
  $('difficulty').value = endlessDifficulty;
  if (next === 'daily') {
    mode = 'daily'; $('genre').value = 'All';
    if (!daily) { refreshDaily(); return; }
    round = daily; loadRound();
  } else {
    $('genre').value = endlessGenre;
    if (endless) { mode = 'endless'; round = endless; loadRound(); }
    else nextEndless();
  }
}
$('daily-mode').onclick = () => setMode('daily'); $('endless-mode').onclick = () => setMode('endless');
$('genre').onchange = () => nextEndless();
$('difficulty').onchange = () => nextEndless();
$('help-button').onclick = () => $('help-dialog').showModal(); $('close-help').onclick = $('start-playing').onclick = () => $('help-dialog').close();
$('help-dialog').addEventListener('click', e => { if (e.target === $('help-dialog')) { const r = e.target.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) e.target.close(); } });
async function refreshDaily() {
  if (dailyLoading) return;
  dailyLoading = true; $('retry-music').hidden = true;
  try {
    const { date, song } = await api('daily'); remember([song]);
    const saved = storageRead(`needle-drop:v2:${date}`); if (Array.isArray(saved?.songs)) remember(saved.songs);
    daily = restoreRound(saved, song, date, catalog);
    if (mode === 'daily' && !roundLoading) { round = daily; loadRound(); }
  } catch { dailyRetryAt = Date.now() + 60000; if (mode === 'daily' && !roundLoading) musicError(refreshDaily); }
  finally { dailyLoading = false; }
}
function registerAgentTools() {
  if (!document.modelContext?.registerTool) return;
  try {
    Promise.resolve(document.modelContext.registerTool({
      name: 'start_endless_round', title: 'Start an endless song round',
      description: 'Start a song round with a genre and optional difficulty, preserving daily progress.',
      inputSchema: { type: 'object', properties: {
        genre: { type: 'string', enum: ['All', 'Pop', 'Rock', 'Hip-Hop', 'Electronic', 'R&B', 'Country'] },
        difficulty: { type: 'string', enum: Object.keys(DIFFICULTIES) },
      }, required: ['genre'], additionalProperties: false },
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      async execute(input) {
        if (!input || !['All', 'Pop', 'Rock', 'Hip-Hop', 'Electronic', 'R&B', 'Country'].includes(input.genre)) throw new Error('Choose a supported genre.');
        const difficulty = input.difficulty ?? endlessDifficulty;
        if (!isDifficulty(difficulty)) throw new Error('Choose a supported difficulty.');
        await nextEndless(input.genre, difficulty);
        if (!$('retry-music').hidden) throw new Error($('status').textContent);
        return { mode, genre: input.genre, difficulty, guessesRemaining: 6, clipSeconds: 1 };
      },
    })).catch(() => {});
  } catch { /* Optional browser capability; normal controls remain available. */ }
}
refreshDaily(); setInterval(updateClock, 1000); registerAgentTools();
