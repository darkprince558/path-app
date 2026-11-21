import { config } from 'dotenv';
import { setTimeout as delay } from 'node:timers/promises';

// Load private local overrides before application imports can load the base .env.
// Explicit environment variables still take precedence.
config({ path: ['.env.local', '.env'], quiet: true });
const [{ captureStorage }, { revisionStorage }, { MockCaptureProcessor }, { CaptureWorker }] = await Promise.all([
  import('../src/lib/storage/captures'), import('../src/lib/storage/revisions'),
  import('../src/lib/processing/processor'), import('../src/lib/processing/worker'),
]);

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
const controller = new AbortController();
process.once('SIGINT', () => controller.abort());
process.once('SIGTERM', () => controller.abort());
const worker = new CaptureWorker({ databaseUrl: process.env.DATABASE_URL,
  captures: captureStorage(), revisions: revisionStorage(), processor: new MockCaptureProcessor(),
  signal: controller.signal,
});
try {
  do {
    const result = await worker.runOnce();
    if (result.state === 'processed') console.log(JSON.stringify(result));
    if (process.argv.includes('--once')) break;
    if (result.state !== 'processed') await delay(1000, undefined, { signal: controller.signal });
  } while (!controller.signal.aborted);
} catch (error) {
  if (!controller.signal.aborted) {
    console.error('Capture worker stopped; unfinished jobs remain in PostgreSQL for recovery.');
    process.exitCode = 1;
  }
}
