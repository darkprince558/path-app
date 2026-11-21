import { constants } from 'node:fs';
import { link, lstat, mkdir, open, realpath, unlink } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { capturePath, type FileDigest } from '../capture/contract';

export class CaptureIntegrityError extends Error {}
export interface CaptureStorage {
  // Implementations must verify size/hash before atomically making immutable bytes visible.
  // S3 implementations can stage, verify and conditionally copy to a final private key.
  putVerified(key: string, chunks: AsyncIterable<Uint8Array>, expected: FileDigest): Promise<void>;
  inspect(key: string): Promise<FileDigest | null>;
  read(key: string, maxBytes: number): Promise<Uint8Array>;
}

export function captureObjectKey(captureId: string, relativePath: string) {
  if (!/^[0-9a-f-]{36}$/.test(captureId)) throw new Error('Invalid capture storage ID');
  if (relativePath !== 'manifest.json') capturePath.parse(relativePath);
  return `captures/${captureId}/${relativePath}`;
}

export class LocalCaptureStorage implements CaptureStorage {
  constructor(private readonly root: string) {}

  private async file(key: string, create: boolean) {
    const match = /^captures\/([0-9a-f-]{36})\/(.+)$/.exec(key);
    if (!match || key !== captureObjectKey(match[1], match[2])) throw new Error('Invalid capture object key');
    // Storage is an application-owned private directory, never a public/ web directory.
    const root = path.resolve(this.root);
    if (create) await mkdir(root, { recursive: true, mode: 0o700 });
    const actualRoot = await realpath(root);
    let current = actualRoot;
    const parts = key.split('/');
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      if (create) await mkdir(current, { mode: 0o700 }).catch(error => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe capture storage directory');
    }
    return path.join(current, parts.at(-1)!);
  }

  async putVerified(key: string, chunks: AsyncIterable<Uint8Array>, expected: FileDigest) {
    const file = await this.file(key, true);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx', 0o600);
    let byteSize = 0;
    const hash = createHash('sha256');
    try {
      for await (const chunk of chunks) {
        byteSize += chunk.byteLength;
        if (byteSize > expected.byteSize) throw new CaptureIntegrityError('File exceeds declared byte size');
        hash.update(chunk);
        // FileHandle.write may write fewer bytes than requested.
        let offset = 0;
        while (offset < chunk.byteLength) {
          const { bytesWritten } = await handle.write(chunk, offset, chunk.byteLength - offset);
          if (!bytesWritten) throw new Error('Capture storage write made no progress');
          offset += bytesWritten;
        }
      }
      if (byteSize !== expected.byteSize) throw new CaptureIntegrityError('File does not match declared byte size');
      if (hash.digest('hex') !== expected.sha256) throw new CaptureIntegrityError('File does not match declared SHA-256');
      await handle.sync();
      await handle.close();
      // Hard-link promotion is atomic and never overwrites an already accepted object.
      try { await link(temporary, file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.inspect(key);
        if (!existing || existing.byteSize !== expected.byteSize || existing.sha256 !== expected.sha256) {
          throw new CaptureIntegrityError('Existing capture object has different bytes');
        }
      }
    } finally {
      await handle.close().catch(() => {});
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async inspect(key: string): Promise<FileDigest | null> {
    let handle;
    try {
      handle = await open(await this.file(key, false), constants.O_RDONLY | constants.O_NOFOLLOW);
      if (!(await handle.stat()).isFile()) throw new Error('Capture object is not a regular file');
      const hash = createHash('sha256');
      let byteSize = 0;
      for await (const chunk of handle.createReadStream()) { byteSize += chunk.length; hash.update(chunk); }
      return { byteSize, sha256: hash.digest('hex') };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    } finally { await handle?.close().catch(() => {}); }
  }

  async read(key: string, maxBytes: number) {
    const handle = await open(await this.file(key, false), constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of handle.createReadStream()) {
        size += chunk.length;
        if (size > maxBytes) throw new CaptureIntegrityError('Capture JSON exceeds size limit');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks, size);
    } finally { await handle.close().catch(() => {}); }
  }
}

export function captureStorage(): CaptureStorage {
  return new LocalCaptureStorage(path.resolve(process.env.CAPTURE_STORAGE_DIR || path.join(process.cwd(), '.local-captures')));
}
