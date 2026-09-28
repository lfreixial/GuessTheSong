# App monitoring

This adds Grafana dashboards, Prometheus metrics, and searchable application logs collected by Alloy into Loki. It runs alongside the existing single game instance. No Docker socket or host filesystem access is given to the collector.

## Start

Grafana, Prometheus, Loki and Alloy are part of the default `compose.yaml`. From the repository root:

```sh
docker compose up --build -d
```

On a fresh checkout, first configure `GRAFANA_ADMIN_PASSWORD` in `.env`: either copy `.env.example` to `.env` and choose a strong password, or generate one with `node scripts/monitoring.mjs init` (requires Node 20+). The initializer preserves existing settings and can migrate the earlier `.env.monitoring` file. Normal startup only requires Docker.

This builds/recreates the game container and starts the four monitoring services together. **Recreating the game closes active lobbies**, so deploy between games. Daily songs and aggregate monitoring totals remain in the existing `daily-songs` volume.

Open **http://localhost:3000/d/needle-drop**. Sign in as **admin**, using `GRAFANA_ADMIN_PASSWORD` from **`.env`** in the repository root. The generated file has owner-only permissions and is ignored by Git. Grafana uses the password on first initialization; changing this file later does not reset an existing Grafana account password.

Grafana binds to localhost by default. For a remote server, use an SSH tunnel (`ssh -L 3000:127.0.0.1:3000 user@server`) and open the same local URL. Alternatively put Grafana behind your authenticated HTTPS reverse proxy. Set `GRAFANA_BIND` / `GRAFANA_PORT` or existing `GAME_BIND` / `GAME_PORT` in the shell or `.env` when needed. Compose loads `.env` automatically; `.env.monitoring` is only used by the initializer for migration.

Prometheus, Loki, Alloy, and the app's metrics listener have **no published host ports**. Do not route the public game domain to port 9464. There is no `/metrics` endpoint on the public game listener.

```sh
docker compose ps
docker compose logs --tail 100 -f
docker compose config --quiet         # Validate without printing secrets
docker compose down                   # Stops the game and monitoring; keeps volumes
node scripts/monitoring.mjs validate   # Optional: promtool, Loki and Alloy config checks
```

The optional Node helper's `up`, `down`, `ps` and `logs` commands use this same default stack. No extra Compose file or separate monitoring startup is needed.

Use the same Compose project name/path as your existing app to reuse its data volume. Avoid `down -v`: it deletes daily history, aggregate totals, metrics, logs and Grafana settings.

## Dashboard and definitions

The provisioned **Needle Drop · App monitoring** dashboard is also the Grafana home page. Give it 15 seconds for the first scrape, and about a minute for useful rates. Use the time picker for period traffic and the log-level filter for logs.

| Measurement | Meaning |
| --- | --- |
| Connected players | Combined active multiplayer seats (20-second timeout) and visible solo sessions (45-second timeout), with separate panels for each mode. |
| Play sessions / joins, all time | Multiplayer seat joins plus anonymous solo session starts, not unique people. Both totals also have separate panels. |
| Solo sessions | A visible solo page sends a heartbeat every 15 seconds after loading a song. Its random token stays in session storage across refreshes. A session expires after 30 minutes without heartbeats or a server restart. Hidden/closed tabs stop counting as active within 45 seconds. No names or fingerprints are collected. |
| Multiplayer joins | Successful new seats including hosts. Reconnecting the same seat does not add another join. |
| Lobbies created, all time | Successful lobby creations since monitoring was installed. |
| Current lobbies | All unexpired rooms, including waiting and finished rooms. Inactive rooms expire after two hours. |
| Running games | Rooms loading a track, counting down, playing, or revealing an answer. Waiting, finished, and load-error rooms are excluded. |
| Traffic | Response body bytes submitted by the app and request body bytes consumed by it. Aborted responses can include unsent bytes. These are payload estimates, **not your ISP's billed network usage**. |
| Response latency | A histogram; the main latency panel excludes intentional 15-second lobby waits and health checks. |
| CPU and RAM | The Node app process, not the entire host or the monitoring containers. CPU value 1 means one occupied core. |

Music streams directly from Deezer's CDN to players, so it does **not** consume your server's upload bandwidth and is not counted here. The traffic panels also exclude HTTP headers, TLS/TCP overhead, reverse-proxy compression, and the server's upstream Deezer API requests. For exact host/interface or per-container network totals, add your existing host/container exporter; this stack does not require privileged exporters.

Additional panels cover game starts/completions, guesses, longer-clip skips, songs passed, track-load failures, HTTP errors, open requests, and monitoring write failures. HTTP 499 indicates an aborted client request. Empty error/alert panels mean no matching events have been recorded. Period traffic uses Prometheus `increase`, so it is sampled and extrapolated; allow at least two scrapes and expect approximate values around restarts.

Totals start at installation, with no retroactive historical data. Solo totals begin when this update is installed. Existing multiplayer totals are migrated automatically. The combined count is not deduplicated across modes, tabs or devices; it measures play sessions rather than unique people. Multiplayer event counters persist to `/data/monitoring/totals.json`, with asynchronous atomic saves every second and a flush on graceful shutdown. An abrupt power loss can lose the latest unsaved second or more if the disk is stalled. A malformed totals file stops startup rather than silently resetting your history; restore it from backup. Run one writer/game instance per data volume, as required by the app's in-memory lobbies.

## Logs, retention and resources

Application events and HTTP request summaries are JSON. Logs omit names, room codes, session tokens, IP addresses, request bodies, query strings, and raw exception messages. Routes are normalized (`/api/lobbies/:code/action`) to keep metrics cardinality bounded. Successful health checks are excluded from logs. Raw runtime crashes and monitoring-service output remain available through `docker compose logs` / the helper's `logs` command; Loki collects the structured app files.

Explore logs using **Needle Drop logs**:

```logql
{app="needle-drop"}
{app="needle-drop", level="error"}
{app="needle-drop"} | json | event="http_request" | status >= 500
```

- Prometheus keeps up to **15 days**, or **1 GB** of historical blocks, whichever limit is reached first. Head/WAL data adds disk overhead.
- Loki deletes log data after **7 days**, asynchronously. This is a time limit, not a disk-size quota; reserve disk space according to traffic.
- Local app logs rotate around **10 MiB** per file, retaining six files (up to roughly 66 MiB including bounded write batches). The queue is capped at 1 MiB; write failures/dropped lines appear as metrics and alert rules. Collection outages longer than this local buffer can lose logs.
- Docker service logs rotate at **10 MB × 3 files per service**. The game writes both stdout summaries and collector files.
- Grafana, Prometheus, Loki and Alloy have combined container RAM limits of **2.25 GiB**. These are ceilings, not measured consumption or reservations. Measure real usage on your server before changing them.

Persistent volumes hold Grafana settings, Prometheus history, Loki logs and Alloy read positions. Back these up together with `daily-songs` and keep `.env` private. The pinned versions are Grafana 13.2.2, Prometheus 3.13.3 LTS, Loki 3.7.0 and Alloy 1.20.0; review updates periodically.

Prometheus evaluates rules for app unavailability, frequent server errors, monitoring write failures, and lobby capacity above 90%. Pending/firing rules appear on the dashboard. **Email, Slack and other outbound notifications are not configured.**

## Verify after deployment

1. Run `node scripts/monitoring.mjs validate` and `docker compose ps`.
2. Open Grafana. **App up** should be 1 after the first scrape.
3. Create a lobby and join from a second browser. Connected players should increase by two, current lobbies by one, and persistent totals accordingly.
4. Start a game. Running games should become one; completion should move that lobby to the finished phase.
5. Find `lobby_created`, `player_joined`, `game_started` and `http_request` events in the logs panel.
6. Open the solo page in another browser. Solo players should increase after the song loads. Refresh the page: the same session must not add another total. Hide/close the tab and wait 45 seconds for active presence to expire.
7. Check the traffic rate while opening the app; music download bandwidth is intentionally absent.

For native development, set `METRICS_PORT=9464` to enable the private listener (localhost by default), and optionally `NEEDLE_DROP_LOG_DIR` to collect JSON files. Without `METRICS_PORT`, no metrics listener is started. JSON stdout logs and persisted multiplayer totals still work.

The app metrics and JSON stdout can also be used with an existing Kubernetes monitoring stack. This Compose configuration does not deploy Kubernetes resources or make in-memory lobbies safe for multiple replicas.

Configuration references: [Grafana provisioning](https://grafana.com/docs/grafana/latest/administration/provisioning/), [Prometheus exposition format](https://prometheus.io/docs/instrumenting/exposition_formats/), [Loki Docker setup](https://grafana.com/docs/loki/latest/setup/install/docker/), [Alloy file collection](https://grafana.com/docs/alloy/latest/reference/components/loki/loki.source.file/).
