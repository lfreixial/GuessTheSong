import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDifficulty, matchesDifficulty } from '../dist/difficulties.js';

export const GENRES = { Pop: [132], Rock: [152], 'Hip-Hop': [116], Electronic: [106, 113], 'R&B': [165], Country: [84] };
const STATION_NAMES = { Pop: /^(pop|hits|the '80s)$/i, Rock: /rock|ac\/dc/i, 'Hip-Hop': /hip.hop|rap|grime/i, Electronic: /electro|techno|house|edm|dance|dubstep|minimal/i, 'R&B': /r&b|r.n.b|motown/i, Country: /country/i };
export function toSong(track, genre = 'Music') {
  if (!Number.isSafeInteger(track?.id) || !track.title || !track.artist?.name) return null;
  return { id: track.id, title: track.title_short || track.title, artist: track.artist.name, genre,
    cover: track.album?.cover_medium || '', link: `https://www.deezer.com/track/${track.id}` };
}
export function createMusicService({ dataDir, fetcher = fetch, random = Math.random, now = () => new Date() }) {
  const cache = new Map(), pending = new Map(), dailyJobs = new Map();
  let activeRequests = 0;
  const queue = [];
  async function limitedRequest(callback) {
    if (activeRequests >= 12) {
      if (queue.length >= 100) throw new Error('Music requests are busy. Please retry in a moment.');
      await new Promise((resolve, reject) => {
        const entry = { resolve: () => { clearTimeout(timer); resolve(); } };
        const timer = setTimeout(() => {
          const index = queue.indexOf(entry);
          if (index !== -1) queue.splice(index, 1);
          reject(new Error('Music requests are busy. Please retry in a moment.'));
        }, 5000);
        queue.push(entry);
      });
    } else activeRequests++;
    try { return await callback(); }
    finally { if (queue.length) queue.shift().resolve(); else activeRequests--; }
  }
  async function provider(path, ttl = 60000) {
    const hit = cache.get(path);
    if (hit && hit.expires > Date.now()) { cache.delete(path); cache.set(path, hit); return hit.value; }
    if (pending.has(path)) return pending.get(path);
    const job = limitedRequest(async () => {
      const response = await fetcher(`https://api.deezer.com${path}`, { signal: AbortSignal.timeout(12000) });
      if (!response.ok) throw new Error('The music provider is temporarily unavailable. Please retry.');
      const value = await response.json();
      if (value.error) throw new Error('The music provider could not complete this request. Please retry.');
      if (cache.size >= 300) cache.delete(cache.keys().next().value);
      cache.set(path, { value, expires: Date.now() + ttl });
      return value;
    });
    pending.set(path, job);
    try { return await job; } finally { pending.delete(path); }
  }
  function shuffled(items) { return items.map(value => ({ value, sort: random() })).sort((a, b) => a.sort - b.sort).map(item => item.value); }
  function validateGenre(genre) {
    if (genre !== 'All' && !Object.hasOwn(GENRES, genre)) throw new Error('Choose a supported genre.');
  }
  async function stationsFor(genre) {
    validateGenre(genre);
    const groups = (await provider('/radio/genres', 3600000)).data || [];
    const names = genre === 'All' ? Object.keys(GENRES) : [genre];
    const stations = names.flatMap(name => groups.filter(g => GENRES[name].includes(g.id)).flatMap(g => (g.radios || []).filter(r => STATION_NAMES[name].test(r.title)).map(r => ({ id: r.id, genre: name }))));
    if (!stations.length) throw new Error('No stations are available for this genre right now. Please retry.');
    return stations;
  }
  const playable = track => track.preview && track.readable !== false && toSong(track);
  function pick(tracks, genre, excluded, difficulty) {
    const songs = [...new Map(tracks.filter(t => playable(t) && !excluded.has(t.id) && (!difficulty || matchesDifficulty(t, difficulty)))
      .map(t => [t.id, toSong(t, genre)])).values()];
    return songs.length ? songs[Math.floor(random() * songs.length)] : null;
  }
  async function stationSong(genre = 'All', exclude = []) {
    const stations = await stationsFor(genre);
    const excluded = new Set(exclude);
    // Rotating provider stations, not a checked-in song pool. Try more stations if a batch was played already.
    for (const station of shuffled(stations).slice(0, 6)) {
      const result = await provider(`/radio/${station.id}/tracks?limit=100`, 60000);
      const song = pick(result.data || [], station.genre, excluded);
      if (song) return song;
    }
    throw new Error('No unplayed previews are available in these stations right now. Try another genre or retry later.');
  }
  async function randomSong(genre = 'All', exclude = [], difficulty = 'easy') {
    validateGenre(genre);
    if (!isDifficulty(difficulty)) throw new Error('Choose a supported difficulty.');
    const excluded = new Set(exclude);
    if (difficulty === 'easy') {
      // One chart only: merging multiple Top 100s would no longer be a Top 100 pool.
      const chartId = genre === 'All' ? 0 : GENRES[genre][0];
      const chart = await provider(`/chart/${chartId}/tracks?limit=100`, 300000);
      const song = pick((chart.data || []).slice(0, 100), genre === 'All' ? 'Music' : genre, excluded);
      if (song) return song;
    } else {
      const stations = shuffled(await stationsFor(genre)).slice(0, 3);
      const batches = await Promise.all(stations.map(async station => ({ ...station, tracks: (await provider(`/radio/${station.id}/tracks?limit=100`)).data || [] })));
      for (const batch of batches) {
        const song = pick(batch.tracks, batch.genre, excluded, difficulty);
        if (song) return song;
      }
      // Radio focuses on hits. Explore those artists' wider catalogues for deep cuts.
      const artists = shuffled([...new Map(batches.flatMap(batch => batch.tracks
        .filter(t => Number.isSafeInteger(t.artist?.id) && t.artist.id > 0)
        .map(t => [t.artist.id, { id: t.artist.id, genre: batch.genre }]))).values()]).slice(0, 3);
      const offsets = difficulty === 'impossible' ? [100, 200, 0] : [0, 100, 200];
      for (const index of offsets) {
        const results = await Promise.all(artists.map(async artist => ({ ...artist,
          tracks: (await provider(`/artist/${artist.id}/top?limit=100&index=${index}`, 300000)).data || [] })));
        for (const result of results) {
          const song = pick(result.tracks, result.genre, excluded, difficulty);
          if (song) return song;
        }
      }
    }
    const error = new Error('No unplayed previews are available for this level and genre. Try another level or genre, or retry later.');
    error.code = 'EMPTY_POOL';
    throw error;
  }
  async function dailySong() {
    const date = now().toISOString().slice(0, 10);
    if (!dailyJobs.has(date)) {
      dailyJobs.clear();
      const job = (async () => {
        await mkdir(dataDir, { recursive: true });
        const path = join(dataDir, `${date}.json`);
        try { return JSON.parse(await readFile(path, 'utf8')); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        const recent = [];
        for (let i = 1; i <= 30; i++) {
          const previous = new Date(`${date}T00:00:00Z`); previous.setUTCDate(previous.getUTCDate() - i);
          try { recent.push(JSON.parse(await readFile(join(dataDir, `${previous.toISOString().slice(0, 10)}.json`), 'utf8')).song.id); }
          catch (error) { if (error.code !== 'ENOENT') throw error; }
        }
        const value = { date, song: await stationSong('All', recent) };
        const temporary = `${path}.${randomUUID()}.tmp`;
        await writeFile(temporary, JSON.stringify(value)); await rename(temporary, path);
        return value;
      })();
      dailyJobs.set(date, job);
      job.catch(() => { if (dailyJobs.get(date) === job) dailyJobs.delete(date); });
    }
    return dailyJobs.get(date);
  }
  async function search(query) {
    if (query.trim().length < 2) return [];
    const normalized = query.trim().replace(/\s+/g, ' ').toLowerCase().slice(0, 120);
    const response = await provider(`/search?q=${encodeURIComponent(normalized)}&limit=20`, 300000);
    const songs = (response.data || []).map(t => toSong(t)).filter(Boolean);
    return [...new Map(songs.map(song => [`${song.artist.toLowerCase()}|${song.title.toLowerCase()}`, song])).values()];
  }
  async function preview(id) {
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid song.');
    const data = await provider(`/track/${id}`, 60000);
    if (!data.preview) throw new Error('This song has no preview available in your region.');
    return { preview: data.preview };
  }
  return { randomSong, dailySong, search, preview };
}
