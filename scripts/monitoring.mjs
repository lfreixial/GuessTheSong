import { randomBytes } from 'node:crypto';
import { readFile, writeFile, appendFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));
const action = process.argv[2] || 'up';
if (!['init', 'up', 'down', 'ps', 'logs', 'config', 'validate'].includes(action)) {
  console.error('Usage: node scripts/monitoring.mjs [init|up|down|ps|logs|config|validate]'); process.exit(1);
}
const envPath = fileURLToPath(new URL('../.env', import.meta.url));
let legacy = '';
try { legacy = await readFile(new URL('../.env.monitoring', import.meta.url), 'utf8'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
try {
  // Preserve any earlier monitoring credentials and port settings on migration.
  await writeFile(envPath, legacy || '# Local Compose settings. Do not commit or share this file.\n', { flag: 'wx', mode: 0o600 });
} catch (error) { if (error.code !== 'EEXIST') throw error; }
const current = await readFile(envPath, 'utf8');
const assignment = current.match(/^[ \t]*(?:export[ \t]+)?GRAFANA_ADMIN_PASSWORD[ \t]*[=:][ \t]*(.*)$/m);
if (!assignment || ['', "''", '""'].includes(assignment[1].trim()) || assignment[1].trim().startsWith('#')) {
  const previous = legacy.match(/^GRAFANA_ADMIN_PASSWORD=(.+)$/m)?.[1];
  const line = 'GRAFANA_ADMIN_PASSWORD=' + (previous || randomBytes(24).toString('hex'));
  if (assignment) await writeFile(envPath, current.replace(assignment[0], () => line));
  else await appendFile(envPath, '\n' + line + '\n');
}
await chmod(envPath, 0o600);
if (action === 'init') {
  console.log('Compose settings are in .env. Start the app and monitoring with: docker compose up --build -d');
  process.exit(0);
}
const base = ['compose', '--env-file', envPath, '-f', 'compose.yaml'];
async function docker(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [...base, ...args], { cwd: root, stdio: 'inherit' });
    child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Docker exited with code ${code}`)));
  });
}
try {
  if (action === 'validate') {
    await docker(['config', '--quiet']);
    await docker(['run', '--rm', '--no-deps', '--entrypoint', '/bin/promtool', 'prometheus', 'check', 'config', '/etc/prometheus/prometheus.yml']);
    await docker(['run', '--rm', '--no-deps', 'loki', '-config.file=/etc/loki/config.yaml', '-verify-config=true']);
    await docker(['run', '--rm', '--no-deps', 'alloy', 'validate', '/etc/alloy/config.alloy']);
  } else {
    const args = action === 'up' ? ['up', '-d', '--build'] : action === 'logs' ? ['logs', '--tail', '100', '-f'] : action === 'config' ? ['config', '--quiet'] : [action];
    await docker(args);
    if (action === 'up') console.log(`Grafana dashboard: /d/needle-drop on your configured Grafana port (3000 by default).\nUsername: admin\nPassword: GRAFANA_ADMIN_PASSWORD in ${envPath}\nThe dashboard fills after the first 15-second scrape.`);
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
