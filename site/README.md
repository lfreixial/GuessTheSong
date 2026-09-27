# Needle Drop

Song guessing with a shared UTC daily challenge, six expanding clips, and endless genre-based rounds. Songs come from Deezer's live stations and catalogue; there is no bundled song list.

## Run

For Docker, run `docker compose up --build -d` from the repository root and visit http://localhost:8080. Compose preserves the daily song in a named volume. See the root README for Docker commands.

Node.js 20 or newer is required. No dependencies need installing.

```sh
npm run dev
npm test
```

Play at http://localhost:4173. The Node server must stay running: serving only `dist/` on a static host no longer supports this version.

## Live music

- Endless mode selects a genre-specific Deezer station, fetches its current preview-enabled songs, and randomly chooses a track. Station batches are cached for one minute. The most recent 500 track IDs in the tab are excluded. Availability depends on the provider's stations and region; this does not promise every song in the world or endlessly unique tracks. A depleted station pool gives a retry error rather than recycling the old 60-song collection.
- Song search queries Deezer's wider catalogue with a short debounce. Matching album/remaster copies by title and artist are accepted.
- Preview URLs are refreshed on the server and audio is streamed directly from Deezer. No music files are copied into the project. Some tracks have explicit lyrics; clips need not be song intros.
- Genre-specific station labels are used instead of broad mood stations. Genre classification remains controlled by the provider.

## Shared daily song

The first request each UTC day selects a song and saves it atomically in `.data/daily/YYYY-MM-DD.json`. All requests to this server use the saved selection, including after restart. Concurrent requests share one selection operation; songs from the previous 30 saved days are excluded. Provider errors never silently switch today's answer.

Daily progress remains local to each browser. The new schedule uses a v2 storage key, so old fixed-catalogue results do not carry over.

For deployment, run **one Node server** with a persistent disk at `NEEDLE_DROP_DATA_DIR` (default `.data/daily`). Keep that directory through deploys and restarts. Multiple independent server instances require a shared transactional database before scaling; separate ephemeral disks would create different daily answers. Configure `HOST=0.0.0.0` when your host requires external binding and `PORT` as needed. The retained `.openai/hosting.json` records the earlier unpublished Site registration, not a deployment configuration for this Node backend.

## APIs and files

`GET /api/daily`, `/api/random?genre=Rock&exclude=123,456`, `/api/search?q=artist`, and `/api/track/123` are implemented in `scripts/serve.mjs`, using `scripts/music.mjs`. Requests have timeouts and a bounded cache. The interface is in `dist/`; game rules are in `dist/game.js`. Tests cover daily persistence/concurrency, UTC rollover, failure recovery, station filtering, live search and guessing.

This is a casual client-side guessing game; answers are inspectable. It does not include competitive anti-cheat or account synchronization. Confirm music-provider permissions for a public or commercial release.
