import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { NodeIO } from '@gltf-transform/core';
import { KHRMaterialsUnlit } from '@gltf-transform/extensions';
import sharp from 'sharp';
import validator from 'gltf-validator';
import { sha256 } from './bundle.mjs';

const fixture = fileURLToPath(new URL('../../../fixtures/lidar-capture/', import.meta.url));
const command = fileURLToPath(new URL('../../../process_lidar_capture', import.meta.url));
const exec = promisify(execFile);
const readJSON = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('Swift capture produces a self-contained metric revision on CPU', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'lidar-revision-'));
  t.after(() => rm(temp, { force: true, recursive: true }));
  const output = join(temp, 'revision');
  const manifest = await readJSON(join(fixture, 'manifest.json'));
  await exec(command, [
    '--input',
    fixture,
    '--output',
    output,
    '--expected-capture-id',
    manifest.captureId,
  ]);
  assert.deepEqual((await readdir(output)).sort(), [
    'master.glb',
    'preview.jpg',
    'report.json',
    'scene.glb',
    'scene.ply',
  ]);
  const report = await readJSON(join(output, 'report.json'));
  assert.equal(report.captureId, manifest.captureId);
  for (const [name, expected] of Object.entries(report.assets)) {
    const data = await readFile(join(output, name));
    assert.deepEqual(expected, { byteSize: data.length, sha256: sha256(data) });
  }
  assert.equal(report.sourceManifestSha256, sha256(await readFile(join(fixture, 'manifest.json'))));
  assert.deepEqual(report.frames, (await readJSON(join(fixture, 'frames.json'))).frames);
  assert.deepEqual(
    report.frames.map((f) => f.frameId),
    ['frame-0000', 'frame-0007'],
  );
  assert.equal(report.frames[1].timestampMs, 1250);
  assert.ok(Math.abs(report.frames[1].cameraPose[12] - 0.2) < 1e-6);
  assert.deepEqual(report.entrancePose, manifest.entrancePose);
  assert.deepEqual(report.trackingWarnings, ['tracking: limited']);
  assert.notEqual(
    sha256(await readFile(join(fixture, report.frames[0].path))),
    sha256(await readFile(join(fixture, report.frames[1].path))),
  );
  assert.equal(report.pointCount, 121);
  assert.deepEqual(
    await readFile(join(output, 'scene.ply')),
    await readFile(join(fixture, 'points.ply')),
  );
  assert.equal(report.masterTriangles, 200);
  assert.ok(report.sceneTriangles > 0 && report.sceneTriangles < report.masterTriangles);
  assert.ok(report.assets['scene.glb'].byteSize < report.assets['master.glb'].byteSize);
  const io = new NodeIO().registerExtensions([KHRMaterialsUnlit]);
  for (const name of ['master.glb', 'scene.glb']) {
    const bytes = await readFile(join(output, name));
    assert.equal(report.assets[name].sha256, sha256(bytes));
    const validated = await validator.validateBytes(bytes);
    assert.equal(validated.issues.numErrors, 0, JSON.stringify(validated.issues.messages));
    const doc = await io.readBinary(bytes);
    const surface = doc.getRoot().listMeshes()[0].listPrimitives()[0];
    const pos = surface.getAttribute('POSITION');
    assert.deepEqual(pos.getMin([]), [-1, -1, -2]);
    assert.deepEqual(pos.getMax([]), [1, 1, -2]);
    assert.ok(surface.getAttribute('_AR_CLASSIFICATION'));
    assert.ok(surface.getMaterial().getBaseColorTexture().getImage().byteLength > 0);
  }
  const preview = await sharp(await readFile(join(output, 'preview.jpg'))).metadata();
  assert.equal(preview.width, 512);
  assert.equal(preview.format, 'jpeg');
  await assert.rejects(exec(command, ['--input', fixture, '--output', output]), (e) => e.code === 1);
  assert.deepEqual(await readJSON(join(output, 'report.json')), report);
});

test('an invalid upload leaves no revision and can be retried after correction', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'lidar-invalid-'));
  t.after(() => rm(temp, { force: true, recursive: true }));
  const input = join(temp, 'capture');
  const output = join(temp, 'revision');
  await cp(fixture, input, { recursive: true });
  const manifest = await readJSON(join(input, 'manifest.json'));
  const args = ['--input', input, '--output', output];
  async function rejected(argsToUse = args) {
    await assert.rejects(exec(command, argsToUse), (e) => e.code === 2);
    assert.deepEqual(await readdir(temp), ['capture']);
  }
  await rejected([...args, '--expected-capture-id', '00000000-0000-0000-0000-000000000000']);
  const manifestPath = join(input, 'manifest.json');
  const writeManifest = (data) => writeFile(manifestPath, JSON.stringify(data));
  await writeManifest({ ...manifest, version: '2.0' });
  await rejected();
  await writeManifest({ ...manifest, files: [...manifest.files.slice(1), manifest.files[1]] });
  await rejected();
  await writeManifest(manifest);
  await writeFile(join(input, 'unexpected.txt'), 'extra');
  await rejected();
  await rm(join(input, 'unexpected.txt'));
  const framesPath = join(input, 'frames.json');
  const bytes = await readFile(framesPath);
  const metadata = JSON.parse(bytes);
  metadata.frames[1].path = metadata.frames[0].path;
  const invalidFrames = JSON.stringify(metadata);
  await writeFile(framesPath, invalidFrames);
  await rejected(); // Inventory still has the original checksum.
  const entry = manifest.files.find((f) => f.path === 'frames.json');
  entry.byteSize = Buffer.byteLength(invalidFrames);
  entry.sha256 = sha256(invalidFrames);
  await writeManifest(manifest);
  await rejected(); // Bytes now match, but the frame reference is inconsistent.
  await cp(fixture, input, { recursive: true });
  await exec(command, args);
  assert.equal((await readJSON(join(output, 'report.json'))).frames.length, 2);
});

test('two workers targeting the same revision publish one complete result', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'lidar-race-'));
  t.after(() => rm(temp, { force: true, recursive: true }));
  const output = join(temp, 'revision');
  const run = () => exec(command, ['--input', fixture, '--output', output]);
  const results = await Promise.allSettled([run(), run()]);
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
  assert.deepEqual(await readdir(temp), ['revision']);
  assert.equal((await readJSON(join(output, 'report.json'))).pointCount, 121);
});
