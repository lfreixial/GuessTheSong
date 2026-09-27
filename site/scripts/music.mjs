import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export const GENRES = { Pop: [132], Rock: [152], 'Hip-Hop': [116], Electronic: [106, 113], 'R&B': [165], Country: [84] };
const STATION_NAMES = { Pop: /^(pop|hits|the '80s)$/i, Rock: /rock|ac\/dc/i, 'Hip-Hop': /hip.hop|rap|grime/i, Electronic: /electro|techno|house|edm|dance|dubstep|minimal/i, 'R&B': /r&b|r.n.b|motown/i, Country: /country/i };
export function toSong(track, genre = 'Music') {
  if (!Number.isSafeInteger(track?.id) || !track.title || !track.artist?.name) return null;
  return { id: track.id, title: track.title_short || track.title, artist: track.artist.name, genre,
    cover: track.album?.cover_medium || '', link: `https://www.deezer.com/track/${track.id}` };
}
export function createMusicService({ dataDir, fetcher = fetch, random = Math.random, now = () => new Date() }) {
  const cache = new Map(), dailyJobs = new Map();
  async function provider(path, ttl = 60000) {
    const hit = cache.get(path);
    if (hit && hit.expires > Date.now()) return hit.value;
    const response = await fetcher(`https://api.deezer.com${path}`, { signal: AbortSignal.timeout(12000) });
    if (!response.ok) throw new Error('The music provider is temporarily unavailable. Please retry.');
    const value = await response.json();
    if (value.error) throw new Error('The music provider could not complete this request. Please retry.');
    if (cache.size >= 300) cache.delete(cache.keys().next().value);
    cache.set(path, { value, expires: Date.now() + ttl });
    return value;
  }
  function shuffled(items) { return items.map(value => ({ value, sort: random() })).sort((a, b) => a.sort - b.sort).map(item => item.value); }
  async function randomSong(genre = 'All', exclude = []) {
    if (genre !== 'All' && !GENRES[genre]) throw new Error('Choose a supported genre.');
    const groups = (await provider('/radio/genres', 3600000)).data || [];
    const names = genre === 'All' ? Object.keys(GENRES) : [genre];
    const stations = names.flatMap(name => groups.filter(g => GENRES[name].includes(g.id)).flatMap(g => (g.radios || []).filter(r => STATION_NAMES[name].test(r.title)).map(r => ({ id: r.id, genre: name }))));
    if (!stations.length) throw new Error('No stations are available for this genre right now. Please retry.');
    const excluded = new Set(exclude);
    // Rotating provider stations, not a checked-in song pool. Try more stations if a batch was played already.
    for (const station of shuffled(stations).slice(0, 6)) {
      const result = await provider(`/radio/${station.id}/tracks?limit=100`, 60000);
      const candidates = (result.data || []).filter(t => t.preview && t.readable !== false && !excluded.has(t.id));
      const songs = candidates.map(t => toSong(t, station.genre)).filter(Boolean);
      if (songs.length) return songs[Math.floor(random() * songs.length)];
    }
    throw new Error('No unplayed previews are available in these stations right now. Try another genre or retry later.');
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
        const value = { date, song: await randomSong('All', recent) };
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
    const response = await provider(`/search?q=${encodeURIComponent(query.trim().slice(0, 120))}&limit=20`, 300000);
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
