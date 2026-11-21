#!/usr/bin/env node
import { lstat, mkdtemp, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { InvalidCapture, readBundle, sha256 } from './bundle.mjs';
import { models, pointPreview, readPoints } from './geometry.mjs';

const usage =
  'Usage: process_lidar_capture --input <bundle-directory> --output <new-revision-directory> [--expected-capture-id <uuid>]';
async function run(args) {
  try {
    if (!(await lstat(args.input)).isDirectory())
      throw new InvalidCapture('Expected a capture directory');
  } catch (e) {
    if (e.code === 'ENOENT') throw new InvalidCapture('Input directory does not exist');
    throw e;
  }
  const input = await realpath(args.input);
  const output = resolve(args.output);
  const parent = await realpath(dirname(output));
  const target = join(parent, basename(output));
  if (target === input || target.startsWith(input + sep))
    throw new Error('Output must be outside the source bundle');
  try {
    await lstat(target);
    throw new Error('Revision output already exists');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }

  let bundle, model, points;
  try {
    bundle = await readBundle(input, args['expected-capture-id']);
    points = readPoints(bundle.assets.get('points.ply'));
    model = await models(bundle.assets.get('source.glb'));
  } catch (e) {
    if (e instanceof InvalidCapture) throw e;
    if (['EACCES', 'EIO', 'EMFILE', 'ENOMEM', 'ENOSPC'].includes(e.code)) throw e;
    throw new InvalidCapture('Cannot process capture: ' + e.message);
  }
  const stage = await mkdtemp(join(parent, '.lidar-revision-'));
  try {
    const assets = {};
    for (const [name, bytes] of [
      ['master.glb', model.master],
      ['scene.glb', model.scene],
      ['scene.ply', bundle.assets.get('points.ply')],
      ['preview.jpg', await pointPreview(points)],
    ]) {
      await writeFile(join(stage, name), bytes);
      assets[name] = { byteSize: bytes.byteLength, sha256: sha256(bytes) };
    }
    const { manifest, manifestHash, frames } = bundle;
    const report = {
      version: '1.0',
      captureId: manifest.captureId,
      sourceManifestSha256: manifestHash,
      coordinateSystem: manifest.coordinateSystem,
      entrancePose: manifest.entrancePose,
      trackingWarnings: manifest.trackingWarnings,
      frames,
      pointCount: points.count,
      masterTriangles: model.fullTriangles,
      sceneTriangles: model.mobileTriangles,
      assets,
    };
    await writeFile(join(stage, 'report.json'), JSON.stringify(report, null, 2) + '\n');
    await rename(stage, target);
    console.log(
      JSON.stringify({
        captureId: manifest.captureId,
        output,
        frames: frames.length,
        points: points.count,
        masterTriangles: model.fullTriangles,
        sceneTriangles: model.mobileTriangles,
      }),
    );
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

let args;
try {
  args = parseArgs({
    options: {
      input: { type: 'string' },
      output: { type: 'string' },
      'expected-capture-id': { type: 'string' },
      help: { type: 'boolean' },
    },
  }).values;
  if (!args.help && (!args.input || !args.output)) throw new Error(usage);
} catch {
  console.error(usage);
  process.exit(64);
}
if (args.help) console.log(usage);
else {
  try {
    await run(args);
  } catch (e) {
    console.error(e.message);
    process.exitCode = e instanceof InvalidCapture ? 2 : 1;
  }
}
