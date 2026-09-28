import { mkdir, readFile, writeFile, rename, readdir, unlink, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const LEGACY_EVENTS = ['lobby_created', 'player_joined', 'game_started', 'game_finished', 'round_finished', 'track_load_failed', 'hear_more', 'guess_correct', 'guess_incorrect'];
const EVENTS = [...LEGACY_EVENTS, 'song_passed', 'solo_session_started'];
const BUCKETS = [0.005, 0.025, 0.1, 0.5, 1, 5, 20, Infinity];
const METHODS = new Set(['GET', 'POST', 'HEAD', 'OPTIONS', 'PUT', 'PATCH', 'DELETE']);
export function requestRoute(raw) {
  try {
    const url = new URL(raw, 'http://localhost'), path = url.pathname;
    if (['/healthz', '/api/daily', '/api/random', '/api/search', '/api/solo/presence'].includes(path)) return path;
    if (/^\/api\/track\/\d+$/.test(path)) return '/api/track/:id';
    if (path === '/api/lobbies') return path;
    const match = path.match(/^\/api\/lobbies\/[A-Za-z0-9]{6}(?:\/(join|action|search))?$/);
    if (match) return `/api/lobbies/:code/${match[1] || (url.searchParams.has('after') ? 'wait' : 'state')}`;
    if (['/', '/index.html', '/styles.css', '/app.js'].includes(path) || /^\/[a-z-]+\.(js|css)$/.test(path)) return 'static';
  } catch { /* Invalid URLs share one bounded label. */ }
  return 'other';
}

// No URLs, query strings, headers, names, tokens or request bodies are recorded.
// File writes are batched, bounded and asynchronous so a failed collector cannot block play.
export async function createMonitoring({ dataDir, logDir, stdout = process.stdout, maxLogBytes = 10 * 1024 * 1024, maxLogFiles = 6 } = {}) {
  const startedAt = Math.floor(Date.now() / 1000 - process.uptime());
  const totals = Object.fromEntries(EVENTS.map(event => [event, 0]));
  let dirty = false, persistenceErrors = 0, logErrors = 0, droppedLogs = 0, closed = false;
  if (dataDir) {
    await mkdir(dataDir, { recursive: true });
    try {
      const saved = JSON.parse(await readFile(join(dataDir, 'totals.json'), 'utf8'));
      const required = saved.version === 1 ? LEGACY_EVENTS : EVENTS;
      if (![1, 2].includes(saved.version) || required.some(key => !Number.isSafeInteger(saved.totals?.[key]) || saved.totals[key] < 0)
        || EVENTS.some(key => saved.totals?.[key] !== undefined && (!Number.isSafeInteger(saved.totals[key]) || saved.totals[key] < 0))) throw new Error('Invalid monitoring totals');
      for (const key of EVENTS) if (saved.totals[key] !== undefined) totals[key] = saved.totals[key];
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  let queue = [], queuedBytes = 0, file, fileBytes = 0, flushJob;
  async function newLogFile() {
    file = `app-${Date.now()}-${randomUUID()}.jsonl`; fileBytes = 0;
    await writeFile(join(logDir, file), '', { mode: 0o644 });
    const files = (await readdir(logDir)).filter(name => name !== file && /^app-\d+-[a-f0-9-]+\.jsonl$/.test(name)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - maxLogFiles + 1))) await unlink(join(logDir, old));
  }
  if (logDir) { await mkdir(logDir, { recursive: true }); await newLogFile(); }
  // All fields below come from fixed internal events or normalized metrics, never error.message.
  function log(level, event, fields = {}) {
    if (closed) return;
    const safe = {};
    for (const key of ['route', 'method', 'status', 'duration_ms', 'response_bytes', 'request_bytes', 'aborted']) if (Object.hasOwn(fields, key)) safe[key] = fields[key];
    const line = JSON.stringify({ time: new Date().toISOString(), level, event, ...safe }) + '\n';
    if (stdout && stdout.writableLength < 1024 * 1024) stdout.write(line);
    if (logDir) {
      const size = Buffer.byteLength(line);
      if (queuedBytes + size > 1024 * 1024) { droppedLogs++; return; }
      queue.push(line); queuedBytes += size;
    }
  }
  async function flush() {
    if (flushJob) { await flushJob; return flush(); }
    flushJob = (async () => {
      if (queue.length) {
        const lines = queue.join(''); queue = []; queuedBytes = 0;
        try {
          if (fileBytes >= maxLogBytes) await newLogFile();
          await appendFile(join(logDir, file), lines); fileBytes += Buffer.byteLength(lines);
        } catch { logErrors++; droppedLogs += lines.split('\n').length - 1; }
      }
      if (dirty && dataDir) {
        dirty = false;
        try {
          await writeFile(join(dataDir, 'totals.json.tmp'), JSON.stringify({ version: 2, totals }));
          await rename(join(dataDir, 'totals.json.tmp'), join(dataDir, 'totals.json'));
        } catch { persistenceErrors++; dirty = true; }
      }
    })();
    try { await flushJob; } finally { flushJob = undefined; }
  }
  const timer = setInterval(() => { void flush(); }, 1000); timer.unref();
  function event(name) {
    if (!EVENTS.includes(name)) return;
    totals[name]++; dirty = true;
    log(name === 'track_load_failed' ? 'error' : 'info', name);
  }
  const requests = new Map();
  let inFlight = 0;
  function observeHttp(req, res) {
    const route = requestRoute(req.url), method = METHODS.has(req.method) ? req.method : 'OTHER';
    const started = performance.now();
    let sent = 0, received = 0, recorded = false;
    inFlight++;
    // Count bodies when consumed without switching the request into flowing mode.
    const emit = req.emit;
    req.emit = function (name, ...args) {
      if (name === 'data') received += Buffer.byteLength(args[0]);
      return emit.call(this, name, ...args);
    };
    const bytes = (chunk, encoding) => typeof chunk === 'string' ? Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding : 'utf8') : chunk?.byteLength || 0;
    const write = res.write, end = res.end;
    res.write = function (chunk, encoding, ...args) { sent += bytes(chunk, encoding); return write.call(this, chunk, encoding, ...args); };
    res.end = function (chunk, encoding, ...args) { sent += bytes(chunk, encoding); return end.call(this, chunk, encoding, ...args); };
    const record = aborted => {
      if (recorded) return; recorded = true; inFlight--;
      const status = aborted ? 499 : res.statusCode, seconds = (performance.now() - started) / 1000;
      const labels = `route=${JSON.stringify(route)},method=${JSON.stringify(method)},status="${status}"`;
      if (!requests.has(labels)) requests.set(labels, { count: 0, sent: 0, received: 0, seconds: 0, buckets: BUCKETS.map(() => 0) });
      const entry = requests.get(labels);
      entry.count++; entry.sent += sent; entry.received += received; entry.seconds += seconds;
      BUCKETS.forEach((bound, index) => { if (seconds <= bound) entry.buckets[index]++; });
      // Successful health checks add metrics but no repetitive logs.
      if (route !== '/healthz' || status >= 400) log(status >= 500 ? 'error' : status >= 400 ? 'warn' : 'info', 'http_request', {
        route, method, status, duration_ms: Math.round(seconds * 1000), response_bytes: sent, request_bytes: received, aborted,
      });
    };
    res.once('finish', () => record(false)); res.once('close', () => record(!res.writableFinished));
  }
  let snapshot = () => ({ connectedPlayers: 0, seats: 0, phases: {}, running: 0, lobbies: 0 });
  function render() {
    const lines = [], gauge = (name, help, value) => { lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`, `${name} ${value}`); };
    lines.push('# HELP needle_events_total Persisted play events; player_joined counts multiplayer seats and solo_session_started counts anonymous solo sessions, not unique people.', '# TYPE needle_events_total counter');
    for (const name of EVENTS) lines.push(`needle_events_total{event="${name}"} ${totals[name]}`);
    const state = snapshot();
    gauge('needle_players_connected', 'Connected multiplayer seats plus active solo sessions; not deduplicated across modes.', state.connectedPlayers + (state.soloPlayers || 0));
    gauge('needle_multiplayer_players_connected', 'Multiplayer seats active within the last 20 seconds.', state.connectedPlayers);
    gauge('needle_solo_players_connected', 'Visible solo sessions with a heartbeat in the last 45 seconds.', state.soloPlayers || 0);
    gauge('needle_player_seats', 'Multiplayer seats including disconnected players.', state.seats);
    gauge('needle_lobbies_current', 'All unexpired lobbies including waiting and finished.', state.lobbies);
    gauge('needle_lobbies_running', 'Games loading, counting down, playing or revealing; excludes waiting, finished and load-error.', state.running);
    lines.push('# HELP needle_lobbies_phase Current lobbies by phase.', '# TYPE needle_lobbies_phase gauge');
    for (const [phase, count] of Object.entries(state.phases)) lines.push(`needle_lobbies_phase{phase="${phase}"} ${count}`);
    gauge('needle_http_in_flight', 'Open app HTTP requests including intentional long polls.', inFlight);
    for (const [suffix, field, help] of [['requests_total', 'count', 'Completed or aborted HTTP requests.'], ['response_body_bytes_total', 'sent', 'Response payload bytes submitted by the app; excludes headers, TLS, TCP and Deezer audio.'], ['request_body_bytes_total', 'received', 'Request payload bytes consumed by the app; excludes headers, TLS and TCP.']]) {
      lines.push(`# HELP needle_http_${suffix} ${help}`, `# TYPE needle_http_${suffix} counter`);
      for (const [labels, entry] of requests) lines.push(`needle_http_${suffix}{${labels}} ${entry[field]}`);
    }
    lines.push('# HELP needle_http_duration_seconds Request duration including deliberate long-poll waits.', '# TYPE needle_http_duration_seconds histogram');
    for (const [labels, entry] of requests) {
      BUCKETS.forEach((bound, i) => lines.push(`needle_http_duration_seconds_bucket{${labels},le="${bound === Infinity ? '+Inf' : bound}"} ${entry.buckets[i]}`));
      lines.push(`needle_http_duration_seconds_sum{${labels}} ${entry.seconds}`, `needle_http_duration_seconds_count{${labels}} ${entry.count}`);
    }
    const cpu = process.cpuUsage(), memory = process.memoryUsage();
    lines.push('# HELP process_cpu_seconds_total Total process CPU seconds.', '# TYPE process_cpu_seconds_total counter', `process_cpu_seconds_total ${(cpu.user + cpu.system) / 1e6}`);
    gauge('process_resident_memory_bytes', 'Process resident memory in bytes.', memory.rss);
    gauge('process_heap_used_bytes', 'Used JavaScript heap in bytes.', memory.heapUsed);
    gauge('process_start_time_seconds', 'Process start time in Unix seconds.', startedAt);
    for (const [name, value] of [['persistence_errors', persistenceErrors], ['log_write_errors', logErrors], ['logs_dropped', droppedLogs]]) {
      lines.push(`# HELP needle_${name}_total Monitoring ${name.replaceAll('_', ' ')}.`, `# TYPE needle_${name}_total counter`, `needle_${name}_total ${value}`);
    }
    return lines.join('\n') + '\n';
  }
  return { event, log, observeHttp, render, setSnapshot: fn => { snapshot = fn; }, flush,
    close: async () => { clearInterval(timer); closed = true; await flush(); } };
}
