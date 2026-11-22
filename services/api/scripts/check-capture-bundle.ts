import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { captureManifest, validateFrameReferences, canonicalJson } from '../src/lib/capture/contract';

const directory = process.argv[2];
if (!directory) throw new Error('Usage: node --import tsx scripts/check-capture-bundle.ts <bundle>');
const manifest = captureManifest.parse(JSON.parse(await readFile(path.join(directory, 'manifest.json'), 'utf8')));
const frames = validateFrameReferences(JSON.parse(await readFile(path.join(directory, 'frames.json'), 'utf8')), manifest);
for (const file of manifest.files) {
  const bytes = await readFile(path.join(directory, file.path));
  if (bytes.length !== file.byteSize || createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
    throw new Error(`Invalid inventory checksum or size: ${file.path}`);
  }
}
console.log(JSON.stringify({ deviceCaptureId: manifest.captureId, frames: frames.frames.length,
  manifestSha256: createHash('sha256').update(canonicalJson(manifest)).digest('hex') }));
