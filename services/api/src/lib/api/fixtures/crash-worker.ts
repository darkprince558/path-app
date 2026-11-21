import { CaptureWorker } from '../../processing/worker';
import { MockCaptureProcessor } from '../../processing/processor';
import { LocalCaptureStorage } from '../../storage/captures';
import { LocalRevisionStorage } from '../../storage/revisions';

// Subprocess fixture: its parent kills it after a durable claim, before outputs exist.
class PausedProcessor extends MockCaptureProcessor {
  async process() {
    console.log('processor-started');
    await new Promise<void>(() => {});
  }
}
class PausedRevisionStorage extends LocalRevisionStorage {
  async publish(outputDir: string, revisionId: string) {
    const result = await super.publish(outputDir, revisionId);
    console.log('outputs-written');
    await new Promise<void>(() => {});
    return result;
  }
}
const afterOutput = process.env.CAPTURE_TEST_PAUSE === 'after-output';
await new CaptureWorker({
  databaseUrl: process.env.TEST_DATABASE_URL!,
  captures: new LocalCaptureStorage(process.env.CAPTURE_TEST_STORAGE!),
  revisions: afterOutput ? new PausedRevisionStorage(process.env.REVISION_TEST_STORAGE!) : new LocalRevisionStorage(process.env.REVISION_TEST_STORAGE!),
  processor: afterOutput ? new MockCaptureProcessor() : new PausedProcessor(), heartbeatMs: 100,
}).runOnce(process.env.CAPTURE_TEST_JOB!);
