# GuessTheSong — Needle Drop

The game uses Deezer's live genre stations and song search, with a shared UTC daily song, endless mode, progressively longer clips, and saved browser progress. The complete app is in [`site/`](site/README.md).

## Run with Docker

Install and start Docker Desktop (Linux containers), then run from this repository:

```sh
docker compose up --build -d
```

Open **http://localhost:8080**.

```sh
docker compose logs -f game
docker compose down
```

The named `daily-songs` volume preserves the shared daily selection across restarts and rebuilds. Keep the volume: `docker compose down -v` removes that history. Run a single game container; horizontal scaling needs a shared database for daily selection.

To use a different host port, set `GAME_PORT` before starting Compose (for example, `$env:GAME_PORT=8081` in PowerShell). The default port binds to this computer only. The application needs outbound HTTPS access to Deezer for live music; no API key is required.

The image runs as the non-root `node` user, checks `/healthz`, and executes the automated tests during the build. Daily data and local environment files are excluded from the image.

## Run without Docker

```sh
cd site
npm run dev
```

Play at http://localhost:4173. Requires Node.js 20 or newer; no dependencies to install. Run `npm test` inside `site/` for the test suite.
