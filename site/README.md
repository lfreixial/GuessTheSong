# Needle Drop

Song guessing with a shared UTC daily challenge, six expanding clips, and endless rounds with genre and difficulty choices. Songs come from Deezer's live charts, stations and catalogue; there is no bundled song list.

## Run

For Docker, configure `.env` as described in the root README, then run `docker compose up --build -d` from the repository root. The game opens at http://localhost:8080 and Grafana at http://localhost:3000; monitoring starts with the app. Compose preserves the daily song in a named volume. See the root README for Docker commands.

Node.js 20 or newer is required. No dependencies need installing.

```sh
npm run dev
npm test
```

Play at http://localhost:4173. The Node server must stay running: serving only `dist/` on a static host no longer supports this version.

## Multiplayer party lobbies

Open **Party lobby** from the session picker (or `/multiplayer.html`). Enter your name and create a lobby to get a six-character code. Friends open the same server, enter their names and the code, then press **Ready**. An invite link pre-fills the code. Names must be unique in a room; no account is needed.

- **Host settings:** 1–20 tracks, all five difficulty levels, genre, 3/6/10 guesses, 2–16 player capacity, expanding clips or the full preview, and optional early finish once every connected player has guessed correctly or used their guesses. Changing settings resets the other players' ready checks. Hosts can remove seats before starting.
- **Shared rounds:** the server chooses one track per round, refreshes its preview, gives everyone a five-second countdown, then starts a 60-second timer. Expanding clips unlock 1/2/4/7/11/16 seconds at 10-second intervals. Players can also press **Hear more** anytime while still guessing to unlock and play the next longer clip immediately, just for themselves. Each manual unlock reduces that player's time-based score by 20% for the rest of that round. Skips do not consume guesses or change anyone else's clip, score, or timer. The button shows the penalty and next clip length; the current potential score is shown alongside it. Personal unlocks and penalties survive a refresh and reset for each new track. Full-preview mode allows up to 30 seconds per playback and has no skip button. Browsers may require pressing Play; the shared timer continues. Correct players wait for the reveal; others keep guessing.
- **Scoring:** the time-based score is `max(100, 1000 - floor(elapsedMilliseconds / 60000 * 900))`. The awarded score is `floor(timeBasedScore * 0.8 ** paidSkips)`. Without skips, 10 seconds earns 850 and 30 seconds earns 550. At 10 seconds, one skip earns 680 and two skips earn 544. Automatic timed unlocks incur no extra penalty; repeated requests for an already-unlocked clip are not charged again. The server tracks skips and uses the time it receives the guess, never client-supplied penalties, times or scores. Wrong answers consume a guess but do not subtract points. One second is required between guesses; duplicate guesses are rejected. At the deadline, no further guesses or skips are accepted.
- **Results:** an eight-second answer reveal and live leaderboard follow each round. The next track starts automatically; the host may advance the reveal early. Final standings support ties. The host can return everyone to the same lobby for a rematch with fresh settings and scores.
- **Reconnects:** each tab saves its private seat token in session storage. Refreshing the tab restores the same identity, score and guesses. Presence expires after 20 seconds without contact; an absent host is replaced by a connected player after 45 seconds. Explicitly leaving releases the seat immediately. New players can join only while the lobby is waiting. A removed player must join again with a new seat.
- **Failure recovery:** song-provider failures pause at a retry screen before starting the next timer. The host can retry, or return to the lobby (resetting the match) to choose other settings. A failed load consumes no round or points. Inactive rooms expire after two hours; empty rooms are deleted immediately.

All players need the **same reachable Node server URL**, then the join code. For local-network play without Docker, run `HOST=0.0.0.0 npm run dev` and open `http://YOUR-COMPUTER-IP:4173` from each device. For Docker's `GAME_BIND` setting and internet hosting, see the root README. Keep one Node process behind your shared HTTPS address. Lobbies use in-memory state: **restarting or deploying the server ends active lobbies**. Multiple replicas need shared state and coordination before scaling. Daily persistence is separate and unaffected.

Lobby updates wait for a state change, returning a heartbeat after 15 seconds when nothing changes. Bursts of changes are grouped over 50 ms. Local countdowns and clip unlocks still update smoothly against the server clock; the intentional server wait is excluded from clock synchronization. Disconnected clients retry with backoff, and leaving cancels the pending update. Answer metadata is withheld until reveal and guesses are checked against server-fetched search results. This remains a casual party game: the browser receives the audio preview, so it is not designed as competitive anti-cheat.

### Lobby API

- `POST /api/lobbies` with `{ "name": "Alex", "settings": { "tracks": 5, "difficulty": "easy" } }` creates a room; `POST /api/lobbies/CODE/join` with `{ "name": "Sam" }` joins it. Both return `{ token, state }`.
- `GET /api/lobbies/CODE` returns a player-specific snapshot. Send the private token in the `X-Player-Token` header for this and the remaining routes; tokens are never included in other players' state or invite links.
- `GET /api/lobbies/CODE?after=VERSION` waits until the room changes or 15 seconds pass. Versions advance on state changes, not reads. Responses include `waitMs` for clock synchronization; heartbeat snapshots may have the same version. At most two waiting requests are allowed per seat. Closed connections release their waiters, and removed seats or expired rooms terminate pending requests.
- `GET /api/lobbies/CODE/search?q=title` returns provider-verified choices during a round.
- `POST /api/lobbies/CODE/action` accepts `ready`, `guess`, `hear-more`, `leave`, or host-only `settings`, `start`, `next`, `retry`, `reset`, and `kick`. Guesses carry the current `roundId` and a searched `songId`; obsolete round IDs are rejected. `hear-more` carries the current `roundId` and the next clip `step` (1–5). Only one step can be purchased at a time; retries for the same step are idempotent. Personal snapshots include `round.unlockedStep` and `round.skips`. Settings are validated on the server. POST bodies must be JSON and at most 4 KB.

The implementation is in `scripts/lobbies.mjs`, `scripts/lobby-api.mjs`, and `dist/multiplayer.*`. Tests cover the room state machine, private snapshots, scoring deadlines, host privileges, failure/reconnect paths, request validation, and a complete two-player flow through both page controllers and API routes.

### Deployment and performance

The app supports 200 rooms with up to 16 players each; those are configuration caps, not a measured production capacity. Updates reuse a cached room leaderboard until something changes. Pending updates use open connections, so set your reverse proxy's upstream response timeout above 25 seconds.

Create/join requests are limited to 30 per minute per client IP. When using a reverse proxy, set `TRUSTED_PROXY_IPS` to the comma-separated **exact IP addresses** of proxies that can connect directly or as trusted forwarding hops (for example, `127.0.0.1,::1` for a host-local proxy). Docker Compose forwards this variable. The app walks `X-Forwarded-For` from the trusted server-facing end and stops at the first untrusted address. Forwarding headers from other peers are ignored. Leave the variable empty when no proxy is used; do not list end-user addresses as trusted proxies.

Music requests reuse the same in-flight lookup when several players or rooms ask for identical data. Search keys normalize case and whitespace. Successful responses use a bounded 300-entry cache that retains recently used entries. At most 12 Deezer requests run at once, with a maximum of 100 queued requests; queued requests time out after five seconds and active fetches after 12 seconds. Failed lookups release their slots and can be retried. These limits protect the app during bursts; they do not override Deezer's own limits or guarantee availability.

Run the local HTTP benchmark with synthetic music:

```sh
npm run benchmark -- wait 320 16
npm run benchmark -- poll 320 16
```

The benchmark opens a local ephemeral port, creates 20 rooms for 320 players, starts rounds, and has half the players search and guess. It never contacts Deezer or a deployed site. The `poll` mode reproduces one-second client polling using the current server; it does not undo other server optimizations.

Observed on the development machine, with 320 simulated players over 16 seconds:

| Measurement | Before optimization | After optimization |
| --- | ---: | ---: |
| HTTP requests started | 5,440 | 2,324 |
| HTTP responses completed | 5,440 | 2,004 |
| Response bodies | 13.07 MiB | 4.58 MiB |
| Combined client/server CPU time | 2.06 seconds | 1.28 seconds |
| Combined peak RSS | 174 MiB | 202 MiB |
| p95 request latency excluding intentional wait | 120 ms | 345 ms |
| Errors | 0 | 0 |
| Upstream calls for 100 simultaneous identical searches | 100 | 1 |

These are single local runs, not a capacity guarantee. Client and server share one process, startup and synchronized bursts are included, and unfinished waiting requests are cancelled at the end. Traffic and CPU fell; retained connections increased measured memory use and burst latency in this run. Real-world capacity still depends on host resources, connections, network latency, player activity, and the music provider. Active rooms still require one server process and are lost on restart; shared state is needed before horizontal scaling.

## Live music

- In Endless mode, pick a genre and a level. Easy is the default; the last successfully loaded level is saved in this browser. Changing either selection starts a fresh round. Returning to the daily challenge preserves daily progress. All levels use the same six guesses and 1/2/4/7/11/16-second clips.

| Level | Song selection |
| --- | --- |
| Easy | Playable songs in Deezer's current Top 100 chart: overall for All genres, or the selected genre's chart. Electronic uses the Electro chart. |
| Medium | Popular favourites: Deezer popularity score of 500,000 or higher. |
| Hard | Lesser-known tracks: score from 200,000 up to 499,999. |
| Expert | Deep cuts: score from 100,000 up to 199,999. |
| Impossible | Obscure tracks: score from 0 up to 99,999. |

These scores are Deezer's `rank` field, where higher means more popular, **not** numbered chart positions. They are a difficulty heuristic, not a guarantee of recognition; album editions and changing listening trends affect scores. Only Easy promises a Top 100 pool; the other levels do not claim global Top 500/1,000 lists.

- Beyond Easy, the server samples up to three genre stations and filters by popularity. When necessary, it explores up to three station artists' top-track pages (up to 300 tracks per artist). Genre follows the source station; an artist's catalogue may cross genres. Unranked tracks are excluded from these levels. Station batches are cached for one minute; charts and artist batches for five minutes.
- The most recent 500 track IDs in the tab are excluded across levels. Availability depends on Deezer and region; small pools, particularly Easy, can run out. A depleted pool gives a retry/change-level message and never silently expands to another difficulty or repeats an excluded ID. This does not promise every song in the world or endlessly unique tracks.
- Song search queries Deezer's wider catalogue with a short debounce. Matching album/remaster copies by title and artist are accepted.
- Preview URLs are refreshed on the server and audio is streamed directly from Deezer. No music files are copied into the project. Some tracks have explicit lyrics; clips need not be song intros.
- Genre-specific station labels are used instead of broad mood stations. Genre classification remains controlled by the provider.

## Shared daily song

The first request each UTC day selects a song and saves it atomically in `.data/daily/YYYY-MM-DD.json`. All requests to this server use the saved selection, including after restart. Concurrent requests share one selection operation; songs from the previous 30 saved days are excluded. Provider errors never silently switch today's answer.

Daily progress remains local to each browser. The new schedule uses a v2 storage key, so old fixed-catalogue results do not carry over.

For deployment, run **one Node server** with a persistent disk at `NEEDLE_DROP_DATA_DIR` (default `.data/daily`). Keep that directory through deploys and restarts. Multiple independent server instances require a shared transactional database before scaling; separate ephemeral disks would create different daily answers. Configure `HOST=0.0.0.0` when your host requires external binding and `PORT` as needed. The retained `.openai/hosting.json` records the earlier unpublished Site registration, not a deployment configuration for this Node backend.

## APIs and files

`GET /api/daily`, `/api/random?genre=Rock&difficulty=hard&exclude=123,456`, `/api/search?q=artist`, and `/api/track/123` are implemented in `scripts/serve.mjs`, using `scripts/music.mjs`. Difficulty accepts `easy` (default), `medium`, `hard`, `expert`, or `impossible`; invalid genre or difficulty values return 400. Requests have timeouts and a bounded cache. The interface is in `dist/`; game rules are in `dist/game.js` and level definitions in `dist/difficulties.js`. Tests cover daily persistence/concurrency, UTC rollover, failure recovery, chart limits, popularity bands, catalogue expansion, live search, guessing, and level-switching state and retries.

Solo answers are inspectable in the client; multiplayer withholds answer metadata until reveal and validates scores on the server. The app does not include competitive anti-cheat or accounts. Confirm music-provider permissions for a public or commercial release.

### Ready updates, passing songs, and solo presence

Waiting rooms fetch a fresh snapshot every second, while active games keep efficient long polling. Returning to the tab cancels a stalled poll and requests fresh state; the Start control explains whether it is waiting for players, saved settings, or a connection. Keep `/api/` uncached at the reverse proxy and run one app instance because lobbies are in memory.

Use **Skip song** to give up immediately. Solo reveals the answer and offers the next track (daily skips persist as a loss). Multiplayer passes only your seat for zero points and prevents further guesses on that track. With early finish enabled, the last player finishing triggers the reveal; otherwise the host’s fixed timer remains in effect. **Hear more** still unlocks a longer clip.

Solo pages send anonymous presence heartbeats every 15 seconds while visible. Grafana shows solo, multiplayer and combined active counts and session/join totals. Solo activity expires after 45 seconds without a heartbeat; a token is reused across refreshes until 30 minutes of inactivity or a server restart. Counts are sessions, not unique people. Existing monitoring totals are automatically upgraded.
