import { CaptureWorker } from '../../processing/worker';
import { CpuCaptureProcessor } from '../../processing/cpu-processor';
import { LocalCaptureStorage } from '../../storage/captures';
import { LocalRevisionStorage } from '../../storage/revisions';

await new CaptureWorker({ databaseUrl: process.env.TEST_DATABASE_URL!,
  captures: new LocalCaptureStorage(process.env.CAPTURE_TEST_STORAGE!),
  revisions: new LocalRevisionStorage(process.env.REVISION_TEST_STORAGE!),
  processor: new CpuCaptureProcessor({ databaseUrl: process.env.TEST_DATABASE_URL!, cliPath: process.env.CAPTURE_TEST_CLI, timeoutMs: 20000 }),
}).runOnce(process.env.CAPTURE_TEST_JOB);
