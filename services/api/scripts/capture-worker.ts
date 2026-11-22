import { config } from 'dotenv';
import { setTimeout as delay } from 'node:timers/promises';
import { parseArgs } from 'node:util';
import { z } from 'zod';

// Load private local overrides before application imports can load the base .env.
// Explicit environment variables still take precedence.
config({ path: ['.env.local', '.env'], quiet: true });
const [{ captureStorage }, { revisionStorage }, { MockCaptureProcessor }, { CaptureWorker }, { CpuCaptureProcessor }, { selectedProcessor, processorTimeout }] = await Promise.all([
  import('../src/lib/storage/captures'), import('../src/lib/storage/revisions'),
  import('../src/lib/processing/processor'), import('../src/lib/processing/worker'),
  import('../src/lib/processing/cpu-processor'), import('../src/lib/processing/selection'),
]);

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const args = parseArgs({ options: { once: { type: 'boolean' }, 'job-id': { type: 'string' } } }).values;
const jobId = args['job-id'] ? z.uuid().parse(args['job-id']) : undefined;
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const identity = selectedProcessor();
const timeoutMs = processorTimeout();
const mock = new MockCaptureProcessor();
const cpu = process.platform === 'win32' && identity.id === mock.id ? undefined : new CpuCaptureProcessor({
  databaseUrl: process.env.DATABASE_URL, cliPath: process.env.LIDAR_PROCESSOR_PATH, timeoutMs });
// Keep already-queued mock jobs executable when operators switch new captures to CPU.
const worker = new CaptureWorker({ databaseUrl: process.env.DATABASE_URL,
  captures: captureStorage(), revisions: revisionStorage(), processor: cpu && identity.id === cpu.id ? cpu : mock,
  processors: cpu ? [mock, cpu] : [mock], timeoutMs,
  signal: controller.signal,
});
try {
  do {
    const result = await worker.runOnce(jobId);
    if (result.state === 'processed' || args.once || jobId) console.log(JSON.stringify(result));
    if (args.once || jobId) break;
    if (result.state !== 'processed') await delay(1000, undefined, { signal: controller.signal });
  } while (!controller.signal.aborted);
} catch (error) {
  if (!controller.signal.aborted) {
    console.error('Capture worker stopped; unfinished jobs remain in PostgreSQL for recovery.');
    process.exitCode = 1;
  }
}
