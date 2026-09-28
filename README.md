# GuessTheSong — Needle Drop

The game uses Deezer's live charts, genre stations and song search, with a shared UTC daily song, endless mode, progressively longer clips, and saved browser progress. In Endless rotation, choose a genre and one of five levels: **Easy** (Top 100), **Medium** (popular favourites), **Hard** (lesser-known tracks), **Expert** (deep cuts), or **Impossible** (obscure tracks). The complete app is in [`site/`](site/README.md).

**Party lobby** lets 2–16 people play together. Create a lobby and share its six-character code or invite link. Everyone hears the same tracks, with a shared 60-second timer and more points for faster correct guesses. Hosts choose the number of tracks, level, genre, guess limit, player limit, and listening mode. Ready checks, a live leaderboard, automatic answer reveals, reconnects, host transfer, and rematches are included.

In expanding-clip mode, each player can press **Hear more** to unlock the next longer clip immediately. Each skip reduces their time-based points by 20%, without spending a guess or affecting anyone else.

**Skip song** reveals the answer immediately in solo mode (a daily skip saves a loss). In multiplayer, it gives up your answer for zero points while others keep guessing. With the host’s early-finish setting enabled, the round reveals as soon as all connected players have answered, skipped, or run out of guesses. **Hear more** remains a separate control for longer clips.

## Run with Docker

Install and start Docker Desktop (Linux containers). On a fresh checkout, copy `.env.example` to `.env` and set `GRAFANA_ADMIN_PASSWORD`, or run `node scripts/monitoring.mjs init` to generate one. Then run from this repository:

```sh
docker compose up --build -d
```

Open the game at **http://localhost:8080** and Grafana at **http://localhost:3000**. The app, Grafana, Prometheus, Loki and Alloy start together.

```sh
docker compose logs -f game
docker compose down
```

The named `daily-songs` volume preserves the shared daily selection across restarts and rebuilds. Keep the volume: `docker compose down -v` removes that history. Run a single game container; horizontal scaling needs a shared database for daily selection.

To use a different host port, set `GAME_PORT` before starting Compose (for example, `$env:GAME_PORT=8081` in PowerShell). The default port binds to this computer only. The application needs outbound HTTPS access to Deezer for live music; no API key is required.

The image runs as the non-root `node` user, checks `/healthz`, and executes the automated tests during the build. Daily data and local environment files are excluded from the image.

## Play with friends

Everyone must open the **same server address**, then select **Party lobby** and enter the join code. A code identifies a lobby on that server; it does not connect separate installations.

For devices on your local network, expose Docker's port to the network:

```sh
GAME_BIND=0.0.0.0 docker compose up --build -d
```

In PowerShell, use `$env:GAME_BIND="0.0.0.0"` followed by `docker compose up --build -d`. Friends open `http://YOUR-COMPUTER-IP:8080` in their browser. Open that address yourself before copying an invite link; `localhost` points to each player's own device. The host firewall must allow the game port.

For friends outside your network, deploy this Node app behind a shared HTTPS address. Run one server instance: active lobbies live in memory and close when the server restarts. Daily songs still persist in the Docker volume. No external multiplayer service or accounts are required.

Waiting rooms refresh once a second so Ready changes reach the host promptly; active games wait for changes, and simultaneous music requests share cached lookups. For reverse-proxy IP configuration and measured performance results, see [deployment and performance](site/README.md#deployment-and-performance).

## Monitoring

**Grafana, Prometheus, Loki and Alloy start automatically with `docker compose up --build -d`.** Open http://localhost:3000/d/needle-drop and sign in as `admin` with `GRAFANA_ADMIN_PASSWORD` from `.env`.

The dashboard includes app traffic, connected solo and multiplayer players, persistent session/join/lobby totals, running games, CPU, memory, errors and searchable JSON logs. Metrics and log backends stay private. Starting the stack rebuilds the app and closes active lobbies; deploy between games. See [monitoring setup and metric definitions](monitoring/README.md).

## Run without Docker

```sh
cd site
npm run dev
```

Play at http://localhost:4173. Requires Node.js 20 or newer; no dependencies to install. Run `npm test` inside `site/` for the test suite.
