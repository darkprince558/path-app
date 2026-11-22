import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile, readdir, rename, realpath, rmdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJson, captureManifest, validateFrameReferences } from '../capture/contract';
import { MAX_GLB_BYTES } from '../api/scans';
import { ProcessingFailure, type CaptureProcessor } from './processor';
import { CPU_PROCESSOR, processorTimeout } from './selection';
import { CAPTURE_CPU_LOCK } from './locks';

const CLI = fileURLToPath(new URL('../../../../../apps/capture/processor/cli.mjs', import.meta.url));
const RUNNER = fileURLToPath(new URL('./cpu-runner.mjs', import.meta.url));
const required = ['master.glb', 'scene.glb', 'preview.jpg', 'report.json'];
const allowed = [...required, 'scene.ply'];
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');

async function boundedBytes(directory: string, filename: string, limit: number) {
  const file = path.join(directory, filename), stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > limit) throw new Error('Invalid file');
  const bytes = await readFile(file);
  if (bytes.length !== stat.size || bytes.length > limit) throw new Error('File changed');
  return bytes;
}

export class CpuCaptureProcessor implements CaptureProcessor {
  readonly id = CPU_PROCESSOR.id;
  readonly version = CPU_PROCESSOR.version;
  constructor(private readonly options: {
    databaseUrl: string; cliPath?: string; timeoutMs?: number; killGraceMs?: number;
  }) {
    if (process.platform === 'win32') throw new Error('CPU processor supervision requires POSIX (Linux/macOS)');
    if (!options.databaseUrl) throw new Error('CPU processor requires a session-preserving database connection');
    for (const n of [options.timeoutMs ?? 300_000, options.killGraceMs ?? 1000]) {
      if (!Number.isSafeInteger(n) || n < 1 || n > 3_600_000) throw new Error('Invalid CPU processor deadline');
    }
  }
  async process({ inputDir, outputDir, signal }: Parameters<CaptureProcessor['process']>[0]) {
    signal.throwIfAborted();
    const manifest = captureManifest.parse(JSON.parse((await boundedBytes(inputDir, 'manifest.json', 2 * 1024 * 1024)).toString()));
    const frames = validateFrameReferences(JSON.parse((await boundedBytes(inputDir, 'frames.json', 2 * 1024 * 1024)).toString()), manifest);
    // Worker owns this empty parent; CLI publishes atomically to an absent child destination.
    if ((await readdir(outputDir)).length) throw new ProcessingFailure('INVALID_OUTPUT', 'Output workspace must be empty');
    const destination = path.join(outputDir, 'cpu-result');
    let cli: string;
    try { cli = await realpath(path.resolve(this.options.cliPath ?? CLI)); if (!(await lstat(cli)).isFile()) throw new Error('Not a CLI file'); }
    catch { throw new ProcessingFailure('PROCESSOR_UNAVAILABLE', 'CPU processor CLI is not installed'); }
    await this.run(cli, [ '--input', inputDir, '--output', destination, '--expected-capture-id', manifest.captureId ], signal);
    signal.throwIfAborted();
    try {
      const directory = await lstat(destination);
      if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe output');
      const names = await readdir(destination);
      if (required.some(name => !names.includes(name)) || names.some(name => !allowed.includes(name))) throw new Error('Invalid inventory');
      const report = JSON.parse((await boundedBytes(destination, 'report.json', 2 * 1024 * 1024)).toString());
      if (report.captureId !== manifest.captureId || report.mock === true ||
          report.sourceManifestSha256 !== sha(canonicalJson(manifest)) ||
          canonicalJson(report.coordinateSystem) !== canonicalJson(manifest.coordinateSystem) ||
          canonicalJson(report.entrancePose) !== canonicalJson(manifest.entrancePose) ||
          canonicalJson(report.frames) !== canonicalJson(frames.frames) ||
          !report.assets || typeof report.assets !== 'object' || Array.isArray(report.assets) ||
          Object.keys(report.assets).length !== names.length - 1) throw new Error('Invalid provenance');
      for (const name of names.filter(name => name !== 'report.json')) {
        const bytes = await boundedBytes(destination, name, MAX_GLB_BYTES);
        const entry = report.assets[name];
        if (!entry || entry.byteSize !== bytes.length || entry.sha256 !== sha(bytes)) throw new Error('Invalid output checksum');
      }
      for (const name of names) await rename(path.join(destination, name), path.join(outputDir, name));
      // Empty result directory must not reach the independent revision inventory validator.
      await rmdir(destination);
    } catch { throw new ProcessingFailure('INVALID_OUTPUT', 'CPU output inventory, checksums or provenance are invalid'); }
    // LocalRevisionStorage independently validates GLB/JPEG/PLY formats and stores immutable 0600 bytes.
  }

  private async run(cli: string, args: string[], signal: AbortSignal) {
    signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(process.execPath, [RUNNER, cli, ...args], {
        detached: true, shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        env: { NODE_ENV: process.env.NODE_ENV ?? 'production', PATH: process.env.PATH, TMPDIR: process.env.TMPDIR, TZ: process.env.TZ,
          LIDAR_PARENT_PID: String(process.pid), LIDAR_CPU_LOCK: String(CAPTURE_CPU_LOCK),
          LIDAR_HARD_TIMEOUT_MS: String((this.options.timeoutMs ?? processorTimeout()) + (this.options.killGraceMs ?? 1000) + 2000),
          LIDAR_GUARD_DATABASE_URL: this.options.databaseUrl },
      });
      // Drain, never buffer or persist arbitrary processor stdout/stderr.
      child.stdout?.resume(); child.stderr?.resume();
      let failure: ProcessingFailure | undefined;
      let escalation: ReturnType<typeof setTimeout> | undefined;
      const kill = (kind: NodeJS.Signals) => {
        if (!child.pid) return;
        try { process.kill(-child.pid, kind); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') failure ??= new ProcessingFailure('PROCESSOR_STOP_FAILED', 'Unable to stop processor process group'); }
      };
      const stop = (reason: ProcessingFailure) => {
        if (failure) return;
        failure = reason; kill('SIGTERM');
        escalation = setTimeout(() => kill('SIGKILL'), this.options.killGraceMs ?? 1000);
      };
      const aborted = () => stop(signal.reason instanceof ProcessingFailure ? signal.reason :
        new ProcessingFailure(signal.reason?.name === 'TimeoutError' ? 'PROCESSOR_TIMEOUT' : 'PROCESSING_ABORTED',
          signal.reason?.name === 'TimeoutError' ? 'CPU processing timed out' : 'CPU processing was cancelled'));
      signal.addEventListener('abort', aborted, { once: true });
      const timeout = setTimeout(() => stop(new ProcessingFailure('PROCESSOR_TIMEOUT', 'CPU processing timed out')),
        this.options.timeoutMs ?? processorTimeout());
      child.on('error', () => { failure ??= new ProcessingFailure('PROCESSOR_START_FAILED', 'CPU processor could not be started'); });
      child.once('close', (code, exitSignal) => {
        clearTimeout(timeout); clearTimeout(escalation); signal.removeEventListener('abort', aborted);
        // close means termination and closed stdio; no job failure/retry is acknowledged earlier.
        if (failure) { reject(failure); return; }
        if (exitSignal) { reject(new ProcessingFailure('PROCESSOR_SIGNAL', 'CPU processor terminated unexpectedly')); return; }
        if (code === 0) { resolve(); return; }
        const reason: Record<number, [string, string]> = {
          1: ['PROCESSOR_FAILED', 'CPU processing failed'], 2: ['INVALID_INPUT', 'CPU processor rejected the capture'],
          64: ['PROCESSOR_USAGE', 'CPU processor configuration is invalid'], 75: ['WORKER_INTERRUPTED', 'CPU processor lost its parent or database session'],
        };
        const [errorCode, message] = reason[code ?? -1] ?? ['PROCESSOR_EXIT', 'CPU processor exited unsuccessfully'];
        reject(new ProcessingFailure(errorCode, message));
      });
      if (signal.aborted) aborted();
    });
  }
}
