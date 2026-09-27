import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { createMusicService, GENRES } from './music.mjs';
const root = resolve('dist');
const music = createMusicService({ dataDir: resolve(process.env.NEEDLE_DROP_DATA_DIR || '.data/daily') });
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end('{"status":"ok"}'); return; }
    if (url.pathname.startsWith('/api/')) {
      const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
      if (req.method !== 'GET') { json(405, { error: 'Method not allowed.' }); return; }
      try {
        if (url.pathname === '/api/daily') { json(200, await music.dailySong()); return; }
        if (url.pathname === '/api/random') {
          const genre = url.searchParams.get('genre') || 'All';
          if (genre !== 'All' && !GENRES[genre]) { json(400, { error: 'Choose a supported genre.' }); return; }
          const exclude = (url.searchParams.get('exclude') || '').split(',').slice(-500).map(Number).filter(Number.isSafeInteger);
          json(200, { song: await music.randomSong(genre, exclude) }); return;
        }
        if (url.pathname === '/api/search') { json(200, { songs: await music.search(url.searchParams.get('q') || '') }); return; }
        const match = url.pathname.match(/^\/api\/track\/(\d+)$/);
        if (match) { json(200, await music.preview(Number(match[1]))); return; }
        json(404, { error: 'Not found.' });
      } catch (error) { console.error('Music request failed:', error.message); json(503, { error: 'Music could not be loaded. Please retry in a moment.' }); }
      return;
    }
    const path = resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname));
    if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
    const body = await readFile(path); res.writeHead(200, { 'Content-Type': types[extname(path)] || 'application/octet-stream', 'Cache-Control': 'no-store' }).end(body);
  } catch { res.writeHead(404).end('Not found'); }
}).listen(Number(process.env.PORT || 4173), process.env.HOST || '127.0.0.1', () => console.log(`Needle Drop is ready at http://localhost:${process.env.PORT || 4173}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 15000).unref();
});
