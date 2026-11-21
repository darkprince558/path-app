import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdtemp, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { captureManifest, captureFrameIndex, validateFrameReferences, canonicalJson } from '../capture/contract';
import { captureManifest as cpuManifest, captureFrameIndex as cpuFrames } from '../../../../../apps/capture/processor/contract.mjs';

const exec = promisify(execFile);
const root = new URL('../../../../../', import.meta.url);
const fixture = fileURLToPath(new URL('fixtures/lidar-native-capture/', root));
const cli = fileURLToPath(new URL('apps/capture/processor/cli.mjs', root));
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const readJson = async (directory: string, name: string) => JSON.parse(await readFile(path.join(directory, name), 'utf8'));

test('CPU validators are generated from unchanged authoritative Zod sources', async () => {
  await exec(process.execPath, ['--import', 'tsx', 'scripts/export-capture-contract.ts', '--check'], {
    cwd: fileURLToPath(new URL('services/api/', root)),
  });
});

test('native shared fixture passes backend validation and real CPU processing with stable provenance', async t => {
  const manifest = captureManifest.parse(await readJson(fixture, 'manifest.json'));
  const frames = validateFrameReferences(await readJson(fixture, 'frames.json'), manifest);
  assert.deepEqual(frames.frames.map(f => f.id), ['frame-0000', 'frame-0007']);
  assert.equal(frames.frames[1].timestampSeconds, 1.25);
  for (const file of manifest.files) {
    const bytes = await readFile(path.join(fixture, file.path));
    assert.equal(sha(bytes), file.sha256); assert.equal(bytes.length, file.byteSize);
  }
  const temp = await mkdtemp(path.join(tmpdir(), 'lidar-contract-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const input = path.join(temp, 'input'), output = path.join(temp, 'revision');
  await cp(fixture, input, { recursive: true });
  // Registration stores canonical JSON; processor provenance must match that same digest.
  await writeFile(path.join(input, 'manifest.json'), canonicalJson(manifest));
  const databaseCaptureId = randomUUID();
  assert.notEqual(databaseCaptureId, manifest.captureId);
  await assert.rejects(exec(process.execPath, [cli, '--input', input, '--output', output,
    '--expected-capture-id', databaseCaptureId]), error => (error as { code: number }).code === 2);
  await exec(process.execPath, [cli, '--input', input, '--output', output, '--expected-capture-id', manifest.captureId]);
  const report = await readJson(output, 'report.json');
  assert.equal(report.captureId, manifest.captureId);
  assert.equal(report.sourceManifestSha256, sha(canonicalJson(manifest)));
  assert.deepEqual(report.frames, frames.frames);
  assert.deepEqual(report.coordinateSystem, manifest.coordinateSystem);
  for (const [filename, expected] of Object.entries(report.assets)) {
    const bytes = await readFile(path.join(output, filename));
    assert.deepEqual(expected, { byteSize: bytes.length, sha256: sha(bytes) });
  }
});

test('exporter/CPU contract rejects old fields, unsafe paths, invalid poses and bounds identically', async () => {
  const manifest = await readJson(fixture, 'manifest.json'), frames = await readJson(fixture, 'frames.json');
  const badManifests = [
    { ...manifest, version: '1.0' }, { ...manifest, createdAt: manifest.capturedAt },
    { ...manifest, device: { model: 'iPhone', platform: 'iOS', scanner: 'ARKit' } },
    { ...manifest, coordinateSystem: { ...manifest.coordinateSystem, units: 'meters' } },
    { ...manifest, files: manifest.files.map((f: object) => ({ ...f, type: 'mesh' })) },
    { ...manifest, files: manifest.files.map((f: object, i: number) => i ? f : { ...f, path: '../source.glb' }) },
    { ...manifest, files: manifest.files.map((f: object, i: number) => i ? f : { ...f, byteSize: 32 * 1024 * 1024 + 1 }) },
    { ...manifest, entrancePose: Array(16).fill(0) },
  ];
  for (const invalid of badManifests) {
    assert.equal(captureManifest.safeParse(invalid).success, false);
    assert.equal(cpuManifest.safeParse(invalid).success, false);
  }
  for (const invalid of [{ frames: frames.frames }, { ...frames, version: '1.0' },
    { ...frames, frames: [frames.frames[0], frames.frames[0]] },
    { ...frames, frames: [{ ...frames.frames[0], imagePath: 'frames/other.jpg' }] },
    { ...frames, frames: [{ ...frames.frames[0], timestampSeconds: -1 }] },
    { ...frames, frames: [{ ...frames.frames[0], width: 0 }] }]) {
    assert.equal(captureFrameIndex.safeParse(invalid).success, false);
    assert.equal(cpuFrames.safeParse(invalid).success, false);
  }
});

test('CPU rejects corrupt checksums, foreign frame capture IDs, dimensions and symlinks', async t => {
  const temp = await mkdtemp(path.join(tmpdir(), 'lidar-contract-reject-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  for (const mode of ['checksum', 'foreign-capture', 'dimensions', 'symlink']) {
    const input = path.join(temp, mode), output = path.join(temp, `${mode}-revision`);
    await cp(fixture, input, { recursive: true });
    const manifest = await readJson(input, 'manifest.json');
    if (mode === 'checksum') await writeFile(path.join(input, 'frames/frame-0007.jpg'), 'corrupt');
    else if (mode === 'symlink') {
      await rm(path.join(input, 'frames/frame-0007.jpg'));
      await symlink(path.join(fixture, 'frames/frame-0007.jpg'), path.join(input, 'frames/frame-0007.jpg'));
    } else {
      const frames = await readJson(input, 'frames.json');
      if (mode === 'foreign-capture') frames.captureId = randomUUID();
      else frames.frames[0].width = 65;
      const bytes = JSON.stringify(frames);
      await writeFile(path.join(input, 'frames.json'), bytes);
      const entry = manifest.files.find((f: { path: string }) => f.path === 'frames.json');
      entry.byteSize = Buffer.byteLength(bytes); entry.sha256 = sha(bytes);
      await writeFile(path.join(input, 'manifest.json'), JSON.stringify(manifest));
    }
    await assert.rejects(exec(process.execPath, [cli, '--input', input, '--output', output]),
      error => (error as { code: number }).code === 2, mode);
  }
});
