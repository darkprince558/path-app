import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { validateGlb, MAX_GLB_BYTES } from '../api/scans';
import { ProcessingFailure } from '../processing/processor';

const required = ['master.glb', 'scene.glb', 'preview.jpg', 'report.json'];
const allowed = [...required, 'scene.ply'];
export type RevisionFile = { path: string; objectKey: string; byteSize: number; sha256: string };
export interface RevisionStorage {
  publish(outputDir: string, revisionId: string): Promise<{ files: RevisionFile[]; report: Record<string, unknown> }>;
}

// Each attempt gets a fresh revision UUID. No update/overwrite operation is exposed.
export class LocalRevisionStorage implements RevisionStorage {
  constructor(readonly root: string) {}
  async publish(outputDir: string, revisionId: string) {
    z.uuid().parse(revisionId);
    const names = await readdir(outputDir);
    if (required.some(name => !names.includes(name)) || names.some(name => !allowed.includes(name))) {
      throw new ProcessingFailure('INVALID_OUTPUT', 'Processor output inventory is incomplete or contains unsupported files');
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const rootInfo = await lstat(this.root);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Unsafe revision storage root');
    const staging = await mkdtemp(path.join(this.root, '.staging-'));
    const files: RevisionFile[] = [];
    let report: Record<string, unknown> = {};
    try {
      for (const name of names.sort()) {
        const file = path.join(outputDir, name);
        const info = await lstat(file);
        const limit = name === 'report.json' ? 2 * 1024 * 1024 : MAX_GLB_BYTES;
        if (!info.isFile() || info.isSymbolicLink() || info.size === 0 || info.size > limit) {
          throw new ProcessingFailure('INVALID_OUTPUT', 'Processor output is not a bounded regular file');
        }
        const bytes = await readFile(file);
        if (bytes.length !== info.size || bytes.length > limit) throw new ProcessingFailure('INVALID_OUTPUT', 'Processor output changed during validation');
        try {
          if (name.endsWith('.glb')) validateGlb(bytes, name);
          if (name === 'report.json') report = z.record(z.string(), z.unknown()).parse(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
          if (name === 'preview.jpg' && (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9)) throw new Error('Invalid JPEG');
          if (name === 'scene.ply' && !/^ply\r?\n/.test(bytes.subarray(0, 8).toString())) throw new Error('Invalid PLY');
        } catch { throw new ProcessingFailure('INVALID_OUTPUT', 'Processor output failed format validation'); }
        const handle = await open(path.join(staging, name), 'wx', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); }
        finally { await handle.close(); }
        files.push({ path: name, objectKey: `revisions/${revisionId}/${name}`, byteSize: bytes.length,
          sha256: createHash('sha256').update(bytes).digest('hex') });
      }
      const stagedDirectory = await open(staging, 'r');
      try { await stagedDirectory.sync(); } finally { await stagedDirectory.close(); }
      // Existing nonempty revision directories cannot be replaced by rename.
      await rename(staging, path.join(this.root, revisionId));
      const directory = await open(this.root, 'r');
      try { await directory.sync(); } finally { await directory.close(); }
      return { files, report };
    } finally { await rm(staging, { recursive: true, force: true }); }
  }
}

export function revisionStorage(): RevisionStorage {
  return new LocalRevisionStorage(path.resolve(process.env.REVISION_STORAGE_DIR || path.join(process.cwd(), '.local-revisions')));
}
