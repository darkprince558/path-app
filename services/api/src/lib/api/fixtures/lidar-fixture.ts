import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { connectDatabase } from '../../../db/client';
import type { AppUser } from '../../auth/user-sync';
import type { CaptureStorage } from '../../storage/captures';
import { captureManifest } from '../../capture/contract';
import { digestBytes, registerCapture, uploadCaptureFile, finalizeCapture } from '../captures';

const root = new URL('../../../../../../fixtures/lidar-capture/', import.meta.url);
export const lidarFixtureFile = (file: string) => readFile(new URL(file, root));
export async function ingestLidarFixture(db: ReturnType<typeof connectDatabase>['db'], storage: CaptureStorage,
  owner: AppUser, spaceId: string, fixtureRoot: URL = root) {
  const fileBytes = (file: string) => readFile(new URL(file, fixtureRoot));
  const manifest = captureManifest.parse(JSON.parse((await fileBytes('manifest.json')).toString()));
  manifest.captureId = randomUUID();
  const frames = JSON.parse((await fileBytes('frames.json')).toString()); frames.captureId = manifest.captureId;
  const frameBytes = Buffer.from(JSON.stringify(frames));
  Object.assign(manifest.files.find(file => file.path === 'frames.json')!, digestBytes(frameBytes));
  const { capture } = await registerCapture(db, storage, owner, { spaceId, manifest });
  for (const file of manifest.files) {
    await uploadCaptureFile(db, storage, owner, capture.id, new Request(`http://localhost/uploads?path=${encodeURIComponent(file.path)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
      body: file.path === 'frames.json' ? frameBytes : await fileBytes(file.path),
    }));
  }
  return finalizeCapture(db, storage, owner, capture.id);
}
