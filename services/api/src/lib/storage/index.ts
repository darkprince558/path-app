import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

export interface ScanStorage {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  // S3-compatible adapters can provide direct browser transfer after API authorization.
  presignUpload?(key: string, contentType: string, expiresInSeconds: number): Promise<string>;
  presignDownload?(key: string, expiresInSeconds: number): Promise<string>;
}

const keyPattern = /^scans\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.glb$/i;

export class LocalScanStorage implements ScanStorage {
  constructor(private readonly root: string) {}

  private file(key: string) {
    if (!keyPattern.test(key)) throw new Error('Invalid scan object key');
    return path.join(this.root, key);
  }

  async put(key: string, bytes: Uint8Array) {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  get(key: string) { return readFile(this.file(key)); }
  async delete(key: string) { await rm(this.file(key), { force: true }); }
  async exists(key: string) {
    try { return (await stat(this.file(key))).isFile(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
  }
}

export function scanStorage(): ScanStorage {
  return new LocalScanStorage(path.resolve(process.env.SCAN_STORAGE_DIR || path.join(process.cwd(), '.local-scans')));
}
