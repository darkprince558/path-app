// Runs Anish's Node CLI in this process; its watchdog thread owns the lifetime lock.
import { once } from 'node:events';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';

const cli = process.argv[2];
const parent = Number(process.env.LIDAR_PARENT_PID);
function stop() { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(75); } }
if (!cli || !parent || process.ppid !== parent || !process.env.LIDAR_GUARD_DATABASE_URL) process.exit(75);
const watchdog = new Worker(new URL('./cpu-watchdog.mjs', import.meta.url), { workerData: {
  parent, databaseUrl: process.env.LIDAR_GUARD_DATABASE_URL,
  lock: Number(process.env.LIDAR_CPU_LOCK), deadline: Number(process.env.LIDAR_HARD_TIMEOUT_MS),
} });
delete process.env.LIDAR_GUARD_DATABASE_URL;
let finishing = false, code = 1;
watchdog.on('error', stop);
watchdog.on('exit', status => { if (!finishing || status !== 0) stop(); });
try {
  await once(watchdog, 'message');
  if (process.ppid !== parent) stop();
  process.argv = [process.execPath, cli, ...process.argv.slice(3)];
  await import(pathToFileURL(cli).href);
  code = process.exitCode ?? 0;
} catch { code = 1; }
finally {
  finishing = true;
  const exited = once(watchdog, 'exit');
  watchdog.postMessage('finished');
  await exited;
}
process.exit(code);
