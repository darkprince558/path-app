// Independent of the CPU-bound CLI's event loop: parent death and deadlines still
// terminate a synchronous WASM/native operation before releasing its lifetime lock.
import { Socket } from 'node:net';
import { parentPort, workerData } from 'node:worker_threads';
import postgres from 'postgres';

function stop() { try { process.kill(-process.pid, 'SIGKILL'); } catch { process.exit(75); } }
process.on('uncaughtException', stop).on('unhandledRejection', stop);
if (!parentPort || !workerData.lock || process.ppid !== workerData.parent) stop();
// spawn's POSIX pipe is a socket pair. Nonblocking I/O can be destroyed on normal
// completion; fs.read on this descriptor would leave an uncancellable pool read.
const lifetime = new Socket({ fd: 3, readable: true, writable: false });
lifetime.on('end', stop).on('error', stop).resume();
const deadline = setTimeout(stop, workerData.deadline);
let closing = false;
const database = postgres(workerData.databaseUrl, { max: 1, prepare: false,
  idle_timeout: 0, max_lifetime: 0, connect_timeout: 5, onclose: () => { if (!closing) stop(); },
});
try {
  const [lock] = await database`SELECT pg_try_advisory_lock(${workerData.lock}) AS acquired`;
  if (!lock.acquired || process.ppid !== workerData.parent) stop();
  parentPort.postMessage('ready');
  await new Promise(resolve => parentPort.once('message', resolve));
  closing = true;
  clearTimeout(deadline); lifetime.removeAllListeners(); lifetime.destroy();
  await database.end({ timeout: 1 });
  parentPort.close();
} catch { stop(); }
