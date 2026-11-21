import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const DEFAULT_PROCESSOR = { id: 'mock-lidar', version: '1' } as const;
export class ProcessingFailure extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export interface CaptureProcessor {
  readonly id: string;
  readonly version: string;
  // A future CLI adapter maps these directories to --input/--output without a shell.
  // It must stop its child process on abort and resolve only after the child has exited.
  process(options: { inputDir: string; outputDir: string; signal: AbortSignal }): Promise<void>;
}

export class MockCaptureProcessor implements CaptureProcessor {
  readonly id = DEFAULT_PROCESSOR.id;
  readonly version = DEFAULT_PROCESSOR.version;
  async process({ inputDir, outputDir, signal }: Parameters<CaptureProcessor['process']>[0]) {
    signal.throwIfAborted();
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    for (const [source, destination] of [
      ['source.glb', 'master.glb'], ['source.glb', 'scene.glb'],
      ['points.ply', 'scene.ply'], ['preview.jpg', 'preview.jpg'],
    ]) {
      signal.throwIfAborted();
      await copyFile(path.join(inputDir, source), path.join(outputDir, destination));
    }
    await writeFile(path.join(outputDir, 'report.json'), JSON.stringify({
      version: 1, processor: { id: this.id, version: this.version }, mock: true,
      warnings: ['Synthetic copy processor: no mesh processing, alignment or walkability verification.'],
    }), { mode: 0o600 });
    signal.throwIfAborted();
  }
}
